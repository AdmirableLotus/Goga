/**
 * notepad-save.test.ts
 *
 * S1 — Successful save: full happy path, content verified from disk.
 * S2 — Stop before save dispatch.
 * S3 — Two Notepad windows sharing a PID and identical titles; only the
 *      unrelated window has a dialog. Assert zero input on the unrelated dialog.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'

// ── Hoisted mock state ────────────────────────────────────────────────────────

const {
  mockFindElement,
  mockFocusGuardedType,
  registry,
  toolOverrides,
  toolCalls,
  executeSlot,
} = vi.hoisted(() => {
  type H = (p: Record<string, unknown>, ctx: { abortSignal?: AbortSignal }) => Promise<{ success: boolean; data?: unknown; error?: string }>
  const registry      = new Map<string, H>()
  const toolOverrides = new Map<string, { success: boolean; data?: unknown; error?: string }>()
  const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = []
  const executeSlot = { fn: null as null | ((n: string, p: Record<string, unknown>, ctx: { abortSignal?: AbortSignal }) => Promise<{ success: boolean; data?: unknown; error?: string }>) }
  return {
    mockFindElement:      vi.fn().mockResolvedValue(null),
    mockFocusGuardedType: vi.fn(),
    registry, toolOverrides, toolCalls, executeSlot,
  }
})

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../adapters/desktop', () => ({
  DesktopAdapter: vi.fn().mockImplementation(() => ({
    findElement:          mockFindElement,
    findOwnedDialogs:     vi.fn().mockResolvedValue([]),
    findElementByHwnd:    vi.fn().mockResolvedValue(null),
    screenshot:           vi.fn(), activeWindow: vi.fn(), windowList: vi.fn(),
    focusWindow:          vi.fn(), windowsByPid: vi.fn(),
    windowByTitleDiff:    vi.fn(), accessibilityTree:    vi.fn(), invoke: vi.fn(),
    pressKey:             vi.fn(), shortcut:             vi.fn(), typeText: vi.fn(),
    focusAndGetForeground: vi.fn().mockResolvedValue({ pid: 0, hwnd: 0, title: '' }),
    activeWindowWithHwnd: vi.fn().mockResolvedValue({ pid: 0, hwnd: 0, title: '' }),
    isWindow:             vi.fn().mockResolvedValue(false),
    postClose:            vi.fn().mockResolvedValue(undefined),
    pidOfHwnd:            vi.fn().mockResolvedValue(0),
    typeIntoHwnd:           vi.fn().mockResolvedValue({ ok: true }),
    saveAsViaMenu:          vi.fn().mockResolvedValue({ ok: true }),
    pressEnterInDialog:     vi.fn().mockResolvedValue({ ok: true }),
    setFilenameInSaveAs:    vi.fn().mockImplementation(async (_h: number, p: string) => ({ ok: true, actual: p })),
  }))
}))
vi.mock('../../services/focusManager', () => ({
  FocusManager: { getInstance: () => ({ focusGuardedType: mockFocusGuardedType }) }
}))

vi.mock('../../tools/registry', () => ({
  ToolRegistry: {
    getInstance: () => ({
      register: (def: { name: string }, handler: (p: Record<string, unknown>, ctx: { abortSignal?: AbortSignal }) => Promise<{ success: boolean; data?: unknown; error?: string }>) => {
        registry.set(def.name, handler)
      },
      execute: (name: string, params: Record<string, unknown>, ctx: { abortSignal?: AbortSignal }) =>
        executeSlot.fn ? executeSlot.fn(name, params, ctx) : defaultExecute(name, params, ctx)
    })
  }
}))

vi.mock('child_process', () => ({ spawn: vi.fn() }))

// ── Import module under test ──────────────────────────────────────────────────

import { fsOps, docsDirOps, hookOps, desktopOps } from '../../tools/notepadSave'

// ── Shared test data ──────────────────────────────────────────────────────────

const FAKE_DOCS = 'C:\\Users\\testuser\\Documents'
// Our owned Notepad window
const WIN    = { hwnd: 0xBEEF, pid: 7777, title: 'Untitled - Notepad' }
// The Save As dialog owned by WIN.hwnd (owner chain: DIALOG -> WIN.hwnd)
const DIALOG = { hwnd: 0xCAFE, pid: WIN.pid, title: 'Save As' }

function defaultToolResponse(name: string): { success: boolean; data?: unknown; error?: string } {
  switch (name) {
    case 'computer.snapshotHwnds':     return { success: true, data: { hwnds: [0x0001, 0x0002] } }
    case 'process.start':              return { success: true, data: { pid: WIN.pid } }
    case 'computer.windowByTitleDiff': return { success: true, data: WIN }
    case 'computer.type':              return { success: true, data: { typed: 'ok' } }
    case 'computer.shortcut':          return { success: true, data: { keys: [] } }
    case 'computer.wait':              return { success: true, data: { found: true, timedOut: false } }
    case 'computer.key':               return { success: true, data: { key: 'Return' } }
    default:                           return { success: true, data: {} }
  }
}

async function defaultExecute(
  name: string, params: Record<string, unknown>, ctx: { abortSignal?: AbortSignal }
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  toolCalls.push({ name, params })
  if (ctx.abortSignal?.aborted) return { success: false, error: 'cancelled' }
  const override = toolOverrides.get(name)
  if (override) { toolOverrides.delete(name); return override }
  return defaultToolResponse(name)
}

// ── Reset between tests ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  toolOverrides.clear()
  toolCalls.length = 0
  executeSlot.fn = null
  mockFindElement.mockResolvedValue(null)
  hookOps.preEnter = null

  Object.assign(fsOps, {
    existsSync:   vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
  })
  Object.assign(docsDirOps, {
    resolve: vi.fn().mockResolvedValue(FAKE_DOCS),
  })
  // Default desktopOps: owner-chain finds exactly DIALOG for WIN.hwnd
  Object.assign(desktopOps, {
    findSaveAsDialog:   vi.fn().mockResolvedValue(DIALOG),
    findDontSave:       vi.fn().mockResolvedValue(null),
    findButtonInDialog: vi.fn().mockResolvedValue(null),
    windowsByPid:       vi.fn().mockResolvedValue([WIN]),
    focusHwnd:          vi.fn().mockResolvedValue(undefined),
    isForeground:       vi.fn().mockResolvedValue(true),
    pidOfHwnd:          vi.fn().mockResolvedValue(WIN.pid),
    typeIntoHwnd:       vi.fn().mockResolvedValue({ ok: true }),
    saveAsViaMenu:      vi.fn().mockResolvedValue({ ok: true }),
    pressEnterInDialog: vi.fn().mockResolvedValue({ ok: true }),
    setFilenameInSaveAs: vi.fn().mockImplementation(async (_hwnd: number, p: string) => ({ ok: true, actual: p })),
    isWindow:           vi.fn().mockResolvedValue(false),
    postClose:          vi.fn().mockResolvedValue(undefined),
  })

  mockFocusGuardedType.mockImplementation(
    async (_t: unknown, fn: () => Promise<void>) => { await fn(); return { allowed: true } }
  )
})

// ── Helper ────────────────────────────────────────────────────────────────────

async function callSaveText(params: Record<string, unknown>, signal?: AbortSignal) {
  const h = registry.get('notepad.saveText')
  if (!h) throw new Error('notepad.saveText not registered')
  return h(params, { abortSignal: signal }) as Promise<{
    success: boolean
    data?: { filePath: string; bytes: number; cleanupWarning?: string }
    error?: string
  }>
}

function destPath(filename: string): string {
  return path.join(FAKE_DOCS, filename)
}

// ── S1: Successful save ───────────────────────────────────────────────────────

describe('S1 — notepad.saveText: successful save with content verification', () => {

  it('S1a: full happy path — returns filePath and bytes; content verified from disk', async () => {
    const TEXT     = 'Hello from Goga test S1'
    const FILENAME = 'goga-test-s1.txt'
    const DEST     = destPath(FILENAME)

    ;(fsOps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(TEXT + '\r\n')

    const result = await callSaveText({ text: TEXT, filename: FILENAME })

    expect(result.success).toBe(true)
    expect(result.data?.filePath).toBe(DEST)
    expect(result.data?.bytes).toBeGreaterThan(0)

    // Call sequence
    const names = toolCalls.map(c => c.name)
    const firstIdx = (n: string) => names.indexOf(n)
    expect(firstIdx('computer.snapshotHwnds')).toBeLessThan(firstIdx('process.start'))
    expect(firstIdx('process.start')).toBeLessThan(firstIdx('computer.windowByTitleDiff'))

    // typeIntoHwnd called once for text only
    const typeCalls = (desktopOps.typeIntoHwnd as ReturnType<typeof vi.fn>).mock.calls
    expect(typeCalls.length).toBe(1)
    expect(typeCalls[0][0]).toBe(WIN.hwnd)
    expect(typeCalls[0][1]).toBe(TEXT)

    // setFilenameInSaveAs called with Notepad HWND and destPath
    expect(desktopOps.setFilenameInSaveAs).toHaveBeenCalledWith(WIN.hwnd, DEST)

    // pressEnterInDialog called with dialog HWND
    expect(desktopOps.pressEnterInDialog).toHaveBeenCalledWith(DIALOG.hwnd)

    expect(fsOps.readFileSync).toHaveBeenCalledWith(DEST, 'utf-8')

    // Owner-chain lookup called with win.hwnd and win.pid
    expect(desktopOps.findSaveAsDialog).toHaveBeenCalledWith(WIN.hwnd, WIN.pid)
  })

  it('S1b: pre-flight rejects if destination already exists — no tools called', async () => {
    ;(fsOps.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const result = await callSaveText({ text: 'x', filename: 'existing.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already exists/)
    expect(toolCalls.length).toBe(0)
  })

  it('S1c: aborts without input when windowByTitleDiff returns null', async () => {
    toolOverrides.set('computer.windowByTitleDiff', { success: false, data: null })
    const result = await callSaveText({ text: 'x', filename: 'goga-ambiguous.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/ambiguous|did not appear/)
    expect(toolCalls.find(c => c.name === 'computer.type')).toBeUndefined()
  })

  it('S1d: aborts before Enter when Replace prompt detected in dialog subtree', async () => {
    Object.assign(desktopOps, {
      findButtonInDialog: vi.fn().mockResolvedValue({
        name: 'Replace', role: 'Button',
        bounds: { x: 0, y: 0, width: 80, height: 30 },
        enabled: true, focused: false, automationId: ''
      }),
    })
    const result = await callSaveText({ text: 'x', filename: 'goga-replace.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Replace prompt/)
    expect(toolCalls.find(c => c.name === 'computer.key' && c.params.key === 'Return')).toBeUndefined()
  })


  it('S1e: fails when disk content does not match typed text', async () => {
    ;(fsOps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('something completely different')
    const result = await callSaveText({ text: 'expected text', filename: 'goga-mismatch.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/mismatch/)
  })

  it('S1f: fails when file is not found on disk after save', async () => {
    ;(fsOps.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('ENOENT') })
    const result = await callSaveText({ text: 'x', filename: 'goga-missing.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found after save/)
  })

  it('S1g: Documents dir resolved via docsDirOps.resolve, not hardcoded', async () => {
    const CUSTOM_DOCS = 'D:\\OneDrive\\Documents'
    ;(docsDirOps.resolve as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOM_DOCS)
    ;(fsOps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('hello\r\n')
    const result = await callSaveText({ text: 'hello', filename: 'goga-onedrive.txt' })
    expect(result.success).toBe(true)
    expect(result.data?.filePath).toBe(path.join(CUSTOM_DOCS, 'goga-onedrive.txt'))
  })

  it('S1h: findSaveAsDialog returns null — tool aborts, zero input dispatched', async () => {
    Object.assign(desktopOps, { findSaveAsDialog: vi.fn().mockResolvedValue(null) })
    const result = await callSaveText({ text: 'x', filename: 'goga-s1h.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Save As dialog did not appear/)
    expect(toolCalls.find(c => c.name === 'computer.key' && c.params.key === 'Return')).toBeUndefined()
  }, 10_000)

  it('S1i: cleanup timeout reported in cleanupWarning, not as failure', async () => {
    // isWindow stays true — simulates window that never closes
    Object.assign(desktopOps, {
      isWindow:     vi.fn().mockResolvedValue(true),
      findDontSave: vi.fn().mockResolvedValue(null),
    })
    ;(fsOps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('x\r\n')
    const result = await callSaveText({ text: 'x', filename: 'goga-s1i.txt' })
    // Save succeeded; cleanup timed out but that is a warning, not a failure
    expect(result.success).toBe(true)
    expect(result.data?.cleanupWarning).toMatch(/still open|timeout/)
    expect(desktopOps.postClose).toHaveBeenCalledWith(WIN.hwnd)
  }, 10_000)
})

// ── S2: Stop before save dispatch ────────────────────────────────────────────

describe('S2 — notepad.saveText: Stop before save dispatch proves no file written', () => {

  it('S2a: abort before process.start — Notepad never launched', async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await callSaveText({ text: 'x', filename: 'goga-preabort.txt' }, ac.signal)
    expect(result.success).toBe(false)
    expect(toolCalls.find(c => c.name === 'process.start')).toBeUndefined()
    expect(fsOps.readFileSync).not.toHaveBeenCalled()
  })

  it('S2b: preEnter hook throws AbortError — Enter never dispatched', async () => {
    const ac = new AbortController()
    hookOps.preEnter = async () => {
      ac.abort()
      const e = new Error('cancelled'); e.name = 'AbortError'; throw e
    }
    const result = await callSaveText({ text: 'Stop test S2b', filename: 'goga-s2b.txt' }, ac.signal)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cancelled/)
    expect(toolCalls.find(c => c.name === 'computer.key' && c.params.key === 'Return')).toBeUndefined()
    expect(fsOps.readFileSync).not.toHaveBeenCalled()
  })

  it('S2e: preEnter hook aborts and returns normally — independent gate blocks Enter', async () => {
    const ac = new AbortController()
    hookOps.preEnter = async () => { ac.abort() /* returns normally */ }
    const result = await callSaveText({ text: 'Stop test S2e', filename: 'goga-s2e.txt' }, ac.signal)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cancelled/)
    expect(toolCalls.find(c => c.name === 'computer.key' && c.params.key === 'Return')).toBeUndefined()
    expect(fsOps.readFileSync).not.toHaveBeenCalled()
  })

  it('S2c: abort during saveAsViaMenu — Enter never dispatched', async () => {
    const ac = new AbortController()
    Object.assign(desktopOps, {
      saveAsViaMenu: vi.fn().mockImplementation(async () => {
        ac.abort()
        return { ok: false, reason: 'cancelled' }
      }),
    })
    const result = await callSaveText({ text: 'Stop test S2c', filename: 'goga-s2c.txt' }, ac.signal)
    expect(result.success).toBe(false)
    expect(desktopOps.pressEnterInDialog).not.toHaveBeenCalled()
    expect(fsOps.readFileSync).not.toHaveBeenCalled()
  })

  it('S2d: abort after dialog found but before path typed — Enter never dispatched', async () => {
    const ac = new AbortController()
    Object.assign(desktopOps, {
      findSaveAsDialog: vi.fn().mockImplementation(async () => { ac.abort(); return DIALOG }),
    })
    const result = await callSaveText({ text: 'Stop test S2d', filename: 'goga-s2d.txt' }, ac.signal)
    expect(result.success).toBe(false)
    expect(toolCalls.find(c => c.name === 'computer.key' && c.params.key === 'Return')).toBeUndefined()
    expect(fsOps.readFileSync).not.toHaveBeenCalled()
  })
})

