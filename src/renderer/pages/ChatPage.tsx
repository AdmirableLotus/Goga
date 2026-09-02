import React, { useState, useRef, useEffect, useCallback } from 'react'
import type { ChatMessage, AgentStep, AgentState } from '@shared/types'
import type { ScreenshotResult } from '@shared/ipc'
import { useSpeech } from '../hooks/useSpeech'

interface DisplayMessage extends ChatMessage {
  screenshot?: ScreenshotResult
}

export default function ChatPage() {
  const [messages, setMessages] = useState<DisplayMessage[]>([
    { id: '0', role: 'system', content: 'Goga is ready. Type or speak to me.', timestamp: Date.now() }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [agentState, setAgentState] = useState<AgentState | null>(null)
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([])
  const [showSteps, setShowSteps] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const stepsBottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { stepsBottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [agentSteps])

  // Subscribe to agent events
  useEffect(() => {
    const unsubs = [
      window.goga.on('agent:step', (step) => {
        setAgentSteps(prev => [...prev, step])
      }),
      window.goga.on('agent:state', (state) => {
        setAgentState(state)
        if (state.status === 'idle' || state.status === 'done' || state.status === 'stopped') {
          setLoading(false)
        }
      }),
      window.goga.on('agent:stopped', () => {
        setLoading(false)
        setAgentState(s => s ? { ...s, status: 'stopped' } : null)
      }),
      // Push final agent reply into chat
      window.goga.on('chat:message', (msg) => {
        setMessages(prev => [...prev, msg])
        if (msg.role === 'assistant') speak(msg.content)
        setLoading(false)
      }),
      window.goga.on('action:approval-required', (action) => {
        setMessages(prev => [...prev, {
          id: `notify-${action.id}`,
          role: 'system',
          content: `⚠️ Approval required: ${action.label} — go to the Approvals tab.`,
          timestamp: Date.now()
        }])
      })
    ]
    return () => unsubs.forEach(u => u())
  }, [])

  // Ctrl+Shift+Escape — emergency stop
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'Escape') {
        e.preventDefault()
        window.goga.invoke('agent:stop')
        window.goga.invoke('action:stop')
        setLoading(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleTranscript = useCallback((text: string) => {
    setInput(text)
    setTimeout(() => sendText(text), 300)
  }, [])

  const { listening, speaking, startListening, stopListening, speak, stopSpeaking } = useSpeech(handleTranscript)

  const sendText = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || loading) return
    setInput('')
    setLoading(true)
    setAgentSteps([])

    const userMsg: DisplayMessage = { id: Date.now().toString(), role: 'user', content: trimmed, timestamp: Date.now() }
    setMessages(prev => [...prev, userMsg])

    try {
      const reply = await window.goga.invoke('chat:send', trimmed)

      // If agent was started, the final reply comes via chat:message event — don't double-add
      if (reply.content.startsWith('On it,') || reply.content.includes('step by step')) {
        setMessages(prev => [...prev, reply])
        // loading stays true until agent:state done/stopped or chat:message arrives
        return
      }

      let displayMsg: DisplayMessage = reply
      if (reply.content === '__screenshot__') {
        const actions = await window.goga.invoke('actions:list')
        const lastAction = actions.find(a => reply.actionIds?.includes(a.id))
        displayMsg = { ...reply, content: 'Screenshot captured:', screenshot: lastAction?.result as ScreenshotResult }
      }

      setMessages(prev => [...prev, displayMsg])
      if (displayMsg.content !== 'Screenshot captured:') speak(displayMsg.content)
    } catch (e) {
      const errMsg = `Error: ${e}`
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'system', content: errMsg, timestamp: Date.now() }])
    } finally {
      setLoading(false)
    }
  }

  const isAgentRunning = agentState?.status === 'running' || agentState?.status === 'waiting-approval'

  return (
    <div style={styles.container}>
      {/* Agent step panel */}
      {(agentSteps.length > 0 || isAgentRunning) && (
        <div style={styles.agentPanel}>
          <div style={styles.agentHeader}>
            <span style={{ fontWeight: 600, fontSize: 12 }}>
              🤖 Agent {agentState?.status === 'waiting-approval' ? '⏳ waiting approval' : agentState?.status ?? 'running'}
              {agentState?.currentTool && ` — ${agentState.currentTool}`}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setShowSteps(s => !s)} style={styles.miniBtn}>
                {showSteps ? '▲ hide' : '▼ show'}
              </button>
              <button onClick={() => { window.goga.invoke('agent:stop'); setLoading(false) }} style={{ ...styles.miniBtn, color: 'var(--danger)' }}>
                ⏹ stop
              </button>
            </div>
          </div>
          {showSteps && (
            <div style={styles.stepList}>
              {agentSteps.map((step, i) => (
                <div key={i} style={styles.stepRow}>
                  <span style={{ color: step.result.success ? 'var(--success)' : 'var(--danger)', width: 14, flexShrink: 0 }}>
                    {step.result.success ? '✓' : '✗'}
                  </span>
                  <span style={{ color: 'var(--accent)', width: 160, flexShrink: 0, fontSize: 11 }}>{step.tool}</span>
                  <span style={{ color: 'var(--text-muted)', flex: 1, fontSize: 11 }}>{step.thought.slice(0, 80)}</span>
                </div>
              ))}
              {isAgentRunning && (
                <div style={{ ...styles.stepRow, color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 11 }}>
                  <span style={{ width: 14 }}>⋯</span>
                  <span>thinking…</span>
                </div>
              )}
              <div ref={stepsBottomRef} />
            </div>
          )}
        </div>
      )}

      {/* Chat messages */}
      <div style={styles.messages}>
        {messages.map(m => (
          <div key={m.id} style={{ ...styles.bubble, ...(m.role === 'user' ? styles.user : m.role === 'system' ? styles.system : styles.assistant) }}>
            <span style={styles.role}>{m.role}</span>
            <p style={{ margin: 0, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{m.content}</p>
            {m.screenshot && (
              <img src={`data:image/png;base64,${m.screenshot.base64}`} alt="Screenshot" style={styles.screenshot} />
            )}
          </div>
        ))}
        {loading && !isAgentRunning && (
          <div style={{ ...styles.bubble, ...styles.assistant, color: 'var(--text-muted)' }}>
            <span style={styles.role}>assistant</span>
            Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input row */}
      <div style={styles.inputRow}>
        <button
          onClick={listening ? stopListening : startListening}
          disabled={loading}
          title={listening ? 'Stop listening' : 'Start voice input'}
          style={{ ...styles.iconBtn, background: listening ? 'var(--danger)' : 'var(--surface2)', color: listening ? '#fff' : 'var(--text-muted)', animation: listening ? 'pulse 1s infinite' : 'none' }}
        >
          {listening ? '⏹' : '🎤'}
        </button>
        {speaking && (
          <button onClick={stopSpeaking} title="Stop speaking" style={{ ...styles.iconBtn, background: 'var(--warn)', color: '#000' }}>🔇</button>
        )}
        <input
          style={{ flex: 1 }}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendText(input)}
          placeholder={listening ? '🎤 Listening…' : isAgentRunning ? '⚡ Agent running… (Ctrl+Shift+Esc to stop)' : 'Type a message or task…'}
          disabled={loading && !isAgentRunning}
        />
        <button onClick={() => sendText(input)} disabled={(loading && !isAgentRunning) || !input.trim()} style={styles.sendBtn}>Send</button>
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }`}</style>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container:   { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' },
  agentPanel:  { background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  agentHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 16px' },
  stepList:    { maxHeight: 160, overflowY: 'auto', padding: '4px 16px 8px' },
  stepRow:     { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '2px 0' },
  miniBtn:     { background: 'var(--surface2)', color: 'var(--text-muted)', padding: '2px 8px', fontSize: 11 },
  messages:    { flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 },
  bubble:      { maxWidth: 720, padding: '10px 14px', borderRadius: 'var(--radius)', lineHeight: 1.5 },
  user:        { background: 'var(--accent)', color: '#fff', alignSelf: 'flex-end' },
  assistant:   { background: 'var(--surface2)', alignSelf: 'flex-start' },
  system:      { background: 'transparent', border: '1px solid var(--border)', alignSelf: 'center', color: 'var(--text-muted)', fontSize: 12 },
  role:        { display: 'block', fontSize: 11, opacity: 0.6, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  screenshot:  { display: 'block', marginTop: 10, maxWidth: '100%', borderRadius: 6, border: '1px solid var(--border)' },
  inputRow:    { display: 'flex', gap: 8, padding: '12px 24px', borderTop: '1px solid var(--border)', background: 'var(--surface)', alignItems: 'center' },
  iconBtn:     { width: 38, height: 38, borderRadius: '50%', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0 },
  sendBtn:     { background: 'var(--accent)', color: '#fff', fontWeight: 600 }
}
