/**
 * focus-input-guard.test.ts
 *
 * Verifies that computer.key, computer.shortcut, computer.click,
 * computer.doubleClick, computer.rightClick, and computer.drag all
 * require pid+hwnd and route through focusGuardedType before any OS input.
 *
 * All desktop I/O is mocked — no live windows are touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Shared mock target ────────────────────────────────────────────────────────

const TARGET = { pid: 5000, hwnd: 0xCAFE }

// ── FocusManager mock ─────────────────────────────────────────────────────────
// We mock the entire FocusManager module so computer.ts never imports the real
// DesktopAdapter (which requires native modules).

const mockFocusGuardedType = vi.fn()

vi.mock('../focusManager', () => ({
  FocusManager: {
    getInstance: () => ({ focusGuardedType: mockFocusGuardedType })
  }
}))

// ── DesktopAdapter mock ───────────────────────────────────────────────────────

const mockPressKey    = vi.fn().mockResolvedValue({ key: 'Enter' })
const mockShortcut    = vi.fn().mockResolvedValue({ keys: ['LeftControl', 'S'] })
const mockClick       = vi.fn().mockResolvedValue({ x: 10, y: 20, button: 'left' })
const mockDoubleClick = vi.fn().mockResolvedValue({ x: 10, y: 20 })
const mockDrag        = vi.fn().mockResolvedValue({ from: { x: 0, y: 0 }, to: { x: 100, y: 100 } })

vi.mock('../../adapters/desktop', () => ({
  DesktopAdapter: vi.fn().mockImplementation(() => ({
    pressKey:    mockPressKey,
    shortcut:    mockShortcut,
    click:       mockClick,
    doubleClick: mockDoubleClick,
    drag:        mockDrag,
    screenshot:  vi.fn(), activeWindow: vi.fn(), windowList: vi.fn(),
    focusWindow: vi.fn(), uiElements: vi.fn(), scroll: vi.fn(),
    typeText: vi.fn(), clipboardRead: vi.fn(), clipboardWrite: vi.fn(),
    wait: vi.fn(), restoreWindow: vi.fn(), accessibilityTree: vi.fn(),
    windowsByPid: vi.fn(), activeWindowWithHwnd: vi.fn(),
    windowByTitleDiff: vi.fn(), snapshotHwnds: vi.fn(),
    invoke: vi.fn(), getFocusState: vi.fn(),
  }))
}))

// ── ToolRegistry mock ─────────────────────────────────────────────────────────
// Capture registrations so we can invoke handlers directly.

type Handler = (params: Record<string, unknown>, ctx: { abortSignal?: AbortSignal }) => Promise<unknown>
const registry = new Map<string, Handler>()

vi.mock('../../tools/registry', () => ({
  ToolRegistry: {
    getInstance: () => ({
      register: (def: { name: string }, handler: Handler) => {
        registry.set(def.name, handler)
      }
    })
  }
}))

// ── Load computer.ts (triggers all reg.register calls) ───────────────────────

beforeEach(async () => {
  vi.clearAllMocks()
  registry.clear()
  // Re-import to re-run all register() calls with fresh mocks.
  vi.resetModules()

  // Re-apply mocks after resetModules
  vi.mock('../focusManager', () => ({
    FocusManager: {
      getInstance: () => ({ focusGuardedType: mockFocusGuardedType })
    }
  }))
  vi.mock('../../adapters/desktop', () => ({
    DesktopAdapter: vi.fn().mockImplementation(() => ({
      pressKey: mockPressKey, shortcut: mockShortcut,
      click: mockClick, doubleClick: mockDoubleClick, drag: mockDrag,
      screenshot: vi.fn(), activeWindow: vi.fn(), windowList: vi.fn(),
      focusWindow: vi.fn(), uiElements: vi.fn(), scroll: vi.fn(),
      typeText: vi.fn(), clipboardRead: vi.fn(), clipboardWrite: vi.fn(),
      wait: vi.fn(), restoreWindow: vi.fn(), accessibilityTree: vi.fn(),
      windowsByPid: vi.fn(), activeWindowWithHwnd: vi.fn(),
      windowByTitleDiff: vi.fn(), invoke: vi.fn(), getFocusState: vi.fn(),
    }))
  }))
  vi.mock('../../tools/registry', () => ({
    ToolRegistry: {
      getInstance: () => ({
        register: (def: { name: string }, handler: Handler) => {
          registry.set(def.name, handler)
        }
      })
    }
  }))

  await import('../../tools/computer')
})

// ── Helper ────────────────────────────────────────────────────────────────────

function allowGuard() {
  mockFocusGuardedType.mockImplementation(async (_t: unknown, fn: () => Promise<void>) => {
    await fn()
    return { allowed: true }
  })
}

function blockGuard() {
  mockFocusGuardedType.mockResolvedValue({ allowed: false, reason: 'focus_lost: test block' })
}

async function call(name: string, params: Record<string, unknown>) {
  const h = registry.get(name)
  if (!h) throw new Error(`Handler not registered: ${name}`)
  return h(params, {})
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('computer.key — HWND guard', () => {
  it('missing pid → blocked without calling focusGuardedType', async () => {
    const r = await call('computer.key', { key: 'Enter', hwnd: TARGET.hwnd }) as { success: boolean; error?: string }
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/pid is mandatory/)
    expect(mockFocusGuardedType).not.toHaveBeenCalled()
  })

  it('missing hwnd → blocked without calling focusGuardedType', async () => {
    const r = await call('computer.key', { key: 'Enter', pid: TARGET.pid }) as { success: boolean; error?: string }
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/hwnd is mandatory/)
    expect(mockFocusGuardedType).not.toHaveBeenCalled()
  })

  it('guard blocks → success:false, pressKey not called', async () => {
    blockGuard()
    const r = await call('computer.key', { key: 'Enter', ...TARGET }) as { success: boolean }
    expect(r.success).toBe(false)
    expect(mockPressKey).not.toHaveBeenCalled()
  })

  it('guard allows → success:true, pressKey called once', async () => {
    allowGuard()
    const r = await call('computer.key', { key: 'Enter', ...TARGET }) as { success: boolean }
    expect(r.success).toBe(true)
    expect(mockPressKey).toHaveBeenCalledWith('Enter')
  })
})

describe('computer.shortcut — HWND guard', () => {
  it('guard blocks → success:false, shortcut not called', async () => {
    blockGuard()
    const r = await call('computer.shortcut', { keys: ['LeftControl', 'S'], ...TARGET }) as { success: boolean }
    expect(r.success).toBe(false)
    expect(mockShortcut).not.toHaveBeenCalled()
  })

  it('guard allows → success:true, shortcut called once', async () => {
    allowGuard()
    const r = await call('computer.shortcut', { keys: ['LeftControl', 'S'], ...TARGET }) as { success: boolean }
    expect(r.success).toBe(true)
    expect(mockShortcut).toHaveBeenCalledWith(['LeftControl', 'S'])
  })
})

describe('computer.click — HWND guard', () => {
  it('guard blocks → success:false, click not called', async () => {
    blockGuard()
    const r = await call('computer.click', { x: 10, y: 20, ...TARGET }) as { success: boolean }
    expect(r.success).toBe(false)
    expect(mockClick).not.toHaveBeenCalled()
  })

  it('guard allows → success:true, click called once', async () => {
    allowGuard()
    const r = await call('computer.click', { x: 10, y: 20, ...TARGET }) as { success: boolean }
    expect(r.success).toBe(true)
    expect(mockClick).toHaveBeenCalledWith(10, 20, undefined)
  })

  it('uses coordinate actionClass (guard receives coordinate)', async () => {
    allowGuard()
    await call('computer.click', { x: 10, y: 20, ...TARGET })
    const [, , , actionClass] = mockFocusGuardedType.mock.calls[0]
    expect(actionClass).toBe('coordinate')
  })
})

describe('computer.doubleClick — HWND guard', () => {
  it('guard blocks → success:false, doubleClick not called', async () => {
    blockGuard()
    const r = await call('computer.doubleClick', { x: 10, y: 20, ...TARGET }) as { success: boolean }
    expect(r.success).toBe(false)
    expect(mockDoubleClick).not.toHaveBeenCalled()
  })

  it('guard allows → success:true, doubleClick called once', async () => {
    allowGuard()
    const r = await call('computer.doubleClick', { x: 10, y: 20, ...TARGET }) as { success: boolean }
    expect(r.success).toBe(true)
    expect(mockDoubleClick).toHaveBeenCalledWith(10, 20)
  })
})

describe('computer.rightClick — HWND guard', () => {
  it('guard blocks → success:false, click not called', async () => {
    blockGuard()
    const r = await call('computer.rightClick', { x: 10, y: 20, ...TARGET }) as { success: boolean }
    expect(r.success).toBe(false)
    expect(mockClick).not.toHaveBeenCalled()
  })

  it('guard allows → success:true, click called with right button', async () => {
    allowGuard()
    const r = await call('computer.rightClick', { x: 10, y: 20, ...TARGET }) as { success: boolean }
    expect(r.success).toBe(true)
    expect(mockClick).toHaveBeenCalledWith(10, 20, 'right')
  })
})

describe('computer.drag — HWND guard', () => {
  it('guard blocks → success:false, drag not called', async () => {
    blockGuard()
    const r = await call('computer.drag', { fromX: 0, fromY: 0, toX: 100, toY: 100, ...TARGET }) as { success: boolean }
    expect(r.success).toBe(false)
    expect(mockDrag).not.toHaveBeenCalled()
  })

  it('guard allows → success:true, drag called once', async () => {
    allowGuard()
    const r = await call('computer.drag', { fromX: 0, fromY: 0, toX: 100, toY: 100, ...TARGET }) as { success: boolean }
    expect(r.success).toBe(true)
    expect(mockDrag).toHaveBeenCalledWith(0, 0, 100, 100)
  })
})
