/**
 * The Lab: offensive tools that run only against a target the user has declared.
 *
 * The rule these types exist to enforce, in one sentence: every tool in this file checks a
 * declaration before it starts a process, and a declaration is the user's own statement that
 * they own or are authorised to test the host. Goga cannot verify that statement. It records
 * it, and it refuses anything the statement does not cover.
 *
 * Nothing here is a permission from a bug-bounty program. A program's rules are separate from
 * and stricter than the law, and a declaration is not permission from a program.
 */

/** What the user says the target is. Recorded verbatim; never inferred. */
export type TargetKind =
  | 'local-vm'
  | 'own-server'
  | 'ctf'
  | 'authorized-engagement'
  | 'lab-container'

export const TARGET_KIND_LABEL: Record<TargetKind, string> = {
  'local-vm': 'A virtual machine on this computer',
  'own-server': 'A server I own',
  ctf: 'A CTF or practice range',
  'authorized-engagement': 'A client engagement with written authorisation',
  'lab-container': 'A container or service on this computer',
}

/**
 * One declared target.
 *
 * `host` is exactly what the user typed: a hostname, an IPv4 address, or a CIDR block. The
 * `ports` field narrows what may be touched; empty means every port on that host.
 */
export interface DeclaredTarget {
  id: string
  /** Hostname, IPv4 address or CIDR block, as typed. */
  host: string
  /** Port range as typed, e.g. "1-1024", "80,443,8080". Empty means all ports. */
  ports: string
  kind: TargetKind
  /** The user's own words on what authorises this. Required, and shown back to them. */
  note: string
  declaredAt: string
  revokedAt: string | null
  revokedReason: string | null
}

/** The answer every offensive tool gets before it is allowed to start. */
export interface TargetCheck {
  declared: boolean
  /** The declaration that covered it, when one did. */
  target: DeclaredTarget | null
  /** The host that was checked, normalised. */
  host: string
  /** The port that was checked, when the caller named one. */
  port: number | null
  /** Plain words: why it was allowed, or exactly what was refused and why. */
  reason: string
}

/** A request budget a run may not exceed. Set by the user when the run starts. */
export interface RunBudget {
  /** Hard cap on requests for the whole run. The run stops when it is reached. */
  maxRequests: number
  /** Pacing: requests per minute. The run waits rather than exceeding it. */
  maxPerMinute: number
}

export const DEFAULT_BUDGET: RunBudget = { maxRequests: 200, maxPerMinute: 30 }

/** How long a prepared spray proposal stays approvable before it expires. Ten minutes. */
export const SPRAY_TTL_MS = 600_000

/** One line of a run's log, as it happens. */
export interface RunLogLine {
  time: string
  level: 'info' | 'step' | 'result' | 'warn' | 'error' | 'stop'
  text: string
}

export type RunState = 'running' | 'done' | 'stopped' | 'refused' | 'failed'

/** A run of any offensive tool. One record per invocation. */
export interface LabRun {
  id: string
  /** Which tool: 'portscan', 'nmap', 'nuclei', 'idor', 'spray', 'autopilot', 'payload', ... */
  tool: string
  targetId: string
  targetHost: string
  state: RunState
  startedAt: string
  endedAt: string | null
  budget: RunBudget
  /** Requests actually made. Never above budget.maxRequests. */
  requests: number
  log: RunLogLine[]
  /** Raw tool output, kept so the user can read what the tool actually said. */
  rawOutput: string
  /** Parsed findings, when the tool's output could be parsed. */
  findings: LabFinding[]
  /** Why it stopped, when it did not finish normally. */
  stopReason: string | null
}

/**
 * A finding from a Lab run.
 *
 * `confidence` is the honest part: 'lead' means a difference worth a human look, 'observation'
 * means a response was recorded, and only 'confirmed' means the validator agreed. Nothing in
 * the Lab sets 'confirmed' on its own.
 */
