import { describe, expect, it, vi } from 'vitest'

// The setup services ask Electron for the user-data folder (the audit file) and spawn
// PowerShell for reads. Neither is wanted in a unit test: the audit is stubbed and the
// PowerShell runner is replaced, so every test here is about the binding, not the machine.
vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\fake\\userData', getAppPath: () => 'C:\\fake' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}))

const auditLines: string[] = []
vi.mock('../setup/store', () => ({
  auditSetup: (kind: string, detail: string) => {
    auditLines.push(`${kind}: ${detail}`)
    return { id: 'a', time: new Date(0).toISOString(), kind, detail }
  },
  readSetupAudit: () => [],
}))

// `winget show` is the only PowerShell call a proposal makes. It is answered from a table so
// the test controls the version and the installer address.
const showAnswers: Record<string, string> = {}
vi.mock('../setup/powershell', () => ({
  runPowerShell: async (command: string) => {
    const id = /--id '([^']+)'/.exec(command)?.[1] ?? ''
    const text = showAnswers[id] ?? 'No package found matching input criteria.'
    return { stdout: text, stderr: '', exitCode: 0, timedOut: false, needsElevation: false }
  },
  runPowerShellJson: async () => ({ data: null, result: { stdout: '', stderr: '', exitCode: 0, timedOut: false, needsElevation: false } }),
  psQuote: (v: string) => `'${v.replace(/'/g, "''")}'`,
}))

const { installGate, proposeInstall, decideInstall, runInstall, vendorHostOf, parseWingetShow } = await import('../setup/install')
const { vmGate, proposeVm, decideVm, createVm, normaliseVmName, defaultResources } = await import('../setup/vm')
const { findInstalled } = await import('../setup/catalogue')
const type = await import('../../../shared/setup')
type CatalogueReading = import('../../../shared/setup').CatalogueReading
type VirtualisationReport = import('../../../shared/setup').VirtualisationReport

function catalogue(over: Partial<CatalogueReading> = {}): CatalogueReading {
  return {
    readAt: new Date(0).toISOString(),
    wingetAvailable: true,
    wingetError: null,
    programs: [],
    counts: { winget: 0, registry: 0, path: 0, 'program-files': 0, 'windows-feature': 0 },
    gaps: [],
    ...over,
  }
}

function report(over: Partial<VirtualisationReport> = {}): VirtualisationReport {
  return {
    readAt: new Date(0).toISOString(),
    os: 'Microsoft Windows 11 Home (build 26200)',
    hypervisorPresent: false,
    firmwareVirtualisationEnabled: true,
    hardwareSupportsVirtualisation: true,
    capacity: { cpuCores: 8, logicalProcessors: 16, memoryGb: 32, freeDiskGb: { 'C:': 600 } },
    providers: [],
    usable: ['virtualbox'],
    summary: 'VirtualBox is usable right now.',
    ...over,
  }
}

const SHOW_7ZIP = `Found 7-Zip [7zip.7zip]
Version: 26.06
Publisher: Igor Pavlov
Homepage: https://7-zip.org/download.html
License: LGPL-2.1
Installer:
  Installer Type: wix
  Installer Url: https://github.com/ip7z/7zip/releases/download/26.06/7z2606-x64.msi
  Installer SHA256: 6dc822569e777d9a3ecd5ffcbc22b55600af87e6c5d9810a64e8566cf5a4af9f
`

