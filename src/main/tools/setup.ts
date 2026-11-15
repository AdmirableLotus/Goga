import { ToolRegistry } from './registry'
import { readCatalogue, describeCatalogue, findInstalled } from '../services/setup/catalogue'
import { decideInstall, listProposals, proposeInstall, runInstall } from '../services/setup/install'
import { detectVirtualisation } from '../services/setup/virtualisation'
import { createVm, decideVm, listVmProposals, proposeVm, VM_IMAGES } from '../services/setup/vm'
import { readSetupAudit } from '../services/setup/store'

/**
 * Setup tools: what is installed, what Goga would install, and what virtualisation this
 * machine actually has.
 *
 * The split that matters:
 *   - reading the catalogue, the virtualisation report and the audit is free;
 *   - proposing an install or a VM changes nothing and is free;
 *   - approving is the user's, through the page or the approval prompt;
 *   - running an install or creating a VM is `critical`, so the agent loop's approval gate
 *     stops it every time, and it additionally refuses unless the single-use gate holds a
 *     matching approval for that exact package or VM.
 *
 * Installing a tool is not permission to use it against anyone's system, and a VM is
 * isolation, not authorisation. Both sentences are in the tool output, not just here.
 */

const reg = ToolRegistry.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

reg.register({
  name: 'setup.catalogue',
  description: 'Read what is already installed on this machine: winget\'s own list, the Windows uninstall registry, PATH and Program Files. Use this before proposing any install, so Goga does not propose something already present. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      check: { type: 'string', description: 'Optional program name to check for, e.g. "nmap". Reports whether it is already installed and where.' },
    },
  },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  try {
    const catalogue = await readCatalogue()
    if (p.check) {
      const found = findInstalled(catalogue, String(p.check))
      if (!found.length) {
        return { success: true, data: `${p.check} is not in the catalogue. Sources read: winget ${catalogue.wingetAvailable ? 'answered' : 'did not answer'}, registry ${catalogue.counts.registry} rows, PATH ${catalogue.counts.path} executables, Program Files ${catalogue.counts['program-files']} folders.${catalogue.gaps.length ? `\nGaps: ${catalogue.gaps.join(' ')}` : ''}` }
      }
      return { success: true, data: found.map(f => `${f.name}${f.version ? ` ${f.version}` : ''} — found via ${f.source}${f.locatedAt ? ` at ${f.locatedAt}` : ''}${f.packageId ? ` [${f.packageId}]` : ''}`).join('\n') }
    }
    return { success: true, data: describeCatalogue(catalogue) }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'setup.proposeInstall',
  description: 'Work out an install for a program a task needs, and show the user exactly what would be installed: the package, the source, the version and what it changes. Downloads and runs NOTHING. Prefers winget; falls back to the vendor\'s own download address. Refuses outright for a Toolbox "never" tool, and refuses if the program is already installed. The user then approves that exact install.',
  parameters: {
    type: 'object',
    properties: {
      package: { type: 'string', description: 'The program to install, e.g. "nmap", "7zip.7zip", "Oracle.VirtualBox".' },
      task: { type: 'string', description: 'The task that needs it, in the user\'s words.' },
      why: { type: 'string', description: 'Why this program does that job.' },
      withoutIt: { type: 'string', description: 'What Goga cannot do without it.' },
      vendorUrl: { type: 'string', description: 'Only when there is no winget entry: the vendor\'s own https download address. A mirror or search-result link is refused.' },
      version: { type: 'string', description: 'Optional exact version to pin.' },
    },
    required: ['package', 'task'],
  },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  try {
    const catalogue = await readCatalogue()
    const result = await proposeInstall({
      package: String(p.package ?? ''),
      task: String(p.task ?? ''),
      why: p.why ? String(p.why) : undefined,
      withoutIt: p.withoutIt ? String(p.withoutIt) : undefined,
      vendorUrl: p.vendorUrl ? String(p.vendorUrl) : undefined,
      version: p.version ? String(p.version) : undefined,
    }, catalogue)
    if (!result.ok) return { success: false, error: result.message }
    const proposal = result.proposal!
    return {
      success: true,
      data: [
        result.message,
        '',
        `Proposal id: ${proposal.id}`,
        `Package: ${proposal.packageId}${proposal.version ? ` ${proposal.version}` : ''}`,
        `Source: ${proposal.source.kind} — ${proposal.source.where}`,
        `What it changes:`,
        ...proposal.impact.changes.map(c => `  - ${c}`),
        proposal.impact.needsElevation ? 'This installer is expected to ask for administrator rights. Goga will stop and tell you what to click rather than elevating on its own.' : '',
        proposal.carriesSecurityVerdict
          ? `\nToolbox verdict: ${proposal.verdict}. Installing it does not authorise running it at anyone's system — the program's scope and rules still decide that.`
          : '',
        '',
        'Nothing has been downloaded or run. The user approves this exact install on the Setup page, or here.',
      ].filter(Boolean).join('\n'),
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'setup.approveInstall',
  description: 'Record the user\'s decision about one exact install proposal. Only call this after the user has said yes to that specific proposal, naming the package. Approving binds to that package, source and version; changing any of them voids it.',
  parameters: {
    type: 'object',
    properties: {
      proposalId: { type: 'string', description: 'The proposal id from setup.proposeInstall.' },
      approved: { type: 'boolean', description: 'True to approve this exact install, false to discard it.' },
    },
    required: ['proposalId', 'approved'],
  },
  riskLevel: 'high', reversible: true, category: 'system',
}, async p => {
  const result = decideInstall(String(p.proposalId ?? ''), p.approved === true)
  return result.ok
    ? { success: true, data: result.message }
    : { success: false, error: result.message }
})

reg.register({
  name: 'setup.runInstall',
  description: 'Carry out an install the user has already approved. Refuses unless the single-use gate holds a matching approval for that exact package, source and version. If the installer needs administrator rights, it stops and says exactly what to click instead of elevating.',
  parameters: {
    type: 'object',
    properties: {
      proposalId: { type: 'string', description: 'The approved proposal id.' },
    },
    required: ['proposalId'],
  },
  riskLevel: 'critical', reversible: false, category: 'system',
}, async p => {
  try {
    const result = await runInstall(String(p.proposalId ?? ''))
    return result.ok
      ? { success: true, data: `${result.message}\n\n${result.output}`.trim() }
      : { success: false, error: `${result.message}\n\n${result.output}`.trim() }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'setup.installs',
  description: 'List the install proposals Goga is holding: what was proposed, whether it was approved, and whether it was carried out.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'system',
}, async () => {
  const proposals = listProposals()
  if (!proposals.length) return { success: true, data: 'No install has been proposed.' }
  return {
    success: true,
    data: proposals.map(p => `${p.id} [${p.status}] ${p.displayName}${p.version ? ` ${p.version}` : ''} from ${p.source.kind} (${p.source.where}) — for: ${p.purpose.task}`).join('\n'),
  }
})

reg.register({
  name: 'setup.virtualisation',
  description: 'Report what virtualisation is actually available on this machine: Hyper-V, Windows Sandbox, VirtualBox, VMware and WSL2, each with how it was checked, whether it is usable, and what it would need. Read-only: enables nothing, downloads nothing, creates nothing.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'system',
}, async () => {
  try {
    const report = await detectVirtualisation()
    return {
      success: true,
      data: [
        `${report.os}`,
        report.summary,
        '',
        `CPU: ${report.capacity.cpuCores} cores / ${report.capacity.logicalProcessors} logical processors. RAM: ${report.capacity.memoryGb} GB.`,
        `Free disk: ${Object.entries(report.capacity.freeDiskGb).map(([d, gb]) => `${d} ${gb} GB`).join(', ') || 'not read'}.`,
        `Hypervisor running: ${report.hypervisorPresent ? 'yes' : 'no'}. CPU virtualisation enabled in firmware: ${report.firmwareVirtualisationEnabled ? 'yes' : 'no'}.`,
        '',
        ...report.providers.map(p => [
          `${p.name} — ${p.state}`,
          `  Checked by: ${p.checkedBy}`,
          `  ${p.detail}`,
          p.wouldNeed ? `  Would need: ${p.wouldNeed}` : '',
          p.needsRestart ? '  Needs a restart.' : '',
          p.needsLicence ? '  Needs a paid licence or edition upgrade.' : '',
        ].filter(Boolean).join('\n')),
        '',
        `Usable right now: ${report.usable.length ? report.usable.join(', ') : 'none'}.`,
      ].join('\n'),
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'setup.proposeVm',
  description: 'Propose a virtual machine for work that should not run on the user\'s own desktop: a named purpose, the base image and its vendor address, the CPU/RAM/disk it takes, and what it changes. Creates and downloads NOTHING. Refuses when no provider on this machine is usable, and never enables a Windows feature.',
  parameters: {
    type: 'object',
    properties: {
      purpose: { type: 'string', description: 'Why a VM is the right place for this work.' },
      usedFor: { type: 'string', description: 'What it will be used for, in the user\'s words.' },
      name: { type: 'string', description: 'Optional short name, e.g. "bounty-recon-01".' },
      image: { type: 'string', description: `Base image key: ${Object.keys(VM_IMAGES).join(', ')}. Default ubuntu-24.04.` },
      provider: { type: 'string', description: 'Optional provider: hyper-v, windows-sandbox, virtualbox, vmware, wsl2. Defaults to the first usable one.' },
      cpuCores: { type: 'number', description: 'Optional CPU cores.' },
      memoryGb: { type: 'number', description: 'Optional RAM in GB.' },
      diskGb: { type: 'number', description: 'Optional disk in GB.' },
    },
    required: ['purpose', 'usedFor'],
  },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  try {
    const report = await detectVirtualisation()
    const result = proposeVm({
      purpose: String(p.purpose ?? ''),
      usedFor: String(p.usedFor ?? ''),
      name: p.name ? String(p.name) : undefined,
      image: p.image ? String(p.image) : undefined,
      provider: p.provider ? String(p.provider) as never : undefined,
      resources: {
        cpuCores: p.cpuCores ? Number(p.cpuCores) : undefined,
        memoryGb: p.memoryGb ? Number(p.memoryGb) : undefined,
        diskGb: p.diskGb ? Number(p.diskGb) : undefined,
      },
    }, report)
    if (!result.ok) return { success: false, error: result.message }
    const proposal = result.proposal!
    return {
      success: true,
      data: [
        result.message,
        '',
        `Proposal id: ${proposal.id}`,
        `What it changes:`,
        ...proposal.changes.map(c => `  - ${c}`),
      ].join('\n'),
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'setup.approveVm',
  description: 'Record the user\'s decision about one exact VM proposal. Only call this after the user has said yes to that specific proposal. Approving binds to the provider, name, image and resources.',
  parameters: {
    type: 'object',
    properties: {
      proposalId: { type: 'string', description: 'The proposal id from setup.proposeVm.' },
      approved: { type: 'boolean', description: 'True to approve this exact VM, false to discard it.' },
    },
    required: ['proposalId', 'approved'],
  },
  riskLevel: 'high', reversible: true, category: 'system',
}, async p => {
  const result = decideVm(String(p.proposalId ?? ''), p.approved === true)
  return result.ok ? { success: true, data: result.message } : { success: false, error: result.message }
})

reg.register({
  name: 'setup.createVm',
  description: 'Create a virtual machine the user has already approved. Refuses unless the single-use gate holds a matching approval for that exact proposal.',
  parameters: {
    type: 'object',
    properties: { proposalId: { type: 'string', description: 'The approved VM proposal id.' } },
    required: ['proposalId'],
  },
  riskLevel: 'critical', reversible: false, category: 'system',
}, async p => {
  try {
    const result = await createVm(String(p.proposalId ?? ''))
    return result.ok ? { success: true, data: result.message } : { success: false, error: result.message }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'setup.vms',
  description: 'List the virtual-machine proposals Goga is holding: what was proposed, whether it was approved, and whether it was created.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'system',
}, async () => {
  const proposals = listVmProposals()
  if (!proposals.length) return { success: true, data: 'No virtual machine has been proposed.' }
  return {
    success: true,
    data: proposals.map(p => `${p.id} [${p.status}] ${p.name} on ${p.provider} — ${p.image.name}, ${p.resources.cpuCores} CPU / ${p.resources.memoryGb} GB / ${p.resources.diskGb} GB — for: ${p.usedFor}`).join('\n'),
  }
})

reg.register({
  name: 'setup.audit',
  description: 'The setup audit trail: every install and VM proposal, approval, refusal and completed install, with the time.',
  parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many recent entries (default 40).' } } },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  const entries = readSetupAudit(Number(p.limit) || 40)
  if (!entries.length) return { success: true, data: 'The setup audit log is empty.' }
  return { success: true, data: entries.map(e => `${e.time.slice(0, 19).replace('T', ' ')} [${e.kind}] ${e.detail}`).join('\n') }
})
