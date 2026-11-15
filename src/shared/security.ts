/**
 * Bug-bounty workspace types.
 *
 * The rule these types exist to enforce: a request against a target is allowed only when
 * (a) an imported program scope says the target is eligible, (b) the user approves that
 * specific request, and (c) the workspace is the active one. Nothing here grants testing
 * rights — the program's own rules do, and the user is responsible for following them.
 */

export type ProgramSource = 'hackerone' | 'bugcrowd' | 'cantina'

export interface ScopeAsset {
  /** The asset exactly as imported: url, wildcard, ip, cidr or other. */
  identifier: string
  assetType: string
  eligibleForSubmission: boolean
  eligibleForBounty: boolean
  maxSeverity: string | null
  instruction: string | null
}

export interface ScopeExclusion {
  category: string
  details: string
}

/** One program as the platform's own directory lists it. No scope is read for this. */
export interface ProgramSummary {
  handle: string
  name: string
  submissionState: string
  offersBounties: boolean
  /** Reports this account has filed. */
  reportsForUser: number
  validReportsForUser: number
  bountyEarnedForUser: number
  /** True when this account has filed a report or accepted an invitation. */
  participating: boolean
}

export interface ProgramList {
  source: ProgramSource
  programs: ProgramSummary[]
  pages: number
  participating: number
  listedAt: string
}

/**
 * What a live call to a platform's API said about the stored credential. This is the only
 * place a connection state comes from: it is set by a real call, never assumed.
 */
export interface PlatformConnection {
  source: ProgramSource
  /**
   * `unchecked` means a token is stored but no live call has judged it yet — never
   * reported as connected or rejected on the strength of the file on disk alone.
   */
  state: 'connected' | 'rejected' | 'expired' | 'not-connected' | 'unchecked' | 'error'
  /** One line in plain words: what happened, and what to do about it. */
  detail: string
  /** The account the credential belongs to, when the platform confirmed it. Never a secret. */
  account: string | null
  checkedAt: string | null
  /** The page where the user creates or replaces the credential. */
  where: string
  /** Every program this account can submit to, when a listing call has run. */
  programs: ProgramSummary[]
  listedAt: string | null
}

export interface ProgramImportResult {
  handle: string
  ok: boolean
  program: ProgramImport | null
  error: string | null
}

export interface ProgramImport {
  id: string
  source: ProgramSource
  handle: string
  name: string
  url: string
  importedAt: string
  policy: string
  submissionState: string
  offersBounties: boolean
  assets: ScopeAsset[]
  exclusions: ScopeExclusion[]
  /** Assets the import deliberately refused to treat as authorized. */
  skipped: string[]
  notes: string
  /**
   * What stands between the user and a first finding, as the program's own page states it.
   * Present for Cantina imports, where the entry bar is the fact that matters most: a
   * $15,500,000 maximum next to a $50 deposit, required KYC and 1,144 existing findings is a
   * different proposition from a $5,000 maximum with no identity check.
   */
  entryBar?: ProgramEntryBar
}

export interface ProgramEntryBar {
  kycRequired: boolean | null
  kycQuote: string | null
  depositUsd: number | null
  findingsSubmitted: number | null
  liveSince: string | null
  assetCount: number | null
  scopeKind: 'web' | 'code-audit' | 'mixed' | 'unknown'
  /** The program's own rule about automated testing, quoted. */
  automatedTestingRule: string | null
  topReward: string | null
  rewards: { severity: string; amount: string }[]
  /** An assessment, labelled as one, of how hard this is to enter. */
  entry: { level: 'open' | 'moderate' | 'crowded' | 'professional'; why: string }
}

export interface ScopeDecision {
  inScope: boolean
  /** The rule that decided it, quoted so the user can check it against the program page. */
  matchedRule: string | null
  reason: string
  /** True when the target is not covered by any rule (a denial, never a maybe). */
  undetermined: boolean
}

export interface Finding {
  id: string
  programId: string
  title: string
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  asset: string
  summary: string
  steps: string
  impact: string
  remediation: string
  evidence: string
  status: 'draft'
  createdAt: string
  updatedAt: string
}

export interface SecurityAuditEntry {
  id: string
  time: string
  kind: 'import' | 'approve' | 'deny' | 'request' | 'blocked' | 'finding' | 'note'
  detail: string
}

export interface ProbeResult {
  ok: boolean
  status: number | null
  url: string | null
  /** Response headers we keep — never cookies or auth. */
  headers: Record<string, string>
  bodyExcerpt: string
  bytes: number
  blockedReason: string | null
}

/** One lesson in the study area. Sources are cited per section, not per claim. */
export interface Lesson {
  id: string
  track: string
  title: string
  minutes: number
  sections: { heading: string; body: string; sources: { title: string; url: string }[] }[]
  /** A question the user should be able to answer before moving on. */
  check: string
}

export interface Curriculum {
  version: string
  note: string
  lessons: Lesson[]
}
