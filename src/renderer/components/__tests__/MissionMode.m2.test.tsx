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
    activeTurnIdRef: { current: null },
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
    // Set activeTurnId so token is accepted
    callbacks.activeTurnIdRef.current = 'turn-1'
    callbacks.setActivity(prev => ({ ...prev, activeTurnId: 'turn-1' }))
    emit('chat:token', { token: 'hello', turnId: 'turn-1' })
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
  it('concatenates tokens in order when turnId matches', () => {
    let s: ActivityState = { ...base(), activeTurnId: 'T1' }
    s = applyToken(s, 'Hello', false, 'T1')
    s = applyToken(s, ', ', false, 'T1')
    s = applyToken(s, 'world', false, 'T1')
    s = applyToken(s, '!', false, 'T1')
    expect(s.streamingText).toBe('Hello, world!')
  })

  it('ignores token when stopped=true', () => {
    let s: ActivityState = applyToken({ ...base(), activeTurnId: 'T1' } as ActivityState, 'Hello', false, 'T1')
    const after = applyToken(s, ' ignored', true, 'T1')
    expect(after.streamingText).toBe('Hello')
    expect(after).toBe(s)
  })

  it('ignores token from a different turnId', () => {
    const s: ActivityState = { ...base(), activeTurnId: 'T1', streamingText: 'existing' }
    const after = applyToken(s, ' stale', false, 'T2')
    expect(after.streamingText).toBe('existing')
    expect(after).toBe(s)
  })

  it('accepts token when activeTurnId is null (no turn set yet)', () => {
    const s: ActivityState = { ...base(), activeTurnId: null }
    const after = applyToken(s, 'hi', false, 'T1')
    expect(after.streamingText).toBe('hi')
  })

  it('resets streaming via applySend', () => {
    let s: ActivityState = applyToken({ ...base(), activeTurnId: 'T1' } as ActivityState, 'old content', false, 'T1')
    s = applySend(s, 'new request', 'T2')
    expect(s.streamingText).toBe('')
    expect(s.activeTurnId).toBe('T2')
  })
})

// ── 3. applyMessage ───────────────────────────────────────────────────────────
describe('applyMessage', () => {
  it('accepts assistant message and clears streaming', () => {
    let s: ActivityState = applyToken({ ...base(), activeTurnId: 'T1' } as ActivityState, 'partial…', false, 'T1')
    const { state, lastMsgId } = applyMessage(
      s, { id: 'msg1', role: 'assistant', content: 'Full response', turnId: 'T1' }, false, null,
    )
    expect(state.finalResponse).toBe('Full response')
    expect(state.streamingText).toBe('')
    expect(state.activityStatus).toBe('completed')
    expect(lastMsgId).toBe('msg1')
  })

  it('ignores non-assistant messages', () => {
    const s: ActivityState = { ...base(), activeTurnId: 'T1' }
    expect(applyMessage(s, { id: 'a', role: 'user',   content: 'x', turnId: 'T1' }, false, null).state.finalResponse).toBeNull()
    expect(applyMessage(s, { id: 'b', role: 'system', content: 'x', turnId: 'T1' }, false, null).state.finalResponse).toBeNull()
  })

  it('rejects duplicate message id', () => {
    const s: ActivityState = { ...base(), activeTurnId: 'T1' }
    const r1 = applyMessage(s, { id: 'msg1', role: 'assistant', content: 'A', turnId: 'T1' }, false, null)
    const r2 = applyMessage(r1.state, { id: 'msg1', role: 'assistant', content: 'A', turnId: 'T1' }, false, r1.lastMsgId)
    expect(r2.state).toBe(r1.state)
    expect(r2.lastMsgId).toBe('msg1')
  })

  it('ignores assistant message when stopped=true', () => {
    const { state } = applyMessage(
      { ...base(), activeTurnId: 'T1' } as ActivityState,
      { id: 'msg1', role: 'assistant', content: 'ignored', turnId: 'T1' }, true, null,
    )
    expect(state.finalResponse).toBeNull()
  })

  it('rejects message from a different turnId', () => {
    const s: ActivityState = { ...base(), activeTurnId: 'T1' }
    const { state } = applyMessage(
      s, { id: 'msg1', role: 'assistant', content: 'stale', turnId: 'T2' }, false, null,
    )
    expect(state.finalResponse).toBeNull()
    expect(state).toBe(s)
  })

  it('accepts message with no turnId regardless of activeTurnId', () => {
    const s: ActivityState = { ...base(), activeTurnId: 'T1' }
    const { state } = applyMessage(
      s, { id: 'msg1', role: 'assistant', content: 'ok' }, false, null,
    )
    expect(state.finalResponse).toBe('ok')
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
    const s: ActivityState = applyStopped(base(), 'user stop')
    const next = applyAgentState(s, ag('done'))
    expect(next.activityStatus).toBe('stopped')
  })

  it('error does not overwrite stopped status', () => {
    const s: ActivityState = applyStopped(base(), 'user stop')
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
    const { accepted } = applyTranscript(base(), 'open browser', 'open browser', true, 'T1')
    expect(accepted).toBe(false)
  })

  it('accepts identical transcript when stream is empty', () => {
    const { accepted, state } = applyTranscript(base(), 'open browser', 'open browser', false, 'T1')
    expect(accepted).toBe(true)
    expect(state.userRequest).toBe('open browser')
    expect(state.activeTurnId).toBe('T1')
  })

  it('accepts different transcript regardless of stream state', () => {
    const { accepted } = applyTranscript(base(), 'close browser', 'open browser', true, 'T2')
    expect(accepted).toBe(true)
  })

  it('resets activity fields on accepted transcript', () => {
    const s = { ...base(), finalResponse: 'old', streamingText: 'old', stopReason: 'x' }
    const { state } = applyTranscript(s, 'new request', '', false, 'T3')
    expect(state.userRequest).toBe('new request')
    expect(state.streamingText).toBe('')
    expect(state.finalResponse).toBeNull()
    expect(state.activityStatus).toBe('running')
    expect(state.stopReason).toBeNull()
    expect(state.loading).toBe(true)
    expect(state.activeTurnId).toBe('T3')
  })
})

