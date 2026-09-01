import type { AgentState, AgentStep, Action, Mission } from '@shared/types'
import type { GogaVisualState } from './GogaCore/GogaVisualState'

export type ActivityStatus = 'none' | 'running' | 'approval' | 'completed' | 'stopped' | 'failed'

export interface ActivityState {
  userRequest: string
  streamingText: string
  finalResponse: string | null
  currentStep: string | null
  activityStatus: ActivityStatus
  stopReason: string | null
  loading: boolean
}

export const INITIAL_ACTIVITY: ActivityState = {
  userRequest: '',
  streamingText: '',
  finalResponse: null,
  currentStep: null,
  activityStatus: 'none',
  stopReason: null,
  loading: false,
}

// ── safeToolLabel ─────────────────────────────────────────────────────────────
// Never exposes AgentStep.thought or raw params — only formats the tool string.
export function safeToolLabel(tool: string): string {
  if (!tool || typeof tool !== 'string') return 'Working…'
  const clean = tool.trim()
  if (!clean) return 'Working…'
  const dot = clean.indexOf('.')
  if (dot > 0) {
    const cat = clean.slice(0, dot)
    const act = clean.slice(dot + 1)
    return `${cat.charAt(0).toUpperCase()}${cat.slice(1)}: ${act}`
  }
  return `${clean.charAt(0).toUpperCase()}${clean.slice(1)}`
}

// ── applyToken ────────────────────────────────────────────────────────────────
// chat:token handler — appends token to streamingText unless stopped.
export function applyToken(
  state: ActivityState,
  token: string,
  stopped: boolean,
): ActivityState {
  if (stopped) return state
  return { ...state, streamingText: state.streamingText + token }
}

// ── applyMessage ──────────────────────────────────────────────────────────────
// chat:message handler — accepts final assistant message, deduplicates by id.
export function applyMessage(
  state: ActivityState,
  msg: { id: string; role: string; content: string },
  stopped: boolean,
  lastMsgId: string | null,
): { state: ActivityState; lastMsgId: string | null } {
  if (stopped) return { state, lastMsgId }
  if (msg.role !== 'assistant') return { state, lastMsgId }
  if (lastMsgId === msg.id) return { state, lastMsgId }
  return {
    state: {
      ...state,
      finalResponse: msg.content,
      streamingText: '',
      activityStatus: state.activityStatus === 'stopped' ? 'stopped' : 'completed',
    },
    lastMsgId: msg.id,
  }
}

// ── applyStopped ──────────────────────────────────────────────────────────────
// agent:stopped handler — locks stopped state, clears step and streaming.
export function applyStopped(
  state: ActivityState,
  reason: string,
): ActivityState {
  return {
    ...state,
    loading: false,
    currentStep: null,
    activityStatus: 'stopped',
    stopReason: reason ?? 'Stopped',
    streamingText: '',
  }
}

// ── applyAgentState ───────────────────────────────────────────────────────────
// agent:state handler — maps AgentStatus to ActivityStatus, respects stop-guard.
export function applyAgentState(
  state: ActivityState,
  agentState: AgentState,
): ActivityState {
  let next = { ...state }

  if (agentState.status === 'running') {
    next.loading = true
    next.activityStatus = 'running'
  } else if (agentState.status === 'waiting-approval') {
    next.loading = true
    next.activityStatus = 'approval'
  } else if (agentState.status === 'done') {
    next.loading = false
    next.currentStep = null
    next.activityStatus = state.activityStatus === 'stopped' ? 'stopped' : 'completed'
  } else if (agentState.status === 'error') {
    next.loading = false
    next.currentStep = null
    next.activityStatus = state.activityStatus === 'stopped' ? 'stopped' : 'failed'
  } else if (agentState.status === 'idle') {
    next.loading = false
    next.currentStep = null
  }

  if (agentState.currentTool) {
    next.currentStep = safeToolLabel(agentState.currentTool)
  }

  return next
}

// ── applyTranscript ───────────────────────────────────────────────────────────
// voice:transcript handler — deduplicates, resets activity for new voice request.
export function applyTranscript(
  state: ActivityState,
  text: string,
  lastTranscript: string,
  streamingActive: boolean,
): { state: ActivityState; lastTranscript: string; accepted: boolean } {
  if (text === lastTranscript && streamingActive) {
    return { state, lastTranscript, accepted: false }
  }
  return {
    state: {
      ...state,
      userRequest: text,
      streamingText: '',
      finalResponse: null,
      currentStep: null,
      activityStatus: 'running',
      stopReason: null,
      loading: true,
    },
    lastTranscript: text,
    accepted: true,
  }
}

// ── applySend ─────────────────────────────────────────────────────────────────
// handleSend state resets — clears all activity and lifts stop guard.
export function applySend(state: ActivityState, text: string): ActivityState {
  return {
    ...state,
    userRequest: text,
    streamingText: '',
    finalResponse: null,
    currentStep: null,
    activityStatus: 'running',
    stopReason: null,
    loading: true,
  }
}

// ── applyVoiceIdle ────────────────────────────────────────────────────────────
// voice:status → 'idle' handler. The voice/chat pipeline has gone idle on the
// backend (response generated + TTS finished). A simple chat/voice turn does
// not emit a terminal agent:state, and a trailing self-echo transcript or a
// deduped completion message can leave activityStatus stuck at 'running'. When
// voice is idle and no genuine multi-step agent run is in flight, reconcile a
// stuck 'running'/'approval' status to a terminal state so the RUNNING badge
// and Stop button clear. Never overrides a 'stopped' status.
export function applyVoiceIdle(state: ActivityState, agentRunning: boolean): ActivityState {
  if (agentRunning) return state
  if (state.activityStatus !== 'running' && state.activityStatus !== 'approval') return state
  return {
    ...state,
    loading: false,
    currentStep: null,
    // If a response was produced, the turn completed; otherwise there is
    // nothing to show, so drop the panel back to idle.
    activityStatus: state.finalResponse ? 'completed' : 'none',
  }
}

