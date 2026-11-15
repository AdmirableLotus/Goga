import React, { useState, useRef, useEffect } from 'react'
import type { ChatMessage, AgentStep, AgentState } from '@shared/types'
import type { ScreenshotResult } from '@shared/ipc'
import { useGogaVisual } from '../context/GogaVisualContext'
import { agentStateToVisual } from '../components/GogaCore/GogaVisualState'
import GogaTriangleScene from '../components/GogaCore/GogaTriangleScene'
import AgentStatusLine from '../components/AgentStatusLine'
import WakeIndicator from '../components/WakeIndicator'
import ChatComposer from '../components/ChatComposer'
import type { ChatAttachment } from '../../shared/attachments'

interface DisplayMessage extends ChatMessage { screenshot?: ScreenshotResult }

function hasConversation(msgs: DisplayMessage[]): boolean {
  return msgs.some(m => m.role === 'user' || (m.role === 'assistant' && m.id !== '0'))
}

export default function ChatPage() {
  const [messages, setMessages] = useState<DisplayMessage[]>([
    { id: '0', role: 'system', content: 'Goga is ready. Type or speak to me.', timestamp: Date.now() }
  ])
  const [loading, setLoading]             = useState(false)
  // A typed send is in flight. Kept separately from `loading`, because a stray
  // agent:state from the previous turn can clear `loading` while the reply is
  // still being written — and then the status line would claim to be Ready.
  const [sending, setSending]             = useState(false)
  // Per-turn streaming text: turnId → accumulated tokens
  const [streamingTurns, setStreamingTurns] = useState<Map<string, string>>(new Map())
  const [agentState, setAgentState]       = useState<AgentState | null>(null)
  const [agentSteps, setAgentSteps]       = useState<AgentStep[]>([])
  const [showSteps, setShowSteps]         = useState(true)
  // 0–1 agitation reported by the status line; the scene follows the same curve.
  const [heat, setHeat]                   = useState(0)
  const bottomRef      = useRef<HTMLDivElement>(null)
  const stepsBottomRef = useRef<HTMLDivElement>(null)
  const { setVisualState } = useGogaVisual()

  // Track which message IDs have already been committed (exactly-once guard)
  const committedMsgIds = useRef<Set<string>>(new Set())
  // Track which turnIds have been finalised by a canonical chat:message
  const finalisedTurnIds = useRef<Set<string>>(new Set())
  // Submission lock: prevents re-entry while a chat:send IPC call is in flight
  const sendInFlight = useRef(false)

  const inConversation = hasConversation(messages)
  // A turn is in flight if either the page or the agent says so.
  const busy = loading || sending
  const isAgentRunning = agentState?.status === 'running' || agentState?.status === 'waiting-approval'

  // Derive a single streaming text for display: the most-recently-active turn
  // that has not yet been finalised. In practice at most one turn streams at a time.
  const activeStreamingText = (() => {
    for (const [, text] of streamingTurns) {
      if (text !== '') return text
    }
    return ''
  })()

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { stepsBottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [agentSteps])

  useEffect(() => {
    const unsubs = [
      window.goga.on('chat:token', ({ token, turnId }) => {
        // Ignore tokens for a turn that already has a canonical message
        if (finalisedTurnIds.current.has(turnId)) return
        setStreamingTurns(prev => {
          const next = new Map(prev)
          next.set(turnId, (next.get(turnId) ?? '') + token)
          return next
        })
      }),

      window.goga.on('agent:step', step => setAgentSteps(prev => [...prev, step])),

      window.goga.on('agent:state', state => {
        setAgentState(state)
        setVisualState(agentStateToVisual(state))
        if (['idle', 'done', 'stopped', 'error'].includes(state.status)) setLoading(false)
      }),

      window.goga.on('agent:stopped', () => {
        setLoading(false)
        setAgentSteps([])
        setAgentState(s => s ? { ...s, status: 'stopped' } : null)
        setVisualState('stopped')
      }),

      // chat:message is the ONLY path that commits a final assistant response.
      // It clears the streaming slot for this turn and marks the turn finalised.
      window.goga.on('chat:message', msg => {
        // Exactly-once guard by message id
        if (committedMsgIds.current.has(msg.id)) return
        committedMsgIds.current.add(msg.id)

        // Mark this turn finalised so late tokens are dropped
        if (msg.turnId) {
          finalisedTurnIds.current.add(msg.turnId)
          setStreamingTurns(prev => {
            const next = new Map(prev)
            next.delete(msg.turnId!)
            return next
          })
        }

        setMessages(prev => [...prev, msg])
        setLoading(false)
      }),

      window.goga.on('action:approval-required', action => {
        setVisualState('waitingApproval')
        setMessages(prev => [...prev, {
          id: `notify-${action.id}`, role: 'system',
          content: `⚠️ Approval required: ${action.label} — go to Approvals tab or say "yes" / "no".`,
          timestamp: Date.now()
        }])
      }),

      // voice:transcript — set loading; resets streaming for this new turn
      window.goga.on('voice:transcript', () => {
        setLoading(true)
        setAgentSteps([])
        setStreamingTurns(new Map())
        setVisualState('thinking')
      }),

      // voice:status → idle: audio pipeline done.
      // ONLY updates loading/visual state. Never creates, erases, or finalises
      // a chat message. The canonical chat:message is the sole commit path.
      window.goga.on('voice:status', ({ status }) => {
        if (status === 'idle') {
          setLoading(false)
        }
      }),
    ]
    return () => unsubs.forEach(u => u())
  }, [setVisualState])

  // Emergency stop
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'Escape') {
        e.preventDefault()
        window.goga.invoke('agent:stop')
        window.goga.invoke('action:stop')
        window.goga.invoke('voice:stopListening')
        window.goga.invoke('voice:stopSpeaking')
        setLoading(false)
        setVisualState('stopped')
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [setVisualState])

  // ── Send ──────────────────────────────────────────────────────────────────
  const sendText = async (text: string, attachments: ChatAttachment[] = []) => {
    // Block if loading (non-agent) OR if a send is already in flight
    if ((!text && !attachments.length) || sendInFlight.current || (loading && !isAgentRunning)) return false
    sendInFlight.current = true

    // A new typed request stops any current speech immediately.
    window.goga.invoke('voice:stopSpeaking')

    setLoading(true)
    setSending(true)
    setAgentSteps([])
    setStreamingTurns(new Map())
    setVisualState('thinking')

    const userMsg: DisplayMessage = { id: Date.now().toString(), role: 'user', content: text, attachments, timestamp: Date.now() }
    setMessages(prev => [...prev, userMsg])

    try {
      const reply = await window.goga.invoke('chat:send', text, attachments)
      // Exactly-once guard: the chat:message event may have already committed this
      if (!committedMsgIds.current.has(reply.id)) {
        committedMsgIds.current.add(reply.id)
        if (reply.turnId) {
          finalisedTurnIds.current.add(reply.turnId)
          setStreamingTurns(prev => {
            const next = new Map(prev)
            next.delete(reply.turnId!)
            return next
          })
        }
        let dm: DisplayMessage = reply
        if (reply.content === '__screenshot__') {
          const actions = await window.goga.invoke('actions:list')
          const last = actions.find(a => reply.actionIds?.includes(a.id))
          dm = { ...reply, content: 'Screenshot captured:', screenshot: last?.result as ScreenshotResult }
        }
        setMessages(prev => [...prev, dm])
      }
      return true
    } catch (e) {
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'system', content: `Error: ${e}`, timestamp: Date.now() }])
      return false
    } finally {
      setLoading(false)
      setSending(false)
      sendInFlight.current = false
    }
  }

  return (
    // --heat is the status line's 0-1 agitation, handed to the backdrop so the
    // scene can grow and warm while Goga works and settle back when it is idle.
    <div className="g-chat" style={{ ['--heat' as string]: heat.toFixed(2) }}>

      {/* Before a conversation the scene IS the page, full height behind the hero.
          Once messages exist it moves down into the open space under them (the
          .g-chat-stage below), because a strip behind the bubbles was mostly
          covered by them and the animation had nothing visible to drive. What
          stays up here then is only a warm wash that follows --heat. */}
      <div className={`g-chat-backdrop${inConversation ? ' g-chat-backdrop--compact' : ''}`} aria-hidden="true">
        {!inConversation && <GogaTriangleScene compact={false} heat={heat} showBadge={false} />}
      </div>

      <div className="g-chat-column">

        {!inConversation && (
          <div className="g-chat-hero">
            <span className="g-chat-greet">Goga</span>
            <span className="g-chat-sub">Your local AI operator. Type or speak.</span>
          </div>
        )}

        {/* Agent step panel */}
        {(agentSteps.length > 0 || isAgentRunning) && agentState?.status !== 'error' && agentState?.status !== 'done' && (
          <div className="g-steps">
            <div className="g-steps-head">
              <span style={{ fontWeight: 600, color: 'var(--accent-hover)' }}>
                {agentState?.status === 'waiting-approval' ? '⏳ awaiting approval' : `⚡ ${agentState?.status ?? 'running'}`}
              </span>
              {agentState?.currentTool && <span className="g-mono" style={{ color: 'var(--text-faint)' }}>{agentState.currentTool}</span>}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button className="g-btn g-btn--ghost g-btn--sm" onClick={() => setShowSteps(v => !v)}>{showSteps ? '▲' : '▼'}</button>
                <button className="g-btn g-btn--ghost g-btn--sm" style={{ color: 'var(--danger)' }} onClick={() => { window.goga.invoke('agent:stop'); setLoading(false) }}>⏹</button>
              </div>
            </div>
            {agentState?.pendingApproval && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-caption)' }}>
                <span style={{ flex: 1 }}>
                  Goga wants to run <code>{agentState.pendingApproval.tool}</code>: {agentState.pendingApproval.label}
                </span>
                <button className="g-btn g-btn--sm" style={{ color: 'var(--success)' }} onClick={() => window.goga.invoke('action:approve', agentState.pendingApproval!.id)}>Approve</button>
                <button className="g-btn g-btn--sm" style={{ color: 'var(--danger)' }} onClick={() => window.goga.invoke('action:reject', agentState.pendingApproval!.id)}>Deny</button>
              </div>
            )}
            {showSteps && (
              <div className="g-steps-list">
                {agentSteps.map((step, i) => (
                  <div key={i} className="g-step-row">
                    <span style={{ color: step.result.success ? 'var(--success)' : 'var(--danger)', width: 12, flexShrink: 0 }}>
                      {step.result.success ? '✓' : '✗'}
                    </span>
                    <span className="g-step-tool">{step.tool}</span>
                    <span className="g-step-thought">{step.thought.slice(0, 90)}</span>
                  </div>
                ))}
                {isAgentRunning && (
                  <div className="g-step-row" style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>
                    <span style={{ width: 12 }}>⋯</span><span>thinking…</span>
                  </div>
                )}
                <div ref={stepsBottomRef} />
              </div>
            )}
          </div>
        )}

        {/* Messages */}
        {inConversation && (
          <div className="g-chat-messages">
            {messages.filter(m => !(m.id === '0' && !inConversation)).map(m => (
              <div key={m.id} className={`g-bubble g-bubble--${m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant'}`}>
                <span className="g-bubble-role">{m.role}</span>
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{m.content}</p>
                {m.attachments?.map(a => <div key={a.id} style={{ marginTop: 10 }}>
                  <span style={{ fontSize: 'var(--fs-caption)' }}>{a.name}{a.kind === 'video' ? ` · ${a.images.length} sampled frames (no audio)` : ''}</span>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{a.images.map((image, i) => <figure key={i} style={{ margin: 0 }}><img src={image} alt={`${a.name}${a.kind === 'video' ? ` frame ${i + 1}` : ''}`} style={{ maxWidth: a.kind === 'video' ? 150 : 380, maxHeight: 240, width: '100%', borderRadius: 6 }} />{a.kind === 'video' && <figcaption style={{ fontSize: 10 }}>{a.sampledAtSeconds?.[i].toFixed(1)}s</figcaption>}</figure>)}</div>
                </div>)}
                {m.screenshot && <img src={`data:image/png;base64,${m.screenshot.base64}`} alt="Screenshot" style={{ display: 'block', marginTop: 10, maxWidth: '100%', borderRadius: 6, border: '1px solid var(--border)' }} />}
              </div>
            ))}
            {busy && !isAgentRunning && activeStreamingText === '' && (
              <div className="g-bubble g-bubble--assistant" style={{ color: 'var(--text-faint)' }}>
                <span className="g-bubble-role">assistant</span>Thinking…
              </div>
            )}
            {activeStreamingText !== '' && (
              <div className="g-bubble g-bubble--assistant">
                <span className="g-bubble-role">assistant</span>
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                  {activeStreamingText}<span style={{ opacity: 0.5, animation: 'pulse 1s infinite' }}>▍</span>
                </p>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}

        {/* The open space under the conversation. The triangle lives here while a
            talk is going on: same scene, same heat, same fixed camera framing, just
            in room of its own instead of under the bubbles. */}
        {inConversation && (
          <div className="g-chat-stage" aria-hidden="true">
            <GogaTriangleScene compact heat={heat} showBadge={false} />
          </div>
        )}

        {/* Hands-free indicator — only shown while the wake word is really on */}
        <WakeIndicator />

        {/* Live status — what Goga is actually doing, from the agent loop's own state */}
        <AgentStatusLine
          agentState={agentState}
          loading={busy}
          streaming={activeStreamingText !== ''}
          onHeat={setHeat}
        />

        {/* Composer — the primary control on the page */}
        <div className="g-composer">
          <ChatComposer
            allowAttachments
            onSend={sendText}
            loading={loading}
            isAgentRunning={isAgentRunning}
          />
          <div className="g-composer-hint">Enter to send · Shift+Enter for a new line · Ctrl+Shift+Esc stops everything</div>
        </div>
      </div>

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
    </div>
  )
}
