// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturedObservation as fixture } from '../../../shared/__tests__/fixtures/capturedObservation'
import type { AgentState } from '../../../shared/types'

const boundary = vi.hoisted(() => ({ send: vi.fn(), chat: vi.fn(), active: vi.fn(), ui: vi.fn() }))
vi.mock('../../../main/services/logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../../../main/services/settings', () => ({ SettingsService: { getInstance: () => ({ get: () => ({ primaryModel: 'local' }) }) } }))
vi.mock('../../../main/services/brain', () => ({ BrainService: { getInstance: () => ({ addMessage: vi.fn() }) } }))
vi.mock('../../../main/services/library', () => ({ LibraryService: { getInstance: () => ({}) }, BOOK_STUDY_REQUEST: /(?!)/, studyReport: () => '' }))
vi.mock('../../../main/services/actionStore', () => ({ ActionStore: { getInstance: () => ({ stopAll: vi.fn() }) } }))
vi.mock('../../../main/services/localLlama', () => ({ LocalLlamaService: { getInstance: () => ({ isReady: () => true, chat: boundary.chat }) } }))
vi.mock('../../../main/services/ollamaClient', () => ({ OllamaClient: vi.fn(() => ({})) }))
vi.mock('../../../main/services/taskMemory', () => ({ TaskMemoryService: { getInstance: () => ({}) } }))
vi.mock('../../../main/services/authorization', () => ({ AuthorizationService: { getInstance: () => ({}) } }))
vi.mock('../../../main/services/focusManager', () => ({ FocusManager: { getInstance: () => ({}) } }))
vi.mock('../../../main/adapters/desktop', () => ({ DesktopAdapter: vi.fn(() => ({ observeWindowIdentity: boundary.active, observeWindowText: boundary.ui })) }))
vi.mock('../../../main/index', () => ({ getMainWindow: () => ({ webContents: { send: boundary.send } }) }))
vi.mock('../GogaCore/GogaTriangleScene', () => ({ default: () => null }))
vi.mock('../../context/GogaVisualContext', () => ({ useGogaVisual: () => ({ visualState: 'idle', setVisualState: vi.fn(), setAudioAmplitude: vi.fn() }) }))

import '../../../main/tools/computer'
import { AgentLoop } from '../../../main/services/agentLoop'
import { OrchestratorService } from '../../../main/services/orchestrator'
import { ToolRegistry } from '../../../main/tools/registry'
import ActivityPage from '../../pages/ActivityPage'
import MissionMode from '../MissionMode'

let agent: AgentLoop
let task: Promise<unknown>
let listeners: Map<string, Set<(value: any) => void>>
let states: AgentState[]

