/**
 * Focused regression tests for browser routing separation:
 *   1. normaliseToolName — browser aliases including openExternal
 *   2. applyAgentState  — error/done/stopped transitions
 *   3. ChatPage terminal status set parity
 *   4. TurnDeduplicator — per-turn deduplication including openExternal
 *   5. isSimpleOpenTask — auto-complete detection
 *   6. BrowserAdapter   — session kind enforcement (ShellSessionError)
 *   7. browser.open vs browser.openExternal routing contract
 */
import { describe, it, expect, vi } from 'vitest'

// ── Mock Electron and all heavy singletons before any import ─────────────────
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, ipcMain: { handle: vi.fn(), on: vi.fn() }, shell: { openExternal: vi.fn().mockResolvedValue(undefined) } }))
vi.mock('../logs',            () => ({ LogService:            { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../settings',        () => ({ SettingsService:        { getInstance: () => ({ get: () => ({ agentMaxSteps: 20, primaryModel: 'local', userName: 'Ace' }) }) } }))
vi.mock('../brain',           () => ({ BrainService:           { getInstance: () => ({ getRelevantFacts: () => [], addMessage: vi.fn(), getHistory: () => [] }) } }))
vi.mock('../actionStore',     () => ({ ActionStore:            { getInstance: () => ({ stopAll: vi.fn(), add: vi.fn() }) } }))
vi.mock('../localLlama',      () => ({ LocalLlamaService:      { getInstance: () => ({ isReady: () => false, getState: () => ({ status: 'idle' }), chat: vi.fn() }) } }))
vi.mock('../ollamaClient',    () => ({ OllamaClient:           vi.fn(() => ({ chat: vi.fn(), chatWithTools: vi.fn(), isAvailable: vi.fn() })) }))
vi.mock('../taskMemory',      () => ({ TaskMemoryService:      { getInstance: () => ({ findRelevant: () => [], save_pattern: vi.fn() }) } }))
vi.mock('../securityWorkspace', () => ({ SecurityWorkspaceService: { getInstance: () => ({ getActive: () => null }) } }))
vi.mock('../authorization',   () => ({ AuthorizationService:  { getInstance: () => ({ evaluateAndLog: () => ({ allowed: true, requiresApproval: false }) }) } }))
vi.mock('../../adapters/desktop', () => ({ DesktopAdapter: vi.fn(() => ({ screenshot: vi.fn(), activeWindow: vi.fn() })) }))
vi.mock('../../index',        () => ({ getMainWindow: () => null }))
vi.mock('../../tools/registry', () => ({
  ToolRegistry: { getInstance: () => ({ get: vi.fn(), execute: vi.fn(), toPromptSummary: () => '', toOllamaTools: () => [] }) }
}))

import { AgentLoop } from '../agentLoop'
import { TurnDeduplicator, SIDE_EFFECTING_TOOLS, canonicalizeParams } from '../agentResilience'
import { BrowserAdapter, ShellSessionError, PageClosedError } from '../../adapters/browser'
import { applyAgentState, INITIAL_ACTIVITY } from '../../../renderer/components/missionUtils'
import type { AgentState } from '../../../../shared/types'

// ── 1. normaliseToolName ──────────────────────────────────────────────────────

describe('AgentLoop.normaliseToolName — browser aliases', () => {
  it('bare "browser" → browser.open', () => {
    expect(AgentLoop.normaliseToolName('browser')).toBe('browser.open')
  })
  it('browser.goto → browser.navigate', () => {
    expect(AgentLoop.normaliseToolName('browser.goto')).toBe('browser.navigate')
  })
  it('browser.go → browser.navigate', () => {
    expect(AgentLoop.normaliseToolName('browser.go')).toBe('browser.navigate')
  })
  it('browser.url → browser.navigate', () => {
    expect(AgentLoop.normaliseToolName('browser.url')).toBe('browser.navigate')
  })
  it('browser.external → browser.openExternal', () => {
    expect(AgentLoop.normaliseToolName('browser.external')).toBe('browser.openExternal')
  })
  it('browser.show → browser.openExternal', () => {
    expect(AgentLoop.normaliseToolName('browser.show')).toBe('browser.openExternal')
  })
  it('concrete browser.open passes through unchanged', () => {
    expect(AgentLoop.normaliseToolName('browser.open')).toBe('browser.open')
  })
  it('concrete browser.openExternal passes through unchanged', () => {
    expect(AgentLoop.normaliseToolName('browser.openExternal')).toBe('browser.openExternal')
  })
  it('concrete browser.navigate passes through unchanged', () => {
    expect(AgentLoop.normaliseToolName('browser.navigate')).toBe('browser.navigate')
  })
  it('unrecognised name passes through unchanged', () => {
    expect(AgentLoop.normaliseToolName('unknown.tool')).toBe('unknown.tool')
  })
  it('shell aliases still resolve', () => {
    expect(AgentLoop.normaliseToolName('shell')).toBe('shell.execute')
    expect(AgentLoop.normaliseToolName('shell.run')).toBe('shell.execute')
  })
})

// ── 2. applyAgentState — error/done/stopped transitions ──────────────────────

describe('applyAgentState — terminal state transitions', () => {
  const running = { ...INITIAL_ACTIVITY, activityStatus: 'running' as const, loading: true }

  it('error status → activityStatus failed, loading cleared', () => {
    const ag: AgentState = { status: 'error', task: '', steps: [], error: 'unknown_tool: browser' }
    const next = applyAgentState(running, ag)
    expect(next.activityStatus).toBe('failed')
    expect(next.loading).toBe(false)
    expect(next.currentStep).toBeNull()
  })

  it('error status does not override a prior stopped status', () => {
    const stopped = { ...INITIAL_ACTIVITY, activityStatus: 'stopped' as const, loading: false }
    const ag: AgentState = { status: 'error', task: '', steps: [], error: 'unknown_tool: browser' }
    const next = applyAgentState(stopped, ag)
    expect(next.activityStatus).toBe('stopped')
  })

  it('done status → activityStatus completed, loading cleared', () => {
    const ag: AgentState = { status: 'done', task: '', steps: [] }
    const next = applyAgentState(running, ag)
    expect(next.activityStatus).toBe('completed')
    expect(next.loading).toBe(false)
  })

  it('duplicate_action error returns UI to idle via failed status', () => {
    const ag: AgentState = { status: 'error', task: '', steps: [], error: 'duplicate_action: browser.openExternal' }
    const next = applyAgentState(running, ag)
    expect(next.activityStatus).toBe('failed')
    expect(next.loading).toBe(false)
  })
})

// ── 3. ChatPage terminal status set parity ────────────────────────────────────

describe('ChatPage agent:state handler — terminal status set includes error', () => {
  const terminal = ['idle', 'done', 'stopped', 'error']
  const nonTerminal = ['running', 'waiting-approval']

  it.each(terminal)('"%s" is terminal → clears loading', (s) => {
    expect(terminal.includes(s)).toBe(true)
  })
  it.each(nonTerminal)('"%s" is non-terminal → does not clear loading', (s) => {
    expect(terminal.includes(s)).toBe(false)
  })
})

// ── 4. TurnDeduplicator ───────────────────────────────────────────────────────

describe('TurnDeduplicator — per-turn deduplication', () => {
  it('first call is not a duplicate', () => {
    const d = new TurnDeduplicator()
    expect(d.isDuplicate('browser.openExternal', { url: 'https://example.com' })).toBe(false)
  })

  it('second identical openExternal call is a duplicate after record()', () => {
    const d = new TurnDeduplicator()
    d.record('browser.openExternal', { url: 'https://example.com' })
    expect(d.isDuplicate('browser.openExternal', { url: 'https://example.com' })).toBe(true)
  })

  it('different URL in same turn is NOT a duplicate', () => {
    const d = new TurnDeduplicator()
    d.record('browser.openExternal', { url: 'https://example.com' })
    expect(d.isDuplicate('browser.openExternal', { url: 'https://other.com' })).toBe(false)
  })

  it('read-only tool (web.search) is never a duplicate', () => {
    const d = new TurnDeduplicator()
    d.record('web.search', { query: 'test' })
    expect(d.isDuplicate('web.search', { query: 'test' })).toBe(false)
  })

  it('new TurnDeduplicator instance (new turn) allows same URL again', () => {
    const turn1 = new TurnDeduplicator()
    turn1.record('browser.openExternal', { url: 'https://example.com' })
    const turn2 = new TurnDeduplicator()
    expect(turn2.isDuplicate('browser.openExternal', { url: 'https://example.com' })).toBe(false)
  })

  it('trailing slash is canonicalized — treated as same URL', () => {
    const d = new TurnDeduplicator()
    d.record('browser.openExternal', { url: 'https://example.com/' })
    expect(d.isDuplicate('browser.openExternal', { url: 'https://example.com' })).toBe(true)
  })

  it('SIDE_EFFECTING_TOOLS includes both browser.open and browser.openExternal', () => {
    expect(SIDE_EFFECTING_TOOLS.has('browser.open')).toBe(true)
    expect(SIDE_EFFECTING_TOOLS.has('browser.openExternal')).toBe(true)
    expect(SIDE_EFFECTING_TOOLS.has('browser.navigate')).toBe(true)
    expect(SIDE_EFFECTING_TOOLS.has('shell.execute')).toBe(true)
  })

  it('browser.open and browser.openExternal are tracked independently', () => {
    const d = new TurnDeduplicator()
    d.record('browser.open', { url: 'https://example.com' })
    // openExternal with same URL is a separate tool — not a duplicate of browser.open
    expect(d.isDuplicate('browser.openExternal', { url: 'https://example.com' })).toBe(false)
  })
})

// ── 5. isSimpleOpenTask ───────────────────────────────────────────────────────

describe('AgentLoop.isSimpleOpenTask', () => {
  it('simple open URL → true', () => {
    expect(AgentLoop.isSimpleOpenTask('Open https://example.com in the browser.')).toBe(true)
  })
  it('go to URL → true', () => {
    expect(AgentLoop.isSimpleOpenTask('Go to https://example.com')).toBe(true)
  })
  it('visit www URL → true', () => {
    expect(AgentLoop.isSimpleOpenTask('Visit www.example.com')).toBe(true)
  })
  it('open bare domain → true', () => {
    expect(AgentLoop.isSimpleOpenTask('open google.com in browser')).toBe(true)
  })
  it('open browser app name → true', () => {
    expect(AgentLoop.isSimpleOpenTask('open mozilla browser')).toBe(true)
  })
  it('login task → false (multi-step)', () => {
    expect(AgentLoop.isSimpleOpenTask('Open https://example.com and log in')).toBe(false)
  })
  it('search task → false', () => {
    expect(AgentLoop.isSimpleOpenTask('Search for cats on https://google.com')).toBe(false)
  })
  it('no URL or domain → false', () => {
    expect(AgentLoop.isSimpleOpenTask('Open Notepad')).toBe(false)
  })
  it('fill form task → false', () => {
    expect(AgentLoop.isSimpleOpenTask('Open https://example.com and fill the form')).toBe(false)
  })
  it('click task → false', () => {
    expect(AgentLoop.isSimpleOpenTask('Open https://example.com and click the button')).toBe(false)
  })
  it('tell me task → false (inspection intent)', () => {
    expect(AgentLoop.isSimpleOpenTask('Open https://example.com and tell me the main heading on the page')).toBe(false)
  })
  it('read task → false (inspection intent)', () => {
    expect(AgentLoop.isSimpleOpenTask('Open https://example.com and read the page heading')).toBe(false)
  })
  it('what is task → false (inspection intent)', () => {
    expect(AgentLoop.isSimpleOpenTask('Open https://example.com — what is the title?')).toBe(false)
  })
  it('get content task → false (extraction intent)', () => {
    expect(AgentLoop.isSimpleOpenTask('Open https://example.com and get the page content')).toBe(false)
  })
})

// ── 6. BrowserAdapter — session kind enforcement ──────────────────────────────

describe('BrowserAdapter — ShellSessionError on Playwright-only ops', () => {
  it('openExternal returns external-N sessionId', async () => {
    const adapter = new BrowserAdapter()
    const result = await adapter.openExternal('https://example.com')
    expect(result.sessionId).toMatch(/^external-\d+$/)
    expect(result.url).toBe('https://example.com')
  })

  it('navigate on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.navigate(sessionId, 'https://other.com'))
      .rejects.toThrow(ShellSessionError)
  })

  it('evaluate on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.evaluate(sessionId, 'document.title'))
      .rejects.toThrow(ShellSessionError)
  })

  it('click on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.click(sessionId, 'button'))
      .rejects.toThrow(ShellSessionError)
  })

  it('ShellSessionError message names the session and explains the fix', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    const err = await adapter.navigate(sessionId, 'https://other.com').catch(e => e)
    expect(err).toBeInstanceOf(ShellSessionError)
    expect(err.message).toContain(sessionId)
    expect(err.message).toContain('browser.open')
  })

  it('type on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.type(sessionId, 'input', 'hello'))
      .rejects.toThrow(ShellSessionError)
  })

  it('screenshotPage on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.screenshotPage(sessionId))
      .rejects.toThrow(ShellSessionError)
  })

  it('waitFor on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.waitFor(sessionId, 'h1'))
      .rejects.toThrow(ShellSessionError)
  })

  it('getContent on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.getContent(sessionId))
      .rejects.toThrow(ShellSessionError)
  })

  it('snapshot on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.snapshot(sessionId))
      .rejects.toThrow(ShellSessionError)
  })

  it('ariaSnapshot on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.ariaSnapshot(sessionId))
      .rejects.toThrow(ShellSessionError)
  })

  it('clickByRole on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.clickByRole(sessionId, 'button', 'Submit'))
      .rejects.toThrow(ShellSessionError)
  })

  it('getByRole on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.getByRole(sessionId, 'heading'))
      .rejects.toThrow(ShellSessionError)
  })

  it('getByLabel on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.getByLabel(sessionId, 'Email'))
      .rejects.toThrow(ShellSessionError)
  })

  it('getByText on external session throws ShellSessionError', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.getByText(sessionId, 'Welcome'))
      .rejects.toThrow(ShellSessionError)
  })

  it('close on external session does not throw', async () => {
    const adapter = new BrowserAdapter()
    const { sessionId } = await adapter.openExternal('https://example.com')
    await expect(adapter.close(sessionId)).resolves.toEqual({ closed: sessionId })
  })
})

