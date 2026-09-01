import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { AgentState, Action, Mission } from '@shared/types'
import GogaTriangleScene from './GogaCore/GogaTriangleScene'
import ChatComposer from './ChatComposer'
import ApprovalCard from './ApprovalCard'
import StopButton from './StopButton'
import { useGogaVisual } from '../context/GogaVisualContext'
import { agentStateToVisual } from './GogaCore/GogaVisualState'

// ── Status line ───────────────────────────────────────────────────────────────
import type { GogaVisualState } from './GogaCore/GogaVisualState'

// ── M2: Activity state model ──────────────────────────────────────────────────
export type { ActivityStatus } from './missionUtils'
export { safeToolLabel } from './missionUtils'
import {
  INITIAL_ACTIVITY,
  applySend, applyDismiss,
  subscribeActivityEvents,
} from './missionUtils'
import type { ActivityStatus, ActivityState, ActivityCallbacks } from './missionUtils'

const STATUS_TEXT: Record<GogaVisualState, string> = {
  idle:            'Ready',
  listening:       'Listening',
  transcribing:    'Transcribing',
  thinking:        'Thinking',
  acting:          'Working',
  seeing:          'Verifying',
  searching:       'Searching',
  speaking:        'Speaking',
  waitingApproval: 'Awaiting approval',
  success:         'Complete',
  error:           'Error',
  stopped:         'Stopped',
  wakeDetected:    'Awake',
}

const STATUS_COLOR: Record<GogaVisualState, string> = {
  idle:            '#8b5cff',
  listening:       '#29d9ff',
  transcribing:    '#29d9ff',
  thinking:        '#b794ff',
  acting:          '#8b5cff',
  seeing:          '#29d9ff',
  searching:       '#b794ff',
  speaking:        '#b794ff',
  waitingApproval: '#ffaa22',
  success:         '#00ffcc',
  error:           '#ff2244',
  stopped:         '#443355',
  wakeDetected:    '#29d9ff',
}

