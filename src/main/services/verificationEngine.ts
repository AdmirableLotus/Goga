/**
 * VerificationEngine — Phase D
 *
 * Every action has an expected result. Verify deterministically first.
 * Only fall back to LLaVA/vision if no deterministic check is available.
 *
 * Verification priority:
 *   1. URL/title check (browser navigation)
 *   2. DOM state check (browser click/type)
 *   3. Window/process existence (app launch)
 *   4. Accessibility tree state (desktop focus/invoke)
 *   5. Filesystem state (file operations)
 *   6. Vision fallback (last resort)
 */

import { DesktopAdapter } from '../adapters/desktop'
import { BrowserAdapter } from '../adapters/browser'

// Lazy import of the shared browser singleton from tools/browser.ts.
// VerificationEngine must use the same BrowserAdapter instance that holds
// the active sessions — creating a new instance would have no sessions.
function getSharedBrowser(): BrowserAdapter {
  // tools/browser.ts exports `browserAdapter` — the singleton used by all
  // browser.* tool registrations. We import lazily to avoid circular deps
  // at module load time (tools/browser imports ToolRegistry which is fine,
  // but VerificationEngine is loaded before tools/index in some test paths).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../tools/browser')
    if (mod.browserAdapter instanceof BrowserAdapter) return mod.browserAdapter
  } catch { /* fall through to own instance */ }
  return new BrowserAdapter()
}

export type VerificationOutcome = 'passed' | 'failed' | 'inconclusive'

export interface VerificationResult {
  outcome: VerificationOutcome
  method: 'url' | 'dom' | 'window' | 'process' | 'accessibility' | 'filesystem' | 'vision' | 'none'
  detail: string
}

export interface VerificationSpec {
  type: 'url_contains' | 'title_contains' | 'dom_text_exists' | 'dom_text_gone'
       | 'window_exists' | 'window_active' | 'element_exists' | 'element_gone'
       | 'file_exists' | 'file_gone' | 'process_running' | 'dialog_gone' | 'none'
  expected?: string
  windowTitle?: string
  elementName?: string
  elementRole?: string
  sessionId?: string
  filePath?: string
  processName?: string
  /** CSS selector — when set, verifyDom evaluates textContent of the matched
   *  element directly instead of using getByText (which only finds visible text). */
  selector?: string
}

export class VerificationEngine {
  private static instance: VerificationEngine
  private desktop = new DesktopAdapter()
  private get browser(): BrowserAdapter { return getSharedBrowser() }

  static getInstance(): VerificationEngine {
    if (!VerificationEngine.instance) VerificationEngine.instance = new VerificationEngine()
    return VerificationEngine.instance
  }

