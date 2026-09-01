/**
 * M2 unit tests — all tests call production functions from missionUtils.ts.
 * No logic is recreated inside this file.
 */
import { describe, it, expect } from 'vitest'
import {
  safeToolLabel,
  applyToken,
  applyMessage,
  applyStopped,
  applyAgentState,
  applyTranscript,
  applySend,
  applyDismiss,
  applyVoiceIdle,
  subscribeActivityEvents,
  INITIAL_ACTIVITY,
} from '../missionUtils'
import type { ActivityState, ActivityCallbacks, GogaEventBus } from '../missionUtils'
import type { AgentState } from '@shared/types'

// ── Mock bus factory ──────────────────────────────────────────────────────────
// Builds a GogaEventBus whose per-channel listener arrays are exposed for
// assertions. emit() drives the real subscribeActivityEvents callbacks.
type AnyFn = (payload: any) => void

function makeBus() {
  const channels = new Map<string, AnyFn[]>()

  const bus: GogaEventBus = {
    on(channel: string, cb: AnyFn) {
      if (!channels.has(channel)) channels.set(channel, [])
      channels.get(channel)!.push(cb)
      return () => {
        const arr = channels.get(channel)!
        arr.splice(arr.indexOf(cb), 1)
      }
    },
  } as unknown as GogaEventBus

  const emit = (channel: string, payload: unknown) =>
    channels.get(channel)?.forEach(fn => fn(payload))

  const count = (channel: string) => channels.get(channel)?.length ?? 0

  return { bus, emit, count }
}

// Minimal ActivityCallbacks stub — only setActivity needs to accumulate state.
function makeCallbacks() {
  let activity: ActivityState = { ...INITIAL_ACTIVITY }
  const setActivity = (updater: (prev: ActivityState) => ActivityState) => {
    activity = updater(activity)
  }
  const noop = () => {}
  const callbacks: ActivityCallbacks = {
    setActivity,
    setAgentState: noop as any,
    setMission:    noop as any,
    setPendingAction: noop as any,
    setVisualState: noop,
    stoppedRef:    { current: false },
    lastMsgIdRef:  { current: null },
    lastTranscript:{ current: '' },
    streamingRef:  { current: '' },
    agentRunningRef: { current: false },
    agentStateToVisual: () => 'idle',
  }
  return { callbacks, getActivity: () => activity }
}

// ── 9. subscribeActivityEvents — registration ─────────────────────────────────
describe('subscribeActivityEvents — registration', () => {
  const ACTIVITY_CHANNELS = [
    'agent:state', 'agent:step', 'agent:stopped',
    'chat:token', 'chat:message', 'voice:transcript', 'voice:status',
    'mission:state', 'action:approval-required', 'action:update',
  ] as const

  it('registers exactly one listener per activity channel', () => {
    const { bus, count } = makeBus()
    const { callbacks } = makeCallbacks()
    subscribeActivityEvents(bus, callbacks)
    for (const ch of ACTIVITY_CHANNELS) {
      expect(count(ch), `${ch} should have 1 listener`).toBe(1)
    }
  })

  it('cleanup removes every registered listener', () => {
    const { bus, count } = makeBus()
    const { callbacks } = makeCallbacks()
    const cleanup = subscribeActivityEvents(bus, callbacks)
    cleanup()
    for (const ch of ACTIVITY_CHANNELS) {
      expect(count(ch), `${ch} should have 0 listeners after cleanup`).toBe(0)
    }
  })

  it('cleanup then remount leaves exactly one listener per channel', () => {
    const { bus, count } = makeBus()
    const { callbacks } = makeCallbacks()
    const cleanup1 = subscribeActivityEvents(bus, callbacks)
    cleanup1()
    subscribeActivityEvents(bus, callbacks)
    for (const ch of ACTIVITY_CHANNELS) {
      expect(count(ch), `${ch} should have 1 listener after remount`).toBe(1)
    }
  })

  it('one emitted chat:token is applied exactly once after remount', () => {
    const { bus, emit } = makeBus()
    const { callbacks, getActivity } = makeCallbacks()
    const cleanup1 = subscribeActivityEvents(bus, callbacks)
    cleanup1()
    subscribeActivityEvents(bus, callbacks)
    emit('chat:token', { token: 'hello' })
    expect(getActivity().streamingText).toBe('hello')
  })
})

const base = (): ActivityState => ({ ...INITIAL_ACTIVITY })