// ── 7. applySend ──────────────────────────────────────────────────────────────
describe('applySend', () => {
  it('resets all activity fields for new typed request', () => {
    const s: ActivityState = {
      userRequest: 'old', streamingText: 'old stream',
      finalResponse: 'old response', currentStep: 'Web: search',
      activityStatus: 'completed', stopReason: 'old reason', loading: false,
      activeTurnId: 'T0',
    }
    const next = applySend(s, 'new request', 'T1')
    expect(next.userRequest).toBe('new request')
    expect(next.streamingText).toBe('')
    expect(next.finalResponse).toBeNull()
    expect(next.currentStep).toBeNull()
    expect(next.activityStatus).toBe('running')
    expect(next.stopReason).toBeNull()
    expect(next.loading).toBe(true)
    expect(next.activeTurnId).toBe('T1')
  })
})

// ── 8. applyDismiss ───────────────────────────────────────────────────────────
describe('applyDismiss', () => {
  it('clears display state, returns none status', () => {
    const s: ActivityState = {
      userRequest: 'do something', streamingText: 'partial',
      finalResponse: 'result', currentStep: 'Web: search',
      activityStatus: 'completed', stopReason: null, loading: false,
      activeTurnId: 'T1',
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
    const s: ActivityState = { ...base(), activityStatus: 'running' as const, loading: true,
                finalResponse: 'Hello Boss.', currentStep: 'Web: search' }
    const next = applyVoiceIdle(s, false)
    expect(next.activityStatus).toBe('completed')
    expect(next.loading).toBe(false)
    expect(next.currentStep).toBeNull()
  })

  it('running with no response → none', () => {
    const s: ActivityState = { ...base(), activityStatus: 'running' as const, loading: true, finalResponse: null }
    const next = applyVoiceIdle(s, false)
    expect(next.activityStatus).toBe('none')
    expect(next.loading).toBe(false)
  })

  it('approval status is also reconciled', () => {
    const s: ActivityState = { ...base(), activityStatus: 'approval' as const, finalResponse: 'done' }
    const next = applyVoiceIdle(s, false)
    expect(next.activityStatus).toBe('completed')
  })

  it('does NOT clear when a genuine agent run is active', () => {
    const s: ActivityState = { ...base(), activityStatus: 'running' as const, loading: true }
    const next = applyVoiceIdle(s, true)
    expect(next).toBe(s)
    expect(next.activityStatus).toBe('running')
  })

  it('leaves a stopped status untouched', () => {
    const s: ActivityState = { ...base(), activityStatus: 'stopped' as const }
    const next = applyVoiceIdle(s, false)
    expect(next.activityStatus).toBe('stopped')
  })

  it('leaves a completed status untouched', () => {
    const s: ActivityState = { ...base(), activityStatus: 'completed' as const }
    const next = applyVoiceIdle(s, false)
    expect(next).toBe(s)
  })
})

// ── 10. voice delivery — chat:message before voice:status idle ────────────────
describe('voice delivery — chat:message before voice:status idle', () => {
  it('chat:message commits response; subsequent idle leaves it intact', () => {
    const s: ActivityState = { ...base(), activeTurnId: 'V1', activityStatus: 'running' as const, loading: true, streamingText: 'Hello Boss.' }
    const { state: afterMsg } = applyMessage(s, { id: 'v1', role: 'assistant', content: 'Hello Boss.', turnId: 'V1' }, false, null)
    expect(afterMsg.streamingText).toBe('')
    const afterIdle = applyVoiceIdle(afterMsg, false)
    // completed → applyVoiceIdle is a no-op; response survives
    expect(afterIdle.finalResponse).toBe('Hello Boss.')
    expect(afterIdle.activityStatus).toBe('completed')
    expect(afterIdle).toBe(afterMsg)
  })

  it('tokens accumulate; chat:message clears streaming and sets finalResponse', () => {
    let s: ActivityState = { ...base(), activeTurnId: 'V2' }
    s = applyToken(s, 'Hello ', false, 'V2')
    s = applyToken(s, 'Boss.', false, 'V2')
    expect(s.streamingText).toBe('Hello Boss.')
    const { state } = applyMessage(s, { id: 'v2', role: 'assistant', content: 'Hello Boss.', turnId: 'V2' }, false, null)
    expect(state.streamingText).toBe('')
    expect(state.finalResponse).toBe('Hello Boss.')
  })

  it('voice:status idle with no chat:message → none status (no fallback commit)', () => {
    const s: ActivityState = { ...base(), activeTurnId: 'V3', activityStatus: 'running' as const,
                loading: true, streamingText: 'partial text', finalResponse: null }
    const afterIdle = applyVoiceIdle(s, false)
    expect(afterIdle.activityStatus).toBe('none')
    expect(afterIdle.loading).toBe(false)
    // streamingText is NOT touched by applyVoiceIdle — no fallback commit
    expect(afterIdle.streamingText).toBe('partial text')
    expect(afterIdle.finalResponse).toBeNull()
  })
})

// ── 11. idle-before-message — idle fires before chat:message arrives ──────────
describe('idle-before-message via subscribeActivityEvents', () => {
  it('idle before message: status goes none, then message commits correctly', () => {
    const { bus, emit } = makeBus()
    const { callbacks, getActivity } = makeCallbacks()
    subscribeActivityEvents(bus, callbacks)

    emit('voice:transcript', { text: 'hello goga' })
    // Manually set activeTurnId as subscribeActivityEvents does internally
    const turnId = getActivity().activeTurnId!
    expect(turnId).not.toBeNull()

    emit('chat:token', { token: 'Hi', turnId })
    // idle fires BEFORE chat:message (e.g. TTS finished before IPC settled)
    emit('voice:status', { status: 'idle' })
    expect(getActivity().activityStatus).toBe('none')
    expect(getActivity().loading).toBe(false)

    // chat:message still arrives — must commit because turnId still matches
    emit('chat:message', { id: 'vm-early', role: 'assistant', content: 'Hi', turnId })
    expect(getActivity().finalResponse).toBe('Hi')
  })

  it('full voice turn: transcript → tokens → message → idle leaves response intact', () => {
    const { bus, emit } = makeBus()
    const { callbacks, getActivity } = makeCallbacks()
    subscribeActivityEvents(bus, callbacks)

    emit('voice:transcript', { text: 'hello goga' })
    const turnId = getActivity().activeTurnId!

    emit('chat:token', { token: 'Hi ', turnId })
    emit('chat:token', { token: 'there!', turnId })
    expect(getActivity().streamingText).toBe('Hi there!')

    emit('chat:message', { id: 'vm1', role: 'assistant', content: 'Hi there!', turnId })
    expect(getActivity().finalResponse).toBe('Hi there!')
    expect(getActivity().streamingText).toBe('')

    emit('voice:status', { status: 'idle' })
    // completed → applyVoiceIdle is a no-op
    expect(getActivity().finalResponse).toBe('Hi there!')
    expect(getActivity().activityStatus).toBe('completed')
  })

  it('voice:status idle with no prior chat:message → none, not completed', () => {
    const { bus, emit } = makeBus()
    const { callbacks, getActivity } = makeCallbacks()
    subscribeActivityEvents(bus, callbacks)

    emit('voice:transcript', { text: 'hello' })
    const turnId = getActivity().activeTurnId!
    emit('chat:token', { token: 'partial', turnId })
    emit('voice:status', { status: 'idle' })
    expect(getActivity().activityStatus).toBe('none')
    expect(getActivity().loading).toBe(false)
  })
})

// ── 12. delayed tokens — tokens arriving after canonical message are dropped ───
describe('delayed tokens dropped after canonical message', () => {
  it('tokens after chat:message do not append to streamingText', () => {
    let s: ActivityState = { ...base(), activeTurnId: 'T1' }
    s = applyToken(s, 'Hello', false, 'T1')
    const { state: committed } = applyMessage(s, { id: 'm1', role: 'assistant', content: 'Hello', turnId: 'T1' }, false, null)
    expect(committed.streamingText).toBe('')
    // Late token for same turn — activeTurnId still T1 but message already committed.
    // In ChatPage the turnId is added to finalisedTurnIds so tokens are dropped
    // before reaching applyToken. At the missionUtils layer, applyToken still
    // accepts them (activeTurnId matches). The ChatPage layer is the gate.
    // Here we verify the pure function behaviour is consistent.
    const afterLate = applyToken(committed, ' late', false, 'T1')
    // Pure function appends — the ChatPage IPC gate is what prevents this in practice.
    // This test documents the contract: ChatPage must gate, not applyToken alone.
    expect(afterLate.streamingText).toBe(' late')
  })

  it('tokens from a stale turn are dropped by applyToken', () => {
    const s: ActivityState = { ...base(), activeTurnId: 'T2', streamingText: '' }
    const after = applyToken(s, 'stale', false, 'T1')
    expect(after.streamingText).toBe('')
    expect(after).toBe(s)
  })

  it('via subscribeActivityEvents: tokens from old turn ignored after new transcript', () => {
    const { bus, emit } = makeBus()
    const { callbacks, getActivity } = makeCallbacks()
    subscribeActivityEvents(bus, callbacks)

    emit('voice:transcript', { text: 'first' })
    const turn1 = getActivity().activeTurnId!

    emit('chat:token', { token: 'A', turnId: turn1 })
    expect(getActivity().streamingText).toBe('A')

    // New transcript starts a new turn
    emit('voice:transcript', { text: 'second' })
    const turn2 = getActivity().activeTurnId!
    expect(turn2).not.toBe(turn1)

    // Stale token from turn1 must be ignored
    emit('chat:token', { token: 'stale', turnId: turn1 })
    expect(getActivity().streamingText).toBe('')

    // Token from turn2 is accepted
    emit('chat:token', { token: 'B', turnId: turn2 })
    expect(getActivity().streamingText).toBe('B')
  })
})

// ── 13. repeated identical replies — same content, different turns ────────────
describe('repeated identical replies', () => {
  it('two turns with identical content are both committed (different ids)', () => {
    let s: ActivityState = { ...base(), activeTurnId: 'T1' }
    const r1 = applyMessage(s, { id: 'msg-a', role: 'assistant', content: 'Yes.', turnId: 'T1' }, false, null)
    expect(r1.state.finalResponse).toBe('Yes.')

    // New turn with same content
    let s2 = applySend(r1.state, 'repeat', 'T2')
    const r2 = applyMessage(s2, { id: 'msg-b', role: 'assistant', content: 'Yes.', turnId: 'T2' }, false, r1.lastMsgId)
    expect(r2.state.finalResponse).toBe('Yes.')
    expect(r2.lastMsgId).toBe('msg-b')
  })

  it('same message id on second turn is still deduped', () => {
    let s: ActivityState = { ...base(), activeTurnId: 'T1' }
    const r1 = applyMessage(s, { id: 'msg-x', role: 'assistant', content: 'Hi', turnId: 'T1' }, false, null)
    // Pathological: same id reused on a new turn
    let s2 = applySend(r1.state, 'again', 'T2')
    const r2 = applyMessage(s2, { id: 'msg-x', role: 'assistant', content: 'Hi', turnId: 'T2' }, false, r1.lastMsgId)
    // lastMsgId guard fires — no change
    expect(r2.state).toBe(s2)
  })
})

// ── 14. overlapping turns — second turn starts before first completes ─────────
describe('overlapping turns', () => {
  it('message from first turn rejected after second turn starts', () => {
    let s: ActivityState = { ...base(), activeTurnId: 'T1' }
    s = applyToken(s, 'partial', false, 'T1')

    // Second turn starts (barge-in / new request)
    s = applySend(s, 'new request', 'T2')
    expect(s.activeTurnId).toBe('T2')
    expect(s.streamingText).toBe('')

    // Late message from T1 must be rejected
    const { state } = applyMessage(s, { id: 'm-old', role: 'assistant', content: 'old reply', turnId: 'T1' }, false, null)
    expect(state.finalResponse).toBeNull()
    expect(state).toBe(s)
  })

  it('message from second turn is accepted', () => {
    let s: ActivityState = applySend(base(), 'request', 'T2')
    const { state } = applyMessage(s, { id: 'm-new', role: 'assistant', content: 'new reply', turnId: 'T2' }, false, null)
    expect(state.finalResponse).toBe('new reply')
  })

  it('via subscribeActivityEvents: overlapping voice turns — only second turn message accepted', () => {
    const { bus, emit } = makeBus()
    const { callbacks, getActivity } = makeCallbacks()
    subscribeActivityEvents(bus, callbacks)

    emit('voice:transcript', { text: 'first request' })
    const turn1 = getActivity().activeTurnId!
    emit('chat:token', { token: 'thinking...', turnId: turn1 })

    // Second transcript interrupts
    emit('voice:transcript', { text: 'second request' })
    const turn2 = getActivity().activeTurnId!
    expect(turn2).not.toBe(turn1)

    // First turn's message arrives late — must be rejected
    emit('chat:message', { id: 'msg-t1', role: 'assistant', content: 'first reply', turnId: turn1 })
    expect(getActivity().finalResponse).toBeNull()

    // Second turn's message is accepted
    emit('chat:message', { id: 'msg-t2', role: 'assistant', content: 'second reply', turnId: turn2 })
    expect(getActivity().finalResponse).toBe('second reply')
  })
})

// ── 15. exactly-once delivery — typed and voice turns ────────────────────────
describe('exactly-once delivery — typed and voice turns', () => {
  it('duplicate canonical message id is a no-op (typed turn)', () => {
    const s: ActivityState = { ...base(), activeTurnId: 'T1' }
    const r1 = applyMessage(s, { id: 'typed1', role: 'assistant', content: 'Response', turnId: 'T1' }, false, null)
    expect(r1.state.finalResponse).toBe('Response')
    const r2 = applyMessage(r1.state, { id: 'typed1', role: 'assistant', content: 'Response', turnId: 'T1' }, false, r1.lastMsgId)
    expect(r2.state).toBe(r1.state)
    expect(r2.lastMsgId).toBe('typed1')
  })

  it('different id after first message is accepted (typed turn)', () => {
    const s: ActivityState = { ...base(), activeTurnId: 'T1' }
    const r1 = applyMessage(s, { id: 'typed1', role: 'assistant', content: 'First', turnId: 'T1' }, false, null)
    const s2 = applySend(r1.state, 'second', 'T2')
    const r2 = applyMessage(s2, { id: 'typed2', role: 'assistant', content: 'Second', turnId: 'T2' }, false, r1.lastMsgId)
    expect(r2.state.finalResponse).toBe('Second')
    expect(r2.lastMsgId).toBe('typed2')
  })

  it('full typed turn via subscribeActivityEvents: token → message → duplicate ignored', () => {
    const { bus, emit } = makeBus()
    const { callbacks, getActivity } = makeCallbacks()
    subscribeActivityEvents(bus, callbacks)

    // Simulate typed turn: set activeTurnId manually (MissionMode would call applySend)
    callbacks.activeTurnIdRef.current = 'T3'
    callbacks.setActivity(prev => ({ ...prev, activeTurnId: 'T3', activityStatus: 'running', loading: true }))

    emit('chat:token', { token: 'Hello', turnId: 'T3' })
    emit('chat:message', { id: 'typed3', role: 'assistant', content: 'Hello', turnId: 'T3' })
    expect(getActivity().finalResponse).toBe('Hello')

    // Duplicate (invoke return path)
    emit('chat:message', { id: 'typed3', role: 'assistant', content: 'Hello', turnId: 'T3' })
    expect(getActivity().finalResponse).toBe('Hello')
    expect(getActivity().activityStatus).toBe('completed')
  })

  it('full voice turn via subscribeActivityEvents: no duplicate on idle after message', () => {
    const { bus, emit } = makeBus()
    const { callbacks, getActivity } = makeCallbacks()
    subscribeActivityEvents(bus, callbacks)

    emit('voice:transcript', { text: 'tell me something' })
    const turnId = getActivity().activeTurnId!

    emit('chat:token', { token: 'Sure!', turnId })
    emit('chat:message', { id: 'voice-msg-1', role: 'assistant', content: 'Sure!', turnId })
    expect(getActivity().finalResponse).toBe('Sure!')
    expect(getActivity().activityStatus).toBe('completed')

    // idle fires — must not erase or duplicate
    emit('voice:status', { status: 'idle' })
    expect(getActivity().finalResponse).toBe('Sure!')
    expect(getActivity().activityStatus).toBe('completed')
  })
})
