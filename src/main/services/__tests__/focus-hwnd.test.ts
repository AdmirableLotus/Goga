/**
 * focus-hwnd.test.ts
 *
 * Regression tests for exact-HWND targeting in FocusManager.focusGuardedType.
 *
 * All desktop I/O is mocked — no live windows are touched.
 * Tests exercise the logic extracted from focusManager.ts directly so that
 * the DesktopAdapter constructor (which imports native modules) is never called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Minimal stubs ─────────────────────────────────────────────────────────────

// We construct FocusManager with a fake desktop and a silent logger so the
// real DesktopAdapter (nut-js, active-win, PowerShell) is never imported.

interface FakeDesktop {
  activeWindowWithHwnd: ReturnType<typeof vi.fn>
  activeWindow:         ReturnType<typeof vi.fn>
  windowList:           ReturnType<typeof vi.fn>
  windowsByPid:         ReturnType<typeof vi.fn>
  focusWindow:          ReturnType<typeof vi.fn>
  restoreWindow:        ReturnType<typeof vi.fn>
  accessibilityTree:    ReturnType<typeof vi.fn>
  invoke:               ReturnType<typeof vi.fn>
  pidOfHwnd:            ReturnType<typeof vi.fn>
}

function makeDesktop(overrides: Partial<FakeDesktop> = {}): FakeDesktop {
  return {
    activeWindowWithHwnd: vi.fn().mockResolvedValue({ pid: 0, hwnd: 0, title: '' }),
    activeWindow:         vi.fn().mockResolvedValue({ title: '', owner: '', pid: 0 }),
    windowList:           vi.fn().mockResolvedValue([]),
    windowsByPid:         vi.fn().mockResolvedValue([]),
    focusWindow:          vi.fn().mockResolvedValue({ focused: true, title: '' }),
    restoreWindow:        vi.fn().mockResolvedValue({ restored: true }),
    accessibilityTree:    vi.fn().mockResolvedValue([]),
    invoke:               vi.fn().mockResolvedValue({ invoked: true, element: '' }),
    pidOfHwnd:            vi.fn().mockResolvedValue(0),
    ...overrides,
  }
}

const silentLog = { info: vi.fn(), warn: vi.fn() }

// Dynamically import FocusManager and inject the fake desktop via the
// constructor's optional logger parameter, then replace the private field.
// We use Object.assign to bypass TypeScript's private access check.
async function makeFM(desktop: FakeDesktop) {
  const { FocusManager } = await import('../focusManager')
  // Reset the singleton so each test gets a fresh instance.
  ;(FocusManager as unknown as { instance: unknown }).instance = undefined
  const fm = new FocusManager(silentLog)
  Object.assign(fm, { desktop })
  return fm
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TARGET = { pid: 1000, hwnd: 0xABCD, title: 'Notepad' }

function makeTypeFn() {
  let calls = 0
  const fn = vi.fn(async () => { calls++ })
  return { fn, calls: () => calls }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('focusGuardedType — exact HWND targeting', () => {

  beforeEach(() => { vi.clearAllMocks() })

  // 1. Exact live target: HWND and PID both match → allowed, typeFn called once.
  it('T1: exact HWND+PID match allows input and calls typeFn exactly once', async () => {
    const desktop = makeDesktop({
      activeWindowWithHwnd: vi.fn().mockResolvedValue({ pid: TARGET.pid, hwnd: TARGET.hwnd, title: 'Notepad' }),
    })
    const fm = await makeFM(desktop)
    const { fn, calls } = makeTypeFn()

    const result = await fm.focusGuardedType(TARGET, fn)

    expect(result.allowed).toBe(true)
    expect(calls()).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  // 2. Same PID, different HWND → blocked, zero input.
  it('T2: same PID but different HWND dispatches zero input', async () => {
    const desktop = makeDesktop({
      activeWindowWithHwnd: vi.fn().mockResolvedValue({ pid: TARGET.pid, hwnd: 0x9999, title: 'Notepad - doc2' }),
    })
    const fm = await makeFM(desktop)
    const { fn, calls } = makeTypeFn()

    const result = await fm.focusGuardedType(TARGET, fn)

    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/same PID.*different window|multi-window/)
    expect(calls()).toBe(0)
  })

  // 3. Foreground HWND is zero/unavailable → blocked, zero input.
  it('T3: foreground HWND zero/unavailable dispatches zero input', async () => {
    const desktop = makeDesktop({
      activeWindowWithHwnd: vi.fn().mockResolvedValue({ pid: TARGET.pid, hwnd: 0, title: '' }),
    })
    const fm = await makeFM(desktop)
    const { fn, calls } = makeTypeFn()

    const result = await fm.focusGuardedType(TARGET, fn)

    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/hwnd_unavailable/)
    expect(calls()).toBe(0)
  })

  // 4. Target window destroyed; another same-PID window survives.
  //    Initial read: wrong HWND (same PID).
  //    After recovery re-focus: still wrong HWND → blocked, zero input.
  it('T4: target destroyed, same-PID survivor in foreground → zero input', async () => {
    const survivorHwnd = 0x1111
    const desktop = makeDesktop({
      // Both initial and post-recovery reads return the survivor, not the target.
      activeWindowWithHwnd: vi.fn().mockResolvedValue({ pid: TARGET.pid, hwnd: survivorHwnd, title: 'Notepad - other' }),
      windowList: vi.fn().mockResolvedValue([
        { title: 'Notepad - other', owner: 'notepad.exe', pid: TARGET.pid, bounds: { x: 0, y: 0, width: 800, height: 600 } }
      ]),
    })
    const fm = await makeFM(desktop)
    const { fn, calls } = makeTypeFn()

    const result = await fm.focusGuardedType(TARGET, fn)

    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/focus_lost|hwnd_unavailable/)
    expect(calls()).toBe(0)
  })

  // 5. Recovery re-focuses but still lands on wrong HWND → zero input.
  it('T5: recovery re-focuses but wrong HWND persists → zero input', async () => {
    let callCount = 0
    const desktop = makeDesktop({
      // First call: wrong HWND. Second call (after recovery): still wrong.
      activeWindowWithHwnd: vi.fn().mockImplementation(async () => {
        callCount++
        return { pid: TARGET.pid, hwnd: callCount === 1 ? 0x0001 : 0x0002, title: 'Other' }
      }),
      windowList: vi.fn().mockResolvedValue([
        { title: 'Other', owner: 'notepad.exe', pid: TARGET.pid, bounds: { x: 0, y: 0, width: 800, height: 600 } }
      ]),
    })
    const fm = await makeFM(desktop)
    const { fn, calls } = makeTypeFn()

    const result = await fm.focusGuardedType(TARGET, fn)

    expect(result.allowed).toBe(false)
    expect(calls()).toBe(0)
    // activeWindowWithHwnd must have been called at least twice (initial + recovery).
    expect(desktop.activeWindowWithHwnd.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  // 6. Stop (AbortSignal) fires during the recovery sleep → zero input.
  //    The abort is injected inside the recovery focusWindow call so it fires
  //    before the post-recovery HWND re-read, which is the earliest point the
  //    signal can be observed after the initial mismatch.
  it('T6: abort during recovery sleep dispatches zero input', async () => {
    const ac = new AbortController()
    const desktop = makeDesktop({
      // Initial read: wrong HWND → triggers recovery path.
      activeWindowWithHwnd: vi.fn().mockResolvedValue({ pid: TARGET.pid, hwnd: 0x0001, title: 'Other' }),
      windowsByPid: vi.fn().mockResolvedValue([
        { hwnd: TARGET.hwnd, pid: TARGET.pid, title: 'Notepad' },
      ]),
      windowList: vi.fn().mockResolvedValue([
        { title: 'Notepad', owner: 'notepad.exe', pid: TARGET.pid, bounds: { x: 0, y: 0, width: 800, height: 600 } },
      ]),
      activeWindow: vi.fn().mockResolvedValue({ title: 'Notepad', owner: 'notepad.exe', pid: TARGET.pid }),
      // Abort fires while focusWindow is executing (simulates Stop during recovery).
      focusWindow: vi.fn().mockImplementation(async () => {
        ac.abort()
        return { focused: true, title: '' }
      }),
    })
    const fm = await makeFM(desktop)
    const { fn, calls } = makeTypeFn()

    await expect(fm.focusGuardedType(TARGET, fn, ac.signal)).rejects.toThrow(/cancel/)
    expect(calls()).toBe(0)
  })

  // 7. Explicit HWND resolution never falls back to another window.
  //    windowList returns two windows with the same PID; only one matches the
  //    target HWND (by title hint).  The guard must not silently pick the other.
  it('T7: explicit HWND never substitutes another window sharing the same PID', async () => {
    // Foreground is the wrong window (same PID, different HWND).
    const desktop = makeDesktop({
      activeWindowWithHwnd: vi.fn().mockResolvedValue({ pid: TARGET.pid, hwnd: 0xDEAD, title: 'Notepad - wrong' }),
      windowList: vi.fn().mockResolvedValue([
        { title: 'Notepad',       owner: 'notepad.exe', pid: TARGET.pid, bounds: { x: 0, y: 0, width: 800, height: 600 } },
        { title: 'Notepad - wrong', owner: 'notepad.exe', pid: TARGET.pid, bounds: { x: 0, y: 0, width: 800, height: 600 } },
      ]),
    })
    const fm = await makeFM(desktop)
    const { fn, calls } = makeTypeFn()

    const result = await fm.focusGuardedType(TARGET, fn)

    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/focus_lost|hwnd_unavailable/)
    expect(calls()).toBe(0)
  })

  // Extra: missing pid → blocked immediately.
  it('missing pid → blocked, zero input', async () => {
    const fm = await makeFM(makeDesktop())
    const { fn, calls } = makeTypeFn()
    const result = await fm.focusGuardedType({ hwnd: 0xABCD }, fn)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/pid is mandatory/)
    expect(calls()).toBe(0)
  })

  // Extra: missing hwnd → blocked immediately.
  it('missing hwnd → blocked, zero input', async () => {
    const fm = await makeFM(makeDesktop())
    const { fn, calls } = makeTypeFn()
    const result = await fm.focusGuardedType({ pid: 1000 }, fn)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/hwnd is mandatory/)
    expect(calls()).toBe(0)
  })

  // Extra: HWND matches but PID differs — accepted (caller pid is stale).
  // The title check is the actual gate: title 'SomeOtherApp' != expected 'Notepad'.
  it('HWND matches but PID differs (recycled handle) → blocked by title mismatch, zero input', async () => {
    const desktop2 = makeDesktop({
      activeWindowWithHwnd: vi.fn().mockResolvedValue({ pid: 9999, hwnd: TARGET.hwnd, title: 'SomeOtherApp' }),
      pidOfHwnd: vi.fn().mockResolvedValue(8888),
    })
    const fm = await makeFM(desktop2)
    const { fn, calls } = makeTypeFn()

    const result = await fm.focusGuardedType(TARGET, fn)

    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/title.*does not contain|focus_lost/)
    expect(calls()).toBe(0)
  })
})

// ── resolveWindowForHwnd regression tests ────────────────────────────────────
// These exercise focusWindow directly (not focusGuardedType) to verify that
// the Win32 windowsByPid path is used when an explicit HWND is supplied.

describe('focusWindow — resolveWindowForHwnd (explicit HWND path)', () => {

  beforeEach(() => { vi.clearAllMocks() })

  // R1. Two same-PID windows; windowsByPid returns both with distinct HWNDs.
  //     focusWindow must resolve the correct one without needing a title.
  it('R1: resolves correct window among two same-PID windows by HWND alone', async () => {
    const TARGET_HWND = 0xAAAA
    const OTHER_HWND  = 0xBBBB
    const PID = 2000

    const desktop = makeDesktop({
      // windowsByPid returns both windows with real HWNDs.
      windowsByPid: vi.fn().mockResolvedValue([
        { hwnd: OTHER_HWND,  pid: PID, title: 'Notepad - doc1' },
        { hwnd: TARGET_HWND, pid: PID, title: 'Notepad - doc2' },
      ]),
      // After SetForegroundWindow the correct window is in the foreground.
      activeWindow: vi.fn().mockResolvedValue({ title: 'Notepad - doc2', owner: 'notepad.exe', pid: PID }),
      activeWindowWithHwnd: vi.fn().mockResolvedValue({ pid: PID, hwnd: TARGET_HWND, title: 'Notepad - doc2' }),
    })
    const fm = await makeFM(desktop)

    const result = await fm.focusWindow({ pid: PID, hwnd: TARGET_HWND })

    expect(result.success).toBe(true)
    expect(result.verifiedBy).toContain('hwnd-match')
    // windowsByPid must have been called; windowList must NOT have been called
    // (UIAutomation list does not expose HWNDs).
    expect(desktop.windowsByPid).toHaveBeenCalledWith(PID)
    expect(desktop.windowList).not.toHaveBeenCalled()
  })

  // R2. Target HWND is destroyed; the sole surviving same-PID window must NOT
  //     be substituted.  windowsByPid returns only the survivor.
  it('R2: destroyed HWND never resolves to the sole surviving same-PID window', async () => {
    const DESTROYED_HWND = 0xDEAD
    const SURVIVOR_HWND  = 0x1234
    const PID = 3000

    const desktop = makeDesktop({
      windowsByPid: vi.fn().mockResolvedValue([
        { hwnd: SURVIVOR_HWND, pid: PID, title: 'Notepad - survivor' },
        // DESTROYED_HWND is absent — the window no longer exists.
      ]),
    })
    const fm = await makeFM(desktop)

    const result = await fm.focusWindow({ pid: PID, hwnd: DESTROYED_HWND })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })

  // R3. A matching title must not override an explicit HWND mismatch.
  //     windowsByPid returns a window whose title matches but HWND differs.
  it('R3: matching title cannot override explicit HWND mismatch', async () => {
    const REQUESTED_HWND = 0xAAAA
    const ACTUAL_HWND    = 0xBBBB   // same title, different HWND
    const PID = 4000

    const desktop = makeDesktop({
      windowsByPid: vi.fn().mockResolvedValue([
        { hwnd: ACTUAL_HWND, pid: PID, title: 'Notepad' },
      ]),
    })
    const fm = await makeFM(desktop)

    // Request the window by HWND + title; the only candidate has the right
    // title but the wrong HWND.
    const result = await fm.focusWindow({ pid: PID, hwnd: REQUESTED_HWND, title: 'Notepad' })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })

  // R4. Abort fires after the final awaited check (activeWindowWithHwnd) but
  //     before the typeFn call in focusGuardedType.  Zero input must be sent.
  //     We simulate this by aborting inside the last activeWindowWithHwnd mock.
  it('R4: abort after final HWND check prevents input', async () => {
    const ac = new AbortController()
    let hwndCallCount = 0

    const desktop = makeDesktop({
      // First call (initial check): wrong HWND → triggers recovery.
      // Second call (post-recovery): correct HWND, but we abort here.
      activeWindowWithHwnd: vi.fn().mockImplementation(async () => {
        hwndCallCount++
        if (hwndCallCount === 1) return { pid: TARGET.pid, hwnd: 0x0001, title: 'Other' }
        // Abort synchronously before returning the "good" value.
        ac.abort()
        return { pid: TARGET.pid, hwnd: TARGET.hwnd, title: 'Notepad' }
      }),
      windowsByPid: vi.fn().mockResolvedValue([
        { hwnd: TARGET.hwnd, pid: TARGET.pid, title: 'Notepad' },
      ]),
      windowList: vi.fn().mockResolvedValue([
        { title: 'Notepad', owner: 'notepad.exe', pid: TARGET.pid, bounds: { x: 0, y: 0, width: 800, height: 600 } },
      ]),
      activeWindow: vi.fn().mockResolvedValue({ title: 'Notepad', owner: 'notepad.exe', pid: TARGET.pid }),
    })
    const fm = await makeFM(desktop)
    const { fn, calls } = makeTypeFn()

    await expect(fm.focusGuardedType(TARGET, fn, ac.signal)).rejects.toThrow(/cancel/)
    expect(calls()).toBe(0)
  })
})