// ── 1. safeToolLabel ──────────────────────────────────────────────────────────
describe('safeToolLabel', () => {
  it('formats category.action correctly', () => {
    expect(safeToolLabel('web.search')).toBe('Web: search')
    expect(safeToolLabel('computer.click')).toBe('Computer: click')
    expect(safeToolLabel('filesystem.read')).toBe('Filesystem: read')
  })

  it('capitalises a plain tool name', () => {
    expect(safeToolLabel('shell')).toBe('Shell')
  })

  it('returns fallback for empty string', () => {
    expect(safeToolLabel('')).toBe('Working…')
  })

  it('returns fallback for whitespace', () => {
    expect(safeToolLabel('   ')).toBe('Working…')
  })

  it('returns fallback for non-string input', () => {
    expect(safeToolLabel(null as any)).toBe('Working…')
    expect(safeToolLabel(undefined as any)).toBe('Working…')
  })

  it('does not expose thought-like content — only uses the tool string', () => {
    const label = safeToolLabel('web.fetch')
    expect(label).toBe('Web: fetch')
    expect(label).not.toContain('thought')
    expect(label).not.toContain('param')
  })
})

// ── 2. applyToken ─────────────────────────────────────────────────────────────
describe('applyToken', () => {
  it('concatenates tokens in order', () => {
    let s = base()
    s = applyToken(s, 'Hello', false)
    s = applyToken(s, ', ', false)
    s = applyToken(s, 'world', false)
    s = applyToken(s, '!', false)
    expect(s.streamingText).toBe('Hello, world!')
  })

  it('ignores token when stopped=true', () => {
    let s = applyToken(base(), 'Hello', false)
    const after = applyToken(s, ' ignored', true)
    expect(after.streamingText).toBe('Hello')
    expect(after).toBe(s) // same reference — no mutation
  })

  it('resets streaming via applySend', () => {
    let s = applyToken(base(), 'old content', false)
    s = applySend(s, 'new request')
    expect(s.streamingText).toBe('')
  })
})

// ── 3. applyMessage ───────────────────────────────────────────────────────────
describe('applyMessage', () => {
  it('accepts assistant message and clears streaming', () => {
    let s = applyToken(base(), 'partial…', false)
    const { state, lastMsgId } = applyMessage(
      s, { id: 'msg1', role: 'assistant', content: 'Full response' }, false, null,
    )
    expect(state.finalResponse).toBe('Full response')
    expect(state.streamingText).toBe('')
    expect(state.activityStatus).toBe('completed')
    expect(lastMsgId).toBe('msg1')
  })

  it('ignores non-assistant messages', () => {
    const s = base()
    expect(applyMessage(s, { id: 'a', role: 'user',   content: 'x' }, false, null).state.finalResponse).toBeNull()
    expect(applyMessage(s, { id: 'b', role: 'system', content: 'x' }, false, null).state.finalResponse).toBeNull()
  })

  it('rejects duplicate message id', () => {
    const s = base()
    const r1 = applyMessage(s, { id: 'msg1', role: 'assistant', content: 'A' }, false, null)
    const r2 = applyMessage(r1.state, { id: 'msg1', role: 'assistant', content: 'A' }, false, r1.lastMsgId)
    expect(r2.state).toBe(r1.state) // no change on duplicate
    expect(r2.lastMsgId).toBe('msg1')
  })

  it('ignores assistant message when stopped=true', () => {
    const { state } = applyMessage(
      base(), { id: 'msg1', role: 'assistant', content: 'ignored' }, true, null,
    )
    expect(state.finalResponse).toBeNull()
  })
})

// ── 4. applyStopped ───────────────────────────────────────────────────────────
describe('applyStopped', () => {
  it('sets stopped status, clears step and streaming', () => {
    const s = { ...base(), activityStatus: 'running' as const,
                currentStep: 'Web: search', streamingText: 'partial' }
    const next = applyStopped(s, 'Emergency stop (Ctrl+Shift+Escape)')
    expect(next.activityStatus).toBe('stopped')
    expect(next.currentStep).toBeNull()
    expect(next.stopReason).toBe('Emergency stop (Ctrl+Shift+Escape)')
    expect(next.streamingText).toBe('')
    expect(next.loading).toBe(false)
  })

  it('uses fallback reason when reason is falsy', () => {
    const next = applyStopped(base(), undefined as any)
    expect(next.stopReason).toBe('Stopped')
  })
})

// ── 5. applyAgentState ────────────────────────────────────────────────────────
describe('applyAgentState', () => {
  const ag = (status: AgentState['status'], currentTool?: string): AgentState =>
    ({ status, task: '', steps: [], currentTool } as AgentState)

  it('running → activityStatus running, loading true', () => {
    const next = applyAgentState(base(), ag('running'))
    expect(next.activityStatus).toBe('running')
    expect(next.loading).toBe(true)
  })

  it('waiting-approval → activityStatus approval', () => {
    const next = applyAgentState(base(), ag('waiting-approval'))
    expect(next.activityStatus).toBe('approval')
  })

  it('done does not overwrite stopped status', () => {
    const s = applyStopped(base(), 'user stop')
    const next = applyAgentState(s, ag('done'))
    expect(next.activityStatus).toBe('stopped')
  })

  it('error does not overwrite stopped status', () => {
    const s = applyStopped(base(), 'user stop')
    const next = applyAgentState(s, ag('error'))
    expect(next.activityStatus).toBe('stopped')
  })

  it('currentTool is formatted via safeToolLabel', () => {
    const next = applyAgentState(base(), ag('running', 'web.search'))
    expect(next.currentStep).toBe('Web: search')
  })
})

