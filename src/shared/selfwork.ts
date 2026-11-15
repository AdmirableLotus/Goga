/**
 * Goga working on its own source code.
 *
 * Reading and searching need no approval. Writing does: a change is first *proposed* —
 * the exact file, the exact before/after text and a diff — and only an explicit approval of
 * that one proposal lets it be applied, once. These types are shared by main and the
 * renderer so the page shows exactly what the gate holds.
 */

export type SelfWorkOperation = 'write' | 'patch' | 'delete'

export type SelfWorkProposalState = 'proposed' | 'approved' | 'applied' | 'refused' | 'expired'

/** One file Goga can see in its own repository. */
export interface RepoFile {
  path: string
  bytes: number
  lines: number
}

export interface RepoRead {
  path: string
  from: number
  to: number
  total: number
  text: string
}

export interface RepoHit {
  path: string
  line: number
  text: string
}

/**
 * A proposed change to one file.
 *
 * `before` and `after` are the whole file body, not a patch, because they are what makes
 * the approval checkable: the diff the user reads is computed from them, and the fingerprint
 * the gate binds to is computed from them.
 */
export interface SelfWorkProposal {
  id: string
  /** Repo-relative, forward slashes, e.g. src/main/services/browser/layer.ts */
  path: string
  operation: SelfWorkOperation
  /** One or two sentences: what changes and why, in Goga's words. */
  summary: string
  before: string
  after: string
  /** Unified diff of before → after, for the user to read. */
  diff: string
  createdAt: string
  expiresAt: string
  state: SelfWorkProposalState
}

/** What the propose call returns to a caller that must not see whole file bodies. */
export interface SelfWorkProposalView {
  id: string
  path: string
  operation: SelfWorkOperation
  summary: string
  diff: string
  createdAt: string
  expiresAt: string
  state: SelfWorkProposalState
  /** True once the user has approved this exact proposal. */
  approved: boolean
}

/** The result of one of the project's own checks. */
export interface SelfWorkCheck {
  /** The command as it was run, e.g. "npx tsc --noEmit". */
  name: string
  ok: boolean
  exitCode: number
  /** The tail of what the command printed, trimmed to something readable. */
  output: string
  ms: number
  at: string
}

export interface SelfWorkCheckReport {
  ok: boolean
  checks: SelfWorkCheck[]
  /** Plain words: what passed, what failed and what it said. */
  summary: string
}

/** One line of the record: every proposal, approval, refusal and application. */
export interface SelfWorkAuditEntry {
  id: string
  at: string
  kind: 'read' | 'search' | 'propose' | 'approve' | 'refuse' | 'discard' | 'apply' | 'check' | 'revert'
  path: string
  summary: string
  detail: string
}

export interface SelfWorkState {
  /** The repository Goga is working on, as an absolute path. */
  repoRoot: string
  proposals: SelfWorkProposalView[]
  /** Changes already applied, newest first, so the user can see and revert them. */
  applied: SelfWorkProposalView[]
  audit: SelfWorkAuditEntry[]
  /** The last check run, if any. */
  lastCheck: SelfWorkCheckReport | null
}
