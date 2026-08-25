import React, { useState, useRef, useEffect } from 'react'
import type { ChatMessage, AgentStep, AgentState } from '@shared/types'
import type { ScreenshotResult } from '@shared/ipc'
import { useGogaVisual } from '../context/GogaVisualContext'
import { agentStateToVisual } from '../components/GogaCore/GogaVisualState'
import GogaTriangleScene from '../components/GogaCore/GogaTriangleScene'
import ChatComposer from '../components/ChatComposer'

interface DisplayMessage extends ChatMessage { screenshot?: ScreenshotResult }

function hasConversation(msgs: DisplayMessage[]): boolean {
  return msgs.some(m => m.role === 'user' || (m.role === 'assistant' && m.id !== '0'))
}

export default function ChatPage() {
  const [messages, setMessages] = useState<DisplayMessage[]>([
    { id: '0', role: 'system', content: 'Goga is ready. Type or speak to me.', timestamp: Date.now() }
  ])
  const [loading, setLoading]             = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [agentState, setAgentState]       = useState<AgentState | null>(null)
  const [agentSteps, setAgentSteps]       = useState<AgentStep[]>([])
  const [showSteps, setShowSteps]         = useState(true)
  const bottomRef      = useRef<HTMLDivElement>(null)
  const stepsBottomRef = useRef<HTMLDivElement>(null)
  const { setVisualState } = useGogaVisual()

  const inConversation = hasConversation(messages)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { stepsBottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [agentSteps])

  useEffect(() => {
    const unsubs = [
      window.goga.on('chat:token', ({ token }) => setStreamingText(prev => prev + token)),
      window.goga.on('agent:step', step => setAgentSteps(prev => [...prev, step])),
      window.goga.on('agent:state', state => {
        setAgentState(state)
        setVisualState(agentStateToVisual(state))
        if (['idle', 'done', 'stopped'].includes(state.status)) setLoading(false)
      }),
      window.goga.on('agent:stopped', () => {
        setLoading(false)
        setAgentState(s => s ? { ...s, status: 'stopped' } : null)
        setVisualState('stopped')
      }),
      window.goga.on('chat:message', msg => {
        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev
          return [...prev, msg]
        })
        setLoading(false)
        setStreamingText('')
      }),
      window.goga.on('action:approval-required', action => {
        setVisualState('waitingApproval')
        setMessages(prev => [...prev, {
          id: `notify-${action.id}`, role: 'system',
          content: `⚠️ Approval required: ${action.label} — go to Approvals tab or say "yes" / "no".`,
          timestamp: Date.now()
        }])
      }),
      // voice:transcript — set loading; voice:status/amplitude handled by ChatComposer
      window.goga.on('voice:transcript', () => {
        setLoading(true)
        setAgentSteps([])
        setStreamingText('')
        setVisualState('thinking')
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
  const sendText = async (text: string) => {
    if (!text || loading) return
    setLoading(true)
    setAgentSteps([])
    setStreamingText('')
    setVisualState('thinking')

    const userMsg: DisplayMessage = { id: Date.now().toString(), role: 'user', content: text, timestamp: Date.now() }
    setMessages(prev => [...prev, userMsg])

    try {
      const reply = await window.goga.invoke('chat:send', text)
      if (!messages.some(m => m.id === reply.id)) {
        let dm: DisplayMessage = reply
        if (reply.content === '__screenshot__') {
          const actions = await window.goga.invoke('actions:list')
          const last = actions.find(a => reply.actionIds?.includes(a.id))
          dm = { ...reply, content: 'Screenshot captured:', screenshot: last?.result as ScreenshotResult }
        }
        setMessages(prev => prev.some(m => m.id === dm.id) ? prev : [...prev, dm])
      }
      setStreamingText('')
    } catch (e) {
      setStreamingText('')
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'system', content: `Error: ${e}`, timestamp: Date.now() }])
    } finally {
      setLoading(false)
    }
  }

  const isAgentRunning = agentState?.status === 'running' || agentState?.status === 'waiting-approval'
  const coreH = inConversation ? 180 : 500

  return (
    <div style={S.page}>

      {/* Triangle */}
      <div style={{ ...S.coreWrap, height: coreH, transition: 'height 0.6s cubic-bezier(0.4,0,0.2,1)' }}>
        <GogaTriangleScene compact={inConversation} />
      </div>

      {/* Welcome */}
      {!inConversation && (
        <div style={S.greeting}>
          <span style={S.greetName}>Goga</span>
          <span style={S.greetSub}>Your local AI operator. Type or speak.</span>
        </div>
      )}

      {/* Agent step panel */}
      {(agentSteps.length > 0 || isAgentRunning) && (
        <div style={S.agentPanel}>
          <div style={S.agentHeader}>
            <span style={{ fontWeight: 600, fontSize: 11, color: '#8b5cff' }}>
              {agentState?.status === 'waiting-approval' ? '⏳ awaiting approval' : `⚡ ${agentState?.status ?? 'running'}`}
              {agentState?.currentTool && <span style={{ color: '#554477', marginLeft: 6 }}>{agentState.currentTool}</span>}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setShowSteps(v => !v)} style={S.miniBtn}>{showSteps ? '▲' : '▼'}</button>
              <button onClick={() => { window.goga.invoke('agent:stop'); setLoading(false) }} style={{ ...S.miniBtn, color: 'var(--danger)' }}>⏹</button>
            </div>
          </div>
          {showSteps && (
            <div style={S.stepList}>
              {agentSteps.map((step, i) => (
                <div key={i} style={S.stepRow}>
                  <span style={{ color: step.result.success ? '#00ffcc' : 'var(--danger)', width: 12, flexShrink: 0 }}>
                    {step.result.success ? '✓' : '✗'}
                  </span>
                  <span style={{ color: '#8b5cff', width: 150, flexShrink: 0, fontSize: 10 }}>{step.tool}</span>
                  <span style={{ color: '#554477', flex: 1, fontSize: 10 }}>{step.thought.slice(0, 90)}</span>
                </div>
              ))}
              {isAgentRunning && (
                <div style={{ ...S.stepRow, color: '#443355', fontStyle: 'italic', fontSize: 10 }}>
                  <span style={{ width: 12 }}>⋯</span><span>thinking…</span>
                </div>
              )}
              <div ref={stepsBottomRef} />
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      <div style={S.messages}>
        {messages.filter(m => !(m.id === '0' && !inConversation)).map(m => (
          <div key={m.id} style={{ ...S.bubble, ...(m.role === 'user' ? S.user : m.role === 'system' ? S.system : S.assistant) }}>
            <span style={S.role}>{m.role}</span>
            <p style={{ margin: 0, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{m.content}</p>
            {m.screenshot && <img src={`data:image/png;base64,${m.screenshot.base64}`} alt="Screenshot" style={S.screenshot} />}
          </div>
        ))}
        {loading && !isAgentRunning && streamingText === '' && (
          <div style={{ ...S.bubble, ...S.assistant, color: '#554477' }}>
            <span style={S.role}>assistant</span>Thinking…
          </div>
        )}
        {streamingText !== '' && (
          <div style={{ ...S.bubble, ...S.assistant }}>
            <span style={S.role}>assistant</span>
            <p style={{ margin: 0, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
              {streamingText}<span style={{ opacity: 0.5, animation: 'pulse 1s infinite' }}>▍</span>
            </p>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer — mic + input + send (shared with MissionMode) */}
      <ChatComposer
        onSend={sendText}
        loading={loading}
        isAgentRunning={isAgentRunning}
      />

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  page:        { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', background: '#06050e' },
  coreWrap:    { flexShrink: 0, width: '100%', position: 'relative', overflow: 'hidden' },
  greeting:    { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '10px 0 18px', flexShrink: 0 },
  greetName:   { fontSize: 22, fontWeight: 700, color: '#b794ff', letterSpacing: 4 },
  greetSub:    { fontSize: 12, color: '#443355', letterSpacing: 1 },
  agentPanel:  { background: '#0a0816', borderBottom: '1px solid #1e1a30', flexShrink: 0 },
  agentHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 16px' },
  stepList:    { maxHeight: 110, overflowY: 'auto', padding: '2px 16px 6px' },
  stepRow:     { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '2px 0' },
  miniBtn:     { background: '#13101f', color: '#443355', padding: '2px 8px', fontSize: 11 },
  messages:    { flex: 1, overflowY: 'auto', padding: '14px 24px', display: 'flex', flexDirection: 'column', gap: 10, background: '#07060d' },
  bubble:      { maxWidth: 680, padding: '9px 13px', borderRadius: 8, lineHeight: 1.5 },
  user:        { background: '#2d1580', color: '#e8d8ff', alignSelf: 'flex-end' },
  assistant:   { background: '#0e0c18', border: '1px solid #1e1a30', alignSelf: 'flex-start', color: '#c8b8f0' },
  system:      { background: 'transparent', border: '1px solid #1a1428', alignSelf: 'center', color: '#3d2d55', fontSize: 11 },
  role:        { display: 'block', fontSize: 9, opacity: 0.45, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.8 },
  screenshot:  { display: 'block', marginTop: 10, maxWidth: '100%', borderRadius: 6, border: '1px solid #2a1f4a' },
}
