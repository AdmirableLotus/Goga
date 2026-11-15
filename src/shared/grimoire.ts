/**
 * The Grimoire: specialist review, an independent validator, disclosure-derived knowledge and
 * per-program memory.
 *
 * The rule these types exist to enforce:
 *   - a specialist produces a HYPOTHESIS, never a finding;
 *   - a hypothesis is not shown as a finding until the validator has named the exact
 *     observable that would confirm it, on the user's own local copy;
 *   - the validator may answer "cannot be confirmed from what we have", and then the item is
 *     dropped rather than softened;
 *   - nothing in this area sends a request. Reviewing is reading.
 *
 * The only code in Goga that reaches a target is still `probe()` in services/security/probe.ts,
 * behind the single-use grant issued by the Security page.
 */

/* ─────────────────────────── specialists ─────────────────────────── */

export type SpecialistId =
  | 'idor' | 'ssrf' | 'sqli' | 'xss' | 'auth' | 'rce' | 'xxe' | 'ssti'
  | 'secrets' | 'otp' | 'pii' | 'logic' | 'redirect' | 'recon' | 'cors'
  | 'referer' | 'integrity' | 'enumeration'

export interface KbCitation {
  /** The HackerOne report id this observation comes from, e.g. "3931771". */
  reportId: string
  /** The report's own title, exactly as HackerOne's API shows it. */
  title: string
  severity: string | null
  cwe: string | null
  disclosed: string | null
  url: string
  /** True when the report body could not be read, so only its metadata is drawn on. */
  bodyUnread: boolean
}

export interface Specialist {
  id: SpecialistId
  name: string
  /** The bug class in one line, in the program's own vocabulary. */
  bugClass: string
  /** What this specialist argues it would look for, and why it matters. */
  looksFor: string[]
  /** The signals it scans supplied code or a page description for. */
  signals: { label: string; pattern: string; why: string }[]
  /** What evidence on the user's OWN LOCAL copy would confirm a real issue. */
  wouldConfirm: string[]
  /** The honest reasons this specialist must stand down. */
  standDown: string[]
}

/** One specialist's reasoning over one batch of material. Never a finding. */
export interface SpecialistReview {
  specialist: SpecialistId
  name: string
  /** True when this specialist had nothing to say about this material. */
  quiet: boolean
  /** The reasoning, in plain sentences, addressed to the user. */
  reasoning: string
  /** Lines of the supplied material this specialist reacted to. */
  hits: { line: number; label: string; excerpt: string; why: string }[]
  /** `code_audit` for local source, `web` for a page description. */
  material: 'code_audit' | 'web'
  /** How long the specialist was willing to argue before it needs evidence. */
  budget: string
}

/* ─────────────────────────── hypotheses and validation ─────────────────────────── */

export type HypothesisState = 'hypothesis' | 'confirmed-observable' | 'dropped' | 'dead'

/**
 * A specialist's proposal. It is a hypothesis because its author could not test it:
 * the specialist never contacts a target.
 */
export interface Hypothesis {
  id: string
  specialist: SpecialistId
  /** De-duplication key: material location plus issue class. */
  key: string
  title: string
  /** Where in the supplied material. A file path and line, or "page description". */
  location: string
  line: number | null
  excerpt: string
  /** The specialist's argument: what it would look for and why. */
  argument: string
  /** What would have to be true for this to be a real bug. */
  ifTrue: string
  /** Importance ordering: impact first, then how cheap the check is. */
  impact: 'low' | 'medium' | 'high' | 'critical' | 'unrated'
  state: HypothesisState
  /** What the validator said. */
  validation: ValidationVerdict
  /** True when an earlier run raised this same candidate. */
  seenBefore: boolean
  firstSeen: string | null
}

export interface ValidationVerdict {
  /** `confirmed-observable` means the confirming observable is PRESENT in the supplied
   *  material. It does not mean the bug is exploitable — the user still has to reproduce it. */
  outcome: 'confirmed-observable' | 'cannot-confirm' | 'refuted'
  /** The exact observable, quoted from the material, when the outcome is confirmed. */
  observable: string | null
  /** Where the observable is, e.g. "wp-includes/class-wp-http.php:412". */
  observableAt: string | null
  /** Concrete, checkable statements of what would confirm the item locally. */
  wouldConfirm: string[]
  /** Why the item was dropped, in plain words. This refusal is the feature. */
  why: string
  /** The independent check the validator actually ran. */
  check: string
}

