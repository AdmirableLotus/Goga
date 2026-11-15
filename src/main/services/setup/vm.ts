import type {
  VirtualisationProvider, VirtualisationReport, VmProposal, VmProposalResult, VmResources,
} from '../../../shared/setup'
import { INSTALL_TTL_MS } from '../../../shared/setup'
import { SingleUseGate } from '../approval/singleUse'
import { auditSetup } from './store'
import { nanoid } from '../../utils/nanoid'

/**
 * Proposing a virtual machine, and creating one only after the user approved that exact
 * proposal.
 *
 * The rules this file keeps:
 *
 *   - Nothing is downloaded or created to make a proposal. A proposal is a description.
 *   - The approval is bound to provider + name + image + resources. Change any of them and
 *     the approval no longer matches.
 *   - Goga will not enable a Windows feature, and will not create a VM on a provider the
 *     detection said is not usable. If nothing is usable, it says so and stops: enabling
 *     Hyper-V or upgrading the edition is the user's decision, not a step to take quietly.
 *   - It never changes an existing VM. The proposal names a new one, and creation is refused
 *     if a VM of that name already exists.
 *
 * A VM is isolation, not authorisation. It keeps work off the user's desktop; it does not
 * make it legal to point at somebody else's machine.
 */

export const vmGate = new SingleUseGate<VmProposal>(
  p => [p.provider, p.name, p.image.url, p.resources.cpuCores, p.resources.memoryGb, p.resources.diskGb].join('|'),
  () => Date.now(),
  INSTALL_TTL_MS,
)

/** The base images Goga will propose, each from its vendor's own address. */
export const VM_IMAGES: Record<string, { name: string; url: string; vendorHost: string; verification: string; downloadGb: number }> = {
  'ubuntu-24.04': {
    name: 'Ubuntu 24.04 LTS cloud image (amd64)',
    url: 'https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img',
    vendorHost: 'cloud-images.ubuntu.com',
    verification: 'Ubuntu publishes a SHA256SUMS file beside the image; Goga checks the download against it before use.',
    downloadGb: 0.6,
  },
  'debian-12': {
    name: 'Debian 12 (bookworm) generic cloud image (amd64)',
    url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2',
    vendorHost: 'cloud.debian.org',
    verification: 'Debian publishes SHA512SUMS beside the image; Goga checks the download against it before use.',
    downloadGb: 0.4,
  },
  'kali-linux': {
    name: 'Kali Linux (official pre-built VirtualBox image)',
    url: 'https://cdimage.kali.org/current/',
    vendorHost: 'cdimage.kali.org',
    verification: 'Kali publishes a SHA256SUMS file beside the image; Goga checks the download against it before use.',
    downloadGb: 4.5,
  },
}

/** A sensible default for a small isolated workspace, sized against what the machine has. */
export function defaultResources(report: VirtualisationReport): VmResources {
  const cores = Math.max(1, Math.min(4, Math.floor(report.capacity.cpuCores / 2) || 1))
  const memory = Math.max(2, Math.min(8, Math.floor(report.capacity.memoryGb / 4) || 2))
  return { cpuCores: cores, memoryGb: memory, diskGb: 40 }
}

export interface ProposeVmInput {
  /** Why a VM is the right place for this work. */
  purpose: string
  /** What it will be used for, in the user's task terms. */
  usedFor: string
  /** A short name. Lower-case letters, digits and dashes. */
  name?: string
  /** Which base image, by key in VM_IMAGES. */
  image?: string
  /** Which provider. Defaults to the first usable one. */
  provider?: VirtualisationProvider
  resources?: Partial<VmResources>
}

/** A name a person can say, and that a hypervisor will accept. */
export function normaliseVmName(raw: string | undefined): string {
  const base = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (base) return base.slice(0, 40)
  return `goga-vm-${new Date().toISOString().slice(0, 10)}`
}

/**
 * Work out a VM proposal.
 *
 * Refuses, with no approval offered, when no provider is usable, when the named provider is
 * not usable, or when the image is not one Goga knows a vendor address for.
 */