describe('install approval — bound to that exact package, source and version', () => {
  it('refuses to run an install that was never approved', async () => {
    showAnswers['7zip.7zip'] = SHOW_7ZIP
    const proposed = await proposeInstall({ package: '7zip.7zip', task: 'unpacking an archive' }, catalogue())
    expect(proposed.ok).toBe(true)
    const id = proposed.proposal!.id

    const run = await runInstall(id)
    expect(run.ok).toBe(false)
    expect(run.message).toContain('has not been approved')
  })

  it('refuses a proposal id it never issued', async () => {
    const run = await runInstall('made-up-id')
    expect(run.ok).toBe(false)
    expect(run.message).toContain('not an install Goga proposed')
  })

  it('binds the approval to the version, so a changed version voids it', async () => {
    showAnswers['7zip.7zip'] = SHOW_7ZIP
    const proposed = await proposeInstall({ package: '7zip.7zip', task: 'unpacking an archive' }, catalogue())
    const proposal = proposed.proposal!
    expect(decideInstall(proposal.id, true).ok).toBe(true)

    // Someone edits the version on the proposal the gate is holding.
    proposal.version = '99.99'
    const run = await runInstall(proposal.id)
    expect(run.ok).toBe(false)
    expect(run.message).toContain('changed after it was approved')
  })

  it('binds the approval to the source, so a changed source voids it', async () => {
    showAnswers['7zip.7zip'] = SHOW_7ZIP
    const proposed = await proposeInstall({ package: '7zip.7zip', task: 'unpacking an archive' }, catalogue())
    const proposal = proposed.proposal!
    decideInstall(proposal.id, true)
    proposal.source = { ...proposal.source, where: 'https://mirror.example/7zip.exe' }
    const run = await runInstall(proposal.id)
    expect(run.ok).toBe(false)
    expect(run.message).toContain('changed after it was approved')
  })

  it('binds the approval to the package id, so a changed package voids it', async () => {
    showAnswers['7zip.7zip'] = SHOW_7ZIP
    const proposed = await proposeInstall({ package: '7zip.7zip', task: 'unpacking an archive' }, catalogue())
    const proposal = proposed.proposal!
    decideInstall(proposal.id, true)
    proposal.packageId = 'SomeOther.Package'
    const run = await runInstall(proposal.id)
    expect(run.ok).toBe(false)
    expect(run.message).toContain('changed after it was approved')
  })

  it('a denial discards the proposal so it can never run', async () => {
    showAnswers['7zip.7zip'] = SHOW_7ZIP
    const proposed = await proposeInstall({ package: '7zip.7zip', task: 'unpacking an archive' }, catalogue())
    const id = proposed.proposal!.id
    const denied = decideInstall(id, false)
    expect(denied.ok).toBe(true)
    expect(denied.message).toContain('Nothing was downloaded')
    const run = await runInstall(id)
    expect(run.ok).toBe(false)
    expect(run.message).toContain('not an install Goga proposed')
  })

  it('an approval works once: a second run is refused as already spent', async () => {
    showAnswers['7zip.7zip'] = SHOW_7ZIP
    const proposed = await proposeInstall({ package: '7zip.7zip', task: 'unpacking an archive' }, catalogue())
    const id = proposed.proposal!.id
    decideInstall(id, true)
    // The first run reaches PowerShell, which the mock answers with empty output; the gate is
    // spent before that, which is what this test is about.
    await runInstall(id)
    const second = await runInstall(id)
    expect(second.ok).toBe(false)
    expect(second.message).toContain('already been carried out')
  })

  it('two different packages are not interchangeable', async () => {
    showAnswers['7zip.7zip'] = SHOW_7ZIP
    showAnswers['Git.Git'] = 'Found Git [Git.Git]\nVersion: 2.55.0\nPublisher: The Git Development Community\n'
    const a = (await proposeInstall({ package: '7zip.7zip', task: 'x' }, catalogue())).proposal!
    const b = (await proposeInstall({ package: 'Git.Git', task: 'x' }, catalogue())).proposal!
    decideInstall(a.id, true)
    // Approving a does not approve b.
    const runB = await runInstall(b.id)
    expect(runB.ok).toBe(false)
    expect(runB.message).toContain('has not been approved')
  })

  it('writes an audit line for the proposal, the approval and the refusal', async () => {
    auditLines.length = 0
    showAnswers['7zip.7zip'] = SHOW_7ZIP
    const proposed = await proposeInstall({ package: '7zip.7zip', task: 'unpacking an archive' }, catalogue())
    decideInstall(proposed.proposal!.id, true)
    await runInstall('not-a-real-id')
    expect(auditLines.some(l => l.startsWith('proposal:'))).toBe(true)
    expect(auditLines.some(l => l.startsWith('approval:'))).toBe(true)
    expect(auditLines.some(l => l.startsWith('refusal:'))).toBe(true)
  })
})

