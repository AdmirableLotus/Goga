/**
 * M4.1 — Hard task-timeout & cancellation (production TaskTimeoutController).
 *
 * AgentLoop.run() delegates its hard overall-timeout to TaskTimeoutController
 * (see agentLoop.ts). AgentLoop itself can't be imported outside Electron
 * (getMainWindow / native deps), so we test the exact production controller
 * that run() uses, with fake timers and a never-resolving model call driven by
 * the same AbortController wiring run() uses.
 *
 * Proves:
 *   - default runs have no deadline; an explicitly configured 90s timer aborts the active signal
 *   - a hung (never-resolving) call settles promptly after that abort
 *   - timeout is recorded (→ run() maps to task_timeout)
 *   - user Stop aborts WITHOUT marking timedOut (→ run() maps to stopped)
 *   - the timer is cleared on every exit path (no late re-fire)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TaskTimeoutController } from '../agentResilience'

// Finite deadlines remain supported when explicitly requested.
const TEST_TIMEOUT_MS = 90_000

// Mirror the run() model-call contract: never resolves; rejects on abort.
function hungModelCall(signal: AbortSignal): Promise<string> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

describe('M4.1 — TaskTimeoutController (hard timeout & cancellation)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('allows long-running tasks by default without arming a timer', async () => {
    const ac = new AbortController()
    const ctl = new TaskTimeoutController(() => ac.abort())
    ctl.start()
    expect(ctl.armed).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(ac.signal.aborted).toBe(false)
    expect(ctl.timedOut).toBe(false)
    ctl.clear()
  })

  it('user Stop still cancels an unlimited task in flight', async () => {
    const ac = new AbortController()
    const ctl = new TaskTimeoutController(() => ac.abort())
    ctl.start()
    const call = hungModelCall(ac.signal)
    call.catch(() => {})
    await vi.advanceTimersByTimeAsync(300_000)
    ac.abort()
    await expect(call).rejects.toThrow(/abort/i)
    expect(ctl.timedOut).toBe(false)
    ctl.clear()
  })

  it('an explicitly configured 90s timer aborts the active signal and the hung call settles promptly', async () => {
    const ac = new AbortController()
    const ctl = new TaskTimeoutController(() => ac.abort(), TEST_TIMEOUT_MS)
    ctl.start()

    // The model call is hung on the shared signal (exactly like run()).
    const call = hungModelCall(ac.signal)
    let settled = false
    call.catch(() => { settled = true })

    // Before budget: still armed, not aborted, not settled.
    await vi.advanceTimersByTimeAsync(TEST_TIMEOUT_MS - 100)
    expect(ac.signal.aborted).toBe(false)
    expect(settled).toBe(false)

    // Cross the budget → timer fires abort → hung call rejects promptly.
    await vi.advanceTimersByTimeAsync(200)
    expect(ac.signal.aborted).toBe(true)
    expect(ctl.timedOut).toBe(true)
    await expect(call).rejects.toThrow(/abort/i)
    expect(settled).toBe(true)

    ctl.clear()
  })

  it('timedOut is true after timeout (run() maps this to task_timeout)', async () => {
    const ac = new AbortController()
    const ctl = new TaskTimeoutController(() => ac.abort(), TEST_TIMEOUT_MS)
    ctl.start()
    await vi.advanceTimersByTimeAsync(TEST_TIMEOUT_MS + 10)
    expect(ctl.timedOut).toBe(true)
    ctl.clear()
  })

  it('user Stop aborts WITHOUT marking timedOut (run() maps this to stopped)', async () => {
    const ac = new AbortController()
    const ctl = new TaskTimeoutController(() => ac.abort(), TEST_TIMEOUT_MS)
    ctl.start()

    const call = hungModelCall(ac.signal)
    call.catch(() => {})

    // User Stop well before the budget: abort the signal directly + clear timer.
    await vi.advanceTimersByTimeAsync(500)
    ac.abort()          // this is what AgentLoop.stop() does via abortController
    ctl.clear()         // run()'s finally clears the timer

    expect(ac.signal.aborted).toBe(true)
    await expect(call).rejects.toThrow(/abort/i)
    // Crucially: the timeout never fired, so run() will NOT report task_timeout.
    expect(ctl.timedOut).toBe(false)

    // Advancing past the would-be budget must not flip timedOut.
    await vi.advanceTimersByTimeAsync(TEST_TIMEOUT_MS + 1000)
    expect(ctl.timedOut).toBe(false)
  })

  it('timer is cleared on exit — no late re-fire on the Stop path', async () => {
    let abortCalls = 0
    const ctl = new TaskTimeoutController(() => { abortCalls++ }, TEST_TIMEOUT_MS)
    ctl.start()
    await vi.advanceTimersByTimeAsync(500)
    ctl.clear()
    expect(ctl.armed).toBe(false)
    // Past the budget: the cleared timer must not fire.
    await vi.advanceTimersByTimeAsync(TEST_TIMEOUT_MS + 1000)
    expect(abortCalls).toBe(0)
  })

  it('timer is cleared on exit — does not re-fire on the timeout path', async () => {
    let abortCalls = 0
    const ctl = new TaskTimeoutController(() => { abortCalls++ }, TEST_TIMEOUT_MS)
    ctl.start()
    await vi.advanceTimersByTimeAsync(TEST_TIMEOUT_MS + 10)
    expect(abortCalls).toBe(1)
    ctl.clear()
    // Advancing again must not fire a second time.
    await vi.advanceTimersByTimeAsync(TEST_TIMEOUT_MS + 1000)
    expect(abortCalls).toBe(1)
  })

  it('start() is idempotent (only one timer armed)', async () => {
    let abortCalls = 0
    const ctl = new TaskTimeoutController(() => { abortCalls++ }, TEST_TIMEOUT_MS)
    ctl.start()
    ctl.start()
    ctl.start()
    await vi.advanceTimersByTimeAsync(TEST_TIMEOUT_MS + 10)
    expect(abortCalls).toBe(1)
    ctl.clear()
  })
})