export function proposeVm(input: ProposeVmInput, report: VirtualisationReport): VmProposalResult {
  if (!report.usable.length) {
    const wouldNeed = report.providers
      .filter(p => p.state !== 'usable')
      .map(p => `${p.name}: ${p.wouldNeed ?? 'not available'}`)
    auditSetup('vm-refusal', `refused to propose a VM: no usable provider on this machine (${report.usable.join(', ') || 'none'})`)
    return {
      ok: false,
      refused: true,
      proposal: null,
      message: [
        'Goga will not propose a virtual machine, because nothing on this machine can create one right now.',
        '',
        report.summary,
        '',
        'What each provider would need:',
        ...wouldNeed.map(w => `  - ${w}`),
        '',
        'Enabling a Windows feature needs a restart, and on a Home edition it needs an edition upgrade first. '
        + 'Both are your decision, not a step Goga takes quietly. Tell me which one you want and I will walk you through it.',
      ].join('\n'),
    }
  }

  const provider = input.provider ?? report.usable[0]
  if (!report.usable.includes(provider)) {
    const reading = report.providers.find(p => p.provider === provider)
    auditSetup('vm-refusal', `refused to propose a VM on ${provider}: not usable (${reading?.detail ?? 'no reading'})`)
    return {
      ok: false,
      refused: true,
      proposal: null,
      message: [
        `${reading?.name ?? provider} cannot create a virtual machine on this machine right now.`,
        reading?.detail ?? '',
        reading?.wouldNeed ? `What it would need: ${reading.wouldNeed}` : '',
        '',
        `Usable right now: ${report.usable.join(', ')}.`,
      ].filter(Boolean).join('\n'),
    }
  }

  const imageKey = input.image ?? 'ubuntu-24.04'
  const image = VM_IMAGES[imageKey]
  if (!image) {
    return {
      ok: false,
      refused: false,
      proposal: null,
      message: `Goga has no vendor address for the image "${imageKey}". Known images: ${Object.keys(VM_IMAGES).join(', ')}.`,
    }
  }

  const defaults = defaultResources(report)
  const resources: VmResources = {
    cpuCores: clamp(input.resources?.cpuCores ?? defaults.cpuCores, 1, Math.max(1, report.capacity.cpuCores)),
    memoryGb: clamp(input.resources?.memoryGb ?? defaults.memoryGb, 1, Math.max(1, Math.floor(report.capacity.memoryGb - 4))),
    diskGb: clamp(input.resources?.diskGb ?? defaults.diskGb, 10, 500),
  }

  const name = normaliseVmName(input.name)
  const changes = [
    `Creates a new virtual machine called "${name}" on ${report.providers.find(p => p.provider === provider)?.name ?? provider}.`,
    `Downloads ${image.name} from ${image.url} (about ${image.downloadGb} GB) and verifies it against the vendor's checksum file.`,
    `Takes ${resources.cpuCores} CPU core${resources.cpuCores === 1 ? '' : 's'}, ${resources.memoryGb} GB of RAM and ${resources.diskGb} GB of disk while it exists.`,
    'Does not change, start, stop or delete any virtual machine that already exists.',
    'Does not enable any Windows feature and does not restart the machine.',
  ]

  const proposal: VmProposal = {
    id: nanoid(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + INSTALL_TTL_MS).toISOString(),
    provider,
    name,
    purpose: input.purpose || 'work that should not run on the user\'s own desktop',
    usedFor: input.usedFor || 'an isolated workspace',
    image: { ...image },
    resources,
    changes,
    status: 'proposed',
    approved: false,
  }

  vmGate.offer(proposal)
  auditSetup('vm-proposal', `proposed VM "${name}" on ${provider} with ${image.name}, ${resources.cpuCores} CPU / ${resources.memoryGb} GB RAM / ${resources.diskGb} GB disk for: ${proposal.usedFor}`)

  return {
    ok: true,
    refused: false,
    proposal,
    message: [
      `Proposed: a virtual machine called "${name}" on ${provider}.`,
      `Base image: ${image.name} — ${image.url}`,
      `Resources: ${resources.cpuCores} CPU core${resources.cpuCores === 1 ? '' : 's'}, ${resources.memoryGb} GB RAM, ${resources.diskGb} GB disk.`,
      `For: ${proposal.usedFor}`,
      '',
      'Nothing has been downloaded or created. Approve this exact proposal to create it, or discard it.',
      '',
      'A virtual machine is isolation, not authorisation. It keeps this work off your desktop; it does not make it legal to point at anyone else\'s system.',
    ].join('\n'),
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

export function decideVm(proposalId: string, approved: boolean): { ok: boolean; message: string; proposal: VmProposal | null } {
  const result = vmGate.decide(proposalId, approved, {
    unknown: 'That is not a VM Goga proposed. Propose it again.',
    spent: 'That VM has already been created. It works once.',
    expired: 'That proposal expired before it was approved. Nothing was created.',
    approved: 'Approved. This exact virtual machine, once.',
    denied: 'Discarded. Nothing was downloaded or created.',
  })
  if (result.item) {
    result.item.approved = true
    result.item.status = 'approved'
    auditSetup('vm-approval', `approved creating VM "${result.item.name}" on ${result.item.provider}`)
  } else if (!approved) {
    auditSetup('denial', `discarded the proposal to create VM ${proposalId}`)
  }
  return { ok: result.ok, message: result.message, proposal: result.item }
}

/**
 * Create an approved VM.
 *
 * The gate is claimed first, so an unapproved proposal never reaches a command. This task
 * does not create a VM: the function exists so the approval binding is real and testable, and
 * it refuses rather than pretending when the provider's creation path is not implemented.
 */
export async function createVm(proposalId: string): Promise<{ ok: boolean; message: string }> {
  const claim = vmGate.claim(proposalId, undefined, {
    unknown: 'That is not a VM Goga proposed. Nothing was created.',
    spent: 'That VM has already been created. Nothing was created a second time.',
    notApproved: 'This VM has not been approved. Nothing was downloaded or created.',
    expired: 'That proposal expired before it was approved. Nothing was created.',
    changed: 'That proposal changed after it was approved, so nothing was created. Propose it again.',
  })
  if (!claim.ok || !claim.item) {
    auditSetup('vm-refusal', `refused to create VM ${proposalId}: ${claim.message}`)
    return { ok: false, message: claim.message }
  }
  const proposal = claim.item
  auditSetup('vm-refusal', `approved VM "${proposal.name}" was not created: the creation step for ${proposal.provider} is not implemented in this build`)
  return {
    ok: false,
    message: [
      `The approval for "${proposal.name}" was accepted, but Goga does not yet have a creation step for ${proposal.provider} in this build, so nothing was downloaded and no VM was created.`,
      '',
      'The approval is spent. When the creation step is added, the same proposal has to be made and approved again.',
    ].join('\n'),
  }
}

export function listVmProposals(): VmProposal[] {
  return vmGate.list().map(p => p.item)
}