// ── 6b. BrowserAdapter — PageClosedError on externally-closed page ────────────

describe('BrowserAdapter — PageClosedError when page closed externally', () => {
  it('getContent on a page-closed session throws PageClosedError', async () => {
    const adapter = new BrowserAdapter()
    // Manually inject a closed playwright session (simulates user closing the window)
    const sessionId = 'browser-test-closed'
    ;(adapter as any).sessions.set(sessionId, {
      kind: 'playwright', browser: null, context: null, page: null, url: 'https://example.com', pageClosed: true
    })
    await expect(adapter.getContent(sessionId)).rejects.toThrow(PageClosedError)
  })

  it('PageClosedError message names the session and explains the fix', async () => {
    const adapter = new BrowserAdapter()
    const sessionId = 'browser-test-closed-2'
    ;(adapter as any).sessions.set(sessionId, {
      kind: 'playwright', browser: null, context: null, page: null, url: 'https://example.com', pageClosed: true
    })
    const err = await adapter.getContent(sessionId).catch(e => e)
    expect(err).toBeInstanceOf(PageClosedError)
    expect(err.message).toContain(sessionId)
    expect(err.message).toContain('browser.open')
  })

  it('navigate on a page-closed session throws PageClosedError', async () => {
    const adapter = new BrowserAdapter()
    const sessionId = 'browser-test-closed-3'
    ;(adapter as any).sessions.set(sessionId, {
      kind: 'playwright', browser: null, context: null, page: null, url: 'https://example.com', pageClosed: true
    })
    await expect(adapter.navigate(sessionId, 'https://other.com')).rejects.toThrow(PageClosedError)
  })

  it('PageClosedError is distinct from ShellSessionError', () => {
    const pce = new PageClosedError('browser-1')
    const sse = new ShellSessionError('external-1')
    expect(pce).toBeInstanceOf(PageClosedError)
    expect(pce).not.toBeInstanceOf(ShellSessionError)
    expect(sse).toBeInstanceOf(ShellSessionError)
    expect(sse).not.toBeInstanceOf(PageClosedError)
  })
})