/* ─────────────────────────── the 7-question gate ─────────────────────────── */

export type GateOutcome = 'pass' | 'fail' | 'unanswered'

export interface GateQuestion {
  id: string
  /** The question, in the words the user reads. */
  question: string
  /** What a passing answer looks like. */
  passing: string
  /** Why a wrong answer kills the finding. */
  why: string
}

export interface GateAnswer {
  questionId: string
  answer: 'yes' | 'no' | 'unsure' | null
  note: string
}

export interface GateResult {
  hypothesisId: string
  answers: GateAnswer[]
  outcome: GateOutcome
  /** The first question that killed it, quoted, when outcome is fail. */
  killedBy: string | null
  decidedAt: string
}

/* ─────────────────────────── knowledge base ─────────────────────────── */

export interface KnowledgeEntry {
  id: string
  specialist: SpecialistId
  bugClass: string
  /** What the class is, in plain words. */
  what: string
  /** How it is usually fixed. A fix, never a payload. */
  fix: string
  /** The reports this entry is drawn from. */
  citations: KbCitation[]
  /** Stated when part of the source material could not be read. */
  limit: string | null
}

export interface KnowledgeBase {
  version: string
  /** Where every entry's evidence came from. */
  sources: { title: string; url: string; what: string }[]
  note: string
  entries: KnowledgeEntry[]
}

/* ─────────────────────────── memory ─────────────────────────── */

export interface MemoryEntry {
  /** De-duplication key: program + location + issue class. */
  key: string
  programId: string
  programName: string
  specialist: SpecialistId
  title: string
  location: string
  /** What happened last time this candidate came up. */
  outcome: 'raised' | 'dropped' | 'dead' | 'user-confirmed'
  /** Why it ended that way, so a later run does not repeat the argument. */
  reason: string
  firstSeen: string
  lastSeen: string
}

export interface MemorySummary {
  total: number
  dropped: number
  dead: number
  confirmed: number
  raised: number
}

/* ─────────────────────────── reading material well ─────────────────────────── */

export interface SampledText {
  /** The text handed to the specialists. */
  text: string
  /** True when the original was longer and this is a sample. */
  sampled: boolean
  originalChars: number
  /** What was kept, in the order it appears. */
  kept: { region: string; chars: number }[]
  /** Said in the output so nobody mistakes a sample for the whole file. */
  note: string
  /**
   * For each line of `text` (1-based, so index 0 is line 1), the line number in the ORIGINAL
   * text. 0 marks a gap marker, which has no original line.
   *
   * Without this, a hit found at sample line 100 is reported as file line 100, which points
   * at unrelated code. A hypothesis that names the wrong line is worse than one naming none.
   */
  lineMap: number[]
}

export interface HeaderOfInterest {
  name: string
  value: string
  /** Why this header carries signal. */
  why: string
  /** Set when the header looks like it carries a credential or a token. */
  sensitive: boolean
}

export interface JsEndpoint {
  value: string
  kind: 'absolute-url' | 'api-path' | 'relative-path' | 'route-template'
  line: number
  /** Which pattern matched, so the user can see how it was found. */
  via: string
}

/* ─────────────────────────── a review run ─────────────────────────── */

export interface LocalTarget {
  /** Root folder the user pointed Goga at. Nothing outside it is read. */
  root: string
  label: string
  /** Files the reader is allowed to consider, relative to root. */
  files: string[]
  indexedAt: string
  /** What was noticed about the tree, in plain words. */
  findings: string[]
}

export interface ReviewRequest {
  /** Absolute path of one file, or a folder to pick one file from. */
  path: string
  /** Optional: the marker the user injected, to sample around it. */
  marker?: string
  /** Optional: restricting to some specialists. */
  specialists?: SpecialistId[]
  /** The program the review is recorded against, for memory. */
  programId?: string
}

export interface ReviewRun {
  id: string
  startedAt: string
  finishedAt: string
  /** The file that was read, relative to the target root when there is one. */
  read: string
  bytes: number
  /** The sampling decision, so the user can see what the specialists actually saw. */
  sample: { sampled: boolean; originalChars: number; kept: string[]; note: string }
  /** True when a local model added a second opinion; false means deterministic only. */
  modelSecondOpinion: { used: boolean; model: string | null; note: string }
  reviews: SpecialistReview[]
  /** Everything the specialists raised, including the dropped ones. */
  hypotheses: Hypothesis[]
  /** Stated in the UI: this is a review, not a scan, and nothing left the machine. */
  guarantee: string
}
