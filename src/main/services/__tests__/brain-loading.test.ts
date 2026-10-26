import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  ready: false,
  localChat: vi.fn(),
  ollamaChat: vi.fn(),
  wait: vi.fn(),
}))
vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => ({ userName: 'Fixture', agentMaxSteps: 20, primaryModel: 'local' }) }) } }))
vi.mock('../brain', () => ({ BrainService: { getInstance: () => ({ getRelevantFacts: () => [], findRelevantFacts: async () => [] }) } }))
vi.mock('../actionStore', () => ({ ActionStore: { getInstance: () => ({ stopAll: vi.fn(), add: vi.fn() }) } }))
vi.mock('../localLlama', async importOriginal => ({
  ...(await importOriginal<typeof import('../localLlama')>()),
  LocalLlamaService: { getInstance: () => ({
    isReady: () => boundary.ready,
    getState: () => ({ status: boundary.ready ? 'ready' : 'loading', modelPath: 'fixture.gguf' }),
    waitWhileLoading: boundary.wait,
    chat: boundary.localChat,
  }) },
}))
vi.mock('../ollamaClient', () => ({ OllamaClient: vi.fn(() => ({ chat: boundary.ollamaChat })) }))
vi.mock('../taskMemory', () => ({ TaskMemoryService: { getInstance: () => ({ findRelevant: () => [], save_pattern: vi.fn() }) } }))
vi.mock('../securityWorkspace', () => ({ SecurityWorkspaceService: { getInstance: () => ({ getActive: () => null, invalidateApprovals: () => {} }) } }))
vi.mock('../authorization', () => ({ AuthorizationService: { getInstance: () => ({ evaluateAndLog: () => ({ allowed: true, requiresApproval: false }) }) } }))
vi.mock('../../adapters/desktop', () => ({ DesktopAdapter: vi.fn(() => ({ screenshot: vi.fn(), activeWindow: vi.fn() })) }))
vi.mock('../../index', () => ({ getMainWindow: () => null }))
vi.mock('../../tools/registry', () => ({ ToolRegistry: { getInstance: () => ({ get: () => undefined, list: () => [], toPromptSummary: () => '' }) } }))
import { AgentLoop } from '../agentLoop'

const validTool = '{"thought":"open it","tool":"browser.openExternal","params":{"url":"https://google.com"}}'
const plan = (agent: AgentLoop, signal = new AbortController().signal) =>
  (agent as any).planNextStep('open google.com', [], 'fixture-screenshot', '', '', signal)

beforeEach(() => {
  boundary.ready = false
  boundary.localChat.mockReset().mockResolvedValue(validTool)
  boundary.ollamaChat.mockReset().mockResolvedValue(validTool)
  boundary.wait.mockReset().mockImplementation(async () => { boundary.ready = true; return true })
})

describe('planner while the local brain is loading', () => {
  it('waits for the brain instead of falling back to the backup model', async () => {
    const result = await plan(new AgentLoop())
    expect(boundary.wait).toHaveBeenCalledOnce()
    expect(boundary.localChat).toHaveBeenCalledOnce()
    expect(boundary.ollamaChat).not.toHaveBeenCalled()
    expect(result).toMatchObject({ tool: 'browser.openExternal', done: false })
  })

  it('never sends screenshots to the text-only planner, even on the backup', async () => {
    boundary.wait.mockResolvedValue(false)  // brain failed to load → backup
    await plan(new AgentLoop())
    expect(boundary.ollamaChat).toHaveBeenCalledOnce()
    const messages = boundary.ollamaChat.mock.calls[0][0] as { images?: string[]; content: string }[]
    expect(messages.every(m => m.images === undefined)).toBe(true)
    expect(messages.map(m => m.content).join('\n')).not.toContain('Screenshot attached')
  })

  it('Stop during the wait ends planning without calling any model', async () => {
    const abort = new AbortController()
    boundary.wait.mockImplementation(async () => { abort.abort(); return false })
    const result = await plan(new AgentLoop(), abort.signal)
    expect(result).toMatchObject({ done: true, reply: 'Stopped.' })
    expect(boundary.localChat).not.toHaveBeenCalled()
    expect(boundary.ollamaChat).not.toHaveBeenCalled()
  })
})
