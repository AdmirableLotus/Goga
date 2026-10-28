import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'

/**
 * Watches the PC while Goga runs, awake or asleep in the tray, and tells the user about
 * changes that matter for safety: programs set to start with Windows, new apps and
 * background services, Windows Defender detections or protection turned off, USB drives,
 * and new devices on the home network. The first look is the baseline; only changes after
 * it are reported. Nothing leaves the PC.
 */

export interface PcSnapshot {
  startup: string[]
  apps: string[]
  services: string[]
  defender: { realtime: boolean; antivirus: boolean } | null
  threats: string[]          // "detectionId|threat name"
  usb: string[]
  devices: string[]          // "MAC|IP" on the home network
}

export interface GuardianAlert { severity: 'info' | 'warning' | 'danger'; title: string; detail: string }

/** What has been seen before, so each change is reported once. */
export interface GuardianMemory {
  known: { startup: string[]; apps: string[]; services: string[]; threats: string[]; devices: string[] }
  last: { defender: PcSnapshot['defender']; usb: string[] }
}

const CHECK_EVERY_MS = 5 * 60_000
const FIRST_CHECK_MS = 60_000
// Every third check also says hello to each home-network address, so quiet devices show up.
const SWEEP_EVERY_CHECKS = 3
const LIST_IN_ALERT = 3

const SNAPSHOT_SCRIPT = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$startup = @()
foreach ($k in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run') {
  $p = Get-ItemProperty $k
  if ($p) { $startup += $p.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $_.Name } }
}
foreach ($d in [Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup')) {
  if ($d) { $startup += Get-ChildItem $d -File | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object { $_.Name } }
}
$apps = foreach ($k in 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*') {
  Get-ItemProperty $k | Where-Object { $_.DisplayName -and -not $_.SystemComponent } | ForEach-Object { $_.DisplayName }
}
# Per-user services get a new suffix each sign-in ("..._284759c2"); drop it.
$services = Get-CimInstance Win32_Service | ForEach-Object { $_.DisplayName -replace '_[0-9a-f]{5,}$', '' }
$mp = Get-MpComputerStatus
$threats = Get-MpThreatDetection | ForEach-Object { $t = Get-MpThreat -ThreatID $_.ThreatID; "$($_.DetectionID)|$($t.ThreatName)" }
$usb = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | ForEach-Object { "$($_.DeviceID) $($_.VolumeName)".Trim() }
$ifs = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | ForEach-Object { $_.InterfaceIndex } | Sort-Object -Unique)
if ($env:GOGA_SWEEP -eq '1') {
  foreach ($i in $ifs) {
    $a = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $i | Where-Object { $_.PrefixLength -ge 24 -and $_.IPAddress -match '^(192\.168|10|172\.(1[6-9]|2\d|3[01]))\.' } | Select-Object -First 1
    if ($a) {
      $base = ($a.IPAddress -split '\.')[0..2] -join '.'
      $pings = 1..254 | ForEach-Object { (New-Object System.Net.NetworkInformation.Ping).SendPingAsync("$base.$_", 300) }
      try { [void][System.Threading.Tasks.Task]::WaitAll($pings, 3000) } catch { }
    }
  }
}
$devices = Get-NetNeighbor -AddressFamily IPv4 | Where-Object {
  $ifs -contains $_.InterfaceIndex -and $_.State -ne 'Unreachable' -and $_.State -ne 'Permanent' -and $_.LinkLayerAddress -and $_.LinkLayerAddress -ne '00-00-00-00-00-00'
} | ForEach-Object { "$($_.LinkLayerAddress)|$($_.IPAddress)" }
[pscustomobject]@{
  startup = @($startup | Sort-Object -Unique)
  apps = @($apps | Sort-Object -Unique)
  services = @($services | Sort-Object -Unique)
  defender = if ($mp) { [pscustomobject]@{ realtime = [bool]$mp.RealTimeProtectionEnabled; antivirus = [bool]$mp.AntivirusEnabled } } else { $null }
  threats = @($threats)
  usb = @($usb)
  devices = @($devices)
} | ConvertTo-Json -Depth 4 -Compress
`

const mac = (device: string) => device.split('|')[0]
const names = (items: string[]) =>
  items.slice(0, LIST_IN_ALERT).join(', ') + (items.length > LIST_IN_ALERT ? ` and ${items.length - LIST_IN_ALERT} more` : '')

/** Compare a new look at the PC with what was seen before. The first look only sets the baseline. */
export function compareSnapshot(memory: GuardianMemory | undefined, snap: PcSnapshot): { alerts: GuardianAlert[]; memory: GuardianMemory } {
  const next: GuardianMemory = {
    known: {
      startup: [...new Set([...(memory?.known.startup ?? []), ...snap.startup])],
      apps: [...new Set([...(memory?.known.apps ?? []), ...snap.apps])],
      services: [...new Set([...(memory?.known.services ?? []), ...snap.services])],
      threats: [...new Set([...(memory?.known.threats ?? []), ...snap.threats])],
      devices: [...new Set([...(memory?.known.devices ?? []), ...snap.devices.map(mac)])],
    },
    last: { defender: snap.defender, usb: snap.usb },
  }
  if (!memory) return { alerts: [], memory: next }

  const alerts: GuardianAlert[] = []
  const added = (now: string[], before: string[]) => now.filter(x => !before.includes(x))

  const threats = added(snap.threats, memory.known.threats)
  if (threats.length > 0) {
    const threatNames = [...new Set(threats.map(t => t.split('|')[1] || 'unknown threat'))]
    alerts.push({ severity: 'danger', title: 'Windows Defender found a threat', detail: `Detected: ${names(threatNames)}. Open Windows Security → Protection history to see what was done about it.` })
  }
  if (memory.last.defender?.realtime && snap.defender && !snap.defender.realtime) {
    alerts.push({ severity: 'danger', title: 'Real-time protection was turned off', detail: 'Windows Defender is no longer scanning files as they open. If you did not turn it off, turn it back on in Windows Security.' })
  }
  const startup = added(snap.startup, memory.known.startup)
  if (startup.length > 0) {
    alerts.push({ severity: 'warning', title: 'New program set to start with Windows', detail: `${names(startup)}. If you didn't install this, it is worth a look.` })
  }
  const services = added(snap.services, memory.known.services)
  if (services.length > 0) {
    alerts.push({ severity: 'warning', title: `New background service${services.length > 1 ? 's' : ''} installed`, detail: names(services) })
  }
  const devices = snap.devices.filter(d => !memory.known.devices.includes(mac(d)))
  if (devices.length > 0) {
    alerts.push({ severity: 'warning', title: 'New device on your home network', detail: devices.map(d => `${d.split('|')[1]} (${mac(d)})`).slice(0, LIST_IN_ALERT).join(', ') + '. If you don\'t recognise it, check your router\'s device list.' })
  }
  const apps = added(snap.apps, memory.known.apps)
  if (apps.length > 0) {
    alerts.push({ severity: 'info', title: `New app${apps.length > 1 ? 's' : ''} installed`, detail: names(apps) })
  }
  const usb = added(snap.usb, memory.last.usb)
  if (usb.length > 0) {
    alerts.push({ severity: 'info', title: 'USB drive connected', detail: names(usb) })
  }
  return { alerts, memory: next }
}