// ── applyDismiss ──────────────────────────────────────────────────────────────
// handleDismiss — clears display state only, does not touch stopped ref.
export function applyDismiss(state: ActivityState): ActivityState {
  return {
    ...state,
    userRequest: '',
    streamingText: '',
    finalResponse: null,
    currentStep: null,
    activityStatus: 'none',
    stopReason: null,
  }
}

// ── subscribeActivityEvents ───────────────────────────────────────────────────
// Registers all MissionMode activity-event listeners on the provided bus.
// Returns a single cleanup function that removes every registered listener.
// MissionMode's useEffect calls this directly; tests pass a mock bus.

// Minimal typed subset of window.goga.on used by activity subscriptions.
export interface GogaEventBus {
  on(channel: 'agent:state',            cb: (s: AgentState) => void): () => void
  on(channel: 'agent:step',             cb: (s: AgentStep)  => void): () => void
  on(channel: 'agent:stopped',          cb: (p: { reason: string }) => void): () => void
  on(channel: 'chat:token',             cb: (p: { token: string }) => void): () => void
  on(channel: 'chat:message',           cb: (p: { id: string; role: string; content: string }) => void): () => void
  on(channel: 'voice:transcript',       cb: (p: { text: string }) => void): () => void
  on(channel: 'voice:status',           cb: (p: { status: string }) => void): () => void
  on(channel: 'mission:state',          cb: (m: Mission) => void): () => void
  on(channel: 'action:approval-required', cb: (a: Action) => void): () => void
  on(channel: 'action:update',          cb: (a: Action) => void): () => void
}

export interface ActivityCallbacks {
  setActivity:     (updater: (prev: ActivityState) => ActivityState) => void
  setAgentState:   (updater: (prev: AgentState | null) => AgentState | null) => void
  setMission:      (updater: (prev: Mission | null) => Mission | null) => void
  setPendingAction:(updater: (prev: Action | null) => Action | null) => void
  setVisualState:  (s: GogaVisualState) => void
  stoppedRef:      { current: boolean }
  lastMsgIdRef:    { current: string | null }
  lastTranscript:  { current: string }
  streamingRef:    { current: string }
  // Tracks whether a genuine multi-step agent run is in flight, so the
  // voice:status→idle reconciliation never clears a real running agent.
  agentRunningRef: { current: boolean }
  agentStateToVisual: (s: AgentState) => GogaVisualState
}

export function subscribeActivityEvents(
  bus: GogaEventBus,
  cb: ActivityCallbacks,
): () => void {
  const unsubs = [
    bus.on('agent:state', (s) => {
      cb.agentRunningRef.current = s.status === 'running' || s.status === 'waiting-approval'
      cb.setAgentState(() => s)
      cb.setVisualState(cb.agentStateToVisual(s))
      cb.setActivity(prev => applyAgentState(prev, s))
    }),

    bus.on('agent:step', (step) => {
      cb.setActivity(prev => ({ ...prev, currentStep: safeToolLabel(step.tool) }))
    }),

    bus.on('agent:stopped', ({ reason }) => {
      cb.stoppedRef.current = true
      cb.agentRunningRef.current = false
      cb.setAgentState(s => s ? { ...s, status: 'stopped' } : null)
      cb.setVisualState('stopped')
      cb.setActivity(prev => applyStopped(prev, reason))
    }),

    bus.on('chat:token', ({ token }) => {
      cb.setActivity(prev => {
        const next = applyToken(prev, token, cb.stoppedRef.current)
        cb.streamingRef.current = next.streamingText
        return next
      })
    }),

    bus.on('chat:message', (msg) => {
      cb.setActivity(prev => {
        const result = applyMessage(prev, msg, cb.stoppedRef.current, cb.lastMsgIdRef.current)
        cb.lastMsgIdRef.current = result.lastMsgId
        return result.state
      })
    }),

    bus.on('voice:transcript', ({ text }) => {
      const accepted = !(text === cb.lastTranscript.current && cb.streamingRef.current !== '')
      if (!accepted) return
      cb.lastTranscript.current = text
      cb.stoppedRef.current = false
      cb.lastMsgIdRef.current = null
      cb.setActivity(prev => applyTranscript(prev, text, text, false).state)
      cb.setVisualState('thinking')
    }),

    bus.on('voice:status', ({ status }) => {
      // When the voice pipeline returns to idle, reconcile a stuck RUNNING
      // activity left by a simple chat/voice turn (which emits no terminal
      // agent:state). Guarded so a genuine agent run is never cleared.
      if (status === 'idle') {
        cb.setActivity(prev => applyVoiceIdle(prev, cb.agentRunningRef.current))
      }
    }),

    bus.on('mission:state', (m) => {
      cb.setMission(() => m)
      if (m.status === 'completed' || m.status === 'failed' || m.status === 'cancelled') {
        setTimeout(() => cb.setMission(() => null), 4000)
      }
    }),

    bus.on('action:approval-required', (action) => {
      cb.setPendingAction(() => action)
      cb.setVisualState('waitingApproval')
      cb.setActivity(prev => ({ ...prev, activityStatus: 'approval' }))
    }),

    bus.on('action:update', (action) => {
      if (action.status !== 'pending') {
        cb.setPendingAction(pa => pa?.id === action.id ? null : pa)
      }
    }),
  ]
  return () => unsubs.forEach(u => u())
}