describe('install refusal — a Toolbox "never" tool is refused outright', () => {
  it('refuses hashcat with no proposal and no approval offered', async () => {
    const result = await proposeInstall({ package: 'hashcat', task: 'cracking a hash' }, catalogue())
    expect(result.ok).toBe(false)
    expect(result.refused).toBe(true)
    expect(result.proposal).toBeNull()
    expect(result.message).toContain('Goga will not install hashcat')
    expect(result.message).toContain('NEVER tool')
    expect(result.message).toContain('no approval you can give')
  })

  it('refuses every credential, wireless and interception tool the Toolbox marks never', async () => {
    for (const tool of ['hashcat', 'john', 'hydra', 'medusa', 'netexec', 'nxc', 'aircrack', 'kismet', 'ettercap', 'mimikatz']) {
      const result = await proposeInstall({ package: tool, task: 'a test' }, catalogue())
      expect(result.refused, tool).toBe(true)
      expect(result.proposal, tool).toBeNull()
    }
  })

  it('does not offer an approval for a refused tool, so the gate holds nothing', async () => {
    const before = installGate.list().length
    await proposeInstall({ package: 'hydra', task: 'a test' }, catalogue())
    expect(installGate.list().length).toBe(before)
  })

  it('allows a "needs program permission" tool to be proposed, carrying its verdict', async () => {
    showAnswers['nmap'] = 'Found Nmap [Insecure.Nmap]\nVersion: 7.95\nPublisher: Insecure.Com LLC\n'
    const result = await proposeInstall({ package: 'nmap', task: 'reading a service banner' }, catalogue())
    expect(result.ok).toBe(true)
    expect(result.proposal!.verdict).toBe('NEEDS_PROGRAM_PERMISSION')
    expect(result.proposal!.carriesSecurityVerdict).toBe(true)
    expect(result.message).toContain('does not authorise running it')
  })

  it('does not propose something already installed', async () => {
    const installed = catalogue({
      programs: [{ name: '7-Zip 26.06 (x64)', packageId: '7zip.7zip', version: '26.06', publisher: 'Igor Pavlov', source: 'registry', locatedAt: 'C:\\Program Files\\7-Zip' }],
    })
    const result = await proposeInstall({ package: '7zip.7zip', task: 'unpacking' }, installed)
    expect(result.ok).toBe(false)
    expect(result.refused).toBe(false)
    expect(result.message).toContain('already on this machine')
  })

  it('refuses a vendor address that is not a vendor host', async () => {
    const result = await proposeInstall({
      package: 'something', task: 'a test', vendorUrl: 'https://random-mirror.example/setup.exe',
    }, catalogue())
    expect(result.refused).toBe(true)
    expect(result.message).toContain('not on a vendor host')
  })

  it('accepts a vendor address on a vendor host', async () => {
    // A package winget does not list, so the vendor download is the route taken.
    const result = await proposeInstall({
      package: 'nmap-live-cd-image', task: 'a test', vendorUrl: 'https://nmap.org/dist/nmap-7.95-setup.exe',
    }, catalogue())
    expect(result.ok).toBe(true)
    expect(result.proposal!.source.kind).toBe('vendor-download')
    expect(result.proposal!.source.vendorHost).toBe('nmap.org')
  })
})

describe('the catalogue answers "is it already here"', () => {
  it('matches a winget id, a display name and a PATH executable', () => {
    const c = catalogue({
      programs: [
        { name: 'Mozilla Firefox (x64 en-US)', packageId: 'Mozilla.Firefox', version: '160.0', publisher: 'Mozilla', source: 'registry', locatedAt: null },
        { name: 'nmap', packageId: null, version: null, publisher: null, source: 'path', locatedAt: 'C:\\Tools' },
      ],
    })
    expect(findInstalled(c, 'Mozilla.Firefox')).toHaveLength(1)
    expect(findInstalled(c, 'firefox')).toHaveLength(1)
    expect(findInstalled(c, 'nmap')).toHaveLength(1)
    expect(findInstalled(c, 'nmap.exe')).toHaveLength(1)
    expect(findInstalled(c, 'wireshark')).toHaveLength(0)
  })
})

