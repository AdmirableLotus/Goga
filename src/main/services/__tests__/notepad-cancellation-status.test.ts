import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolResult } from '../../../shared/types'
import {
  INITIAL_ACTIVITY, subscribeActivityEvents,
  type ActivityCallbacks, type ActivityState, type GogaEventBus,
} from '../../../renderer/components/missionUtils'

const boundary = vi.hoisted(() => ({ execute: vi.fn(), send: vi.fn(), savePattern: vi.fn() }))
vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => ({ agentMaxSteps: 20 }) }) } }))
vi.mock('../brain', () => ({ BrainService: { getInstance: () => ({ getRelevantFacts: () => [], findRelevantFacts: async () => [] }) } }))
vi.mock('../actionStore', () => ({ ActionStore: { getInstance: () => ({ stopAll: vi.fn() }) } }))
vi.mock('../localLlama', () => ({ LocalLlamaService: { getInstance: () => ({}) } }))
vi.mock('../ollamaClient', () => ({ OllamaClient: vi.fn(() => ({})) }))
vi.mock('../taskMemory', () => ({ TaskMemoryService: { getInstance: () => ({ findRelevant: () => [], save_pattern: boundary.savePattern }) } }))
vi.mock('../authorization', () => ({ AuthorizationService: { getInstance: () => ({ evaluateAndLog: () => ({ allowed: true, requiresApproval: false }) }) } }))
vi.mock('../../adapters/desktop', () => ({ DesktopAdapter: vi.fn(() => ({
  screenshot: vi.fn().mockRejectedValue(new Error('No desktop in unit test')),
  activeWindow: vi.fn().mockResolvedValue({ owner: 'fixture' }),
})) }))
vi.mock('../../index', () => ({ getMainWindow: () => ({ webContents: { send: boundary.send } }) }))
vi.mock('../../tools/registry', () => ({ ToolRegistry: { getInstance: () => ({
  get: () => ({ definition: { name: 'notepad.saveText' } }), execute: boundary.execute,
}) } }))
import { AgentLoop } from '../agentLoop'

function renderer() {
  let activity: ActivityState = { ...INITIAL_ACTIVITY }
  const listeners = new Map<string, (payload: any) => void>()
  const cb: ActivityCallbacks = {
    setActivity: update => { activity = update(activity) },
    setAgentState: vi.fn(), setMission: vi.fn(), setPendingAction: vi.fn(), setVisualState: vi.fn(),
    stoppedRef: { current: false }, lastMsgIdRef: { current: null }, lastTranscript: { current: '' },
    streamingRef: { current: '' }, agentRunningRef: { current: false },
    agentStateToVisual: () => 'idle', activeTurnIdRef: { current: null },
  }
  const unsubscribe = subscribeActivityEvents({
    on: (channel: string, listener: (payload: any) => void) => {
      listeners.set(channel, listener)
      return () => { listeners.delete(channel) }
    },
  } as GogaEventBus, cb)
  boundary.send.mockImplementation((channel, payload) => listeners.get(channel)?.(payload))
  return { activity: () => activity, cb, unsubscribe }
}

beforeEach(() => { boundary.execute.mockReset(); boundary.send.mockReset(); boundary.savePattern.mockReset() })

describe('terminal save results reach the renderer without leaving it busy', () => {
  it.each([
    ['cancelled', false],
    ['cancelled before save dispatch', false],
    ['cancelled before save dispatch', true],
  ] as const)('reports %s as Stopped (Stop already requested: %s)', async (error, stopFirst) => {
    const view = renderer()
    const agent = new AgentLoop()
    vi.spyOn(agent as any, 'planNextStep').mockResolvedValue({
      tool: 'notepad.saveText', thought: 'Save requested text', params: { text: 'fixture', filename: 'fixture.txt' },
    })
    boundary.execute.mockImplementation(async (_tool, _params, ctx) => {
      expect(view.activity().loading).toBe(true)
      expect(view.cb.agentRunningRef.current).toBe(true)
      if (stopFirst) agent.stop('Controlled cancellation before Save')
      expect(ctx.abortSignal.aborted).toBe(stopFirst)
      return { success: false, error } satisfies ToolResult
    })
    const reply = await agent.run('make a text file called fixture.txt')
    expect(reply).toBe('Stopped.')
    expect(agent.getState()).toMatchObject({ status: 'stopped', currentTool: undefined, error: undefined })
    expect(view.activity()).toMatchObject({ loading: false, activityStatus: 'stopped', currentStep: null })
    expect(view.cb.agentRunningRef.current).toBe(false)
    boundary.send('chat:message', { id: 'reply', role: 'assistant', content: reply })
    expect(view.activity()).toMatchObject({ loading: false, activityStatus: 'stopped', currentStep: null })
    expect(boundary.execute).toHaveBeenCalledTimes(1)
    expect(boundary.savePattern).not.toHaveBeenCalled()
    view.unsubscribe()
  })

  it.each([
    'filename_input_target_mismatch',
    'cancelled before save dispatch; cleanup failed: owned window still open',
    'cancellation verification failed',
  ])('keeps genuine failure %s as an error and clears busy state', async error => {
    const view = renderer()
    const agent = new AgentLoop()
    vi.spyOn(agent as any, 'planNextStep').mockResolvedValue({
      tool: 'notepad.saveText', thought: 'Save requested text', params: { text: 'fixture', filename: 'fixture.txt' },
    })
    boundary.execute.mockImplementation(async () => {
      expect(view.activity().loading).toBe(true)
      return { success: false, error }
    })
    const reply = await agent.run('make a text file called fixture.txt')
    expect(reply).toBe(`Save failed: ${error}`)
    expect(agent.getState()).toMatchObject({ status: 'error', error: reply, currentTool: undefined })
    expect(view.activity()).toMatchObject({ loading: false, activityStatus: 'failed', currentStep: null })
    expect(view.cb.agentRunningRef.current).toBe(false)
    boundary.send('chat:message', { id: 'reply', role: 'assistant', content: reply })
    expect(view.activity()).toMatchObject({ loading: false, activityStatus: 'failed', currentStep: null })
    expect(boundary.execute).toHaveBeenCalledTimes(1)
    expect(boundary.savePattern).not.toHaveBeenCalled()
    view.unsubscribe()
  })
})
