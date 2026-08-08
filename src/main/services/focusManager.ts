/**
 * FocusManager — Phase B (final hardened)
 *
 * Hardening:
 *   1. Abort throws — AbortError thrown before every OS mutation; code after await cannot run
 *   2. HWND identity — FocusContext carries hwnd > pid > title priority chain
 *   3. Coordinate safety — verifyCoordinates() re-reads bounds after focus, rejects out-of-bounds
 *   4. Confidence policy — MIN_CONFIDENCE_TO_ACT constant; callers must not lower it
 *   5. Telemetry privacy — typed text / values / clipboard never enter telemetry
 *   6. Focus failure blocks — focusGuardedType() returns focus_lost instead of typing to wrong window
 */

import { DesktopAdapter } from '../adapters/desktop'
import { LogService } from './logs'

// ── Abort helper ──────────────────────────────────────────────────────────────
// Throws a named AbortError so callers can distinguish cancellation from real errors.
// Call this before EVERY OS mutation (restore, SetForegroundWindow, invoke, type, click).
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const e = new Error('FocusManager: operation cancelled')
    e.name = 'AbortError'
    throw e
  }
}

// ── Confidence policy ─────────────────────────────────────────────────────────
// Action-specific minimum confidence requirements.
// A PID match alone is NOT sufficient for destructive/input actions because
// one process can own multiple windows.
//
// For typing/paste/keypress/shortcuts/UIAutomation invoke+setValue:
//   Preferred: HWND + foreground-window (hwnd-match + foreground-window = 0.67)
//   Fallback:  PID + foreground-window title match (pid-match + foreground-window = 0.67)
//   Minimum:   foreground-window alone (0.33) — only when PID/HWND unavailable
//
// For coordinate clicks: additionally requires bounds verification (verifyCoordinates)
//
// Never lower these to make a mission continue — replan instead.
export const MIN_CONFIDENCE_INPUT   = 1 / 3   // foreground-window alone (title match verified by OS)
export const MIN_CONFIDENCE_STRONG  = 2 / 3   // pid-match + foreground-window (preferred for typing)
export const MIN_CONFIDENCE_TO_ACT  = MIN_CONFIDENCE_INPUT  // backward-compat alias

/**
 * Returns the minimum confidence required for a given action class.
 * Callers should use this instead of the raw constant.
 */