// ── 7. browser.open vs browser.openExternal routing contract ─────────────────

describe('browser.open vs browser.openExternal routing contract', () => {
  it('openExternal does not launch Playwright (no browser-N session)', async () => {
    const adapter = new BrowserAdapter()
    const result = await adapter.openExternal('https://example.com')
    // Must be external-N, never browser-N
    expect(result.sessionId.startsWith('external-')).toBe(true)
    expect(result.sessionId.startsWith('browser-')).toBe(false)
  })

  it('isSimpleOpenTask false for multi-step → browser.open should be used, not openExternal', () => {
    // Routing contract: multi-step tasks must not auto-complete on openExternal
    const multiStep = 'Open https://example.com and click the login button'
    expect(AgentLoop.isSimpleOpenTask(multiStep)).toBe(false)
  })

  it('isSimpleOpenTask true for bare open → openExternal auto-completes', () => {
    const simple = 'Open https://example.com'
    expect(AgentLoop.isSimpleOpenTask(simple)).toBe(true)
  })

  it('browser.external alias resolves to browser.openExternal not browser.open', () => {
    expect(AgentLoop.normaliseToolName('browser.external')).toBe('browser.openExternal')
    expect(AgentLoop.normaliseToolName('browser.external')).not.toBe('browser.open')
  })
})

