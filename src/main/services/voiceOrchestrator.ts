/**
 * VoiceOrchestrator — Phase E.1
 *
 * New in E.1:
 *   - Conversation session window: stay awake N seconds after last interaction
 *   - Self-TTS suppression: reject STT results that match current TTS text
 *   - allowBargeIn enforcement: when OFF, mic button still works but auto-interrupt blocked
 *   - Continuous wake loop via startContinuous() — no repeated 4s PS startup cost
 *   - Mission conversation routing: mid-mission utterances classified before routing
 *
 * SECURITY (unchanged):
 *   - Only actual STT events are treated as user voice input
 *   - Screen/page text NEVER enters this pipeline
 *   - Voice does NOT bypass AuthorizationService
 *   - approvalPending gate: voice:approve only fires when action awaiting approval
 */

import { EventEmitter } from 'events'
import { WindowsSttProvider } from './speech/WindowsSpeechProvider'
import { WindowsTtsProvider } from './speech/WindowsSpeechProvider'
import { WhisperSttProvider } from './speech/WhisperSttProvider'
import { ElevenLabsTtsProvider } from './speech/ElevenLabsTtsProvider'
import type { ISttProvider, ITtsProvider } from './speech/ISpeechProvider'
import { SettingsService } from './settings'
import { LogService } from './logs'

export type VoiceStatus =
  | 'idle'
  | 'wake_listening'
  | 'listening'
  | 'transcribing'
  | 'speaking'
  | 'disabled'