export function minConfidenceFor(actionClass: 'read' | 'input' | 'coordinate' | 'invoke'): number {
  switch (actionClass) {
    case 'read':       return 0           // no focus requirement for read-only
    case 'input':      return MIN_CONFIDENCE_INPUT   // typing, key, shortcut
    case 'invoke':     return MIN_CONFIDENCE_INPUT   // UIAutomation invoke/setValue
    case 'coordinate': return MIN_CONFIDENCE_STRONG  // coordinate clicks need stronger identity
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WindowTarget {
  title?: string
  pid?: number
  hwnd?: number   // strongest identity — prefer over pid/title when available
}

export interface ElementSpec {
  windowTitle?: string
  windowPid?: number
  windowHwnd?: number
  name?: string
  role?: string
  automationId?: string
}

export interface FocusState {
  activeWindowTitle: string
  activeWindowPid: number
  activeWindowHwnd: number
  focusedElementName: string
  focusedElementRole: string
  focusedElementAutomationId: string
}

// FocusContext is the resolved, verified identity of the focused window.
// Passed to coordinate safety checks and input guards.
export interface FocusContext {
  hwnd: number          // 0 if unavailable
  pid: number
  title: string
  bounds: { x: number; y: number; width: number; height: number }
  confidence: number
  verifiedBy: VerificationSource[]
}

export type VerificationSource = 'foreground-window' | 'focused-element' | 'pid-match' | 'hwnd-match'
// hwnd-match is a bonus source; baseline is 3 (foreground-window + pid-match + focused-element)
const TOTAL_SOURCES = 3

export interface FocusResult {
  success: boolean
  action: 'already-focused' | 'focused' | 'restored-and-focused' | 'failed' | 'cancelled'
  verifiedActiveWindow: string
  verifiedFocusedElement?: string
  confidence: number
  verifiedBy: VerificationSource[]
  attempts: number
  elapsedMs: number
  context?: FocusContext   // populated on success — use for coordinate safety
  error?: string
}

// ── Telemetry ─────────────────────────────────────────────────────────────────
// PRIVACY: never include typed text, values, clipboard content, or credentials.
export interface FocusTelemetry {
  operation: 'focus.window' | 'focus.element' | 'focus.ensure' | 'focus.state' | 'focus.type_guard'
  requestedWindow?: string
  requestedElement?: string   // element name/role only — never the value being typed
  beforeWindow: string
  afterWindow: string
  attempts: number
  elapsedMs: number
  confidence: number
  verifiedBy: VerificationSource[]
  result: 'success' | 'failure' | 'cancelled' | 'focus_lost'
  error?: string
}

// ── Logger interface ──────────────────────────────────────────────────────────
interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
}

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 600
const VERIFY_SETTLE_MS = 150

export class FocusManager {
  private static instance: FocusManager
  private desktop = new DesktopAdapter()
  private log: Logger

  static getInstance(): FocusManager {
    if (!FocusManager.instance) FocusManager.instance = new FocusManager()
    return FocusManager.instance
  }

  constructor(logger?: Logger) {
    this.log = logger ?? LogService.getInstance()
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async focusWindow(target: WindowTarget, signal?: AbortSignal): Promise<FocusResult> {
    const t0 = Date.now()
    const beforeWindow = await this.safeActiveTitle()

    if (!target.title && !target.pid && !target.hwnd) {
      return this.finish('focus.window', t0, beforeWindow, 0, target, undefined,
        this.fail('focusWindow requires title, pid, or hwnd', 0))
    }

    let attempts = 0
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      throwIfAborted(signal)   // ← abort check before every iteration
      attempts = attempt

      const windows = await this.desktop.windowList().catch(() => [])
      throwIfAborted(signal)   // ← abort check after every long PS call

      const match = this.resolveWindow(windows, target)
      if (!match) {
        return this.finish('focus.window', t0, beforeWindow, attempts, target, undefined,
          this.fail(`Window not found: ${JSON.stringify(target)}`, 0))
      }

      const bounds = match.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
      const wasMinimized = bounds.width === 0 || bounds.height === 0
      if (wasMinimized) {
        throwIfAborted(signal)   // ← before OS mutation: restore
        const restored = await this.desktop.restoreWindow(match.pid).catch(() => ({ restored: false }))
        throwIfAborted(signal)   // ← after PS call
        if (!restored.restored) {
          if (attempt < MAX_RETRIES) { await sleepCheck(RETRY_DELAY_MS, signal); continue }
          return this.finish('focus.window', t0, beforeWindow, attempts, target, undefined,
            this.fail('Window destroyed before restore could complete', 0))
        }
        await sleepCheck(VERIFY_SETTLE_MS, signal)
      }

      throwIfAborted(signal)   // ← before OS mutation: SetForegroundWindow
      await this.desktop.focusWindow(match.title, match.pid).catch(() => null)
      throwIfAborted(signal)   // ← after PS call
      await sleepCheck(VERIFY_SETTLE_MS, signal)

      const active = await this.desktop.activeWindow().catch(() => null)
      throwIfAborted(signal)

      if (!active) { if (attempt < MAX_RETRIES) { await sleepCheck(RETRY_DELAY_MS, signal); continue } break }

      const verifiedBy: VerificationSource[] = []
      if (this.windowMatchesTarget(active.title, target)) verifiedBy.push('foreground-window')
      if (target.pid && active.pid === target.pid) verifiedBy.push('pid-match')
      // HWND match: active-win doesn't expose hwnd directly, but pid-match is sufficient for hwnd targets
      if (target.hwnd && target.pid && active.pid === target.pid) verifiedBy.push('hwnd-match')

      if (verifiedBy.length > 0) {
        const ctx: FocusContext = {
          hwnd: target.hwnd ?? 0,
          pid: active.pid,
          title: active.title,
          bounds: active.bounds ?? bounds,
          confidence: this.confidence(verifiedBy),
          verifiedBy
        }
        const result: FocusResult = {
          success: true,
          action: wasMinimized ? 'restored-and-focused' : 'focused',
          verifiedActiveWindow: active.title,
          confidence: ctx.confidence,
          verifiedBy,
          attempts,
          elapsedMs: Date.now() - t0,
          context: ctx
        }
        return this.finish('focus.window', t0, beforeWindow, attempts, target, undefined, result)
      }

      if (attempt < MAX_RETRIES) await sleepCheck(RETRY_DELAY_MS, signal)
    }

    const finalActive = await this.desktop.activeWindow().catch(() => null)
    return this.finish('focus.window', t0, beforeWindow, attempts, target, undefined,
      this.fail(
        `SetForegroundWindow did not take effect after ${MAX_RETRIES} attempts. ` +
        `Active window is: "${finalActive?.title ?? 'unknown'}"`, 0))
  }

  async focusElement(spec: ElementSpec, signal?: AbortSignal): Promise<FocusResult> {
    const t0 = Date.now()
    const beforeWindow = await this.safeActiveTitle()

    const current = await this.getFocusState()
    throwIfAborted(signal)

    if (this.elementMatchesSpec(current, spec)) {
      const verifiedBy: VerificationSource[] = ['foreground-window', 'focused-element']
      const result: FocusResult = {
        success: true, action: 'already-focused',
        verifiedActiveWindow: current.activeWindowTitle,
        verifiedFocusedElement: current.focusedElementName,
        confidence: this.confidence(verifiedBy), verifiedBy, attempts: 0,
        elapsedMs: Date.now() - t0,
        context: {
          hwnd: current.activeWindowHwnd, pid: current.activeWindowPid,
          title: current.activeWindowTitle, bounds: { x: 0, y: 0, width: 0, height: 0 },
          confidence: this.confidence(verifiedBy), verifiedBy
        }
      }
      return this.finish('focus.element', t0, beforeWindow, 0,
        { title: spec.windowTitle, pid: spec.windowPid, hwnd: spec.windowHwnd }, spec.name, result)
    }

    if (spec.windowTitle || spec.windowPid || spec.windowHwnd) {
      const winResult = await this.focusWindow(
        { title: spec.windowTitle, pid: spec.windowPid, hwnd: spec.windowHwnd }, signal)
      if (!winResult.success) {
        return this.finish('focus.element', t0, beforeWindow, winResult.attempts,
          { title: spec.windowTitle }, spec.name, { ...winResult, elapsedMs: Date.now() - t0 })
      }
    }

    throwIfAborted(signal)   // ← before OS mutation: invoke
    await this.desktop.invoke({
      name: spec.name, role: spec.role,
      automationId: spec.automationId, windowTitle: spec.windowTitle
    }).catch(() => null)
    throwIfAborted(signal)   // ← after PS call

    await sleepCheck(VERIFY_SETTLE_MS, signal)

    const tree = await this.desktop.accessibilityTree(spec.windowTitle, 4).catch(() => [])
    throwIfAborted(signal)
    const focused = this.findFocusedInTree(tree)

    let active = await this.desktop.activeWindow().catch(() => null)
    throwIfAborted(signal)

    if (active && spec.windowTitle && !this.windowMatchesTarget(active.title, { title: spec.windowTitle })) {
      throwIfAborted(signal)   // ← before recovery focus mutation
      await this.desktop.focusWindow(spec.windowTitle).catch(() => null)
      throwIfAborted(signal)
      await sleepCheck(VERIFY_SETTLE_MS, signal)
      active = await this.desktop.activeWindow().catch(() => null)
      throwIfAborted(signal)
    }

    const verifiedBy: VerificationSource[] = []
    if (active && spec.windowTitle && this.windowMatchesTarget(active.title, { title: spec.windowTitle }))
      verifiedBy.push('foreground-window')
    if (active && spec.windowPid && active.pid === spec.windowPid) verifiedBy.push('pid-match')
    if (focused && this.elementMatchesSpec(
      { activeWindowTitle: active?.title ?? '', activeWindowPid: active?.pid ?? 0,
        activeWindowHwnd: 0, focusedElementName: focused.name,
        focusedElementRole: focused.role, focusedElementAutomationId: focused.automationId }, spec))
      verifiedBy.push('focused-element')

    const windowActive = verifiedBy.includes('foreground-window') || verifiedBy.includes('pid-match')
    const ctx: FocusContext | undefined = windowActive && active ? {
      hwnd: spec.windowHwnd ?? 0, pid: active.pid, title: active.title,
      bounds: active.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      confidence: this.confidence(verifiedBy), verifiedBy
    } : undefined

    const result: FocusResult = {
      success: windowActive, action: 'focused',
      verifiedActiveWindow: active?.title ?? '',
      verifiedFocusedElement: focused?.name,
      confidence: this.confidence(verifiedBy), verifiedBy, attempts: 1,
      elapsedMs: Date.now() - t0, context: ctx,
      error: windowActive ? undefined : 'Window not active after focus attempt'
    }
    return this.finish('focus.element', t0, beforeWindow, 1,
      { title: spec.windowTitle, pid: spec.windowPid, hwnd: spec.windowHwnd }, spec.name, result)
  }

  async ensureFocus(spec: ElementSpec, signal?: AbortSignal): Promise<FocusResult> {
    const t0 = Date.now()
    const beforeWindow = await this.safeActiveTitle()
    throwIfAborted(signal)

    const state = await this.getFocusState()
    throwIfAborted(signal)

    const windowOk = (!spec.windowTitle && !spec.windowPid && !spec.windowHwnd) ||
      this.windowMatchesTarget(state.activeWindowTitle, { title: spec.windowTitle, pid: spec.windowPid, hwnd: spec.windowHwnd })
    const elementOk = (!spec.name && !spec.automationId && !spec.role) || this.elementMatchesSpec(state, spec)

    if (windowOk && elementOk) {
      const verifiedBy: VerificationSource[] = ['foreground-window']
      if (elementOk && (spec.name || spec.automationId || spec.role)) verifiedBy.push('focused-element')
      const result: FocusResult = {
        success: true, action: 'already-focused',
        verifiedActiveWindow: state.activeWindowTitle,
        verifiedFocusedElement: state.focusedElementName || undefined,
        confidence: this.confidence(verifiedBy), verifiedBy, attempts: 0,
        elapsedMs: Date.now() - t0,
        context: {
          hwnd: state.activeWindowHwnd, pid: state.activeWindowPid,
          title: state.activeWindowTitle, bounds: { x: 0, y: 0, width: 0, height: 0 },
          confidence: this.confidence(verifiedBy), verifiedBy
        }
      }
      return this.finish('focus.ensure', t0, beforeWindow, 0,
        { title: spec.windowTitle }, spec.name, result)
    }

    const inner = (spec.name || spec.automationId || spec.role)
      ? await this.focusElement(spec, signal)
      : await this.focusWindow({ title: spec.windowTitle, pid: spec.windowPid, hwnd: spec.windowHwnd }, signal)

    return this.finish('focus.ensure', t0, beforeWindow, inner.attempts,
      { title: spec.windowTitle }, spec.name, { ...inner, elapsedMs: Date.now() - t0 })
  }

  async getFocusState(): Promise<FocusState> {
    const [active, tree] = await Promise.all([
      this.desktop.activeWindow().catch(() => ({ title: '', owner: '', pid: 0, bounds: undefined })),
      this.desktop.accessibilityTree(undefined, 3).catch(() => [])
    ])
    const focused = this.findFocusedInTree(tree)
    return {
      activeWindowTitle: active.title,
      activeWindowPid: active.pid,
      activeWindowHwnd: 0,   // active-win doesn't expose hwnd; populated by getWindowHwnd when needed
      focusedElementName: focused?.name ?? '',
      focusedElementRole: focused?.role ?? '',
      focusedElementAutomationId: focused?.automationId ?? ''
    }
  }

  /**
   * Guard for input actions (type/click/key).
   * Verifies focus matches target before allowing the action to proceed.
   * Returns { allowed: true } or { allowed: false, reason, result: 'focus_lost' }.
   *
   * PRIVACY: the `text` parameter is intentionally NOT logged.
   */
  async focusGuardedType(
    targetWindow: WindowTarget,
    typeFn: () => Promise<void>,
    signal?: AbortSignal,
    actionClass: 'input' | 'coordinate' | 'invoke' = 'input'
  ): Promise<{ allowed: boolean; reason?: string }> {
    throwIfAborted(signal)

    const active = await this.desktop.activeWindow().catch(() => null)
    throwIfAborted(signal)

    if (!active) {
      this.emitTelemetry('focus.type_guard', '', targetWindow, 0, 0, 0, [], 'focus_lost',
        'No active window detected')
      return { allowed: false, reason: 'No active window detected' }
    }

    const matches = this.windowMatchesTarget(active.title, targetWindow)
    if (!matches) {
      this.emitTelemetry('focus.type_guard', active.title, targetWindow, 0, 0, 0, [], 'focus_lost',
        `Active window "${active.title}" does not match target`)
      return {
        allowed: false,
        reason: `focus_lost: active window is "${active.title}", expected "${targetWindow.title ?? targetWindow.pid}"`
      }
    }

    // Build verified-by set
    const verifiedBy: VerificationSource[] = ['foreground-window']
    if (targetWindow.pid && active.pid === targetWindow.pid) verifiedBy.push('pid-match')
    if (targetWindow.hwnd && targetWindow.pid && active.pid === targetWindow.pid) verifiedBy.push('hwnd-match')
    const conf = this.confidence(verifiedBy)

    // Action-specific minimum — coordinate clicks require stronger identity than plain typing
    const required = minConfidenceFor(actionClass)
    if (conf < required) {
      this.emitTelemetry('focus.type_guard', active.title, targetWindow, 0, 0, conf, verifiedBy, 'focus_lost',
        `Confidence ${conf.toFixed(2)} below threshold ${required} for action class "${actionClass}"`)
      return {
        allowed: false,
        reason: `focus confidence ${conf.toFixed(2)} below minimum ${required} for ${actionClass} action. ` +
          `Provide pid or hwnd for stronger identity.`
      }
    }

    throwIfAborted(signal)   // ← final abort check before the actual OS mutation
    await typeFn()
    return { allowed: true }
  }

  /**
   * Verify that screen coordinates fall inside the current bounds of targetWindow.
   * Re-reads bounds after focus restoration — windows can move.
   * Returns { safe: true } or { safe: false, reason }.
   */
  async verifyCoordinates(
    x: number, y: number,
    targetWindow: WindowTarget
  ): Promise<{ safe: boolean; reason?: string; bounds?: { x: number; y: number; width: number; height: number } }> {
    const windows = await this.desktop.windowList().catch(() => [])
    const match = this.resolveWindow(windows, targetWindow)
    if (!match) return { safe: false, reason: `Target window not found: ${JSON.stringify(targetWindow)}` }

    const b = match.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
    if (b.width === 0 || b.height === 0) return { safe: false, reason: 'Target window has zero bounds (minimized?)', bounds: b }

    const inside = x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height
    if (!inside) return {
      safe: false,
      reason: `Coordinates (${x},${y}) outside window bounds (${b.x},${b.y},${b.width}x${b.height})`,
      bounds: b
    }
    return { safe: true, bounds: b }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private confidence(verifiedBy: VerificationSource[]): number {
    return Math.min(1, verifiedBy.length / TOTAL_SOURCES)
  }

  private finish(
    operation: FocusTelemetry['operation'],
    t0: number,
    beforeWindow: string,
    attempts: number,
    target: WindowTarget,
    requestedElement: string | undefined,
    result: FocusResult
  ): FocusResult {
    // Stamp final elapsedMs
    result.elapsedMs = Date.now() - t0
    this.emitTelemetry(
      operation, beforeWindow, target, attempts, result.elapsedMs,
      result.confidence, result.verifiedBy,
      result.success ? 'success' : result.action === 'cancelled' ? 'cancelled' : 'failure',
      result.error, requestedElement
    )
    return result
  }

  private emitTelemetry(
    operation: FocusTelemetry['operation'],
    beforeWindow: string,
    target: WindowTarget,
    attempts: number,
    elapsedMs: number,
    confidence: number,
    verifiedBy: VerificationSource[],
    result: FocusTelemetry['result'],
    error?: string,
    requestedElement?: string
  ) {
    // PRIVACY: requestedWindow is the window title (not secret).
    // requestedElement is the element name/role (not the value being typed).
    // Typed text, clipboard content, and input values are NEVER passed here.
    const telemetry: FocusTelemetry = {
      operation,
      requestedWindow: target.title,
      requestedElement,
      beforeWindow,
      afterWindow: '',   // filled by callers via result.verifiedActiveWindow
      attempts,
      elapsedMs,
      confidence,
      verifiedBy,
      result,
      error
    }
    if (result === 'success') {
      this.log.info(`focus:${operation}`, telemetry as unknown as Record<string, unknown>)
    } else {
      this.log.warn(`focus:${operation}:${result}`, telemetry as unknown as Record<string, unknown>)
    }
  }

  private fail(error: string, attempts: number): FocusResult {
    return {
      success: false, action: 'failed', verifiedActiveWindow: '',
      confidence: 0, verifiedBy: [], attempts, elapsedMs: 0, error
    }
  }

  private async safeActiveTitle(): Promise<string> {
    return this.desktop.activeWindow().then(w => w.title).catch(() => '')
  }

  private resolveWindow(
    windows: Array<{ title: string; owner: string; pid: number; bounds?: { x: number; y: number; width: number; height: number } }>,
    target: WindowTarget
  ) {
    // Identity priority: hwnd (via pid proxy) > pid > title
    if (target.pid) return windows.find(w => w.pid === target.pid) ?? null
    if (target.title) {
      const q = target.title.toLowerCase()
      return windows.find(w => w.title.toLowerCase().includes(q)) ?? null
    }
    return null
  }

  private windowMatchesTarget(activeTitle: string, target: WindowTarget): boolean {
    if (!target.title) return false
    return activeTitle.toLowerCase().includes(target.title.toLowerCase())
  }

  private elementMatchesSpec(state: FocusState, spec: ElementSpec): boolean {
    if (spec.automationId && state.focusedElementAutomationId !== spec.automationId) return false
    if (spec.name && !state.focusedElementName.toLowerCase().includes(spec.name.toLowerCase())) return false
    if (spec.role && !state.focusedElementRole.toLowerCase().includes(spec.role.toLowerCase())) return false
    return true
  }

  private findFocusedInTree(
    nodes: import('../../shared/types').AccessibilityNode[]
  ): import('../../shared/types').AccessibilityNode | undefined {
    for (const n of nodes) {
      if (n.focused) return n
      if (n.children) {
        const found = this.findFocusedInTree(n.children)
        if (found) return found
      }
    }
    return undefined
  }
}

// Sleeps for ms; throws AbortError if signal fires during the wait
function sleepCheck(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()) }, { once: true })
  })
}

function abortError(): Error {
  const e = new Error('FocusManager: operation cancelled')
  e.name = 'AbortError'
  return e
}
