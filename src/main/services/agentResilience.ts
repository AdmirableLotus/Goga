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
