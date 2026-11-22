/**
 * Agent-loop resilience helpers (pure, dependency-free).
 *
 * Extracted so the loop-guard logic can be unit-tested without instantiating
 * AgentLoop (which pulls in native LLM modules).
 */

// Tools that produce irreversible real-world side effects and must not be
// executed twice with identical arguments in the same agent turn.
export const SIDE_EFFECTING_TOOLS = new Set([
  'browser.open', 'browser.openExternal', 'browser.navigate', 'browser.click', 'browser.type',
  'browser.clickByRole', 'browser.evaluate',
  'shell.execute', 'process.start', 'filesystem.write', 'filesystem.delete',
  'computer.click', 'computer.type', 'computer.key',
])

/**
 * Canonicalize params for deduplication: sort object keys, normalise URL
 * trailing slash so "http://x.com" and "http://x.com/" are the same key.
 */
export function canonicalizeParams(params: unknown): string {
  const s = JSON.stringify(params, Object.keys(params as object).sort())
  return s.replace(/(\/")/, '"').replace(/(\/$)/, '')
}

/**
 * Per-turn deduplicator. Blocks a side-effecting tool from executing more than
 * once with the same canonicalized arguments within a single agent run.
 * A new instance must be created for every call to AgentLoop.run().
 */
export class TurnDeduplicator {
  private seen = new Set<string>()

  /** Returns true if this (tool, params) pair has already executed this turn. */
  isDuplicate(tool: string, params: unknown): boolean {
    if (!SIDE_EFFECTING_TOOLS.has(tool)) return false
    return this.seen.has(`${tool}|${canonicalizeParams(params)}`)
  }

  /** Record that this (tool, params) pair has now executed. */
  record(tool: string, params: unknown): void {
    this.seen.add(`${tool}|${canonicalizeParams(params)}`)
  }
}

export const MAX_EQUIVALENT_FAILURES = 3
export const MAX_RECOVERY = 3
// No wall-clock deadline. Individual operations and failure-cycle guards still
// apply, and the user can abort the shared task signal with Stop.
export const OVERALL_TASK_TIMEOUT_MS = Number.POSITIVE_INFINITY

/**
 * Owns the hard overall-timeout timer for a single agent run. When the budget
 * elapses it fires the provided abort callback (which aborts the shared signal,
 * cancelling any in-flight model/tool call) and records that a timeout occurred.
 * The timer MUST be cleared via clear() on every run exit path.
 */
export class TaskTimeoutController {
  private timer: ReturnType<typeof setTimeout> | null = null
  private _timedOut = false

  constructor(private onAbort: () => void, private budgetMs = OVERALL_TASK_TIMEOUT_MS) {}

  /** Arm the hard timeout. Safe to call once per run. */
  start(): void {
    // Never pass Infinity to setTimeout: Node clamps it to a 1ms timeout.
    if (!Number.isFinite(this.budgetMs)) return
    if (this.timer) return
    this.timer = setTimeout(() => {
      this._timedOut = true
      try { this.onAbort() } catch { /* ignore */ }
    }, this.budgetMs)
  }

  /** Clear the timer. Idempotent. Call on EVERY exit path. */
  clear(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  get timedOut(): boolean { return this._timedOut }
  /** True while the timer is still armed (not cleared). */
  get armed(): boolean { return this.timer !== null }
}

/** Build a stable signature for a tool call outcome (tool + params + error). */
export function failureSignature(tool: string, params: unknown, error?: string): string {
  return `${tool}|${JSON.stringify(params).slice(0, 200)}|${(error ?? '').slice(0, 80)}`
}

/** True when the elapsed time exceeds the overall task budget. */
export function isTaskTimedOut(startMs: number, nowMs: number, budgetMs = OVERALL_TASK_TIMEOUT_MS): boolean {
  return Number.isFinite(budgetMs) && nowMs - startMs > budgetMs
}

/**
 * Tracks repeated equivalent failures. record() returns true when the same
 * signature has occurred MAX_EQUIVALENT_FAILURES times (a cycle to break).
 */
export class FailureCycleTracker {
  private counts = new Map<string, number>()
  constructor(private max = MAX_EQUIVALENT_FAILURES) {}

  /** Record a failure; returns true if this signature has now cycled `max` times. */
  record(tool: string, params: unknown, error?: string): boolean {
    const key = failureSignature(tool, params, error)
    const n = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, n)
    return n >= this.max
  }

  count(tool: string, params: unknown, error?: string): number {
    return this.counts.get(failureSignature(tool, params, error)) ?? 0
  }
}

/** What a successful step did, in plain words ("opened https://…"). */
/** Lookups the planner tends to repeat with slightly different inputs instead of moving on. */
export const REPEAT_LIMIT = 4
export function isRepeatableLookup(tool: string): boolean {
  return /^(trading\.(analyze|quote|account|news|plan|journal|backtest)|web\.search|clock\.now|self\.(overview|search|gaps))$/.test(tool)
}

/** What a step returned, in words, for a reply that stops early. */
export function stepOutput(data: unknown): string {
  if (typeof data === 'string') return data.slice(0, 2500)
  if (data && typeof data === 'object' && 'readable' in data) return String((data as { readable: unknown }).readable).slice(0, 2500)
  return JSON.stringify(data ?? '').slice(0, 1200)
}

// ── A precondition is not a retryable error ─────────────────────────────────
//
// A live run spent three approvals on the same refused call: `lab.scan` with a target id that
// had no declaration behind it. "no such declaration" is not a transient failure — repeating
// it with the same input can only fail the same way. These helpers name that class of error
// and give the run the next step to offer instead of another attempt.

/** The preconditions a tool checks before it will act, and the next step when one is missing. */
const PRECONDITION_ERRORS: { test: RegExp; next: string }[] = [
  {
    test: /\bno such declaration\b|\bnot been declared\b|\bis not declared\b|\bundeclared\b|\bno declaration\b/i,
    next: 'This target is not declared, so no Lab tool will accept it. Declare it in Security → Lab ("Declare this target"), '
      + 'or say "declare 192.168.56.10 as my own VM". If you only want to prove an XSS on source you already have, the local '
      + 'WordPress path needs no declaration: say "run the WordPress XSS path on wp-includes/blocks/legacy-widget.php".',
  },
  {
    test: /\bno program\b|\bnot imported\b|\bno active program\b|\bimport a program\b/i,
    next: 'No bug-bounty program is imported, so the scope check has nothing to check against. Import one in Security → Bug bounty first.',
  },
  {
    test: /\bnot approved\b|\bhas not been approved\b|\bno approval\b|\bunapproved\b/i,
    next: 'That request has not been approved. Prepare the exact one and approve it; an approval is single-use and repeating it will not work.',
  },
  {
    test: /\bnot attached\b|\bno browser\b|\battach (?:to )?firefox\b/i,
    next: 'No browser is attached. Open Browser → Attach, or say "start Firefox and attach", and then the run can continue.',
  },
  {
    test: /\bis not a folder\b|\bnot a directory\b|\bno such file\b|\bENOENT\b|\bcannot be read\b|\bdoes not exist\b/i,
    next: 'That path could not be read. If you have a WordPress copy on this machine, tell me its folder — "use C:\\path\\to\\wordpress as my local copy" — and I will read it there.',
  },
]

/** The next step for a precondition failure, or null when this is an ordinary failure. */
export function preconditionNextStep(error: string): string | null {
  const text = String(error ?? '')
  if (!text) return null
  for (const p of PRECONDITION_ERRORS) if (p.test.test(text)) return p.next
  return null
}

/** True when this error is a precondition failure, which must never be retried. */
export function isPreconditionFailure(error: string): boolean {
  return preconditionNextStep(error) !== null
}

/**
 * The failure a step should carry, exactly as the tool reported it.
 *
 * A refusal with no cause is reported as the refusal, word for word. Nothing here guesses why
 * — that guess is what turned "no such declaration" into "it seems there's a typo".
 */
export function refusalText(tool: string, error: unknown): string {
  const text = String(error ?? '').trim()
  return text || `${tool} refused without giving a reason. That is all the result says.`
}

export function describeDone(step: { tool: string; params: Record<string, unknown> }): string {

  const p = step.params ?? {}
  const s = (k: string) => String(p[k] ?? '').slice(0, 200)
  switch (step.tool) {
    case 'browser.open': case 'browser.openExternal': case 'browser.navigate': return `I opened ${s('url')}`
    case 'process.start': return `I started ${s('executable')}`
    case 'shell.execute': return 'I ran the command'
    case 'filesystem.write': return `I saved ${s('path')}`
    case 'browser.click': case 'browser.clickByRole': return 'I clicked it'
    case 'browser.type': return 'I typed it in'
    default: return `${step.tool} worked`
  }
}
