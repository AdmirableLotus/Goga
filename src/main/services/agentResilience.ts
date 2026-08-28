/**
 * Agent-loop resilience helpers (pure, dependency-free).
 *
 * Extracted so the loop-guard logic can be unit-tested without instantiating
 * AgentLoop (which pulls in native LLM modules).
 */

export const MAX_EQUIVALENT_FAILURES = 3
export const MAX_RECOVERY = 3
export const OVERALL_TASK_TIMEOUT_MS = 90_000

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
  return nowMs - startMs > budgetMs
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