export interface LabFinding {
  id: string
  kind: 'port' | 'service' | 'template' | 'endpoint' | 'idor' | 'username' | 'payload' | 'note'
  title: string
  detail: string
  confidence: 'lead' | 'observation' | 'confirmed'
  /** The exact request or probe that produced it, so it can be reproduced by hand. */
  evidence: string
}

/** One step of the scanner pipeline. */
export type ScanStepId = 'subfinder' | 'portscan' | 'httpx' | 'katana' | 'nuclei' | 'ffuf' | 'nmap'

export interface ScanStepResult {
  step: ScanStepId
  /** True when the step actually ran. False when its binary is missing or it was skipped. */
  ran: boolean
  /** Why it did not run, when it did not. */
  skippedReason: string | null
  /** The exact command line, when an external binary was used. */
  command: string | null
  exitCode: number | null
  output: string
  findings: LabFinding[]
  requests: number
}

export interface ScanResult {
  run: LabRun
  steps: ScanStepResult[]
}

/** IDOR auto-testing: substitute identifier values and compare responses. */
export interface IdorRequest {
  targetId: string
  /** A URL with `{id}` where the identifier goes, e.g. https://host/api/users/{id} */
  urlTemplate: string
  /** The identifier the user is entitled to see, used as the baseline. */
  baselineId: string
  /** Identifiers to try. */
  candidateIds: string[]
  budget?: Partial<RunBudget>
}

export interface IdorComparison {
  id: string
  status: number | null
  bytes: number
  /** How similar the body is to the baseline after the id itself is normalised out, 0..1. */
  similarity: number
  /** True when this differs from the baseline in a way worth a human look. */
  differs: boolean
  why: string
  excerpt: string
}

export interface IdorResult {
  run: LabRun
  baseline: IdorComparison | null
  comparisons: IdorComparison[]
  /** The sentence the UI must show: a difference is a lead, not a confirmed finding. */
  caveat: string
}

/** Credential attack: wordlist, enumeration, spray. */
export interface WordlistRequest {
  base: string
  /** Extra words to include verbatim. */
  extra?: string[]
  /** Add years, digits and common suffixes. */
  mutate?: boolean
  limit?: number
}

export interface EnumerationRequest {
  targetId: string
  /** A URL with `{user}` where the username goes. */
  urlTemplate: string
  usernames: string[]
  budget?: Partial<RunBudget>
}

export interface EnumerationHit {
  username: string
  status: number | null
  bytes: number
  similarityToBaseline: number
  differs: boolean
  why: string
}

export interface EnumerationResult {
  run: LabRun
  baseline: { status: number | null; bytes: number } | null
  hits: EnumerationHit[]
  caveat: string
}

/**
 * A spray proposal. The user approves this exact thing — target, username list and rate —
 * and only then can the spray run. This is the hard stop the reference tool has.
 */
export interface SprayProposal {
  id: string
  createdAt: string
  expiresAt: string
  targetId: string
  targetHost: string
  /** The exact URL the spray will post to. */
  url: string
  /** The exact usernames, in order. */
  usernames: string[]
  /** The exact password list, in order. */
  passwords: string[]
  /** Requests per minute. Part of what the user approves. */
  ratePerMinute: number
  /** Total requests this spray will make: usernames × passwords. */
  totalRequests: number
  approved: boolean
  status: 'proposed' | 'approved' | 'sprayed' | 'refused' | 'failed' | 'discarded'
}

export interface SprayResult {
  run: LabRun
  proposal: SprayProposal
  /** Username/password pairs that produced a response different from the failure baseline. */
  hits: { username: string; password: string; status: number | null; why: string }[]
  caveat: string
}

/** Autopilot: scope → recon → hunt → validate → report, with no human between steps. */
export type AutopilotPhase = 'scope' | 'recon' | 'hunt' | 'validate' | 'report'

export interface AutopilotRequest {
  targetId: string
  /** The URL the hunt phase works on. Must be on the declared target. */
  url: string
  budget?: Partial<RunBudget>
}

