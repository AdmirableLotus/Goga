import type {
  MachineCapacity, ProviderReading, VirtualisationProvider, VirtualisationReport,
} from '../../../shared/setup'
import { runPowerShell } from './powershell'

/**
 * What virtualisation is actually available on this machine.
 *
 * The rule this file follows: report what was measured, not what the edition is usually
 * assumed to have. On this machine several of the usual answers are "no" for reasons that
 * only a real probe shows:
 *
 *   - Windows 11 Home has no Hyper-V and no Windows Sandbox at all, so neither can be turned
 *     on without an edition upgrade — that is a purchase decision, not a step.
 *   - `HypervisorPresent` is false even though the CPU reports virtualisation enabled in
 *     firmware, because no hypervisor is running.
 *   - WSL2 needs its own optional component, and `wsl --status` says plainly it is not there.
 *
 * Nothing here enables a Windows feature, downloads an image or creates anything. Every
 * command is a read. Enabling a feature needs a restart and a separate approval; that is the
 * user's decision and this report only says it would be needed.
 */

/** InstallState from Win32_OptionalFeature: 1 enabled, 2 disabled, 3 absent, 4 unknown. */
const INSTALL_STATE: Record<number, string> = { 1: 'enabled', 2: 'disabled', 3: 'absent', 4: 'unknown' }

const PROBE_SCRIPT = `
$ErrorActionPreference = 'Continue'
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$features = @{}
Get-CimInstance Win32_OptionalFeature -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match 'Hyper-V-All|Containers-DisposableClientVM|VirtualMachinePlatform|Subsystem-Linux|HypervisorPlatform'
} | ForEach-Object { $features[$_.Name] = $_.InstallState }

$disk = @{}
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | ForEach-Object {
  $disk[$_.DeviceID] = [math]::Round($_.FreeSpace / 1GB, 1)
}

$hasHyperVCmdlets = $null -ne (Get-Command Get-VM -ErrorAction SilentlyContinue)
$hasSandboxExe = Test-Path 'C:\\Windows\\System32\\WindowsSandbox.exe'
$vbox = Test-Path 'C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe'
$vmrun = (Test-Path 'C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe') -or (Test-Path 'C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe')

$vms = @()
if ($hasHyperVCmdlets) {
  try { $vms = @(Get-VM -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name = $_.Name; state = [string]$_.State } }) } catch { }
}

$out = [pscustomobject]@{
  osCaption        = [string]$os.Caption
  osBuild          = [string]$os.BuildNumber
  osSku            = [int]$os.OperatingSystemSKU
  hypervisorPresent = [bool]$cs.HypervisorPresent
  firmwareVirt      = [bool]$cpu.VirtualizationFirmwareEnabled
  cpuCores          = [int]$cpu.NumberOfCores
  logicalProcessors = [int]$cpu.NumberOfLogicalProcessors
  memoryGb          = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  features          = $features
  freeDiskGb        = $disk
  hasHyperVCmdlets  = $hasHyperVCmdlets
  hasSandboxExe     = $hasSandboxExe
  vboxPresent       = $vbox
  vmwarePresent     = $vmrun
  existingVms       = $vms
}
Write-Output (ConvertTo-Json -InputObject $out -Depth 6 -Compress)
`

/** WSL has its own status command, and it is the only honest source for whether it works. */
const WSL_SCRIPT = `
$ErrorActionPreference = 'Continue'
$raw = (& wsl.exe --status) 2>&1 | Out-String
$list = (& wsl.exe -l -v) 2>&1 | Out-String
$combined = ($raw + " " + $list)
# wsl.exe writes UTF-16; strip the interleaved null bytes before reporting.
$clean = ($combined -replace [char]0, '').Trim()
Write-Output (ConvertTo-Json -InputObject @{ text = $clean } -Compress)
`