// Words that approve a pending action — ONLY when approvalPending=true
const APPROVE_WORDS = /^(yes|yeah|yep|sure|ok|okay|go ahead|do it|proceed|affirmative|absolutely|correct|right)[.!]?$/i
const REJECT_WORDS  = /^(no|nope|don'?t|cancel|stop|reject|abort|never)[.!]?$/i
const STOP_WORDS    = /^(stop|halt|cancel|abort|quit)[.!]?$/i

// How long a TTS phrase stays in the suppression window after speaking ends (ms)
const TTS_SUPPRESS_GRACE_MS = 1500

export class VoiceOrchestrator extends EventEmitter {
  private static instance: VoiceOrchestrator

  private stt: ISttProvider = new WindowsSttProvider()
  private tts: ITtsProvider = new WindowsTtsProvider()
  private fallbackTts: ITtsProvider = new WindowsTtsProvider()
  private log = LogService.getInstance()

  private status: VoiceStatus = 'disabled'
  private wakeLoopActive = false
  private approvalPending = false
  private abortWake = false

  // ── Conversation session ──────────────────────────────────────────────────
  // After wake word or any interaction, stay in active-conversation mode for
  // conversationWindowSecs. During this window, every utterance is routed
  // directly without requiring another wake word.
  private conversationActive = false
  private conversationTimer: ReturnType<typeof setTimeout> | null = null

  // ── Self-TTS suppression ──────────────────────────────────────────────────
  // Track what Goga is currently saying so we can reject it if STT picks it up.
  private currentTtsText = ''
  private ttsSpeakingUntil = 0   // epoch ms when TTS is expected to finish + grace

  static getInstance() {
    if (!VoiceOrchestrator.instance) {
      VoiceOrchestrator.instance = new VoiceOrchestrator()
      VoiceOrchestrator.instance.initTtsProvider()
    }
    return VoiceOrchestrator.instance
  }

  /** Select TTS provider: ElevenLabs if key+voiceId present, else SAPI. */
  private initTtsProvider() {
    if (ElevenLabsTtsProvider.isConfigured()) {
      this.tts = new ElevenLabsTtsProvider()
      this.log.info('VoiceOrchestrator: TTS provider → ElevenLabs')
    } else {
      this.tts = new WindowsTtsProvider()
      this.log.info('VoiceOrchestrator: TTS provider → WindowsSpeech (SAPI)')
    }
    this.fallbackTts = new WindowsTtsProvider()
  }

  // ── Providers ─────────────────────────────────────────────────────────────

  setSttProvider(p: ISttProvider) {
    // Stop current provider before swapping
    try { this.stt.stopContinuous(); this.stt.abort() } catch { }
    if ('dispose' in this.stt && typeof (this.stt as { dispose?: () => void }).dispose === 'function') {
      (this.stt as { dispose: () => void }).dispose()
    }
    this.stt = p
    this.log.info(`VoiceOrchestrator: STT provider → ${p.name}`)
  }

  setTtsProvider(p: ITtsProvider) {
    this.tts = p
    this.log.info(`VoiceOrchestrator: TTS provider → ${p.name}`)
  }

  /** Re-read sttProvider from settings and swap if needed. */
  reloadSttProvider() {
    const settings = SettingsService.getInstance().get()
    const want = settings.sttProvider ?? 'windows'
    const current = this.stt.name
    if (want === 'whisper' && current !== 'Whisper') {
      this.setSttProvider(new WhisperSttProvider({
        model:   settings.whisperModel,
        device:  settings.whisperDevice,
        language: settings.whisperLanguage || undefined
      }))
    } else if (want === 'windows' && current !== 'WindowsSpeech') {
      this.setSttProvider(new WindowsSttProvider())
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────

  getStatus(): VoiceStatus { return this.status }
  isConversationActive(): boolean { return this.conversationActive }

  private setStatus(s: VoiceStatus) {
    this.status = s
    this.emit('status', s)
  }

  // ── Conversation session ──────────────────────────────────────────────────

  private activateConversation() {
    this.conversationActive = true
    this.resetConversationTimer()
    this.emit('conversation:active', true)
  }

  private resetConversationTimer() {
    if (this.conversationTimer) clearTimeout(this.conversationTimer)
    const secs = SettingsService.getInstance().get().conversationWindowSecs ?? 45
    this.conversationTimer = setTimeout(() => {
      this.conversationActive = false
      this.conversationTimer = null
      this.emit('conversation:active', false)
      this.log.info('VoiceOrchestrator: conversation window expired, returning to passive mode')
    }, secs * 1000)
  }

  // ── Wake word loop (continuous) ───────────────────────────────────────────

  startWakeLoop() {
    if (this.wakeLoopActive) return
    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled) return
    this.wakeLoopActive = true
    this.abortWake = false
    this.setStatus('wake_listening')
    this.log.info('VoiceOrchestrator: wake loop started (continuous)')

    // Use continuous recognition — no repeated PS startup cost
    this.stt.startContinuous(
      (result) => { if (!this.abortWake) this.onContinuousResult(result.transcript) },
      () => {
        // Engine died — restart after brief pause if still active
        if (this.wakeLoopActive && !this.abortWake) {
          setTimeout(() => { if (this.wakeLoopActive) this.startWakeLoop() }, 1000)
        }
      }
    )
  }

  stopWakeLoop() {
    this.abortWake = true
    this.wakeLoopActive = false
    this.stt.stopContinuous()
    this.stt.abort()
    if (this.status === 'wake_listening') this.setStatus('idle')
    if (this.conversationTimer) { clearTimeout(this.conversationTimer); this.conversationTimer = null }
    this.conversationActive = false
    this.log.info('VoiceOrchestrator: wake loop stopped')
  }

  private onContinuousResult(text: string) {
    if (!text) return
    if (this.isSelfTts(text)) {
      this.log.info(`VoiceOrchestrator: suppressed self-TTS echo: "${text.slice(0, 40)}"`)
      return
    }

    const settings = SettingsService.getInstance().get()
    const wakePhrase = (settings.wakePhrase ?? 'hey goga').toLowerCase()
    const lower = text.toLowerCase().trim()

    if (this.conversationActive) {
      // Already in conversation — route directly
      this.handleTranscript(text)
      return
    }

    // Check for wake word
    if (lower.includes(wakePhrase) || lower.startsWith('hey goga') || lower.startsWith('goga')) {
      this.log.info(`VoiceOrchestrator: wake word: "${text}"`)
      this.emit('status', 'listening')  // quick visual pulse
      this.activateConversation()

      const afterWake = text
        .replace(/hey\s+goga[,.]?\s*/i, '')
        .replace(/^goga[,.]?\s*/i, '')
        .trim()

      if (afterWake.length > 2) {
        this.handleTranscript(afterWake)
      } else {
        // Just the wake word — emit wake event for triangle pulse, wait for next utterance
        this.emit('wake:detected')
      }
    }
    // Outside conversation window and no wake word — ignore
  }

  // ── Active listening (mic button) ─────────────────────────────────────────

  async listenOnce(): Promise<void> {
    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled) return

    // Barge-in: stop TTS if allowBargeIn is on, or always allow explicit mic press
    if (this.status === 'speaking') {
      this.tts.stop()
    }

    this.setStatus('listening')
    try {
      const result = await this.stt.recognize(12000)
      if (!result.transcript) { this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle'); return }
      if (this.isSelfTts(result.transcript)) {
        this.log.info(`VoiceOrchestrator: suppressed self-TTS in listenOnce: "${result.transcript.slice(0, 40)}"`)
        this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
        return
      }
      this.activateConversation()
      await this.handleTranscript(result.transcript)
    } catch {
      this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
    }
  }

  stopListening() {
    this.stt.abort()
    this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
  }

  // ── Self-TTS suppression ──────────────────────────────────────────────────

  private isSelfTts(transcript: string): boolean {
    if (!this.currentTtsText) return false
    if (Date.now() > this.ttsSpeakingUntil) return false

    const t = transcript.toLowerCase().trim()
    const s = this.currentTtsText.toLowerCase().trim()

    // Exact or near-exact match (STT may drop words)
    if (s.includes(t) || t.includes(s.slice(0, Math.min(s.length, 20)))) return true

    // Word overlap > 60%
    const tWords = new Set(t.split(/\s+/))
    const sWords = s.split(/\s+/)
    const overlap = sWords.filter(w => tWords.has(w)).length
    return sWords.length > 0 && overlap / sWords.length > 0.6
  }

  private markTtsSpeaking(text: string, estimatedDurationMs: number) {
    this.currentTtsText = text
    this.ttsSpeakingUntil = Date.now() + estimatedDurationMs + TTS_SUPPRESS_GRACE_MS
  }

  private clearTtsSuppression() {
    // Keep suppression active for grace period after TTS ends
    setTimeout(() => {
      this.currentTtsText = ''
      this.ttsSpeakingUntil = 0
    }, TTS_SUPPRESS_GRACE_MS)
  }

  // ── Transcript routing ────────────────────────────────────────────────────

  async handleTranscript(text: string) {
    this.setStatus('transcribing')
    this.resetConversationTimer()
    this.log.info(`VoiceOrchestrator: transcript: "${text.slice(0, 80)}"`)

    // Stop word — cancel speech + mission
    if (STOP_WORDS.test(text.trim())) {
      this.tts.stop()
      this.emit('transcript', text)
      this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
      return
    }

    // Approval detection — ONLY when approval is actually pending
    if (this.approvalPending) {
      if (APPROVE_WORDS.test(text.trim())) {
        this.emit('voice:approve', true)
        this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
        return
      }
      if (REJECT_WORDS.test(text.trim())) {
        this.emit('voice:approve', false)
        this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
        return
      }
    }

    // Barge-in: if Goga is speaking and allowBargeIn is on, stop TTS
    const settings = SettingsService.getInstance().get()
    if (this.status === 'speaking' && settings.allowBargeIn) {
      this.tts.stop()
    }

    // Normal transcript → chat pipeline
    this.emit('transcript', text)
    this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
  }

  // ── TTS ───────────────────────────────────────────────────────────────────

  private static readonly TTS_OVERALL_TIMEOUT_MS = 75_000
  private static readonly SAPI_TIMEOUT_MS = 30_000

  /** Race a promise against a timeout. Rejects with a timeout error if exceeded. */
  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.log.info(`VoiceOrchestrator: ${label} timeout (${ms}ms)`)
        reject(new Error(`TTS timeout: ${label}`))
      }, ms)
      promise.then(
        v => { clearTimeout(timer); resolve(v) },
        e => { clearTimeout(timer); reject(e) }
      )
    })
  }

  async speak(text: string): Promise<void> {
    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled || !settings.autoSpeakResponses) return

    const clean = this.cleanForSpeech(text)
    if (!clean) return

    const words = clean.split(/\s+/).length
    const wpm = 130 * (settings.voiceRate ?? 1.0)
    const estimatedMs = (words / wpm) * 60000

    this.markTtsSpeaking(clean, estimatedMs)
    this.log.info('VoiceOrchestrator: speak started')

    let playbackStarted = false
    const provider = this.tts
    let userStopped = false

    provider.onAmplitude = (v: number) => { this.emit('amplitude', v) }
    provider.onPlaybackStart = () => {
      playbackStarted = true
      this.setStatus('speaking')
    }

    try {
      await this.withTimeout(
        provider.speak(clean, settings.voiceRate, settings.voiceVolume, settings.voiceName),
        VoiceOrchestrator.TTS_OVERALL_TIMEOUT_MS,
        'overall speak'
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      userStopped = this.status === 'idle'

      if (!playbackStarted && !userStopped && provider.name === 'ElevenLabs') {
        const reason = msg.includes('timeout') ? 'timeout' : 'error'
        this.log.info(`VoiceOrchestrator: ElevenLabs failed (${reason}), falling back to SAPI`)
        provider.stop()
        try {
          this.fallbackTts.onAmplitude = (v: number) => { this.emit('amplitude', v) }
          this.fallbackTts.onPlaybackStart = () => { playbackStarted = true; this.setStatus('speaking') }
          this.setStatus('speaking')
          await this.withTimeout(
            this.fallbackTts.speak(clean, settings.voiceRate, settings.voiceVolume, settings.voiceName),
            VoiceOrchestrator.SAPI_TIMEOUT_MS,
            'SAPI fallback'
          )
        } catch {
          this.log.info('VoiceOrchestrator: SAPI fallback also failed')
        } finally {
          this.fallbackTts.onAmplitude = undefined
          this.fallbackTts.onPlaybackStart = undefined
        }
      }
    } finally {
      provider.onAmplitude = undefined
      provider.onPlaybackStart = undefined
      this.emit('amplitude', 0)
      this.clearTtsSuppression()
      this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
      this.log.info('VoiceOrchestrator: speak completed, status → idle')
    }
  }

  stopSpeaking() {
    this.tts.stop()
    this.fallbackTts.stop()
    this.clearTtsSuppression()
    this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
    this.log.info('VoiceOrchestrator: stopSpeaking called')
  }

  async narrate(text: string): Promise<void> {
    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled || !settings.autoSpeakResponses) return
    const clean = this.cleanForSpeech(text)
    if (!clean || clean.length < 4) return
    if (this.status === 'listening' || this.status === 'transcribing') return

    const words = clean.split(/\s+/).length
    const wpm = 130 * (settings.voiceRate ?? 1.0)
    this.markTtsSpeaking(clean, (words / wpm) * 60000)

    let playbackStarted = false
    const provider = this.tts

    provider.onAmplitude = (v: number) => { this.emit('amplitude', v) }
    provider.onPlaybackStart = () => { playbackStarted = true; this.setStatus('speaking') }

    try {
      await this.withTimeout(
        provider.speak(clean, settings.voiceRate, settings.voiceVolume, settings.voiceName),
        VoiceOrchestrator.TTS_OVERALL_TIMEOUT_MS,
        'narrate'
      )
    } catch {
      if (!playbackStarted && provider.name === 'ElevenLabs' && this.status !== 'idle') {
        this.log.info('VoiceOrchestrator: ElevenLabs narrate failed, falling back to SAPI')
        provider.stop()
        try {
          this.setStatus('speaking')
          this.fallbackTts.onAmplitude = (v: number) => { this.emit('amplitude', v) }
          await this.withTimeout(
            this.fallbackTts.speak(clean, settings.voiceRate, settings.voiceVolume, settings.voiceName),
            VoiceOrchestrator.SAPI_TIMEOUT_MS,
            'SAPI narrate fallback'
          )
        } catch { }
        finally { this.fallbackTts.onAmplitude = undefined }
      }
    } finally {
      provider.onAmplitude = undefined
      provider.onPlaybackStart = undefined
      this.emit('amplitude', 0)
      this.clearTtsSuppression()
      if (this.status === 'speaking') this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
    }
  }

  // ── Approval state ────────────────────────────────────────────────────────

  setApprovalPending(pending: boolean) {
    this.approvalPending = pending
  }

  // ── Speech cleaning ───────────────────────────────────────────────────────

  cleanForSpeech(text: string): string {
    let cleaned = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/\*\*/g, '').replace(/\*/g, '')
      .replace(/__/g, '')
      .replace(/\[UNTRUSTED_DATA[^\]]*\][\s\S]*?\[\/UNTRUSTED_DATA[^\]]*\]/g, '')
      .replace(/\{[\s\S]{0,300}\}/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[#>\-]{2,}/g, '')
      .replace(/\d+,\d+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()

    // For text over 400 chars, truncate at the last sentence or word boundary before 400
    if (cleaned.length > 400) {
      const window = cleaned.slice(0, 400)
      const lastSentence = window.lastIndexOf('. ')
      const lastQuestion = window.lastIndexOf('? ')
      const lastExclaim = window.lastIndexOf('! ')
      const breakPoint = Math.max(lastSentence, lastQuestion, lastExclaim)
      if (breakPoint > 50) {
        cleaned = cleaned.slice(0, breakPoint + 1)
      } else {
        // No sentence boundary — break at last word boundary
        const lastSpace = window.lastIndexOf(' ')
        cleaned = lastSpace > 50 ? cleaned.slice(0, lastSpace) : window
      }
    }

    return cleaned
  }

  async getVoices(): Promise<string[]> {
    return this.tts.getVoices()
  }
}