export interface AutopilotPhaseResult {
  phase: AutopilotPhase
  startedAt: string
  endedAt: string
  summary: string
  findings: LabFinding[]
  requests: number
}

export interface AutopilotResult {
  run: LabRun
  phases: AutopilotPhaseResult[]
  /** The report text, assembled from what the phases actually found. */
  report: string
}

/** Payload dispatch: send one candidate payload and observe the response. */
export interface PayloadRequest {
  targetId: string
  /** The URL to send to. `{payload}` is replaced with the candidate. */
  urlTemplate: string
  payload: string
  /** A unique marker to look for in the response. */
  marker?: string
  method?: 'GET' | 'POST'
  budget?: Partial<RunBudget>
}

export interface PayloadResult {
  run: LabRun
  status: number | null
  bytes: number
  /** Where the marker came back, when it did. */
  reflection: { found: boolean; occurrences: number; contexts: { context: string; excerpt: string }[]; verdict: string }
  /** Always 'observation': a response is not a finding until the validator confirms it. */
  confidence: 'observation'
  caveat: string
  /** True when the payload came back as live markup a browser would parse, not escaped text. */
  unescaped: boolean
  /** The context the value landed in: element text, an attribute, a script block, or null. */
  context: string | null
  /** True when the payload's own bytes came back, whether escaped or not. */
  payloadEchoed: boolean
}

// ── The live view ──────────────────────────────────────────────────────────

/**
 * The kind of thing a live entry records. One signal per line, and the kind is only there so
 * the line can be coloured — the text always says what happened in plain words.
 *
 *   source    a file was read
 *   specialist a specialist was consulted, and what it said
 *   validator what the independent validator decided, and why
 *   target    a host or URL was checked against a rule
 *   send      something was sent, to which host
 *   response  what came back
 *   browser   the browser was driven: navigated, attached, or could not be reached
 *   verdict   the run's own conclusion
 *   stop      the run stopped or ended
 */
export type LiveKind =
  | 'source' | 'specialist' | 'validator' | 'target'
  | 'send' | 'response' | 'browser' | 'verdict' | 'stop'

/** One line of the live log. Exists only because something occurred. */
export interface LiveEntry {
  id: string
  /** When it happened, ISO 8601. */
  at: string
  kind: LiveKind
  /** What happened, short and plain. */
  label: string
  /** Where or why, when there is more to say. Empty is normal. */
  detail: string
}

/** One real capture of the browser Goga drives. */
export interface LiveFrame {
  /** PNG, base64. */
  base64: string
  /** The address the picture was taken at. */
  url: string
  capturedAt: string
  /** False once the run has ended: the picture is the last real one, not a live view. */
  live: boolean
}

export interface LabLiveState {
  /** True only while a run is actually working. */
  active: boolean
  /** 'wp-xss' | 'payload' | ... — which path is running. Null when idle. */
  runKind: string | null
  /** What is running, in the user's words. */
  label: string
  startedAt: string | null
  endedAt: string | null
  entries: LiveEntry[]
  /** The last real capture, or null when no browser picture has been taken. */
  frame: LiveFrame | null
  /** One sentence: working now, finished, or idle. */
  status: string
}

/** What main pushes to the renderer as a run happens. */
export type LabLiveEvent =
  | { type: 'entry'; entry: LiveEntry; state: LabLiveState }
  | { type: 'frame'; frame: LiveFrame }
  | { type: 'state'; state: LabLiveState }

/** What the Lab page shows at a glance. */
export interface LabState {
  targets: DeclaredTarget[]
  runs: LabRun[]
  /** Which external tools are on PATH right now. */
  tools: { id: ScanStepId; name: string; installed: boolean; path: string | null }[]
  /** True while any offensive process is running. */
  running: boolean
  /** The kill switch's own record: how many processes it has stopped. */
  killed: number
}
