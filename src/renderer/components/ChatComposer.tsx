import React, { useState, useCallback, useEffect } from 'react'
import type { VoiceStatus } from '../../main/services/voiceOrchestrator'
import { useGogaVisual } from '../context/GogaVisualContext'

const MIC_LABEL: Record<VoiceStatus, string> = {
  idle:           'mic',
  wake_listening: 'ear',
  listening:      'stop',
  transcribing:   'dots',
  speaking:       'mute',
  disabled:       'mic',
}

// SVG icons for mic button
const MicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1 17.93V21H9v2h6v-2h-2v-2.07A8 8 0 0 0 20 11h-2a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93z"/>
  </svg>
)
const StopMicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="2"/>
  </svg>
)
const MuteIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <path d="M16.5 12A4.5 4.5 0 0 0 14 7.97V10.5l2.45 2.45c.03-.3.05-.6.05-.95zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A9.9 9.9 0 0 0 21 12c0-5.52-3.99-10.1-9.28-10.9v2.06A8 8 0 0 1 19 12zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25A6.97 6.97 0 0 1 14 18.7v2.06c1.7-.34 3.22-1.1 4.47-2.17L19.73 20 21 18.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
  </svg>
)

interface Props {
  onSend: (text: string) => void
  loading?: boolean
  isAgentRunning?: boolean
  /** If true, renders in compact/mission style */
  compact?: boolean
}

/**
 * Reusable mic + text input + send composer.
 * Owns voice status IPC subscription and amplitude forwarding.
 * Used by both ChatPage and MissionMode.
 */
export default function ChatComposer({ onSend, loading = false, isAgentRunning = false, compact = false }: Props) {
  const [input, setInput] = useState('')
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle')
  const [partialText, setPartialText] = useState('')
  const { setVisualState, setAudioAmplitude } = useGogaVisual()

  // Voice status → visual state + amplitude
  useEffect(() => {
    const unsubs = [
      window.goga.on('voice:status', ({ status }) => {
        setVoiceStatus(status)
        if (status === 'listening' || status === 'wake_listening') setVisualState('listening')
        else if (status === 'transcribing') setVisualState('transcribing')
        else if (status === 'speaking') setVisualState('speaking')
        // Clear stale partial text once we leave the listening/transcribing phase
        if (status !== 'listening' && status !== 'transcribing') setPartialText('')
      }),
      window.goga.on('voice:amplitude', ({ value }) => setAudioAmplitude(value)),
      // Partial STT transcript is DISPLAY ONLY — it is never submitted.
      window.goga.on('voice:partial', ({ text }) => setPartialText(text)),
    ]
    return () => unsubs.forEach(u => u())
  }, [setVisualState, setAudioAmplitude])

  const handleMic = useCallback(async () => {
    if (voiceStatus === 'listening') {
      window.goga.invoke('voice:stopListening')
    } else if (voiceStatus === 'speaking') {
      // Barge-in: stop playback, then immediately begin listening
      await window.goga.invoke('voice:stopSpeaking')
      window.goga.invoke('voice:listenOnce')
    } else {
      window.goga.invoke('voice:listenOnce')
    }
  }, [voiceStatus])

  const handleSend = () => {
    const t = input.trim()
    if (!t || (loading && !isAgentRunning)) return
    setInput('')
    onSend(t)
  }

  const micActive = voiceStatus === 'listening' || voiceStatus === 'transcribing'
  const micIcon = voiceStatus === 'listening' ? <StopMicIcon /> :
                  voiceStatus === 'speaking'   ? <MuteIcon /> :
                  <MicIcon />
  const micAriaLabel = voiceStatus === 'listening' ? 'Stop listening' :
                       voiceStatus === 'speaking'   ? 'Stop speaking' :
                       'Voice input'

  const placeholder =
    (voiceStatus === 'listening' || voiceStatus === 'transcribing') && partialText
                                   ? `🎤 ${partialText}` :
    voiceStatus === 'listening'    ? '🎤 Listening…' :
    voiceStatus === 'transcribing' ? '⋯ Transcribing…' :
    voiceStatus === 'speaking'     ? '🔊 Speaking…' :
    isAgentRunning                 ? '⚡ Running…' :
    compact                        ? 'Talk to Goga or type a message…' :
    'Talk to Goga or type a message…'

  return (
    <div style={{ ...S.row, ...(compact ? S.rowCompact : {}) }}>
      <button
        onClick={handleMic}
        /* Mic always usable during speaking/listening (for barge-in/stop);
           only disabled during pure LLM generation. */
        disabled={loading && voiceStatus === 'idle' && !isAgentRunning}
        title={micAriaLabel}
        aria-label={micAriaLabel}
        style={{
          ...S.micBtn,
          background: micActive ? '#1a0a2e' : voiceStatus === 'speaking' ? '#aa6600' : '#13101f',
          color:      micActive ? '#29d9ff' : voiceStatus === 'speaking' ? '#fff'    : '#554477',
          border:     micActive ? '1px solid #29d9ff55' : '1px solid #2a1f4a',
          animation:  micActive ? 'pulse 1s infinite' : 'none',
        }}
      >{micIcon}</button>

      <input
        style={S.input}
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
        placeholder={placeholder}
        /* Input stays usable during TTS (speaking) and listening — only the
           LLM generation window (loading, non-agent) disables it. */
        disabled={loading && !isAgentRunning && voiceStatus !== 'speaking' && voiceStatus !== 'listening'}
      />

      <button
        onClick={handleSend}
        /* Send stays clickable during TTS/listening; only blocked while the
           LLM is actively generating (and only if agent isn't multi-step). */
        disabled={!input.trim() || (loading && !isAgentRunning && voiceStatus !== 'speaking' && voiceStatus !== 'listening')}
        style={S.sendBtn}
      >Send</button>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex', gap: 8, padding: '10px 20px',
    borderTop: '1px solid #1a1428', background: '#0a0816', alignItems: 'center',
  },
  rowCompact: {
    padding: '8px 16px',
    background: 'rgba(10,8,22,0.85)',
    backdropFilter: 'blur(12px)',
    borderTop: '1px solid rgba(91,33,255,0.18)',
  },
  micBtn: {
    width: 40, height: 40, minWidth: 40, minHeight: 40,
    borderRadius: '50%', fontSize: 15,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, padding: 0, cursor: 'pointer',
  },
  input: {
    flex: 1, background: '#0e0c18', border: '1px solid #2a1f4a', color: '#e8d8ff',
  },
  sendBtn: {
    background: '#5b21ff', color: '#fff', fontWeight: 600, padding: '8px 18px',
  },
}