// ── S3: Two Notepad windows sharing PID and identical titles ──────────────────

describe('S3 — two Notepad windows, same PID, identical titles; only unrelated has a dialog', () => {
  // Scenario: two Notepad windows share PID 7777 and both have title
  // 'Untitled - Notepad'. Our window is WIN (hwnd=0xBEEF). The unrelated
  // window is OTHER (hwnd=0xDEAD). The unrelated window has a Save As dialog
  // (UNRELATED_DIALOG, hwnd=0xF00D) whose owner chain leads to OTHER.hwnd.
  // findSaveAsDialog(WIN.hwnd, WIN.pid) must return null because no dialog's
  // owner chain leads to WIN.hwnd — only to OTHER.hwnd.

  const OTHER           = { hwnd: 0xDEAD, pid: WIN.pid, title: 'Untitled - Notepad' }
  const UNRELATED_DIALOG = { hwnd: 0xF00D, pid: WIN.pid, title: 'Save As' }

  it('S3a: findSaveAsDialog returns null when only unrelated window has a dialog — tool aborts, zero input', async () => {
    // The owner-chain walk finds UNRELATED_DIALOG owned by OTHER.hwnd, not WIN.hwnd.
    // So findSaveAsDialog(WIN.hwnd, WIN.pid) returns null.
    Object.assign(desktopOps, {
      findSaveAsDialog: vi.fn().mockResolvedValue(null),
    })
    const result = await callSaveText({ text: 'x', filename: 'goga-s3a.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Save As dialog did not appear/)
    // No input dispatched to either window
    expect(toolCalls.find(c => c.name === 'computer.type' && c.params.hwnd === UNRELATED_DIALOG.hwnd)).toBeUndefined()
    expect(toolCalls.find(c => c.name === 'computer.key' && c.params.key === 'Return')).toBeUndefined()
    // findSaveAsDialog called with our window's HWND, not the other window's
    expect(desktopOps.findSaveAsDialog).toHaveBeenCalledWith(WIN.hwnd, WIN.pid)
    expect(desktopOps.findSaveAsDialog).not.toHaveBeenCalledWith(OTHER.hwnd, expect.anything())
  }, 10_000)

  it('S3b: findDontSave scoped to win.hwnd — unrelated window\'s Don\'t Save never invoked', async () => {
    // isWindow stays true once then false — simulates window closing after first poll
    let pollCount = 0
    Object.assign(desktopOps, {
      isWindow: vi.fn().mockImplementation(async () => { pollCount++; return pollCount <= 1 }),
      // findDontSave called with WIN.hwnd — returns null (our window has no prompt)
      findDontSave: vi.fn().mockResolvedValue(null),
    })
    ;(fsOps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('x\r\n')
    await callSaveText({ text: 'x', filename: 'goga-s3b.txt' })
    // findDontSave must only be called with WIN.hwnd
    const dontSaveCalls = (desktopOps.findDontSave as ReturnType<typeof vi.fn>).mock.calls
    for (const [hwnd] of dontSaveCalls) {
      expect(hwnd).toBe(WIN.hwnd)
      expect(hwnd).not.toBe(OTHER.hwnd)
    }
    // computer.key('N') must not have been called (no Don't Save prompt)
    expect(toolCalls.find(c => c.name === 'computer.key' && c.params.key === 'N')).toBeUndefined()
  })

  it('S3c: overwrite prompt check scoped to dialog.hwnd — unrelated dialog\'s Replace never touched', async () => {
    // findButtonInDialog called with DIALOG.hwnd — returns null (no Replace in our dialog)
    // The unrelated dialog (UNRELATED_DIALOG.hwnd) is never queried.
    ;(fsOps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('x\r\n')
    await callSaveText({ text: 'x', filename: 'goga-s3c.txt' })
    const btnCalls = (desktopOps.findButtonInDialog as ReturnType<typeof vi.fn>).mock.calls
    for (const [hwnd] of btnCalls) {
      expect(hwnd).toBe(DIALOG.hwnd)
      expect(hwnd).not.toBe(UNRELATED_DIALOG.hwnd)
    }
  })
})

// -- S4: focusHwnd verification and agentLoop terminal behaviour ---------------

describe('S4 - focusHwnd verification and terminal behaviour', () => {
  it('S4a: typeIntoHwnd called for Notepad window with correct text', async () => {
    ;(fsOps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('x\r\n')
    await callSaveText({ text: 'x', filename: 'goga-s4a.txt' })
    expect(desktopOps.typeIntoHwnd).toHaveBeenCalledWith(WIN.hwnd, 'x')
  })

  it('S4b: saveAsViaMenu called for Notepad window', async () => {
    ;(fsOps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('x\r\n')
    await callSaveText({ text: 'x', filename: 'goga-s4b.txt' })
    expect(desktopOps.saveAsViaMenu).toHaveBeenCalledWith(WIN.hwnd)
  })

  it('S4c: failed typeIntoHwnd produces error string and no file read', async () => {
    Object.assign(desktopOps, {
      typeIntoHwnd: vi.fn().mockResolvedValue({ ok: false, reason: 'err:edit_not_found' }),
    })
    const result = await callSaveText({ text: 'x', filename: 'goga-s4c.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/type failed/)
    expect(fsOps.readFileSync).not.toHaveBeenCalled()
  })

  it('S4d: successful save returns filePath and bytes without re-reading or re-saving', async () => {
    const TEXT = 'S4d content'
    const FILENAME = 'goga-s4d.txt'
    const DEST = destPath(FILENAME)
    ;(fsOps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(TEXT + '\r\n')
    const result = await callSaveText({ text: TEXT, filename: FILENAME })
    expect(result.success).toBe(true)
    expect(result.data?.filePath).toBe(DEST)
    expect(result.data?.bytes).toBeGreaterThan(0)
    // readFileSync called exactly once (verification read)
    expect((fsOps.readFileSync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    // typeIntoHwnd called once (text only); setFilenameInSaveAs called once (path)
    expect((desktopOps.typeIntoHwnd as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect(desktopOps.setFilenameInSaveAs).toHaveBeenCalledWith(WIN.hwnd, DEST)
  })
})