export function parseSnapshot(raw: string): PcSnapshot {
  const j = JSON.parse(raw)
  const list = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]).filter((x): x is string => typeof x === 'string' && x.length > 0)
  return {
    startup: list(j.startup), apps: list(j.apps), services: list(j.services),
    defender: j.defender && typeof j.defender === 'object' ? { realtime: !!j.defender.realtime, antivirus: !!j.defender.antivirus } : null,
    threats: list(j.threats), usb: list(j.usb), devices: list(j.devices),
  }
}

export interface GuardianDeps {
  dir: string
  onAlert: (alert: GuardianAlert) => void
  enabled: () => boolean
  log: { info: (m: string) => void; warn: (m: string) => void }
}

export class GuardianService {
  private timer: ReturnType<typeof setTimeout> | undefined
  private checks = 0
  private running = false

  constructor(private deps: GuardianDeps) {}

  private get memoryFile() { return path.join(this.deps.dir, 'guardian.json') }

  start(): void {
    if (this.timer) return
    this.deps.log.info('Guardian: watching the PC')
    this.schedule(FIRST_CHECK_MS)
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => { void this.check().finally(() => { if (this.timer) this.schedule(CHECK_EVERY_MS) }) }, ms)
    this.timer.unref?.()
  }

  /** One look at the PC. Never throws. */
  async check(): Promise<GuardianAlert[]> {
    if (this.running || !this.deps.enabled()) return []
    this.running = true
    try {
      const sweep = this.checks++ % SWEEP_EVERY_CHECKS === 0
      const snap = parseSnapshot(await this.snapshot(sweep))
      let memory: GuardianMemory | undefined
      try { memory = JSON.parse(fs.readFileSync(this.memoryFile, 'utf8')) } catch { /* first look */ }
      const result = compareSnapshot(memory, snap)
      fs.writeFileSync(this.memoryFile, JSON.stringify(result.memory), { mode: 0o600 })
      if (!memory) this.deps.log.info(`Guardian: baseline — ${snap.startup.length} startup items, ${snap.apps.length} apps, ${snap.services.length} services, ${snap.devices.length} network devices`)
      for (const alert of result.alerts) {
        this.deps.log.info(`Guardian: ${alert.title} — ${alert.detail}`)
        this.deps.onAlert(alert)
      }
      return result.alerts
    } catch (err) {
      this.deps.log.warn(`Guardian check failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    } finally {
      this.running = false
    }
  }

  private snapshot(sweep: boolean): Promise<string> {
    const script = path.join(this.deps.dir, 'guardian-snapshot.ps1')
    fs.writeFileSync(script, SNAPSHOT_SCRIPT)
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GOGA_SWEEP: sweep ? '1' : '0' } },
        (err, stdout) => err ? reject(err) : resolve(stdout))
    })
  }
}