interface Probe {
  osCaption?: string
  osBuild?: string
  osSku?: number
  hypervisorPresent?: boolean
  firmwareVirt?: boolean
  cpuCores?: number
  logicalProcessors?: number
  memoryGb?: number
  features?: Record<string, number>
  freeDiskGb?: Record<string, number>
  hasHyperVCmdlets?: boolean
  hasSandboxExe?: boolean
  vboxPresent?: boolean
  vmwarePresent?: boolean
  existingVms?: { name: string; state: string }[]
}

function featureWord(state: number | undefined): string {
  // Absent from the feature store and absent from the machine are different facts, and on a
  // Home edition the first is what happens: the feature is not listed at all.
  if (state === undefined) return 'absent (not listed in this edition\'s feature store)'
  return INSTALL_STATE[state] ?? `state ${state}`
}

/**
 * Read what is actually available.
 *
 * `providers` is ordered cheapest-to-adopt first, and each entry says what it would take to
 * make it usable and whether that needs a restart or a licence. The `usable` list is what a
 * VM proposal may actually use — often empty, and saying so is the honest answer.
 */
export async function detectVirtualisation(signal?: AbortSignal): Promise<VirtualisationReport> {
  const probeResult = await runPowerShell(PROBE_SCRIPT, { timeoutMs: 60_000, signal })
  let probe: Probe = {}
  try { probe = JSON.parse(probeResult.stdout) as Probe } catch { probe = {} }

  const wslResult = await runPowerShell(WSL_SCRIPT, { timeoutMs: 30_000, signal })
  let wslText = ''
  try {
    const parsed = JSON.parse(wslResult.stdout) as { text?: string }
    wslText = (parsed.text ?? '').trim()
  } catch {
    wslText = (wslResult.stdout || wslResult.stderr).replace(/\0/g, '').trim()
  }
  const wslInstalled = !!wslText && !/not installed|no installed distributions|not found/i.test(wslText)

  const readFailed = !probeResult.stdout
  const capacity: MachineCapacity = {
    cpuCores: probe.cpuCores ?? 0,
    logicalProcessors: probe.logicalProcessors ?? 0,
    memoryGb: probe.memoryGb ?? 0,
    freeDiskGb: probe.freeDiskGb ?? {},
  }

  const features = probe.features ?? {}
  const hyperVState = features['Microsoft-Hyper-V-All']
  const sandboxState = features['Containers-DisposableClientVM']
  const vmPlatformState = features['VirtualMachinePlatform']
  const wslState = features['Microsoft-Windows-Subsystem-Linux']

  // A Home edition has no Hyper-V and no Sandbox in the feature store at all.
  const homeEdition = probe.osSku === 101 || /Home/i.test(probe.osCaption ?? '')

  const providers: ProviderReading[] = []

  // ── Hyper-V ───────────────────────────────────────────────────────────────
  if (probe.hasHyperVCmdlets && hyperVState === 1) {
    const running = probe.existingVms ?? []
    providers.push({
      provider: 'hyper-v', name: 'Hyper-V', state: 'usable',
      checkedBy: probe.hasHyperVCmdlets ? 'Get-Command Get-VM answered and the Hyper-V feature is enabled' : 'the Hyper-V feature is enabled',
      detail: `Hyper-V is enabled and its management commands answer. ${running.length} virtual machine${running.length === 1 ? '' : 's'} exist already, and Goga will not change them.`,
      wouldNeed: null, needsRestart: false, needsLicence: false,
    })
  } else if (hyperVState === 2) {
    providers.push({
      provider: 'hyper-v', name: 'Hyper-V', state: 'present-but-unusable',
      checkedBy: 'Win32_OptionalFeature Microsoft-Hyper-V-All reports state 2 (disabled)',
      detail: 'The Hyper-V feature exists on this machine but is turned off.',
      wouldNeed: 'Turning Hyper-V on needs administrator rights, a restart, and — on Windows Home — an edition upgrade to Pro or higher.',
      needsRestart: true, needsLicence: homeEdition,
    })
  } else {
    providers.push({
      provider: 'hyper-v', name: 'Hyper-V', state: 'absent',
      checkedBy: `Win32_OptionalFeature Microsoft-Hyper-V-All reports ${featureWord(hyperVState)}${homeEdition ? '; this is a Home edition, which does not include it' : ''}`,
      detail: homeEdition
        ? `${probe.osCaption ?? 'This Windows edition'} does not include Hyper-V. It is not a setting that is off; it is not part of this edition.`
        : 'Hyper-V is not installed on this machine.',
      wouldNeed: homeEdition
        ? 'An upgrade to Windows Pro or Enterprise, which is a purchase. After that, enabling Hyper-V needs administrator rights and a restart.'
        : 'Enabling Hyper-V needs administrator rights and a restart.',
      needsRestart: true, needsLicence: homeEdition,
    })
  }

  // ── Windows Sandbox ───────────────────────────────────────────────────────
  if (probe.hasSandboxExe && sandboxState === 1) {
    providers.push({
      provider: 'windows-sandbox', name: 'Windows Sandbox', state: 'usable',
      checkedBy: 'WindowsSandbox.exe exists and the Containers-DisposableClientVM feature is enabled',
      detail: 'Windows Sandbox is available. It gives a throwaway desktop that discards everything when it closes — no saved state, and no way to keep a tool installed between sessions.',
      wouldNeed: null, needsRestart: false, needsLicence: false,
    })
  } else if (sandboxState === 2) {
    providers.push({
      provider: 'windows-sandbox', name: 'Windows Sandbox', state: 'present-but-unusable',
      checkedBy: 'Win32_OptionalFeature Containers-DisposableClientVM reports state 2 (disabled)',
      detail: 'Windows Sandbox is present but turned off.',
      wouldNeed: 'Turning it on needs administrator rights and a restart.',
      needsRestart: true, needsLicence: false,
    })
  } else {
    providers.push({
      provider: 'windows-sandbox', name: 'Windows Sandbox', state: 'absent',
      checkedBy: `Containers-DisposableClientVM reports ${featureWord(sandboxState)}${homeEdition ? ' and this is a Home edition' : ''}`,
      detail: homeEdition
        ? `${probe.osCaption ?? 'This Windows edition'} does not include Windows Sandbox, and WindowsSandbox.exe is not present.`
        : 'Windows Sandbox is not installed on this machine.',
      wouldNeed: homeEdition
        ? 'An upgrade to Windows Pro or Enterprise, which is a purchase. After that, enabling it needs administrator rights and a restart.'
        : 'Enabling it needs administrator rights and a restart.',
      needsRestart: true, needsLicence: homeEdition,
    })
  }

  // ── VirtualBox ────────────────────────────────────────────────────────────
  providers.push(probe.vboxPresent
    ? {
      provider: 'virtualbox', name: 'Oracle VirtualBox', state: 'usable',
      checkedBy: 'VBoxManage.exe exists at C:\\Program Files\\Oracle\\VirtualBox',
      detail: 'VirtualBox is installed and can create a virtual machine without touching any Windows feature or restarting.',
      wouldNeed: null, needsRestart: false, needsLicence: false,
    }
    : {
      provider: 'virtualbox', name: 'Oracle VirtualBox', state: 'absent',
      checkedBy: 'VBoxManage.exe was not found at C:\\Program Files\\Oracle\\VirtualBox',
      detail: 'VirtualBox is not installed. It is the cheapest way to get a usable VM on this machine: it is a normal program install, and it does not need a restart or an edition upgrade.',
      wouldNeed: 'Installing VirtualBox (winget package Oracle.VirtualBox, published by Oracle). No restart and no licence needed.',
      needsRestart: false, needsLicence: false,
    })

  // ── VMware Workstation ────────────────────────────────────────────────────
  providers.push(probe.vmwarePresent
    ? {
      provider: 'vmware', name: 'VMware Workstation', state: 'usable',
      checkedBy: 'vmrun.exe exists under the VMware Workstation program folder',
      detail: 'VMware Workstation is installed and can create a virtual machine.',
      wouldNeed: null, needsRestart: false, needsLicence: false,
    }
    : {
      provider: 'vmware', name: 'VMware Workstation', state: 'absent',
      checkedBy: 'vmrun.exe was not found in either VMware Workstation program folder',
      detail: 'VMware Workstation is not installed. Its licence is paid, so it is not a default choice here.',
      wouldNeed: 'Buying a licence and installing it. Goga will not choose this for you.',
      needsRestart: false, needsLicence: true,
    })

  // ── WSL2 ──────────────────────────────────────────────────────────────────
  if (wslInstalled && (/version:\s*2/i.test(wslText) || /WSL\s*:\s*\d/.test(wslText))) {
    providers.push({
      provider: 'wsl2', name: 'WSL2', state: 'usable',
      checkedBy: 'wsl.exe --status and wsl.exe -l -v answered with a version',
      detail: 'WSL2 is working. It runs a Linux distribution, not a Windows desktop, and its files live inside its own virtual disk.',
      wouldNeed: null, needsRestart: false, needsLicence: false,
    })
  } else {
    // State 2 is disabled (the component is there but off). State 3 means it is not on the
    // machine, which is a different answer and is reported as such.
    providers.push({
      provider: 'wsl2', name: 'WSL2', state: wslState === 2 ? 'present-but-unusable' : 'absent',
      checkedBy: `wsl.exe answered "not installed", and Microsoft-Windows-Subsystem-Linux reports ${featureWord(wslState)}`,
      detail: wslState === 2
        ? 'The WSL optional component is present but turned off, and wsl.exe reports it is not installed.'
        : 'WSL is not installed on this machine; wsl.exe reports no subsystem.',
      wouldNeed: 'Running "wsl --install" with administrator rights, which turns on two Windows features and needs a restart.',
      needsRestart: true, needsLicence: false,
    })
  }

  const usable = providers.filter(p => p.state === 'usable').map(p => p.provider)

  const summary = buildSummary(usable, providers, probe, capacity, homeEdition, readFailed)

  return {
    readAt: new Date().toISOString(),
    os: `${probe.osCaption ?? 'Windows'} (build ${probe.osBuild ?? 'unknown'})`,
    hypervisorPresent: probe.hypervisorPresent === true,
    firmwareVirtualisationEnabled: probe.firmwareVirt === true,
    hardwareSupportsVirtualisation: probe.firmwareVirt === true,
    capacity,
    providers,
    usable,
    summary,
  }
}