// ── Props ─────────────────────────────────────────────────────────────────────
export interface Props {
  /** Called when user clicks the history/chat icon to switch to ChatPage */
  onOpenChat: () => void
  /** Called when user clicks the settings icon */
  onOpenSettings: () => void
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function MissionMode({ onOpenChat, onOpenSettings }: Props) {
  const { visualState, setVisualState } = useGogaVisual()

  const [agentState,    setAgentState]    = useState<AgentState | null>(null)
  const [mission,       setMission]       = useState<Mission | null>(null)
  const [pendingAction, setPendingAction] = useState<Action | null>(null)

  // ── M2 activity state ────────────────────────────────────────────────────
  const [activity, setActivity] = useState<ActivityState>(INITIAL_ACTIVITY)

  // Refs for stable subscription callbacks — do not trigger re-subscription
  const stoppedRef     = useRef(false)            // true while in stopped state
  const lastMsgIdRef   = useRef<string | null>(null)  // dedup chat:message
  const lastTranscript = useRef<string>('')           // dedup voice:transcript
  const streamingRef   = useRef('')                   // mirror of streamingText for stable closure
  const agentRunningRef = useRef(false)               // true while a real multi-step agent run is in flight

  // ── IPC subscriptions ─────────────────────────────────────────────────────
  // voice:status and voice:amplitude are handled by ChatComposer.
  // Functional state updates used throughout so this effect stays stable
  // and does not resubscribe on every token or state change.
  useEffect(() => {
    const callbacks: ActivityCallbacks = {
      setActivity, setAgentState, setMission, setPendingAction, setVisualState,
      stoppedRef, lastMsgIdRef, lastTranscript, streamingRef,
      agentRunningRef,
      agentStateToVisual,
    }
    return subscribeActivityEvents(window.goga, callbacks)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setVisualState])

  // ── Approval handlers (same logic as ApprovalsPage) ───────────────────────
  const handleApprove = useCallback(async (id: string) => {
    await window.goga.invoke('action:approve', id)
    setPendingAction(null)
  }, [])

  const handleDeny = useCallback(async (id: string) => {
    await window.goga.invoke('action:reject', id)
    setPendingAction(null)
  }, [])

  // ── Send handler ──────────────────────────────────────────────────────────
  const handleSend = useCallback(async (text: string) => {
    stoppedRef.current = false
    lastMsgIdRef.current = null
    agentRunningRef.current = false
    setActivity(prev => applySend(prev, text))
    setVisualState('thinking')
    try {
      await window.goga.invoke('chat:send', text)
    } catch {
      setActivity(prev => ({ ...prev, loading: false, activityStatus: 'failed' }))
      setVisualState('error')
    }
  }, [setVisualState])

  // ── Dismiss handler ───────────────────────────────────────────────────────
  const handleDismiss = useCallback(() => {
    setActivity(prev => applyDismiss(prev))
  }, [])

  const { userRequest, streamingText, finalResponse, currentStep,
          activityStatus, stopReason, loading } = activity

  const isAgentRunning = agentState?.status === 'running' || agentState?.status === 'waiting-approval'
  const statusText  = STATUS_TEXT[visualState]
  const statusColor = STATUS_COLOR[visualState]

  const showActivity = activityStatus !== 'none' || userRequest !== ''
  const displayedResponse = streamingText !== '' ? streamingText : finalResponse

  return (
    <div style={S.root}>

      {/* ── Top identity bar ─────────────────────────────────────────────── */}
      <div style={S.topBar}>
        <span style={S.logo}>GOGA</span>
        <div style={S.topRight}>
          <button
            onClick={onOpenChat}
            style={S.iconBtn}
            title="Conversation history"
            aria-label="Open conversation history"
          >💬</button>
          <button
            onClick={onOpenSettings}
            style={S.iconBtn}
            title="Settings"
            aria-label="Open settings"
          >⚙</button>
        </div>
      </div>

      {/* ── Triangle — fills remaining vertical space ─────────────────────── */}
      <div style={S.triangleWrap}>
        <GogaTriangleScene compact />
      </div>

      {/* ── Status line ──────────────────────────────────────────────────── */}
      <div style={{ ...S.statusLine, color: statusColor }}>
        <span style={{ ...S.statusDot, background: statusColor }} />
        {statusText}
      </div>

      {/* ── Active mission panel (only while a mission exists) ───────────── */}
      {mission && !['completed', 'failed', 'cancelled'].includes(mission.status) && (
        <div style={S.missionPanel}>
          <span style={S.missionStatus}>{mission.status.replace('_', ' ').toUpperCase()}</span>
          <span style={S.missionGoal}>{mission.userGoal.slice(0, 100)}</span>
          {mission.steps.length > 0 && (
            <span style={S.missionSteps}>{mission.steps.length} steps</span>
          )}
        </div>
      )}

      {/* ── Approval card (only when genuinely required) ─────────────────── */}
      {pendingAction && (
        <div style={S.approvalWrap}>
          <ApprovalCard
            action={pendingAction}
            onApprove={handleApprove}
            onDeny={handleDeny}
          />
        </div>
      )}

      {/* ── M2 Activity panel ─────────────────────────────────────────────── */}
      {showActivity && (
        <div style={S.activityPanel}>
          <div style={S.activityHeader}>
            <span style={{ ...S.activityBadge, ...activityBadgeStyle(activityStatus) }}>
              {ACTIVITY_LABEL[activityStatus]}
            </span>
            <button
              onClick={handleDismiss}
              style={S.dismissBtn}
              aria-label="Dismiss activity panel"
              title="Dismiss"
            >✕</button>
          </div>

          {userRequest !== '' && (
            <div style={S.activityRequest}>
              <span style={S.activityLabel}>You</span>
              <span style={S.activityText}>{userRequest}</span>
            </div>
          )}

          {currentStep !== null && activityStatus === 'running' && (
            <div style={S.activityStep}>
              <span style={S.stepDot}>⋯</span>
              <span style={S.activityText}>{currentStep}</span>
            </div>
          )}

          {displayedResponse !== null && displayedResponse !== '' && (
            <div style={S.activityResponse}>
              <span style={S.activityLabel}>Goga</span>
              <span style={{ ...S.activityText, ...S.activityResponseText }}>
                {displayedResponse}
                {streamingText !== '' && <span style={S.cursor}>▍</span>}
              </span>
            </div>
          )}

          {activityStatus === 'stopped' && (
            <div style={S.activityOutcome}>
              <span style={{ color: '#ff4466' }}>Stopped</span>
              {stopReason && stopReason !== 'Stopped' && (
                <span style={S.stopReasonText}> — {stopReason}</span>
              )}
            </div>
          )}

          {activityStatus === 'failed' && (
            <div style={{ ...S.activityOutcome, color: '#ff4466' }}>Failed</div>
          )}
        </div>
      )}

      {/* ── Bottom composer ───────────────────────────────────────────────── */}
      <div style={S.composerWrap}>
        {(activityStatus === 'running' || activityStatus === 'approval') && (
          <div style={S.stopRow}>
            <StopButton />
          </div>
        )}
        <ChatComposer
          onSend={handleSend}
          loading={loading}
          isAgentRunning={isAgentRunning}
          compact
        />
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @media (prefers-reduced-motion: reduce) {
          * { animation: none !important; transition: none !important; }
        }
      `}</style>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column',
    flex: 1, overflow: 'hidden',
    background: '#06050e',
    position: 'relative',
  },

  // Top bar — identity + icon controls
  topBar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 20px 0',
    flexShrink: 0,
    zIndex: 10,
  },
  logo: {
    fontSize: 11, fontWeight: 700, letterSpacing: 5,
    color: '#7a5ccc',
    userSelect: 'none',
  },
  topRight: {
    display: 'flex', gap: 8,
  },
  iconBtn: {
    background: 'rgba(255,255,255,0.04)', border: '1px solid #2a1f4a',
    color: '#7a5ccc', fontSize: 16,
    width: 40, height: 40,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 8,
    cursor: 'pointer',
    transition: 'color 0.2s, background 0.2s',
    flexShrink: 0,
  },

  // Triangle — takes all available vertical space
  triangleWrap: {
    flex: 1, minHeight: 0,
    position: 'relative',
  },

  // Single truthful status line
  statusLine: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
    fontSize: 11, fontWeight: 600, letterSpacing: 1.5,
    padding: '8px 0 6px',
    flexShrink: 0,
    transition: 'color 0.5s',
    userSelect: 'none',
  },
  statusDot: {
    width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
    transition: 'background 0.5s',
  },

  // Compact mission panel — shown only while a mission is active
  missionPanel: {
    display: 'flex', alignItems: 'center', gap: 10,
    margin: '0 16px 6px',
    padding: '8px 14px',
    background: 'rgba(10,8,22,0.7)',
    border: '1px solid rgba(91,33,255,0.2)',
    borderRadius: 8,
    backdropFilter: 'blur(8px)',
    flexShrink: 0,
  },
  missionStatus: {
    fontSize: 9, fontWeight: 700, letterSpacing: 1.5,
    color: '#8b5cff', flexShrink: 0,
  },
  missionGoal: {
    flex: 1, fontSize: 11, color: '#c8b8f0',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  missionSteps: {
    fontSize: 9, color: '#3d2d55', flexShrink: 0,
  },

  // Approval card wrapper
  approvalWrap: {
    margin: '0 16px 6px',
    flexShrink: 0,
  },

  // Bottom composer area
  composerWrap: {
    flexShrink: 0,
  },
  stopRow: {
    display: 'flex', justifyContent: 'center',
    padding: '4px 16px 0',
    background: 'rgba(10,8,22,0.85)',
  },

  // M2 activity panel
  activityPanel: {
    margin: '0 16px 6px',
    padding: '10px 14px',
    background: 'rgba(10,8,22,0.82)',
    border: '1px solid rgba(91,33,255,0.18)',
    borderRadius: 8,
    backdropFilter: 'blur(10px)',
    flexShrink: 0,
    maxHeight: 220,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  activityHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    flexShrink: 0,
  },
  activityBadge: {
    fontSize: 9, fontWeight: 700, letterSpacing: 1.5,
    padding: '2px 8px', borderRadius: 3,
    border: '1px solid',
    userSelect: 'none',
  },
  dismissBtn: {
    background: 'transparent', border: 'none',
    color: '#3d2d55', fontSize: 12,
    cursor: 'pointer', padding: '2px 6px',
    lineHeight: 1,
  },
  activityRequest: {
    display: 'flex', gap: 8, alignItems: 'baseline',
  },
  activityResponse: {
    display: 'flex', gap: 8, alignItems: 'baseline',
  },
  activityStep: {
    display: 'flex', gap: 6, alignItems: 'center',
  },
  activityLabel: {
    fontSize: 9, fontWeight: 700, letterSpacing: 1,
    color: '#554477', flexShrink: 0, textTransform: 'uppercase' as const,
    width: 32,
  },
  activityText: {
    fontSize: 12, color: '#c8b8f0', lineHeight: 1.5,
    flex: 1, wordBreak: 'break-word' as const,
  },
  activityResponseText: {
    color: '#e8d8ff',
  },
  stepDot: {
    color: '#8b5cff', fontSize: 14, flexShrink: 0, width: 16,
  },
  cursor: {
    opacity: 0.5, animation: 'pulse 1s infinite',
  },
  activityOutcome: {
    fontSize: 11, fontWeight: 600,
    display: 'flex', alignItems: 'center', gap: 4,
  },
  stopReasonText: {
    fontSize: 10, color: '#554477',
  },
}

// ── M2 activity badge helpers ─────────────────────────────────────────────────
const ACTIVITY_LABEL: Record<ActivityStatus, string> = {
  none:      '',
  running:   'RUNNING',
  approval:  'APPROVAL',
  completed: 'DONE',
  stopped:   'STOPPED',
  failed:    'FAILED',
}

function activityBadgeStyle(status: ActivityStatus): React.CSSProperties {
  const map: Record<ActivityStatus, { color: string; borderColor: string }> = {
    none:      { color: '#443355', borderColor: '#443355' },
    running:   { color: '#8b5cff', borderColor: '#8b5cff55' },
    approval:  { color: '#ffaa22', borderColor: '#ffaa2255' },
    completed: { color: '#00ffcc', borderColor: '#00ffcc55' },
    stopped:   { color: '#ff4466', borderColor: '#ff446655' },
    failed:    { color: '#ff4466', borderColor: '#ff446655' },
  }
  return map[status] ?? map.none
}
