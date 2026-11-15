/**
 * What Goga can set up on this machine: programs it does not have, and a virtual machine when
 * a task should not run on the user's own desktop.
 *
 * Two honest framings used throughout, and they are not decoration:
 *   - Installing a tool is not permission to use it against anyone's system. The program's
 *     scope and rules decide what may be pointed at a target, and the Security area's single
 *     pre-approved GET remains the only thing that touches one.
 *   - A virtual machine is isolation, not authorisation. It keeps work off the user's desktop;
 *     it does not make it legal to point at somebody else's machine.
 */

// ── Installed-tool catalogue ───────────────────────────────────────────────────

/** Where a fact about an installed program came from, so the page can say which. */
export type InstallEvidence =
  | 'winget'
  | 'registry'
  | 'path'
  | 'program-files'
  | 'windows-feature'

export interface InstalledProgram {
  /** What the package manager calls it, or the registry display name when unknown. */
  name: string
  /** The id winget knows it by, when this row came from winget. */
  packageId: string | null
  version: string | null
  publisher: string | null
  source: InstallEvidence
  /** Where it was found, so the reading is checkable rather than a claim. */
  locatedAt: string | null
}

export interface CatalogueReading {
  readAt: string
  /** True when winget answered. False means only the registry and PATH were read. */
  wingetAvailable: boolean
  /** Why winget did not answer, when it did not. */
  wingetError: string | null
  programs: InstalledProgram[]
  /** How many rows came from each source, so the page can be honest about coverage. */
  counts: Record<InstallEvidence, number>
  /** Anything that could not be read, in plain words. */
  gaps: string[]
}

// ── Install proposals ──────────────────────────────────────────────────────────

export type InstallSourceKind = 'winget' | 'vendor-download'

/** Where an install comes from, named exactly. Never a search-result link. */
export interface InstallSource {
  kind: InstallSourceKind
  /** The winget package id, or the vendor's own download URL. */
  where: string
  /** The vendor's own domain, for a download, so an unofficial mirror is visibly wrong. */
  vendorHost: string | null
  /** One line on why this source and not another. */
  note: string
}

/** What installing will change, so the user approves a change and not a name. */
export interface InstallImpact {
  /** Rough download size in megabytes when the source states one. */
  downloadMb: number | null
  /** Where the files go. */
  installsTo: string | null
  /** True when the installer is expected to prompt for administrator rights. */
  needsElevation: boolean
  /** Anything it adds or changes beyond its own folder. */
  changes: string[]
}

/** What a package is for, in the user's task terms. */
export interface InstallPurpose {
  /** The task, in the user's own words as far as Goga can tell. */
  task: string
  /** Why this particular package does that job. */
  why: string
  /** What Goga could not do without it. */
  withoutIt: string
}

export type InstallStatus = 'proposed' | 'approved' | 'installed' | 'refused' | 'failed' | 'discarded'

/**
 * One install, worked out but not carried out.
 *
 * The approval is bound to `packageId`, `source` and `version`: change any of them and the
 * approval dies, because they are in the fingerprint.
 */
export interface InstallProposal {
  id: string
  createdAt: string
  expiresAt: string
  /** The winget id, or the vendor's package name when no winget entry exists. */
  packageId: string
  displayName: string
  /** The exact version to be installed, or null when the newest is meant. */
  version: string | null
  source: InstallSource
  impact: InstallImpact
  purpose: InstallPurpose
  /** The Toolbox verdict, when this is a security tool. Null otherwise. */
  verdict: 'ALLOWED_UNDER_SCOPE' | 'NEEDS_PROGRAM_PERMISSION' | 'NEVER' | null
  /** The Toolbox reason, carried so the user sees why a verdict applies. */
  verdictReason: string | null
  /**
   * True when installing this means the user must see, next to the button, that installing
   * it does not authorise running it at anyone's system.
   */
  carriesSecurityVerdict: boolean
  status: InstallStatus
  /** The single-use approval, once the user gives it. */
  approved: boolean
}