  async verify(spec: VerificationSpec, signal?: AbortSignal): Promise<VerificationResult> {
    if (signal?.aborted) return { outcome: 'inconclusive', method: 'none', detail: 'cancelled' }

    try {
      switch (spec.type) {
        case 'url_contains':
          return this.verifyUrl(spec)
        case 'title_contains':
          return this.verifyTitle(spec)
        case 'dom_text_exists':
        case 'dom_text_gone':
          return this.verifyDom(spec)
        case 'window_exists':
          return this.verifyWindowExists(spec)
        case 'window_active':
          return this.verifyWindowActive(spec)
        case 'element_exists':
        case 'element_gone':
          return this.verifyElement(spec)
        case 'dialog_gone':
          return this.verifyDialogGone(spec)
        case 'file_exists':
        case 'file_gone':
          return this.verifyFile(spec)
        case 'process_running':
          return this.verifyProcess(spec)
        case 'none':
          return { outcome: 'inconclusive', method: 'none', detail: 'no verification spec provided' }
      }
    } catch (e) {
      return {
        outcome: 'inconclusive', method: 'none',
        detail: `verification error: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  /** Infer a verification spec from a tool call + params */
  inferSpec(tool: string, params: Record<string, unknown>, sessionId?: string): VerificationSpec {
    if (tool === 'browser.navigate' || tool === 'browser.open') {
      const url = String(params.url ?? '')
      return { type: 'url_contains', expected: url.slice(0, 60), sessionId }
    }
    if (tool === 'browser.clickByRole' || tool === 'browser.click') {
      // After a click, verify the page didn't crash (title still exists)
      return { type: 'title_contains', expected: '', sessionId }
    }
    if (tool === 'computer.focus.window' || tool === 'computer.focusWindow') {
      return { type: 'window_active', windowTitle: String(params.title ?? params.windowTitle ?? '') }
    }
    if (tool === 'computer.focus.ensure') {
      return { type: 'window_active', windowTitle: String(params.windowTitle ?? '') }
    }
    if (tool === 'computer.wait') {
      const wt = String(params.windowTitle ?? params.name ?? '')
      return { type: 'window_exists', windowTitle: wt }
    }
    if (tool === 'filesystem.write' || tool === 'filesystem.copy') {
      return { type: 'file_exists', filePath: String(params.path ?? params.dest ?? '') }
    }
    if (tool === 'process.launch' || tool === 'shell.run') {
      return { type: 'none' }
    }
    return { type: 'none' }
  }

  // ── Private verifiers ──────────────────────────────────────────────────────

  private async verifyUrl(spec: VerificationSpec): Promise<VerificationResult> {
    if (!spec.sessionId) return { outcome: 'inconclusive', method: 'url', detail: 'no sessionId' }
    try {
      const snap = await this.browser.snapshot(spec.sessionId)
      const matches = !spec.expected || snap.url.includes(spec.expected)
      return {
        outcome: matches ? 'passed' : 'failed', method: 'url',
        detail: `url="${snap.url}" expected to contain "${spec.expected}"`
      }
    } catch (e) {
      return { outcome: 'inconclusive', method: 'url', detail: String(e) }
    }
  }

  private async verifyTitle(spec: VerificationSpec): Promise<VerificationResult> {
    if (!spec.sessionId) return { outcome: 'inconclusive', method: 'url', detail: 'no sessionId' }
    try {
      const snap = await this.browser.snapshot(spec.sessionId)
      const matches = !spec.expected || snap.title.toLowerCase().includes(spec.expected.toLowerCase())
      return {
        outcome: matches ? 'passed' : 'failed', method: 'url',
        detail: `title="${snap.title}"`
      }
    } catch (e) {
      return { outcome: 'inconclusive', method: 'url', detail: String(e) }
    }
  }

  private async verifyDom(spec: VerificationSpec): Promise<VerificationResult> {
    if (!spec.sessionId) return { outcome: 'inconclusive', method: 'dom', detail: 'missing sessionId' }
    if (!spec.expected && !spec.selector) return { outcome: 'inconclusive', method: 'dom', detail: 'missing expected or selector' }
    const wantGone = spec.type === 'dom_text_gone'
    try {
      // Path 1: CSS selector provided — evaluate textContent directly.
      // This works for hidden elements that getByText cannot find.
      if (spec.selector) {
        const r = await this.browser.evaluate(
          spec.sessionId,
          `(function(){
            var el = document.querySelector(${JSON.stringify(spec.selector)});
            if (!el) return null;
            return el.textContent || el.value || '';
          })()`
        )
        const text = r.result == null ? null : String(r.result)
        if (text === null) {
          return { outcome: wantGone ? 'passed' : 'failed', method: 'dom',
            detail: `selector="${spec.selector}" element not found` }
        }
        const matches = spec.expected ? text.includes(spec.expected) : text.length > 0
        return {
          outcome: (wantGone ? !matches : matches) ? 'passed' : 'failed',
          method: 'dom',
          detail: `selector="${spec.selector}" text="${text.slice(0,80)}" expected="${spec.expected ?? '(any)'}" matches=${matches}`
        }
      }
      // Path 2: No selector — use getByText (visible text only).
      const r = await this.browser.getByText(spec.sessionId, spec.expected!)
      const found = r.found && r.count > 0
      return {
        outcome: (wantGone ? !found : found) ? 'passed' : 'failed',
        method: 'dom',
        detail: `text="${spec.expected}" found=${found} wantGone=${wantGone}`
      }
    } catch (e) {
      return { outcome: 'inconclusive', method: 'dom', detail: String(e) }
    }
  }

  private async verifyWindowExists(spec: VerificationSpec): Promise<VerificationResult> {
    const windows = await this.desktop.windowList().catch(() => [])
    const q = (spec.windowTitle ?? '').toLowerCase()
    const found = windows.some(w => w.title.toLowerCase().includes(q))
    return {
      outcome: found ? 'passed' : 'failed', method: 'window',
      detail: `window "${spec.windowTitle}" ${found ? 'found' : 'not found'} in ${windows.length} windows`
    }
  }

  private async verifyWindowActive(spec: VerificationSpec): Promise<VerificationResult> {
    const active = await this.desktop.activeWindow().catch(() => null)
    if (!active) return { outcome: 'failed', method: 'window', detail: 'no active window' }
    const q = (spec.windowTitle ?? '').toLowerCase()
    const matches = !q || active.title.toLowerCase().includes(q)
    return {
      outcome: matches ? 'passed' : 'failed', method: 'window',
      detail: `active="${active.title}" expected="${spec.windowTitle}"`
    }
  }

  private async verifyElement(spec: VerificationSpec): Promise<VerificationResult> {
    const el = await this.desktop.findElement({
      name: spec.elementName, role: spec.elementRole, windowTitle: spec.windowTitle
    }).catch(() => null)
    const found = el !== null
    const wantGone = spec.type === 'element_gone'
    return {
      outcome: (wantGone ? !found : found) ? 'passed' : 'failed',
      method: 'accessibility',
      detail: `element name="${spec.elementName}" role="${spec.elementRole}" found=${found}`
    }
  }

  private async verifyDialogGone(spec: VerificationSpec): Promise<VerificationResult> {
    if (spec.sessionId) {
      // Browser dialog
      try {
        const r = await this.browser.getByRole(spec.sessionId, 'dialog')
        return {
          outcome: !r.found ? 'passed' : 'failed', method: 'dom',
          detail: `dialog found=${r.found}`
        }
      } catch (e) {
        return { outcome: 'inconclusive', method: 'dom', detail: String(e) }
      }
    }
    // Desktop dialog
    const el = await this.desktop.findElement({ role: 'Dialog', windowTitle: spec.windowTitle }).catch(() => null)
    return {
      outcome: !el ? 'passed' : 'failed', method: 'accessibility',
      detail: `desktop dialog ${el ? 'still present' : 'gone'}`
    }
  }

  private async verifyFile(spec: VerificationSpec): Promise<VerificationResult> {
    if (!spec.filePath) return { outcome: 'inconclusive', method: 'filesystem', detail: 'no filePath' }
    const fs = require('fs') as typeof import('fs')
    const exists = fs.existsSync(spec.filePath)
    const wantGone = spec.type === 'file_gone'
    return {
      outcome: exists !== wantGone ? 'passed' : 'failed', method: 'filesystem',
      detail: `file "${spec.filePath}" ${exists ? 'exists' : 'not found'}`
    }
  }

  private async verifyProcess(spec: VerificationSpec): Promise<VerificationResult> {
    if (!spec.processName) return { outcome: 'inconclusive', method: 'none', detail: 'no processName' }
    const windows = await this.desktop.windowList().catch(() => [])
    const found = windows.some(w =>
      w.owner.toLowerCase().includes(spec.processName!.toLowerCase()) ||
      w.title.toLowerCase().includes(spec.processName!.toLowerCase())
    )
    return {
      outcome: found ? 'passed' : 'failed', method: 'process',
      detail: `process "${spec.processName}" ${found ? 'found' : 'not found'}`
    }
  }
}