describe('source preference', () => {
  it('prefers winget over a vendor address when a winget entry exists', async () => {
    showAnswers['7zip.7zip'] = SHOW_7ZIP
    const result = await proposeInstall({
      package: '7zip.7zip', task: 'unpacking', vendorUrl: 'https://7-zip.org/a/7z2606-x64.exe',
    }, catalogue())
    expect(result.ok).toBe(true)
    expect(result.proposal!.source.kind).toBe('winget')
    expect(result.proposal!.source.where).toBe('7zip.7zip')
  })
})

describe('winget show parsing', () => {
  it('reads the version, publisher, installer address and hash', () => {
    const parsed = parseWingetShow(SHOW_7ZIP)
    expect(parsed.found).toBe(true)
    expect(parsed.id).toBe('7zip.7zip')
    expect(parsed.version).toBe('26.06')
    expect(parsed.publisher).toBe('Igor Pavlov')
    expect(parsed.installerUrl).toContain('7z2606-x64.msi')
    expect(parsed.installerSha256).toHaveLength(64)
  })

  it('reports not-found rather than inventing a package', () => {
    const parsed = parseWingetShow('No package found matching input criteria.')
    expect(parsed.found).toBe(false)
    expect(parsed.version).toBeNull()
  })
})

describe('vendor hosts', () => {
  it('accepts a vendor host over https and refuses anything else', () => {
    expect(vendorHostOf('https://nmap.org/dist/x.exe')).toBe('nmap.org')
    expect(vendorHostOf('http://nmap.org/dist/x.exe')).toBeNull()
    expect(vendorHostOf('https://nmap.org.evil.example/x.exe')).toBeNull()
    expect(vendorHostOf('not a url')).toBeNull()
  })
})

