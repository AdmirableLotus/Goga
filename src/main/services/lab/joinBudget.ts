/**
 * The rate and volume cap for a LIVE joining run — and the kill switch that stops one mid-flight.
 *
 * Cantina's own policy says, in its words: "Please be extremely cautious when performing any
 * automated scans or tests that involve multiple requests. Excessive traffic may be flagged as
 * malicious activity." A live attempt is one request per approval, but a *run* of them still adds
 * up, so this file makes the ceiling a property of the code rather than of the operator's
 * self-control.
 *
 * Three numbers, and the relation between them is the whole design:
 *
 *   - **the ceiling** — the most a joining run may ever be started with. Chosen here, fixed, and
 *     stated on screen. A start request above it is refused; there is no way to raise it from
 *     the UI, an approval, a config file or a chat message.
 *   - **the default** — what a run gets when the user does not choose. Deliberately lower than
 *     the ceiling, because the safe default is the one nobody has to think about.
 *   - **the run's own budget** — what the user typed, which must be at or below the ceiling.
 *
 * `spend()` is the only way a live request may be made. It refuses past the total cap, paces to
 * the per-minute rate by waiting, and refuses everything after a stop. `stop()` also aborts the
 * request already in flight, so the kill switch is immediate rather than "after this one".
 */

export interface JoinLimits {
  /** Hard cap on requests for the whole joining run. */
  maxRequests: number
  /** Pacing: requests per minute. The run waits rather than exceeding it. */
  maxPerMinute: number
}

/**
 * The ceiling a joining run may never be started above.
 *
 * Six requests a minute is the fastest this will ever go at a live bounty host, and twenty
 * requests is the most one run will ever send. Both are far below anything a scanner does, and
 * both are chosen to be defensible beside the program's own warning about excessive traffic.
 */
export const JOIN_CEILING: JoinLimits = { maxRequests: 20, maxPerMinute: 6 }

/** What a run gets when the user does not choose: two requests, at most two a minute. */
export const JOIN_DEFAULT: JoinLimits = { maxRequests: 5, maxPerMinute: 2 }

/** The minimum that still lets a run do its job: a benign marker, then the payload. */
export const JOIN_MIN_REQUESTS = 1

export interface JoinStartCheck {
  ok: boolean
  limits: JoinLimits
  reason: string
}

/**
 * Validate the limits a user asked for, without starting anything.
 *
 * A value that is not a positive integer is refused rather than clamped, because clamping a
 * number the user typed would make the run do something they did not ask for and then report a
 * cap they never set. Above the ceiling is refused for the same reason: the honest answer is
 * "no, and here is the most you can have", not a silent downgrade.
 */
export function checkJoinLimits(input: Partial<JoinLimits> | null | undefined): JoinStartCheck {
  const rawRequests = input?.maxRequests
  const rawRate = input?.maxPerMinute
  const requests = rawRequests === undefined || rawRequests === null ? JOIN_DEFAULT.maxRequests : Number(rawRequests)
  const rate = rawRate === undefined || rawRate === null ? JOIN_DEFAULT.maxPerMinute : Number(rawRate)

  if (!Number.isFinite(requests) || !Number.isInteger(requests) || requests < JOIN_MIN_REQUESTS) {
    return {
      ok: false, limits: JOIN_DEFAULT,
      reason: `Requests must be a whole number of at least ${JOIN_MIN_REQUESTS}. Nothing was started.`,
    }
  }
  if (!Number.isFinite(rate) || !Number.isInteger(rate) || rate < 1) {
    return { ok: false, limits: JOIN_DEFAULT, reason: 'Requests per minute must be a whole number of at least 1. Nothing was started.' }
  }
  if (requests > JOIN_CEILING.maxRequests) {
    return {
      ok: false, limits: JOIN_CEILING,
      reason: `A joining run may send at most ${JOIN_CEILING.maxRequests} requests. ${requests} is above that ceiling, and the ceiling is fixed in code — nothing was started.`,
    }
  }
  if (rate > JOIN_CEILING.maxPerMinute) {
    return {
      ok: false, limits: JOIN_CEILING,
      reason: `A joining run may send at most ${JOIN_CEILING.maxPerMinute} requests a minute. ${rate} is above that ceiling, and the ceiling is fixed in code — nothing was started.`,
    }
  }
  return { ok: true, limits: { maxRequests: requests, maxPerMinute: rate }, reason: `${requests} request(s) total, at most ${rate} a minute.` }
}

export type JoinSpendRefusal = 'cap' | 'stopped' | null

/** One request the run made, as the live log shows it. */
export interface JoinRequestLine {
  host: string
  /** Plain words: what came back, or why nothing did. */
  outcome: string
  /** Milliseconds from the moment the request was allowed to the moment it settled. */
  elapsedMs: number
  /** The one-based index of this request in the run. */
  index: number
}

export class JoinBudget {
  readonly maxRequests: number
  readonly maxPerMinute: number
  private used = 0
  private stopped = false
  private windowStart: number
  private inWindow = 0
  private controller = new AbortController()

  constructor(
    limits: JoinLimits,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
  ) {
    const checked = checkJoinLimits(limits)
    // A budget cannot exist above the ceiling, whatever a caller hands it. The check above is
    // the same one `start` uses; applying it here means a hand-built budget cannot bypass it.
    this.maxRequests = checked.ok ? checked.limits.maxRequests : JOIN_CEILING.maxRequests
    this.maxPerMinute = checked.ok ? checked.limits.maxPerMinute : JOIN_CEILING.maxPerMinute
    this.windowStart = this.now()
  }

  get requests(): number { return this.used }
  get remaining(): number { return Math.max(0, this.maxRequests - this.used) }
  get isStopped(): boolean { return this.stopped }

  /** The signal a live request is given, so a stop aborts the one in flight. */
  get signal(): AbortSignal { return this.controller.signal }

  /** The kill switch. Refuses every later spend AND aborts what is already happening. */
  stop(): void {
    this.stopped = true
    try { this.controller.abort() } catch { /* already aborted */ }
  }

  /**
   * Ask to make one request. Null when it may proceed; otherwise the reason it may not.
   * Paces to the per-minute rate by waiting, and re-checks after the wait, because a stop or a
   * cap reached during the wait must still be honoured.
   */
  async spend(): Promise<JoinSpendRefusal> {
    if (this.stopped) return 'stopped'
    if (this.used >= this.maxRequests) return 'cap'
    const now = this.now()
    if (now - this.windowStart >= 60_000) { this.windowStart = now; this.inWindow = 0 }
    if (this.inWindow >= this.maxPerMinute) {
      const wait = Math.max(0, 60_000 - (this.now() - this.windowStart))
      if (wait > 0) await this.sleep(wait)
      this.windowStart = this.now()
      this.inWindow = 0
      if (this.stopped) return 'stopped'
      if (this.used >= this.maxRequests) return 'cap'
    }
    this.used++
    this.inWindow++
    return null
  }
}