beforeEach(() => {
  vi.clearAllMocks()
  listeners = new Map()
  states = []
  boundary.active.mockResolvedValue(fixture.identity)
  boundary.ui.mockResolvedValue(fixture.ui)
  boundary.chat.mockResolvedValue(fixture.raw)
  agent = new AgentLoop()
  vi.spyOn(AgentLoop, 'getInstance').mockReturnValue(agent)
  const orchestrator = new OrchestratorService()
  boundary.send.mockImplementation((channel, value) => {
    if (channel === 'agent:state') states.push(value)
    listeners.get(channel)?.forEach(listener => listener(value))
  })
  vi.stubGlobal('goga', {
    on: (channel: string, listener: (value: any) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(listener)
      return () => listeners.get(channel)!.delete(listener)
    },
    invoke: vi.fn((channel: string, text?: string) => {
      if (channel === 'agent:state') return Promise.resolve(agent.getState())
      if (channel === 'logs:list') return Promise.resolve([])
      if (channel === 'voice:stopSpeaking') return Promise.resolve()
      if (channel === 'chat:send') {
        task = orchestrator.process({ id: 'replay', role: 'user', content: text!, timestamp: 1 })
        return task
      }
      throw new Error(`Unexpected replay IPC: ${channel}`)
    }),
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function send() {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: fixture.request } })
  fireEvent.click(screen.getByRole('button', { name: /^Send$/ }))
}

describe('captured observation through real routing, task state, Activity and Mission Mode', () => {
  it('shows both tool steps, the exact captured answer in a Mission Mode span, clears busy, and retains Activity on reopening', async () => {
    let completeIdentity!: (value: typeof fixture.identity) => void
    let completeUi!: (value: typeof fixture.ui) => void
    boundary.active.mockReturnValue(new Promise(resolve => { completeIdentity = resolve }))
    boundary.ui.mockReturnValue(new Promise(resolve => { completeUi = resolve }))
    const dispatch = vi.spyOn(ToolRegistry.getInstance(), 'execute')
    let activity = render(<ActivityPage />)
    const mission = render(<MissionMode onOpenChat={() => {}} onOpenSettings={() => {}} />)
    send()
    await waitFor(() => expect(boundary.active).toHaveBeenCalledOnce())
    expect(within(mission.container).getByText('Computer: activeWindow')).toBeTruthy()
    expect(within(activity.container).getByRole('region', { name: 'Current task' }).textContent).toContain('computer.activeWindow')
    await act(async () => { completeIdentity(fixture.identity) })
    await waitFor(() => expect(boundary.ui).toHaveBeenCalledOnce())
    const running = within(activity.container)
    expect(running.getByRole('status').textContent).toBe('Running')
    expect(running.getByRole('region', { name: 'Current task' }).textContent).toContain('computer.activeWindow')
    expect(running.getByRole('region', { name: 'Current task' }).textContent).toContain('computer.uiElements')
    expect(within(mission.container).getByText('Computer: uiElements')).toBeTruthy()
    expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(false) // An agent task remains interruptible.
    await act(async () => { completeUi(fixture.ui); await task })
    const done = within(activity.container)
    expect(done.getByRole('status').textContent).toBe('Completed')
    expect(done.getByLabelText('Task result').textContent).toBe(fixture.reply)
    expect(done.getByRole('list', { name: 'Tool results' }).children).toHaveLength(2)
    // Mission Mode renders the final response in a span, not a ChatPage paragraph.
    expect(within(mission.container).getByText((_, element) => element?.tagName === 'SPAN' && element.textContent === fixture.reply)).toBeTruthy()
    expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(false)
    expect(within(mission.container).queryByText('Running')).toBeNull()
    expect(dispatch.mock.calls.map(([name]) => name)).toEqual(['computer.activeWindow', 'computer.uiElements'])
    expect(dispatch.mock.calls.every(([, , context]) => context.mode === 'read-only-observation')).toBe(true)
    expect(states.some(state => state.currentTool === 'computer.activeWindow')).toBe(true)
    expect(states.some(state => state.currentTool === 'computer.uiElements')).toBe(true)
    expect(agent.getState()).toMatchObject({ status: 'done', reply: fixture.reply, currentTool: undefined })
    activity.unmount()
    activity = render(<ActivityPage />)
    await waitFor(() => expect(within(activity.container).getByLabelText('Task result').textContent).toBe(fixture.reply))
    expect(within(activity.container).getByRole('list', { name: 'Tool results' }).textContent).toContain('computer.activeWindow')
    expect(within(activity.container).getByRole('list', { name: 'Tool results' }).textContent).toContain('computer.uiElements')
    send()
    // A fresh send synchronously resets the prior state, before either read resolves.
    expect(within(activity.container).queryByLabelText('Task result')).toBeNull()
    expect(within(mission.container).queryByText((_, element) => element?.tagName === 'SPAN' && element.textContent === fixture.reply)).toBeNull()
    await act(async () => { await task })
  })

  it.each(['identity', 'UI text', 'answering model'])('shows an explicit %s failure and clears both busy states', async failure => {
    if (failure === 'identity') boundary.active.mockRejectedValue(new Error('identity read failed'))
    if (failure === 'UI text') boundary.ui.mockRejectedValue(new Error('Invalid observation UI JSON'))
    if (failure === 'answering model') boundary.chat.mockRejectedValue(new Error('local model failed'))
    const activity = render(<ActivityPage />)
    const mission = render(<MissionMode onOpenChat={() => {}} onOpenSettings={() => {}} />)
    send()
    await act(async () => { await task })
    expect(within(activity.container).getByRole('status').textContent).toBe('Failed')
    expect(within(activity.container).getByLabelText('Task result').textContent).toBe(agent.getState().reply)
    expect(within(mission.container).getByText((_, element) => element?.tagName === 'SPAN' && element.textContent === agent.getState().reply)).toBeTruthy()
    expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(false)
    expect(within(mission.container).queryByText('Running')).toBeNull()
    expect(agent.isRunning()).toBe(false)
  })

  it('stops during the read without a late success or answering-model call', async () => {
    let completeUi!: (value: typeof fixture.ui) => void
    boundary.ui.mockReturnValue(new Promise(resolve => { completeUi = resolve }))
    const activity = render(<ActivityPage />)
    const mission = render(<MissionMode onOpenChat={() => {}} onOpenSettings={() => {}} />)
    send()
    await waitFor(() => expect(boundary.ui).toHaveBeenCalledOnce())
    act(() => agent.stop())
    await act(async () => { completeUi(fixture.ui); await task })
    expect(within(activity.container).getByRole('status').textContent).toBe('Stopped')
    expect(within(activity.container).getByLabelText('Task result').textContent).toBe('Stopped.')
    expect(within(mission.container).queryByText('Running')).toBeNull()
    expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(false)
    expect(boundary.chat).not.toHaveBeenCalled()
    expect(agent.getState().status).toBe('stopped')
  })

  it('a cancelled older read cannot replace a newer task result', async () => {
    let completeUi!: (value: typeof fixture.ui) => void
    boundary.ui.mockReturnValue(new Promise(resolve => { completeUi = resolve }))
    render(<MissionMode onOpenChat={() => {}} onOpenSettings={() => {}} />)
    send()
    await waitFor(() => expect(boundary.ui).toHaveBeenCalledOnce())
    act(() => agent.stop())
    await act(async () => {
      await agent.runObservation('newer request', async (_signal, progress) => {
        progress.completed?.({ status: 'done', reply: 'newer result' })
        return 'newer result'
      })
      completeUi(fixture.ui)
      await task
    })
    expect(agent.getState()).toMatchObject({ status: 'done', task: 'newer request', reply: 'newer result', steps: [] })
    expect(boundary.chat).not.toHaveBeenCalled()
  })

  it('honors parent cancellation and blocks re-entry while an observation is running', async () => {
    const controller = new AbortController()
    let complete!: (reply: string) => void
    const first = agent.runObservation('first', async () => new Promise(resolve => { complete = resolve }), controller.signal)
    const second = vi.fn()
    expect(await agent.runObservation('second', second)).toContain('still working')
    expect(second).not.toHaveBeenCalled()
    controller.abort()
    complete('late successful reply')
    expect(await first).toBe('Stopped.')
    expect(agent.getState()).toMatchObject({ status: 'stopped', reply: 'Stopped.', currentTool: undefined })
  })
})
