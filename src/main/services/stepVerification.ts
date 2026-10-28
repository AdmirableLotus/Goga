import type { AgentStep, ToolResult } from '../../shared/types'
import type { VerificationSpec } from './verificationEngine'
import { PromptInjectionGuard } from './promptInjectionGuard'

/** Tools that only read state; a successful result is its own evidence. */
export const READ_ONLY_TOOLS = new Set([
  'computer.screenshot', 'computer.activeWindow', 'computer.windowList',
  'computer.uiElements', 'filesystem.read', 'filesystem.list',
  'filesystem.search', 'process.list', 'web.search', 'web.fetch',
  'memory.search', 'browser.read', 'browser.screenshot',
  'vision.analyze', 'vision.findElement',
])

function host(url: unknown): string {
  const raw = String(url ?? '').trim()
  if (!raw) return ''
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, '')
  } catch { return '' }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * A deterministic check of the tool's intended effect, or null when none exists.
 * Only checks that cannot misfire on a correct action belong here: a failed check
 * triggers a retry, and a false failure would make Goga repeat a real action.
 */
export function checkSpecFor(tool: string, params: Record<string, unknown>, result: ToolResult): VerificationSpec | null {
  switch (tool) {
    case 'browser.open': {
      const sessionId = str((result.data as { sessionId?: unknown } | undefined)?.sessionId)
      const expected = host(params.url)
      return sessionId && expected ? { type: 'url_contains', expected, sessionId } : null
    }
    case 'browser.navigate': {
      const sessionId = str(params.sessionId)
      const expected = host(params.url)
      return sessionId && expected ? { type: 'url_contains', expected, sessionId } : null
    }
    case 'computer.focusWindow':
    case 'computer.focus.window': {
      const windowTitle = str(params.title)
      return windowTitle ? { type: 'window_active', windowTitle } : null
    }
    case 'filesystem.write':
    case 'filesystem.mkdir': {
      const filePath = str(params.path)
      return filePath ? { type: 'file_exists', filePath } : null
    }
    case 'filesystem.move': {
      const filePath = str(params.to)
      return filePath ? { type: 'file_exists', filePath } : null
    }
    case 'filesystem.delete': {
      const filePath = str(params.path)
      return filePath ? { type: 'file_gone', filePath } : null
    }
    default:
      return null
  }
}

/** Stable action identity, including nested arguments without depending on key order. */
function actionParams(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
      : item)
}

/** Failed steps that no later successful retry of the same action fixed. */
export function unresolvedFailures(steps: AgentStep[]): AgentStep[] {
  return steps.filter((step, i) =>
    step.check?.outcome === 'failed' &&
    !steps.slice(i + 1).some(later => later.tool === step.tool &&
      actionParams(later.params) === actionParams(step.params) &&
      later.result.success && later.check?.outcome === 'passed'))
}

/** Appended to a "done" reply so Goga never claims success over a step it saw fail. */
export function honestyNote(steps: AgentStep[]): string {
  const failures = unresolvedFailures(steps)
  if (failures.length === 0) return ''
  const lines = failures.slice(-3).map(s => `- ${s.tool}: ${(s.check?.detail ?? 'failed').slice(0, 160)}`)
  return `\n\nHeads-up: I couldn't confirm every step worked:\n${lines.join('\n')}`
}

/** Readable text of what a read-only step returned (search hits, page text, file content). */
export function resultText(step: AgentStep): string {
  if (!step.result.success || !READ_ONLY_TOOLS.has(step.tool)) return ''
  const data = step.result.data as unknown
  if (data == null) return ''
  if (Array.isArray(data) && data.every(r => r && typeof r === 'object' && 'url' in r)) {
    return (data as { title?: string; url: string; snippet?: string }[])
      .map(r => `- ${r.title ?? ''} — ${r.url}${r.snippet ? `: ${r.snippet}` : ''}`).join('\n')
  }
  if (typeof data === 'object') {
    const { content: c, text, answer } = data as { content?: unknown; text?: unknown; answer?: unknown }
    const content = c ?? text ?? answer
    if (typeof content === 'string') return content
  }
  return typeof data === 'string' ? data : JSON.stringify(data)
}

/** Step history for the planner: the outcome, why a check failed, and (when
 *  resultChars > 0) what the step returned, wrapped as untrusted data. */
export function describeStepForPlanner(step: AgentStep, n: number, resultChars = 0): string {
  const call = `Step ${n}: ${step.tool}(${JSON.stringify(step.params).slice(0, 120)})`
  const check = step.check
  if (!step.result.success) return `${call} → FAILED: ${step.result.error ?? 'unknown error'}`
  if (check?.outcome === 'failed') return `${call} → RAN, BUT CHECK FAILED (${check.method}): ${check.detail.slice(0, 160)}`
  if (check?.outcome === 'doubtful') return `${call} → ran; screen check was doubtful: ${check.detail.slice(0, 160)}`
  const line = check?.outcome === 'passed'
    ? `${call} → SUCCESS (confirmed by ${check.method})`
    : `${call} → SUCCESS (not independently confirmed)`
  const text = resultChars > 0 ? resultText(step) : ''
  if (!text) return line
  const guard = PromptInjectionGuard.getInstance()
  const excerpt = text.length > resultChars ? `${text.slice(0, resultChars)}… [truncated]` : text
  const safe = guard.containsInjection(excerpt) ? guard.scan({ excerpt }).sanitized.excerpt : excerpt
  return `${line}\n${guard.wrapObservation(`${step.tool}_result`, safe)}`
}
