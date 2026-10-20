/**
 * notepad-save.test.ts
 *
 * S1 — Successful save: full happy path, content verified from disk.
 * S2 — Stop before save dispatch.
 * S3 — Two Notepad windows sharing a PID and identical titles; only the
 *      unrelated window has a dialog. Assert zero input on the unrelated dialog.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { prioritiesText, prioritiesFilename, quotedPrioritiesText, corruptedPrioritiesText } from '../../../shared/__tests__/fixtures/prioritiesNote'

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
    postClose:            vi.fn().mockResolvedValue({requested:true,win32Error:0}),
    pidOfHwnd:            vi.fn().mockResolvedValue(0),
    typeIntoHwnd:           vi.fn().mockResolvedValue({ ok: true }),
    saveAsViaMenu:          vi.fn().mockResolvedValue({ ok: true }),
    pressEnterInDialog:     vi.fn().mockResolvedValue({ ok: true }),
    setFilenameInSaveAs:    vi.fn().mockImplementation(async (_h: number, p: string) => ({ ok: true, actual: p })),
    readFilenameFromSaveAs:  vi.fn().mockResolvedValue({ ok: true, value: '' }),
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

import { fsOps, docsDirOps, hookOps, desktopOps, closeOwnedNotepad } from '../../tools/notepadSave'
import { plannerDiagnostic } from '../plannerDiagnostics'
vi.mock('../plannerDiagnostics', () => ({plannerDiagnostic:vi.fn()}))

// ── Shared test data ──────────────────────────────────────────────────────────

const FAKE_DOCS = 'C:\\Users\\testuser\\Documents'
const WIN    = { hwnd: 0xBEEF, pid: 7777, title: 'Untitled - Notepad' }
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

// ── Default mock factory — call at start of each test ────────────────────────
// Returns fresh counter-based mocks so vi.clearAllMocks() doesn't break them.

function setupDefaultMocks(overrides: {
  readFileContent?: string
  existsAlwaysFalse?: boolean  // S1f: file never appears
  existsAlwaysTrue?: boolean   // S1b: pre-flight fails
} = {}) {
  // findSaveAsDialog: DIALOG on first call (step 7), null after (step 13 poll)
  let findSaveAsCallCount = 0
  // existsSync: false on pre-flight (call 1), true on file poll (call 2+)
  // unless overridden
  let existsSyncCallCount = 0
  // track last path set so readFilenameFromSaveAs can echo it
  let _lastSetPath = ''

  Object.assign(desktopOps, {
    findSaveAsDialog: vi.fn().mockImplementation(async () => {
      findSaveAsCallCount++
      return findSaveAsCallCount === 1 ? DIALOG : null
    }),
    findSaveAsDialogOrThrow: vi.fn().mockResolvedValue(null), // dialog already gone after Enter
    findDontSave:       vi.fn().mockResolvedValue(null),
    findButtonInDialog: vi.fn().mockResolvedValue(null),
    windowsByPid:       vi.fn().mockResolvedValue([WIN]),
    focusHwnd:          vi.fn().mockResolvedValue(undefined),
    isForeground:       vi.fn().mockResolvedValue(true),
    pidOfHwnd:          vi.fn().mockResolvedValue(WIN.pid),
    typeIntoHwnd:       vi.fn().mockResolvedValue({ ok: true }),
    saveAsViaMenu:      vi.fn().mockResolvedValue({ ok: true }),
    pressEnterInDialog: vi.fn().mockResolvedValue({ ok: true }),
    setFilenameInSaveAs: vi.fn().mockImplementation(async (_hwnd: number, p: string) => { _lastSetPath = p; return { ok: true, actual: p } }),
    readFilenameFromSaveAs: vi.fn().mockImplementation(async (_hwnd: number) => ({ ok: true, value: _lastSetPath })),
    isWindow:           vi.fn().mockResolvedValue(false),
    postClose:          vi.fn().mockResolvedValue({requested:true,win32Error:0}),
  })

  Object.assign(fsOps, {
    existsSync: vi.fn().mockImplementation(() => {
      if (overrides.existsAlwaysTrue) return true
      if (overrides.existsAlwaysFalse) return false
      existsSyncCallCount++
      return existsSyncCallCount > 1  // false on pre-flight, true on file poll
    }),
    readFileSync: vi.fn().mockReturnValue(overrides.readFileContent ?? ''),
  })
}

// ── Reset between tests ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  toolOverrides.clear()
  toolCalls.length = 0
  executeSlot.fn = null
  mockFindElement.mockResolvedValue(null)
  hookOps.preEnter = null

  Object.assign(docsDirOps, {
    resolve: vi.fn().mockResolvedValue(FAKE_DOCS),
  })

  mockFocusGuardedType.mockImplementation(
    async (_t: unknown, fn: () => Promise<void>) => { await fn(); return { allowed: true } }
  )
})

afterEach(() => vi.useRealTimers())

// ── Helper ────────────────────────────────────────────────────────────────────

async function callSaveText(params: Record<string, unknown>, signal?: AbortSignal) {
  const h = registry.get('notepad.saveText')
  if (!h) throw new Error('notepad.saveText not registered')
  return h(params, { abortSignal: signal ?? new AbortController().signal }) as Promise<{
    success: boolean
    data?: { filePath: string; bytes: number; cleanupWarning?: string }
    error?: string
  }>
}

function destPath(filename: string): string {
  return path.join(FAKE_DOCS, filename)
}

describe('scoped cleanup diagnostics and errors', () => {
  async function cleanup() {
    const pending = closeOwnedNotepad(WIN.pid, WIN.hwnd)
    await vi.runAllTimersAsync()
    return pending
  }
  beforeEach(() => { setupDefaultMocks(); vi.useFakeTimers() })

  it('records request, polling and final closure on the exact owned HWND', async () => {
    expect(await cleanup()).toMatchObject({closed:true,finalWindowState:'closed',errors:[]})
    expect(desktopOps.postClose).toHaveBeenCalledTimes(1)
    expect(desktopOps.postClose).toHaveBeenCalledWith(WIN.hwnd)
    expect(plannerDiagnostic).toHaveBeenCalledWith('notepad.cleanup.close_request', expect.objectContaining({hwnd:WIN.hwnd,pid:WIN.pid,requested:true,win32Error:0}))
    expect(plannerDiagnostic).toHaveBeenCalledWith('notepad.cleanup.poll', expect.objectContaining({hwnd:WIN.hwnd,alive:false}))
    expect(plannerDiagnostic).toHaveBeenCalledWith('notepad.cleanup.result', expect.objectContaining({closed:true,finalWindowState:'closed'}))
  })
  it('preserves rejected close-request and native error rather than claiming closure', async () => {
    vi.mocked(desktopOps.postClose).mockResolvedValue({requested:false,win32Error:5})
    vi.mocked(desktopOps.isWindow).mockResolvedValue(true)
    const result = await cleanup()
    expect(result).toMatchObject({closed:false,finalWindowState:'open',errors:[{stage:'close_request',error:expect.stringContaining('Win32 error 5')}]})
    expect(desktopOps.findDontSave).not.toHaveBeenCalled()
    expect(toolCalls).toEqual([])
  })
  it('records lookup errors without falling back to another window or sending N', async () => {
    vi.mocked(desktopOps.isWindow).mockResolvedValue(true)
    vi.mocked(desktopOps.findDontSave).mockRejectedValue(new Error('fixture lookup error'))
    expect(await cleanup()).toMatchObject({closed:false,finalWindowState:'open',errors:[{stage:'dialog_lookup',error:expect.stringContaining('fixture lookup error')}]})
    expect(desktopOps.findDontSave).toHaveBeenCalledTimes(1)
    expect(desktopOps.findDontSave).toHaveBeenCalledWith(WIN.hwnd)
    expect(desktopOps.windowsByPid).not.toHaveBeenCalled()
    expect(toolCalls).toEqual([])
    expect(plannerDiagnostic).toHaveBeenCalledWith('notepad.cleanup.error', expect.objectContaining({stage:'dialog_lookup',hwnd:WIN.hwnd}))
  })
  it('keeps polling/final-state failures distinct from a closed window', async () => {
    vi.mocked(desktopOps.isWindow).mockRejectedValue(new Error('fixture poll error'))
    expect(await cleanup()).toMatchObject({closed:false,finalWindowState:'unknown',errors:[{stage:'closure_poll',error:expect.stringContaining('fixture poll error')},{stage:'final_state',error:expect.stringContaining('fixture poll error')}]})
  })
  it('records every absent-dialog poll and the final open state on timeout', async () => {
    vi.mocked(desktopOps.isWindow).mockResolvedValue(true)
    expect(await cleanup()).toMatchObject({closed:false,reason:expect.stringContaining('timeout'),finalWindowState:'open'})
    expect(desktopOps.findDontSave).toHaveBeenCalledTimes(15)
    expect(vi.mocked(plannerDiagnostic).mock.calls.filter(c=>c[0]==='notepad.cleanup.poll')).toHaveLength(15)
    expect(desktopOps.postClose).toHaveBeenCalledTimes(1)
  })
  it('does not hide a failed exact-window cleanup dismissal', async () => {
    vi.mocked(desktopOps.isWindow).mockResolvedValue(true)
    vi.mocked(desktopOps.findDontSave).mockResolvedValue({name:"Don't Save"} as any)
    toolOverrides.set('computer.key',{success:false,error:'fixture dismissal blocked'})
    expect(await cleanup()).toMatchObject({closed:false,reason:expect.stringContaining('fixture dismissal blocked'),finalWindowState:'open'})
    expect(toolCalls).toEqual([{name:'computer.key',params:{key:'N',pid:WIN.pid,hwnd:WIN.hwnd}}])
  })
  it('preserves cleanup failure alongside the original filename failure in the tool result', async () => {
    vi.mocked(desktopOps.setFilenameInSaveAs).mockResolvedValue({ok:false,reason:'filename_input_target_mismatch:foreground_hwnd expected=100 observed=200'})
    vi.mocked(desktopOps.postClose).mockRejectedValue(new Error('fixture close helper failed'))
    const pending = callSaveText({text:'x',filename:'fixture-diagnostics.txt'})
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.error).toContain('filename_input_target_mismatch:foreground_hwnd expected=100 observed=200')
    expect(result.error).toContain('fixture close helper failed')
    expect(result.data).toMatchObject({cleanup:{closed:false,errors:[{stage:'close_request',error:expect.stringContaining('fixture close helper failed')}]}})
    expect(desktopOps.pressEnterInDialog).not.toHaveBeenCalled()
    expect(desktopOps.postClose).toHaveBeenCalledTimes(1)
  })
})

// ── S1: Successful save ───────────────────────────────────────────────────────

describe('S1 — notepad.saveText: successful save with content verification', () => {
  it('preserves a discovery enumeration error without typing or claiming zero matches', async () => {
    setupDefaultMocks()
    toolOverrides.set('computer.windowByTitleDiff', { success: false, error: 'discovery_enumeration_error: fixture failure' })
    const result = await callSaveText({ text: 'fixture', filename: 'fixture.txt' })
    expect(result.error).toContain('discovery_enumeration_error')
    expect(desktopOps.typeIntoHwnd).not.toHaveBeenCalled()
    expect(desktopOps.setFilenameInSaveAs).not.toHaveBeenCalled()
  })
  it('stops immediately on dialog enumeration errors and cleans up only the owned HWND', async () => {
    setupDefaultMocks()
    Object.assign(desktopOps, {findSaveAsDialog:vi.fn().mockRejectedValue(new Error('discovery_enumeration_error: fixture'))})
    const result = await callSaveText({text:'fixture',filename:'fixture.txt'})
    expect(result.error).toContain('discovery_enumeration_error')
    expect(desktopOps.findSaveAsDialog).toHaveBeenCalledTimes(1)
    expect(desktopOps.setFilenameInSaveAs).not.toHaveBeenCalled()
    expect(desktopOps.postClose).toHaveBeenCalledWith(WIN.hwnd)
  })

  it('S1a: full happy path — returns filePath and bytes; content verified from disk', async () => {
    const TEXT     = 'Hello from Goga test S1'
    const FILENAME = 'goga-test-s1.txt'
    const DEST     = destPath(FILENAME)
    setupDefaultMocks({ readFileContent: TEXT + '\r\n' })

    const result = await callSaveText({ text: TEXT, filename: FILENAME })

    expect(result.success).toBe(true)
    expect(result.data?.filePath).toBe(DEST)
    expect(result.data?.bytes).toBeGreaterThan(0)

    const names = toolCalls.map(c => c.name)
    const firstIdx = (n: string) => names.indexOf(n)
    expect(firstIdx('computer.snapshotHwnds')).toBeLessThan(firstIdx('process.start'))
    expect(firstIdx('process.start')).toBeLessThan(firstIdx('computer.windowByTitleDiff'))

    const typeCalls = (desktopOps.typeIntoHwnd as ReturnType<typeof vi.fn>).mock.calls
    expect(typeCalls.length).toBe(1)
    expect(typeCalls[0][0]).toBe(WIN.hwnd)
    expect(typeCalls[0][1]).toBe(TEXT)

    expect(desktopOps.setFilenameInSaveAs).toHaveBeenCalledWith(WIN.hwnd, DEST, WIN.pid, expect.any(AbortSignal))
    // pressEnterInDialog called with Notepad HWND — dialog's WinUI3 island HWND is not a root child
    expect(desktopOps.pressEnterInDialog).toHaveBeenCalledWith(WIN.hwnd)
    // step 13 uses findSaveAsDialogOrThrow (distinguishes error from closed)
    expect(desktopOps.findSaveAsDialogOrThrow).toHaveBeenCalledWith(WIN.hwnd)
    expect(fsOps.readFileSync).toHaveBeenCalledWith(DEST, 'utf-8')
    expect(desktopOps.findSaveAsDialog).toHaveBeenCalledWith(WIN.hwnd, WIN.pid)
  })

  it('passes the exact priorities sentence to the owned editor and verifies the same content', async () => {
    setupDefaultMocks({ readFileContent: prioritiesText })
    const result = await callSaveText({ text: prioritiesText, filename: prioritiesFilename })
    expect(result.success).toBe(true)
    expect(result.data?.filePath).toBe(destPath(prioritiesFilename))
    expect(desktopOps.typeIntoHwnd).toHaveBeenCalledWith(WIN.hwnd, prioritiesText)
  })

  it.each([quotedPrioritiesText, corruptedPrioritiesText])('still rejects altered priorities content: %s', async saved => {
    setupDefaultMocks({ readFileContent: saved })
    const result = await callSaveText({ text: prioritiesText, filename: prioritiesFilename })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/content mismatch/)
    expect(desktopOps.postClose).toHaveBeenCalledWith(WIN.hwnd)
  })

  it('S1j: PS error in dialog-close poll is distinct from dialog-closed — reports poll error', async () => {
    setupDefaultMocks({ readFileContent: 'x\r\n' })
    Object.assign(desktopOps, {
      findSaveAsDialogOrThrow: vi.fn().mockRejectedValue(new Error('ps:timeout')),
    })
    const result = await callSaveText({ text: 'x', filename: 'goga-s1j.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/dialog-close poll error/)
    // file read must NOT have been called — error before file poll
    expect(fsOps.readFileSync).not.toHaveBeenCalled()
  })

  it('S1b: pre-flight rejects if destination already exists — no tools called', async () => {
    setupDefaultMocks({ existsAlwaysTrue: true })
    const result = await callSaveText({ text: 'x', filename: 'existing.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already exists/)
    expect(toolCalls.length).toBe(0)
  })

  it('S1c: aborts without input when windowByTitleDiff returns null', async () => {
    setupDefaultMocks()
    toolOverrides.set('computer.windowByTitleDiff', { success: false, data: null })
    const result = await callSaveText({ text: 'x', filename: 'goga-ambiguous.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/ambiguous|did not appear/)
    expect(toolCalls.find(c => c.name === 'computer.type')).toBeUndefined()
  })

  it('S1d: aborts before Enter when Replace prompt detected in dialog subtree', async () => {
    setupDefaultMocks()
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
    setupDefaultMocks({ readFileContent: 'something completely different' })
    const result = await callSaveText({ text: 'expected text', filename: 'goga-mismatch.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/mismatch/)
  })

  it('S1f: fails when file is not found on disk after save', async () => {
    // existsAlwaysFalse: pre-flight passes (false=not exists), file poll also false=never appears
    setupDefaultMocks({ existsAlwaysFalse: true })
    const result = await callSaveText({ text: 'x', filename: 'goga-missing.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found after save/)
  }, 10_000)

  it('S1g: Documents dir resolved via docsDirOps.resolve, not hardcoded', async () => {
    const CUSTOM_DOCS = 'D:\\OneDrive\\Documents'
    setupDefaultMocks({ readFileContent: 'hello\r\n' })
    ;(docsDirOps.resolve as ReturnType<typeof vi.fn>).mockResolvedValue(CUSTOM_DOCS)
    const result = await callSaveText({ text: 'hello', filename: 'goga-onedrive.txt' })
    expect(result.success).toBe(true)
    expect(result.data?.filePath).toBe(path.join(CUSTOM_DOCS, 'goga-onedrive.txt'))
  })

  it('S1h: findSaveAsDialog returns null — tool aborts, zero input dispatched', async () => {
    setupDefaultMocks()
    Object.assign(desktopOps, { findSaveAsDialog: vi.fn().mockResolvedValue(null) })
    const result = await callSaveText({ text: 'x', filename: 'goga-s1h.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Save As dialog did not appear/)
    expect(toolCalls.find(c => c.name === 'computer.key' && c.params.key === 'Return')).toBeUndefined()
  }, 10_000)

  it('S1i: cleanup timeout reported in cleanupWarning, not as failure', async () => {
    setupDefaultMocks({ readFileContent: 'x\r\n' })
    Object.assign(desktopOps, {
      isWindow:     vi.fn().mockResolvedValue(true),
      findDontSave: vi.fn().mockResolvedValue(null),
    })
    const result = await callSaveText({ text: 'x', filename: 'goga-s1i.txt' })
    expect(result.success).toBe(true)
    expect(result.data?.cleanupWarning).toMatch(/still open|timeout/)
    expect(desktopOps.postClose).toHaveBeenCalledWith(WIN.hwnd)
  }, 10_000)

  it('S1k: filename with path separator is rejected before any tool call', async () => {
    setupDefaultMocks()
    const result = await callSaveText({ text: 'x', filename: 'C:\\TestPath\\test.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/path separator/)
    expect(toolCalls.length).toBe(0)
  })

  it('S1l: setFilenameInSaveAs returns mismatched actual — field mismatch error, Enter never dispatched', async () => {
    setupDefaultMocks({ readFileContent: 'x\r\n' })
    Object.assign(desktopOps, {
      setFilenameInSaveAs: vi.fn().mockResolvedValue({ ok: true, actual: 'C:\\WrongPath\\wrong.txt' }),
    })
    const result = await callSaveText({ text: 'x', filename: 'goga-s1l.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/filename field mismatch/)
    expect(desktopOps.pressEnterInDialog).not.toHaveBeenCalled()
    expect(fsOps.readFileSync).not.toHaveBeenCalled()
  })
})

// ── S2: Stop before save dispatch ────────────────────────────────────────────

describe('S2 — notepad.saveText: Stop before save dispatch proves no file written', () => {

  it('S2a: abort before process.start — Notepad never launched', async () => {
    setupDefaultMocks()
    const ac = new AbortController()
    ac.abort()
    const result = await callSaveText({ text: 'x', filename: 'goga-preabort.txt' }, ac.signal)
    expect(result.success).toBe(false)
    expect(toolCalls.find(c => c.name === 'process.start')).toBeUndefined()
    expect(fsOps.readFileSync).not.toHaveBeenCalled()
  })

  it('S2b: preEnter hook throws AbortError — Enter never dispatched', async () => {
    setupDefaultMocks()
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
    setupDefaultMocks()
    const ac = new AbortController()
    hookOps.preEnter = async () => { ac.abort() }
    const result = await callSaveText({ text: 'Stop test S2e', filename: 'goga-s2e.txt' }, ac.signal)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cancelled/)
    expect(toolCalls.find(c => c.name === 'computer.key' && c.params.key === 'Return')).toBeUndefined()
    expect(fsOps.readFileSync).not.toHaveBeenCalled()
  })

  it('S2c: abort during saveAsViaMenu — Enter never dispatched', async () => {
    setupDefaultMocks()
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
    setupDefaultMocks()
    const ac = new AbortController()
    Object.assign(desktopOps, {
      findSaveAsDialog: vi.fn().mockImplementation(async () => { ac.abort(); return DIALOG }),
    })
    const result = await callSaveText({ text: 'Stop test S2d', filename: 'goga-s2d.txt' }, ac.signal)
    expect(result.success).toBe(false)
    expect(toolCalls.find(c => c.name === 'computer.key' && c.params.key === 'Return')).toBeUndefined()
    expect(fsOps.readFileSync).not.toHaveBeenCalled()
  })

  it('S2f: abort during dialog-close poll (step 13) — file never read', async () => {
    setupDefaultMocks()
    const ac = new AbortController()
    Object.assign(desktopOps, {
      // dialog still open on first poll — abort fires during the 300ms sleep
      findSaveAsDialogOrThrow: vi.fn().mockImplementation(async () => {
        ac.abort()
        return DIALOG  // still open
      }),
    })
    const result = await callSaveText({ text: 'Stop test S2f', filename: 'goga-s2f.txt' }, ac.signal)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cancelled/)
    expect(fsOps.readFileSync).not.toHaveBeenCalled()
  })
})

// ── S3: Two Notepad windows sharing PID and identical titles ──────────────────

describe('S3 — two Notepad windows, same PID, identical titles; only unrelated has a dialog', () => {
  const OTHER            = { hwnd: 0xDEAD, pid: WIN.pid, title: 'Untitled - Notepad' }
  const UNRELATED_DIALOG = { hwnd: 0xF00D, pid: WIN.pid, title: 'Save As' }

  it('S3a: findSaveAsDialog returns null when only unrelated window has a dialog — tool aborts, zero input', async () => {
    setupDefaultMocks()
    Object.assign(desktopOps, {
      findSaveAsDialog: vi.fn().mockResolvedValue(null),
    })
    const result = await callSaveText({ text: 'x', filename: 'goga-s3a.txt' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Save As dialog did not appear/)
    expect(toolCalls.find(c => c.name === 'computer.type' && c.params.hwnd === UNRELATED_DIALOG.hwnd)).toBeUndefined()
    expect(toolCalls.find(c => c.name === 'computer.key' && c.params.key === 'Return')).toBeUndefined()
    expect(desktopOps.findSaveAsDialog).toHaveBeenCalledWith(WIN.hwnd, WIN.pid)
    expect(desktopOps.findSaveAsDialog).not.toHaveBeenCalledWith(OTHER.hwnd, expect.anything())
  }, 10_000)

  it('S3b: findDontSave scoped to win.hwnd — unrelated window\'s Don\'t Save never invoked', async () => {
    setupDefaultMocks({ readFileContent: 'x\r\n' })
    let pollCount = 0
    Object.assign(desktopOps, {
      isWindow: vi.fn().mockImplementation(async () => { pollCount++; return pollCount <= 1 }),
      findDontSave: vi.fn().mockResolvedValue(null),
    })
    await callSaveText({ text: 'x', filename: 'goga-s3b.txt' })
    const dontSaveCalls = (desktopOps.findDontSave as ReturnType<typeof vi.fn>).mock.calls
    for (const [hwnd] of dontSaveCalls) {
      expect(hwnd).toBe(WIN.hwnd)
      expect(hwnd).not.toBe(OTHER.hwnd)
    }
    expect(toolCalls.find(c => c.name === 'computer.key' && c.params.key === 'N')).toBeUndefined()
  })

  it('S3c: overwrite prompt check scoped to dialog.hwnd — unrelated dialog\'s Replace never touched', async () => {
    setupDefaultMocks({ readFileContent: 'x\r\n' })
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
    setupDefaultMocks({ readFileContent: 'x\r\n' })
    await callSaveText({ text: 'x', filename: 'goga-s4a.txt' })
    expect(desktopOps.typeIntoHwnd).toHaveBeenCalledWith(WIN.hwnd, 'x')
  })

  it('S4b: saveAsViaMenu called for Notepad window', async () => {
    setupDefaultMocks({ readFileContent: 'x\r\n' })
    await callSaveText({ text: 'x', filename: 'goga-s4b.txt' })
    expect(desktopOps.saveAsViaMenu).toHaveBeenCalledWith(WIN.hwnd)
  })

  it('S4c: failed typeIntoHwnd produces error string and no file read', async () => {
    setupDefaultMocks()
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
    setupDefaultMocks({ readFileContent: TEXT + '\r\n' })
    const result = await callSaveText({ text: TEXT, filename: FILENAME })
    expect(result.success).toBe(true)
    expect(result.data?.filePath).toBe(DEST)
    expect(result.data?.bytes).toBeGreaterThan(0)
    expect((fsOps.readFileSync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect((desktopOps.typeIntoHwnd as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect(desktopOps.setFilenameInSaveAs).toHaveBeenCalledWith(WIN.hwnd, DEST, WIN.pid, expect.any(AbortSignal))
  })
})
