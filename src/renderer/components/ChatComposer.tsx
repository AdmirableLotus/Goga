import React, { useState, useCallback, useEffect, useRef } from 'react'
import { prepareAttachment } from './prepareAttachment'
import { validateAttachments, type ChatAttachment, MAX_ATTACHMENTS } from '../../shared/attachments'
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
  onSend: (text: string, attachments?: ChatAttachment[]) => void | boolean | Promise<void | boolean>
  allowAttachments?: boolean
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
export default function ChatComposer({ onSend, loading = false, isAgentRunning = false, compact = false, allowAttachments = false }: Props) {
  const [input, setInput] = useState('')
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle')
  const [partialText, setPartialText] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [mediaError, setMediaError] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [sending, setSending] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const submitLock = useRef(false)
  const prepareLock = useRef(false)
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

  const handleSend = async () => {
    const t = input.trim()
    if ((!t && !attachments.length) || (loading && !isAgentRunning) || submitLock.current || prepareLock.current) return
    submitLock.current = true; setSending(true); setMediaError('')
    try {
      const result = await onSend(t, attachments)
      if (result !== false) { setInput(current => current.trim() === t ? '' : current); setAttachments([]) }
    } catch (error) { setMediaError(String(error)) }
    finally { submitLock.current = false; setSending(false) }
  }

  const attach = async (files: File[]) => {
    if (!files.length || prepareLock.current || submitLock.current) return
    if (files.length + attachments.length > MAX_ATTACHMENTS) { setMediaError('Attach up to four files.'); return }
    prepareLock.current = true; setPreparing(true); setMediaError('')
    try {
      const added: ChatAttachment[] = []
      for (const file of files) added.push(await prepareAttachment(file))
      setAttachments(validateAttachments([...attachments, ...added]))
    } catch (error) { setMediaError(error instanceof Error ? error.message : String(error)) }
    finally { prepareLock.current = false; setPreparing(false) }
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
    <div style={{ flexShrink: 0 }}>
      {(attachments.length > 0 || preparing || mediaError) && (
        <div style={{ padding: '10px 14px', background: 'var(--surface-2)', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{attachments.map(a => <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', maxWidth: 270 }}>
            <img src={a.images[0]} alt={a.name} style={{ width: 58, height: 46, objectFit: 'cover', borderRadius: 5 }} />
            <span style={{ fontSize: 'var(--fs-caption)', overflowWrap: 'anywhere' }}>{a.name}{a.kind === 'video' && <small style={{ display: 'block' }}>Video · {a.images.length} sampled frames · no audio</small>}</span>
            <button className="g-btn g-btn--ghost g-btn--sm" aria-label={`Remove ${a.name}`} disabled={preparing || sending} onClick={() => setAttachments(prev => prev.filter(item => item.id !== a.id))}>×</button>
          </div>)}</div>
          {preparing && <p role="status" style={{ fontSize: 'var(--fs-caption)' }}>Preparing media…</p>}
          {mediaError && <p role="alert" style={{ fontSize: 'var(--fs-caption)', color: '#ff9fae' }}>{mediaError}</p>}
        </div>
      )}
      <div className={compact ? 'g-composer-row' : 'g-composer-row'} style={compact ? { padding: '8px 10px' } : undefined}>
        {allowAttachments && <>
          <input ref={fileInput} type="file" aria-label="Choose images or videos" accept="image/*,video/*" multiple hidden onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; void attach(files) }} />
          <button
            className="g-btn g-btn--ghost g-btn--sm"
            title="Attach images or videos"
            aria-label="Attach images or videos"
            disabled={preparing || sending || (loading && !isAgentRunning)}
            onClick={() => fileInput.current?.click()}
          >Attach</button>
        </>}
        <button
          onClick={handleMic}
          /* Mic always usable during speaking/listening (for barge-in/stop);
             only disabled during pure LLM generation. */
          disabled={loading && voiceStatus === 'idle' && !isAgentRunning}
          title={micAriaLabel}
          aria-label={micAriaLabel}
          style={{
            ...S.micBtn,
            background: micActive ? 'rgba(41,217,255,0.12)' : voiceStatus === 'speaking' ? '#aa6600' : 'var(--surface-2)',
            color:      micActive ? '#29d9ff' : voiceStatus === 'speaking' ? '#fff'    : 'var(--text-muted)',
            border:     micActive ? '1px solid rgba(41,217,255,0.4)' : '1px solid var(--border)',
            animation:  micActive ? 'pulse 1s infinite' : 'none',
          }}
        >{micIcon}</button>

        <input
          className="g-composer-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
          placeholder={placeholder}
          /* Input stays usable during TTS (speaking) and listening — only the
             LLM generation window (loading, non-agent) disables it. */
          disabled={(sending && !isAgentRunning) || (loading && !isAgentRunning && voiceStatus !== 'speaking' && voiceStatus !== 'listening')}
        />

        <button
          className="g-btn g-btn--primary"
          onClick={handleSend}
          /* Send stays clickable during TTS/listening; only blocked while the
             LLM is actively generating (and only if agent isn't multi-step). */
          disabled={sending || preparing || (!input.trim() && !attachments.length) || (loading && !isAgentRunning && voiceStatus !== 'speaking' && voiceStatus !== 'listening')}
        >Send</button>
      </div>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  micBtn: {
    width: 36, height: 36, minWidth: 36, minHeight: 36,
    borderRadius: '50%', fontSize: 15,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, padding: 0, cursor: 'pointer',
  },
}