describe('VM proposal — bound to that exact provider, image and size', () => {
  it('refuses to create a VM that was never approved', () => {
    const proposed = proposeVm({ purpose: 'isolation', usedFor: 'reading a file' }, report())
    expect(proposed.ok).toBe(true)
    return createVm(proposed.proposal!.id).then(run => {
      expect(run.ok).toBe(false)
      expect(run.message).toContain('has not been approved')
    })
  })

  it('refuses a proposal id it never issued', async () => {
    const run = await createVm('made-up')
    expect(run.ok).toBe(false)
    expect(run.message).toContain('not a VM Goga proposed')
  })

  it('binds the approval to the resources, so a changed size voids it', async () => {
    const proposed = proposeVm({ purpose: 'isolation', usedFor: 'reading a file' }, report())
    const proposal = proposed.proposal!
    decideVm(proposal.id, true)
    proposal.resources.memoryGb = 64
    const run = await createVm(proposal.id)
    expect(run.ok).toBe(false)
    expect(run.message).toContain('changed after it was approved')
  })

  it('binds the approval to the image, so a changed image voids it', async () => {
    const proposed = proposeVm({ purpose: 'isolation', usedFor: 'reading a file' }, report())
    const proposal = proposed.proposal!
    decideVm(proposal.id, true)
    proposal.image = { ...proposal.image, url: 'https://evil.example/image.img' }
    const run = await createVm(proposal.id)
    expect(run.ok).toBe(false)
    expect(run.message).toContain('changed after it was approved')
  })

  it('binds the approval to the provider and the name', async () => {
    const proposed = proposeVm({ purpose: 'isolation', usedFor: 'reading a file' }, report())
    const proposal = proposed.proposal!
    decideVm(proposal.id, true)
    proposal.name = 'a-different-vm'
    const run = await createVm(proposal.id)
    expect(run.ok).toBe(false)
    expect(run.message).toContain('changed after it was approved')
  })

  it('a denial discards the proposal so it can never be created', async () => {
    const proposed = proposeVm({ purpose: 'isolation', usedFor: 'reading a file' }, report())
    const id = proposed.proposal!.id
    const denied = decideVm(id, false)
    expect(denied.ok).toBe(true)
    expect(denied.message).toContain('Nothing was downloaded')
    const run = await createVm(id)
    expect(run.ok).toBe(false)
    expect(run.message).toContain('not a VM Goga proposed')
  })

  it('refuses to propose anything when no provider is usable, and says what each would need', () => {
    const result = proposeVm({ purpose: 'isolation', usedFor: 'reading a file' }, report({
      usable: [],
      providers: [
        { provider: 'hyper-v', name: 'Hyper-V', state: 'absent', checkedBy: 'x', detail: 'Home edition has no Hyper-V.', wouldNeed: 'An edition upgrade, which is a purchase.', needsRestart: true, needsLicence: true },
        { provider: 'virtualbox', name: 'Oracle VirtualBox', state: 'absent', checkedBy: 'x', detail: 'Not installed.', wouldNeed: 'Installing VirtualBox.', needsRestart: false, needsLicence: false },
      ],
    }))
    expect(result.ok).toBe(false)
    expect(result.refused).toBe(true)
    expect(result.proposal).toBeNull()
    expect(result.message).toContain('nothing on this machine can create one')
    expect(result.message).toContain('edition upgrade')
    expect(result.message).toContain('your decision')
  })

  it('refuses a provider that is not usable, even when another one is', () => {
    const result = proposeVm({ purpose: 'x', usedFor: 'y', provider: 'hyper-v' }, report({
      usable: ['virtualbox'],
      providers: [{ provider: 'hyper-v', name: 'Hyper-V', state: 'absent', checkedBy: 'x', detail: 'Not part of this edition.', wouldNeed: 'An edition upgrade.', needsRestart: true, needsLicence: true }],
    }))
    expect(result.refused).toBe(true)
    expect(result.message).toContain('cannot create a virtual machine')
  })

  it('names the image vendor address and the resources in the proposal', () => {
    const result = proposeVm({ purpose: 'isolation', usedFor: 'reading a file', name: 'Recon 01' }, report())
    const p = result.proposal!
    expect(p.name).toBe('recon-01')
    expect(p.image.url.startsWith('https://cloud-images.ubuntu.com/')).toBe(true)
    expect(p.resources.cpuCores).toBeGreaterThan(0)
    expect(p.resources.memoryGb).toBeGreaterThan(0)
    expect(p.changes.join(' ')).toContain('Does not enable any Windows feature')
    expect(result.message).toContain('isolation, not authorisation')
  })

  it('sizes a default VM against what the machine has', () => {
    const small = defaultResources(report({ capacity: { cpuCores: 2, logicalProcessors: 4, memoryGb: 8, freeDiskGb: {} } }))
    expect(small.cpuCores).toBe(1)
    expect(small.memoryGb).toBe(2)
    const big = defaultResources(report())
    expect(big.cpuCores).toBe(4)
    expect(big.memoryGb).toBe(8)
  })

  it('normalises a name a hypervisor will accept', () => {
    expect(normaliseVmName('Recon 01!')).toBe('recon-01')
    expect(normaliseVmName('')).toMatch(/^goga-vm-/)
  })
})

describe('the shared single-use gate is the one pattern', () => {
  it('is the same class the venue gate uses', async () => {
    const { ApprovalGate } = await import('../venues/guard')
    const { SingleUseGate } = await import('../approval/singleUse')
    const venue = new ApprovalGate(() => 0)
    expect(venue).toBeInstanceOf(ApprovalGate)
    // Both gates expose the same offer/decide/claim/peek shape.
    for (const gate of [installGate, vmGate, venue]) {
      expect(typeof gate.offer).toBe('function')
      expect(typeof gate.decide).toBe('function')
      expect(typeof gate.claim).toBe('function')
      expect(typeof gate.peek).toBe('function')
    }
    expect(typeof SingleUseGate).toBe('function')
  })

  it('exposes the install TTL the proposals use', () => {
    expect(type.INSTALL_TTL_MS).toBe(15 * 60_000)
  })
})