// ── 6. applyTranscript ────────────────────────────────────────────────────────
describe('applyTranscript', () => {
  it('ignores identical transcript when stream is active', () => {
    const { accepted } = applyTranscript(base(), 'open browser', 'open browser', true)
    expect(accepted).toBe(false)
  })

  it('accepts identical transcript when stream is empty', () => {
    const { accepted, state } = applyTranscript(base(), 'open browser', 'open browser', false)
    expect(accepted).toBe(true)
    expect(state.userRequest).toBe('open browser')
  })

  it('accepts different transcript regardless of stream state', () => {
    const { accepted } = applyTranscript(base(), 'close browser', 'open browser', true)
    expect(accepted).toBe(true)
  })

  it('resets activity fields on accepted transcript', () => {
    const s = { ...base(), finalResponse: 'old', streamingText: 'old', stopReason: 'x' }
    const { state } = applyTranscript(s, 'new request', '', false)
    expect(state.userRequest).toBe('new request')
    expect(state.streamingText).toBe('')
    expect(state.finalResponse).toBeNull()
    expect(state.activityStatus).toBe('running')
    expect(state.stopReason).toBeNull()
    expect(state.loading).toBe(true)
  })
})

// ── 7. applySend ──────────────────────────────────────────────────────────────
describe('applySend', () => {
  it('resets all activity fields for new typed request', () => {
    const s: ActivityState = {
      userRequest: 'old', streamingText: 'old stream',
      finalResponse: 'old response', currentStep: 'Web: search',
      activityStatus: 'completed', stopReason: 'old reason', loading: false,
    }
    const next = applySend(s, 'new request')
    expect(next.userRequest).toBe('new request')
    expect(next.streamingText).toBe('')
    expect(next.finalResponse).toBeNull()
    expect(next.currentStep).toBeNull()
    expect(next.activityStatus).toBe('running')
    expect(next.stopReason).toBeNull()
    expect(next.loading).toBe(true)
  })
})

// ── 8. applyDismiss ───────────────────────────────────────────────────────────
describe('applyDismiss', () => {
  it('clears display state, returns none status', () => {
    const s: ActivityState = {
      userRequest: 'do something', streamingText: 'partial',
      finalResponse: 'result', currentStep: 'Web: search',
      activityStatus: 'completed', stopReason: null, loading: false,
    }
    const next = applyDismiss(s)
    expect(next.userRequest).toBe('')
    expect(next.streamingText).toBe('')
    expect(next.finalResponse).toBeNull()
    expect(next.currentStep).toBeNull()
    expect(next.activityStatus).toBe('none')
    expect(next.stopReason).toBeNull()
  })

  it('does not affect loading field', () => {
    const s = { ...base(), loading: true }
    const next = applyDismiss(s)
    expect(next.loading).toBe(true)
  })
})

// ── applyVoiceIdle ────────────────────────────────────────────────────────────
describe('applyVoiceIdle', () => {
  it('running with a response → completed, loading cleared', () => {
    const s = { ...base(), activityStatus: 'running' as const, loading: true,
                finalResponse: 'Hello Boss.', currentStep: 'Web: search' }
    const next = applyVoiceIdle(s, false)
    expect(next.activityStatus).toBe('completed')
    expect(next.loading).toBe(false)
    expect(next.currentStep).toBeNull()
  })

  it('running with no response → none', () => {
    const s = { ...base(), activityStatus: 'running' as const, loading: true, finalResponse: null }
    const next = applyVoiceIdle(s, false)
    expect(next.activityStatus).toBe('none')
    expect(next.loading).toBe(false)
  })

  it('approval status is also reconciled', () => {
    const s = { ...base(), activityStatus: 'approval' as const, finalResponse: 'done' }
    const next = applyVoiceIdle(s, false)
    expect(next.activityStatus).toBe('completed')
  })

  it('does NOT clear when a genuine agent run is active', () => {
    const s = { ...base(), activityStatus: 'running' as const, loading: true }
    const next = applyVoiceIdle(s, true)
    expect(next).toBe(s)
    expect(next.activityStatus).toBe('running')
  })

  it('leaves a stopped status untouched', () => {
    const s = { ...base(), activityStatus: 'stopped' as const }
    const next = applyVoiceIdle(s, false)
    expect(next.activityStatus).toBe('stopped')
  })

  it('leaves a completed status untouched', () => {
    const s = { ...base(), activityStatus: 'completed' as const }
    const next = applyVoiceIdle(s, false)
    expect(next).toBe(s)
  })
})
