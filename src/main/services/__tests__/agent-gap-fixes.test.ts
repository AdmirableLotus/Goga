import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolResult } from '../../../shared/types'

// Fixes for the top gaps in Goga's own journal: repeating an action that already worked,
// and asking for tools under invented names.

const boundary = vi.hoisted(() => ({ execute: vi.fn(), verify: vi.fn() }))
const KNOWN = new Set(['browser.open', 'shell.execute', 'filesystem.search', 'trading.analyze'])
vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => ({ agentMaxSteps: 20 }) }) } }))
vi.mock('../brain', () => ({ BrainService: { getInstance: () => ({ getRelevantFacts: () => [], findRelevantFacts: async () => [] }) } }))
vi.mock('../actionStore', () => ({ ActionStore: { getInstance: () => ({ stopAll: vi.fn() }) } }))
vi.mock('../localLlama', () => ({ LocalLlamaService: { getInstance: () => ({}) } }))
vi.mock('../ollamaClient', () => ({ OllamaClient: vi.fn(() => ({})) }))
vi.mock('../taskMemory', () => ({ TaskMemoryService: { getInstance: () => ({ findRelevant: () => [], save_pattern: vi.fn() }) } }))
vi.mock('../authorization', () => ({ AuthorizationService: { getInstance: () => ({ evaluateAndLog: () => ({ allowed: true, requiresApproval: false }) }) } }))
vi.mock('../verificationEngine', () => ({ VerificationEngine: { getInstance: () => ({ verify: boundary.verify }) } }))
vi.mock('../gapJournal', () => ({ gapJournal: () => undefined, gapFromAgentEnd: () => null }))
vi.mock('../../adapters/desktop', () => ({ DesktopAdapter: vi.fn(() => ({
  screenshot: vi.fn().mockRejectedValue(new Error('No desktop in unit test')),
  activeWindow: vi.fn().mockResolvedValue({ owner: 'fixture' }),
})) }))
vi.mock('../../index', () => ({ getMainWindow: () => null }))
vi.mock('../../tools/registry', () => ({ ToolRegistry: { getInstance: () => ({
  get: (name: string) => KNOWN.has(name) ? { definition: { name } } : undefined,
  execute: boundary.execute, list: () => [...KNOWN].map(name => ({ name })),
}) } }))
import { AgentLoop } from '../agentLoop'

const done = (reply: string) => ({ thought: 'finished', tool: '', params: {}, done: true, reply })

beforeEach(() => {
  boundary.execute.mockReset().mockResolvedValue({ success: true, data: {} } satisfies ToolResult)
  boundary.verify.mockReset()
})

describe('repeating an action that already worked', () => {
  it('finishes as done instead of failing', async () => {
    const agent = new AgentLoop()
    const open = { tool: 'browser.open', thought: 'open it', params: { url: 'https://example.com/research' }, done: false }
    vi.spyOn(agent as any, 'planNextStep').mockResolvedValue(open)
    const reply = await agent.run('research my code on example.com')
    expect(boundary.execute).toHaveBeenCalledTimes(1)
    expect(reply).toMatch(/^Done — I opened https:\/\/example\.com\/research/)
    expect(agent.getState().status).toBe('done')
  })

  it('still stops with an error when the first try failed', async () => {
    boundary.execute.mockResolvedValue({ success: false, error: 'boom' })
    const agent = new AgentLoop()
    const cmd = { tool: 'shell.execute', thought: 'run', params: { command: 'x' }, done: false }
    vi.spyOn(agent as any, 'planNextStep').mockResolvedValue(cmd)
    const reply = await agent.run('run x')
    expect(agent.getState().status).toBe('error')
    expect(reply).not.toMatch(/^Done/)
  })
})

describe('the same lookup over and over', () => {
  it('stops after a few runs and reports what it found', async () => {
    boundary.execute.mockResolvedValue({ success: true, data: { readable: 'AAPL daily: trend up, RSI 48' } })
    const agent = new AgentLoop()
    let n = 0
    vi.spyOn(agent as any, 'planNextStep').mockImplementation(async () =>
      ({ tool: 'trading.analyze', thought: 'analyze', params: { symbol: 'AAPL', timeframe: ['1Day', '1Hour', '1Week'][n++ % 3], note: n }, done: false }))
    const reply = await agent.run('analyze AAPL and plan a buy')
    expect(boundary.execute).toHaveBeenCalledTimes(4)
    expect(reply).toMatch(/kept running trading\.analyze \(4 times\)[\s\S]*trend up, RSI 48/)
    expect(agent.getState().status).toBe('done')
  })
})

describe('invented tool names', () => {
  it('runs "terminal" as the real shell tool', async () => {
    const agent = new AgentLoop()
    vi.spyOn(agent as any, 'planNextStep')
      .mockResolvedValueOnce({ tool: 'terminal', thought: 'install', params: { command: 'pip --version' }, done: false })
      .mockResolvedValueOnce(done('Installed.'))
    const reply = await agent.run('install the package')
    expect(boundary.execute).toHaveBeenCalledWith('shell.execute', { command: 'pip --version' }, expect.anything())
    expect(reply).toBe('Installed.')
  })

  it('asks the user instead of calling a made-up "clarify" tool', async () => {
    const agent = new AgentLoop()
    vi.spyOn(agent as any, 'planNextStep').mockResolvedValueOnce({ tool: 'clarify_query', thought: 'unclear', params: { question: 'Which folder do you mean?' }, done: false })
    const reply = await agent.run('review it')
    expect(reply).toBe('Which folder do you mean?')
    expect(boundary.execute).not.toHaveBeenCalled()
    expect(agent.getState().status).toBe('done')
  })
})