function buildSummary(
  usable: VirtualisationProvider[],
  providers: ProviderReading[],
  probe: Probe,
  capacity: MachineCapacity,
  homeEdition: boolean,
  readFailed: boolean,
): string {
  if (readFailed) {
    return 'Goga could not read this machine\'s virtualisation state, so it will not claim any provider is available. Nothing was created.'
  }
  const parts: string[] = []
  if (usable.length) {
    const names = providers.filter(p => p.state === 'usable').map(p => p.name)
    parts.push(`${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} usable right now.`)
  } else {
    parts.push('No virtual machine provider on this machine can create a VM right now.')
  }
  if (homeEdition) {
    parts.push(
      'This is a Windows Home edition, which has no Hyper-V and no Windows Sandbox at all — turning either on needs an edition upgrade, which is a purchase decision.',
    )
  }
  const installable = providers.filter(p => p.state === 'absent' && !p.needsLicence && p.provider === 'virtualbox')
  if (installable.length && !usable.includes('virtualbox')) {
    parts.push(
      'VirtualBox is not installed but is the cheapest route: a normal program install, no restart needed, and no Windows feature involved.',
    )
  }
  if (capacity.memoryGb) {
    parts.push(
      `This machine has ${capacity.cpuCores} physical cores / ${capacity.logicalProcessors} logical processors and ${capacity.memoryGb} GB of RAM.`,
    )
  }
  return parts.join(' ')
}