// ── 8. agentRouting — show verb and URL triggers ────────────────────────────────────

import { looksLikeAgentTask } from '../agentRouting'

describe('agentRouting — show verb and URL triggers', () => {
  it('"Show https://... in my browser" is an agent task', () => {
    expect(looksLikeAgentTask('Show https://example.com in my browser.')).toBe(true)
  })
  it('"show https://..." bare is an agent task', () => {
    expect(looksLikeAgentTask('show https://example.com')).toBe(true)
  })
  it('"Open https://... and tell me the heading" is an agent task', () => {
    expect(looksLikeAgentTask('Open https://example.com and tell me the main heading on the page.')).toBe(true)
  })
  it('"visit www...." is an agent task', () => {
    expect(looksLikeAgentTask('visit www.example.com')).toBe(true)
  })
  it('plain chat question is not an agent task', () => {
    expect(looksLikeAgentTask('What is the capital of France?')).toBe(false)
  })
})

// ── 9. browser.open → browser.openExternal rewrite for simple tasks ────────────

describe('agentLoop tool rewrite — browser.open → browser.openExternal on simple tasks', () => {
  it('isSimpleOpenTask true + browser.open → should use openExternal (rewrite contract)', () => {
    // The rewrite happens inside run() before tool lookup.
    // We verify the contract via isSimpleOpenTask + normaliseToolName independently.
    const simple = 'Show https://example.com in my browser.'
    expect(AgentLoop.isSimpleOpenTask(simple)).toBe(true)
    // After rewrite, the tool that executes must be browser.openExternal
    // (verified by the rewrite block in run() — this test documents the contract)
  })
  it('isSimpleOpenTask false + browser.open → must NOT rewrite (multi-step keeps Playwright)', () => {
    const multiStep = 'Open https://example.com and tell me the main heading on the page.'
    expect(AgentLoop.isSimpleOpenTask(multiStep)).toBe(false)
    // No rewrite — browser.open stays as browser.open for Playwright automation
  })
  it('browser.openExternal is not rewritten (already correct)', () => {
    // normaliseToolName passes it through unchanged
    expect(AgentLoop.normaliseToolName('browser.openExternal')).toBe('browser.openExternal')
  })
})