/** The answer to a request to install something. */
export interface InstallProposalResult {
  ok: boolean
  /** Plain words: what was proposed, or why nothing was. */
  message: string
  proposal: InstallProposal | null
  /** True when this was refused outright and no approval can be given. */
  refused: boolean
}

export interface InstallRunResult {
  ok: boolean
  message: string
  /** What the installer's own output said, trimmed. */
  output: string
  /** The package manager's exit code, when it ran. */
  exitCode: number | null
}

// ── Virtual machines ──────────────────────────────────────────────────────────

export type VirtualisationProvider = 'hyper-v' | 'windows-sandbox' | 'virtualbox' | 'vmware' | 'wsl2'

export type ProviderState = 'usable' | 'present-but-unusable' | 'absent'

export interface ProviderReading {
  provider: VirtualisationProvider
  name: string
  state: ProviderState
  /** How it was checked, so the reading is checkable rather than a claim. */
  checkedBy: string
  /** What is true, in plain words. */
  detail: string
  /** What it would take to make it usable, when it is not. */
  wouldNeed: string | null
  /** True when making it usable needs a reboot. The user decides that, not Goga. */
  needsRestart: boolean
  /** True when making it usable needs a paid licence or an edition upgrade. */
  needsLicence: boolean
}

export interface MachineCapacity {
  cpuCores: number
  logicalProcessors: number
  memoryGb: number
  /** Free disk by drive letter, in gigabytes. */
  freeDiskGb: Record<string, number>
}

export interface VirtualisationReport {
  readAt: string
  /** The operating system, as reported, so an edition limit is visible. */
  os: string
  hypervisorPresent: boolean
  firmwareVirtualisationEnabled: boolean
  hardwareSupportsVirtualisation: boolean
  capacity: MachineCapacity
  providers: ProviderReading[]
  /** The providers that could actually run a VM right now. Often empty. */
  usable: VirtualisationProvider[]
  /** Plain words about what is and is not possible on this machine. */
  summary: string
}

/** The resources a VM would take. */
export interface VmResources {
  cpuCores: number
  memoryGb: number
  diskGb: number
}

/** Where the base image comes from, named exactly. */
export interface VmImage {
  /** What it is, e.g. "Ubuntu 24.04 LTS cloud image". */
  name: string
  /** The vendor's own address. Never a mirror or a search result. */
  url: string
  vendorHost: string
  /** What the image is verified against when it arrives. */
  verification: string
  /** Rough download size in gigabytes. */
  downloadGb: number | null
}

export interface VmProposal {
  id: string
  createdAt: string
  expiresAt: string
  provider: VirtualisationProvider
  /** A short name a person can say, e.g. "bounty-recon-01". */
  name: string
  /** Why a VM is the right place for this work. */
  purpose: string
  /** What it will be used for, in the user's task terms. */
  usedFor: string
  image: VmImage
  resources: VmResources
  /** Anything creating it changes on the machine beyond the VM's own disk. */
  changes: string[]
  status: InstallStatus
  approved: boolean
}

export interface VmProposalResult {
  ok: boolean
  message: string
  proposal: VmProposal | null
  refused: boolean
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export type SetupAuditKind =
  | 'catalogue'
  | 'proposal'
  | 'refusal'
  | 'approval'
  | 'denial'
  | 'install'
  | 'install-failed'
  | 'vm-proposal'
  | 'vm-approval'
  | 'vm-refusal'

export interface SetupAuditEntry {
  id: string
  time: string
  kind: SetupAuditKind
  detail: string
}

/** Everything the Setup page needs in one read. */
export interface SetupPageState {
  catalogue: CatalogueReading
  virtualisation: VirtualisationReport
  proposals: InstallProposal[]
  vmProposals: VmProposal[]
  audit: SetupAuditEntry[]
}

export const INSTALL_TTL_MS = 15 * 60_000
