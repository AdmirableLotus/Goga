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
import { app } from 'electron'
import { WindowsSttProvider } from './speech/WindowsSpeechProvider'
import { WindowsTtsProvider } from './speech/WindowsSpeechProvider'
import { WhisperSttProvider } from './speech/WhisperSttProvider'
import type { WhisperModel, WhisperDevice } from './speech/WhisperSttProvider'
import { ElevenLabsTtsProvider } from './speech/ElevenLabsTtsProvider'
import { ElevenLabsSttProvider } from './speech/ElevenLabsSttProvider'
import { KokoroTtsProvider, KokoroModelMissingError } from './speech/KokoroTtsProvider'
import type { ISttProvider, ITtsProvider, SpeechStream } from './speech/ISpeechProvider'
import { SentenceBuffer } from './speech/sentenceBuffer'
import { isConfirmation } from './agentRouting'
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

// Longest reply Goga reads aloud; the full text is always shown in the chat.
const MAX_SPOKEN_REPLY_CHARS = 450

/** A reply being spoken while it is written; see VoiceOrchestrator.speakReply(). */
export interface ReplySpeech {
  push(chunk: string): void
  finish(fullReply: string): Promise<void>
  cancel(): void
}

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

  // ── Echo-tail guard ────────────────────────────────────────────────────────
  // After TTS ends, block recognition briefly so Goga's own tail audio (still
  // decaying through speakers) is not transcribed as user speech.
  private static readonly ECHO_TAIL_GUARD_MS = 1200
  // After confirming playback termination, wait this long for the audio output
  // buffer to drain before opening the mic, so no residual TTS audio is heard.
  private static readonly OUTPUT_DRAIN_MS = 400
  private echoGuardUntil = 0
  // Rolling record of recent spoken assistant text (with expiry) for self-echo
  // rejection. Bounded to a short window so legitimate later follow-ups that
  // happen to repeat Goga's wording are NOT wrongly rejected.
  private static readonly ECHO_MEMORY_WINDOW_MS = 10_000
  private recentSpoken: Array<{ text: string; expiresAt: number }> = []

  static getInstance() {
    if (!VoiceOrchestrator.instance) {
      VoiceOrchestrator.instance = new VoiceOrchestrator()
      VoiceOrchestrator.instance.initTtsProvider()
      VoiceOrchestrator.instance.initSttProvider()
    }
    return VoiceOrchestrator.instance
  }

  /**
   * Select TTS provider based on settings.ttsProvider.
   * ElevenLabs is only selected when explicitly configured AND env vars present.
   * Default for new and existing installs is 'sapi'. Kokoro only activates after
   * verified installation AND explicit user selection (ttsProvider = 'kokoro').
   */
  private initTtsProvider() {
    const settings = SettingsService.getInstance().get()
    const want = settings.ttsProvider ?? 'sapi'
    try { this.tts?.dispose?.() } catch { }
    this.fallbackTts = new WindowsTtsProvider()

    if (want === 'elevenlabs') {
      if (ElevenLabsTtsProvider.isConfigured()) {
        this.tts = new ElevenLabsTtsProvider()
        this.log.info('VoiceOrchestrator: TTS provider → ElevenLabs')
      } else {
        this.tts = new WindowsTtsProvider()
        this.log.info('VoiceOrchestrator: TTS provider → WindowsSpeech (ElevenLabs not configured)')
      }
    } else if (want === 'sapi') {
      this.tts = new WindowsTtsProvider()
      this.log.info('VoiceOrchestrator: TTS provider → WindowsSpeech (SAPI)')
    } else if (want === 'kokoro') {
      // speak() will throw KokoroModelMissingError if model absent or manifest stale;
      // the orchestrator catches that and falls back to SAPI.
      let userDataPath = ''
      try { userDataPath = app.getPath('userData') } catch { }
      const kokoro = new KokoroTtsProvider(userDataPath)
      kokoro.warmUp?.()
      this.tts = kokoro
      this.log.info('VoiceOrchestrator: TTS provider → Kokoro (local)')
    } else {
      // Unknown value — safe fallback
      this.tts = new WindowsTtsProvider()
      this.log.info(`VoiceOrchestrator: TTS provider unknown (${want}), falling back to SAPI`)
    }
  }

  // ── Authoritative STT selection ────────────────────────────────────────────
  // A SINGLE serialized selection promise decides the STT provider. Every
  // listening entry point awaits it before touching any provider, so no
  // recognizer (especially the broken Whisper) can be spawned during the
  // ElevenLabs availability probe. `selectionGen` guards against stale
  // selections when settings change mid-probe.
  private elSttPreferred = false
  private selectionGen = 0
  private sttSelection: Promise<void> | null = null

  /** Kick off the authoritative selection (idempotent-ish; supersedes prior). */
  private initSttProvider(): void {
    this.selectStt()
  }

  /** Ensure a selection is in progress and return the promise to await. */
  private ensureSttSelected(): Promise<void> {
    if (!this.sttSelection) this.selectStt()
    return this.sttSelection ?? Promise.resolve()
  }

  /**
   * The one authoritative selector. Preference order:
   *   1. ElevenLabs realtime STT — when key carries speech_to_text permission
   *   2. Settings-driven Whisper — ONLY if the Python script exists on disk
   *   3. Windows STT — safe offline fallback
   * Runs under a generation guard so a superseding call wins.
   */
  private selectStt(): Promise<void> {
    const gen = ++this.selectionGen
    this.sttSelection = (async () => {
      // 1. ElevenLabs (preferred)
      if (ElevenLabsSttProvider.isConfigured()) {
        let ok = false
        try { ok = await ElevenLabsSttProvider.isAvailable() } catch { ok = false }
        if (gen !== this.selectionGen) return  // superseded
        if (ok) {
          this.elSttPreferred = true
          if (this.stt.name !== 'ElevenLabsSTT') {
            const el = new ElevenLabsSttProvider()
            el.onPartial = (text: string) => this.emit('partial', text)
            this.setSttProvider(el)
          }
          this.log.info(`VoiceOrchestrator: effective STT provider → ElevenLabs (realtime)`)
          return
        }
      }
      if (gen !== this.selectionGen) return
      this.elSttPreferred = false

      // 2. Whisper — only when explicitly selected AND its script exists
      const settings = SettingsService.getInstance().get()
      const want = settings.sttProvider ?? 'windows'
      if (want === 'whisper') {
        if (WhisperSttProvider.scriptExists()) {
          if (this.stt.name !== 'Whisper') {
            const wModel = settings.whisperModel as WhisperModel | undefined
            const wDevice = settings.whisperDevice as WhisperDevice | undefined
            // Pre-download disclosure: emit event so UI can gate if model not cached
            const preflight = WhisperSttProvider.preflight(wModel ?? 'base', wDevice ?? 'cpu')
            if (!preflight.cached) {
              this.log.info(
                `WhisperSTT: model not cached — first use will download ~${preflight.downloadMB}MB from ${preflight.source} to ${preflight.cacheDir}`
              )
              this.emit('whisper:download-required', preflight)
            }
            this.setSttProvider(new WhisperSttProvider({
              model: wModel,
              device: wDevice,
              language: settings.whisperLanguage || undefined
            }))
          }
          this.log.info('VoiceOrchestrator: effective STT provider → Whisper')
          return
        }
        this.log.info('VoiceOrchestrator: Whisper script missing — falling back to WindowsSpeech')
      }

      // 3. Windows STT (safe fallback)
      if (this.stt.name !== 'WindowsSpeech') {
        this.setSttProvider(new WindowsSttProvider())
      }
      this.log.info('VoiceOrchestrator: effective STT provider → WindowsSpeech')
    })()
    return this.sttSelection
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

  getTtsProvider(): ITtsProvider { return this.tts }

  /**
   * Re-run the authoritative selector (e.g. after settings change). Uses the
   * same serialized path + generation guard, so it can never start Whisper
   * while ElevenLabs is preferred, nor spawn a broken Whisper.
   */
  reloadSttProvider(): Promise<void> {
    return this.selectStt()
  }

  /**
   * Safe TTS provider reload after a settings change.
   * - Stops and awaits current playback before swapping.
   * - Serialized: a second call while one is in progress is a no-op (returns
   *   the same promise), so rapid saves cannot cause overlapping reloads.
   * - Returns an error string on failure so the caller can surface it to the UI.
   */
  private ttsReloadPromise: Promise<string | null> | null = null

  reloadTtsProvider(): Promise<string | null> {
    if (this.ttsReloadPromise) return this.ttsReloadPromise
    this.ttsReloadPromise = (async () => {
      try {
        // Stop and await current playback so the old provider is fully idle.
        if (this.tts.stopAndWait) {
          await this.tts.stopAndWait().catch(() => {})
        } else {
          this.tts.stop()
        }
        this.initTtsProvider()
        return null
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.log.info(`VoiceOrchestrator: TTS reload failed: ${msg}`)
        return msg
      } finally {
        this.ttsReloadPromise = null
      }
    })()
    return this.ttsReloadPromise
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

  async startWakeLoop(): Promise<void> {
    if (this.wakeLoopActive) return
    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled) return
    this.wakeLoopActive = true
    this.abortWake = false
    this.setStatus('wake_listening')

    // Wait for the authoritative STT selection before touching any provider,
    // so we never start a recognizer mid-probe.
    await this.ensureSttSelected()
    if (!this.wakeLoopActive || this.abortWake) return

    this.log.info(`VoiceOrchestrator: wake loop started (continuous, provider=${this.stt.name})`)

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
    if (this.inEchoGuard()) {
      this.log.info('VoiceOrchestrator: suppressed transcript during echo-tail guard')
      return
    }
    if (this.isSelfTts(text) || this.isRecentSpokenEcho(text)) {
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

    // ── Self-echo prevention: fully stop TTS before opening the mic ──────────
    // On a mic press during (or right after) TTS, we must NOT begin capture
    // until the playback process has genuinely terminated and the output has
    // had a moment to drain. Otherwise the mic hears Goga's own voice.
    const wasSpeaking = this.status === 'speaking' || (this.tts.isPlaying?.() ?? false)
    if (wasSpeaking) {
      if (this.tts.stopAndWait) {
        await this.tts.stopAndWait()
      } else {
        this.tts.stop()
      }
      // Arm the echo-tail guard and drain the audio output buffer.
      this.echoGuardUntil = Date.now() + VoiceOrchestrator.ECHO_TAIL_GUARD_MS
      await new Promise(r => setTimeout(r, VoiceOrchestrator.OUTPUT_DRAIN_MS))
    }

    // Wait for the authoritative STT selection before invoking any provider,
    // so an immediate mic click during the probe uses the correct recognizer
    // (never a transient/broken Whisper).
    await this.ensureSttSelected()

    // If any playback somehow resumed, do not open the mic.
    if (this.tts.isPlaying?.()) {
      this.log.info('VoiceOrchestrator: listenOnce aborted — TTS still playing')
      this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
      return
    }

    // Only now is capture genuinely ready — show Listening.
    this.setStatus('listening')
    try {
      const result = await this.stt.recognize(12000)
      const transcript = result.transcript?.trim() ?? ''
      if (!transcript) { this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle'); return }
      // Reject self-echo by BOTH the timed window and the timing-independent
      // recent-spoken-text overlap check.
      if (this.isSelfTts(transcript) || this.isRecentSpokenEcho(transcript)) {
        this.log.info(`VoiceOrchestrator: rejected self-echo transcript: "${transcript.slice(0, 48)}"`)
        this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
        return
      }
      this.activateConversation()
      await this.handleTranscript(transcript)
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
    // Remember this spoken phrase only for a short window after playback is
    // expected to end. Acoustic echo only occurs shortly after speaking, so a
    // bounded window avoids rejecting genuine later follow-ups.
    const norm = this.normalizeForEcho(text)
    if (norm) {
      const expiresAt = this.ttsSpeakingUntil + VoiceOrchestrator.ECHO_MEMORY_WINDOW_MS
      this.recentSpoken.push({ text: norm, expiresAt })
      if (this.recentSpoken.length > 4) this.recentSpoken.shift()
    }
  }

  /** Normalize text for echo comparison: lowercase, strip punctuation, collapse spaces. */
  private normalizeForEcho(text: string): string {
    return text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  }

  /**
   * Reject a transcript that strongly overlaps recent spoken assistant text,
   * but ONLY within a bounded window after that TTS ended (acoustic echo is a
   * short-lived phenomenon). Legitimate follow-ups repeating Goga's wording
   * later are NOT rejected. Uses normalized token overlap ≥50% with ≥3 words.
   */
  private isRecentSpokenEcho(transcript: string): boolean {
    const t = this.normalizeForEcho(transcript)
    if (!t) return false
    const tWords = t.split(' ').filter(Boolean)
    if (tWords.length === 0) return false
    const tSet = new Set(tWords)
    const now = Date.now()
    for (const entry of this.recentSpoken) {
      if (now > entry.expiresAt) continue  // outside the echo window — ignore
      const spoken = entry.text
      const sWords = spoken.split(' ').filter(Boolean)
      if (sWords.length === 0) continue
      // Substring containment (STT often captures a contiguous slice of TTS)
      if (spoken.includes(t) || t.includes(spoken.slice(0, Math.min(spoken.length, 24)))) return true
      // Token overlap ratio relative to the (shorter) transcript
      const overlap = tWords.filter(w => new Set(sWords).has(w)).length
      const ratio = overlap / tWords.length
      if (ratio >= 0.5 && overlap >= 3) return true
      // Also guard the reverse (long transcript, short spoken phrase)
      const sOverlap = sWords.filter(w => tSet.has(w)).length
      if (sWords.length > 0 && sOverlap / sWords.length >= 0.6 && sOverlap >= 3) return true
    }
    return false
  }

  private clearTtsSuppression() {
    // Echo-tail guard: block recognition for a short window after TTS ends so
    // Goga's own decaying audio is not picked up as user speech.
    this.echoGuardUntil = Date.now() + VoiceOrchestrator.ECHO_TAIL_GUARD_MS
    // Keep suppression active for grace period after TTS ends
    setTimeout(() => {
      this.currentTtsText = ''
      this.ttsSpeakingUntil = 0
    }, TTS_SUPPRESS_GRACE_MS)
  }

  /** True while the post-TTS echo-tail guard is active. */
  private inEchoGuard(): boolean {
    return Date.now() < this.echoGuardUntil
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
      if (APPROVE_WORDS.test(text.trim()) || isConfirmation(text.trim())) {
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
      // Reset conversation window from when Goga starts speaking so the user
      // has a full window to reply after playback ends.
      if (this.conversationActive) this.resetConversationTimer()
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

      const isProviderFailure = !playbackStarted && !userStopped
      const isKokoroMissing = err instanceof KokoroModelMissingError
      const needsFallback = isProviderFailure || isKokoroMissing

      if (needsFallback && provider.name !== 'WindowsSpeech') {
        const reason = isKokoroMissing ? 'model missing' : msg.includes('timeout') ? 'timeout' : 'error'
        this.log.info(`VoiceOrchestrator: ${provider.name} failed (${reason}), falling back to SAPI`)
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

  private replySpeechSeq = 0

  /**
   * Speak a reply while the brain is still writing it: each finished sentence is spoken
   * straight away. push() takes streamed text; finish() takes the final reply, which is
   * spoken whole if nothing was streamed (tasks, cached answers). cancel() goes quiet.
   * Voices that cannot stream (Windows, ElevenLabs) speak the reply once it is complete.
   */
  speakReply(): ReplySpeech {
    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled || !settings.autoSpeakResponses) {
      return { push: () => { }, finish: async () => { }, cancel: () => { } }
    }
    const provider = this.tts
    if (!provider.speakStream) {
      return { push: () => { }, finish: full => this.speak(full), cancel: () => { } }
    }

    const mySeq = ++this.replySpeechSeq
    const sentences = new SentenceBuffer()
    let stream: SpeechStream | null = null
    let streamed = false        // any text arrived from the brain
    let spoken = ''             // what was handed to the voice, for echo suppression
    let closed = false
    let playbackStarted = false
    const wpm = 130 * (settings.voiceRate ?? 1.0)

    const say = (sentence: string) => {
      const clean = this.cleanForSpeech(sentence)
      if (!clean || spoken.length >= MAX_SPOKEN_REPLY_CHARS) return
      if (!stream) {
        provider.onAmplitude = (v: number) => { this.emit('amplitude', v) }
        provider.onPlaybackStart = () => {
          playbackStarted = true
          this.setStatus('speaking')
          if (this.conversationActive) this.resetConversationTimer()
        }
        stream = provider.speakStream!(settings.voiceRate, settings.voiceVolume, settings.voiceName)
        this.log.info('VoiceOrchestrator: streamed reply started')
      }
      spoken = spoken ? `${spoken} ${clean}` : clean
      this.markTtsSpeaking(spoken, (spoken.split(/\s+/).length / wpm) * 60000)
      stream.push(clean)
    }

    const settle = async (fullReply?: string) => {
      const s = stream as SpeechStream | null
      if (!s) return
      try {
        await s.done
      } catch (err) {
        // Nothing was heard: say the whole reply with the Windows voice instead.
        // (A stopped stream resolves quietly, so this is a real failure, not the user's Stop.)
        const whole = fullReply === undefined ? '' : this.cleanForSpeech(fullReply)
        if (whole && !playbackStarted && mySeq === this.replySpeechSeq) {
          this.log.info(`VoiceOrchestrator: streamed reply failed (${err instanceof Error ? err.message : String(err)}), falling back to SAPI`)
          try {
            this.setStatus('speaking')
            await this.withTimeout(
              this.fallbackTts.speak(whole, settings.voiceRate, settings.voiceVolume, settings.voiceName),
              VoiceOrchestrator.SAPI_TIMEOUT_MS, 'SAPI fallback')
          } catch { this.log.info('VoiceOrchestrator: SAPI fallback also failed') }
        }
      } finally {
        if (mySeq === this.replySpeechSeq) {
          provider.onAmplitude = undefined
          provider.onPlaybackStart = undefined
          this.emit('amplitude', 0)
          this.clearTtsSuppression()
          this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
          this.log.info('VoiceOrchestrator: speak completed, status → idle')
        }
      }
    }

    return {
      push: chunk => {
        if (closed || !chunk) return
        streamed = true
        for (const sentence of sentences.push(chunk)) say(sentence)
      },
      finish: async full => {
        if (closed) return
        closed = true
        if (!streamed) for (const sentence of sentences.push(full)) say(sentence)
        const rest = sentences.flush()
        if (rest) say(rest)
        ;(stream as SpeechStream | null)?.end()
        await settle(full)
      },
      cancel: () => {
        if (closed) return
        closed = true
        // Only silence the voice if a newer reply has not already taken it over.
        if (stream && mySeq === this.replySpeechSeq) provider.stop()
        void settle()
      },
    }
  }

  stopSpeaking() {
    this.replySpeechSeq++   // a reply being streamed must not fall back or reset status later
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
    } catch (err) {
      const isKokoroMissing = err instanceof KokoroModelMissingError
      if ((!playbackStarted || isKokoroMissing) && provider.name !== 'WindowsSpeech' && this.status !== 'idle') {
        this.log.info(`VoiceOrchestrator: ${provider.name} narrate failed, falling back to SAPI`)
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

  // ── Audio for paired devices (Rabbit R1) ─────────────────────────────────
  // Uses the PC's Whisper and Kokoro without touching the PC's own mic or speakers.
  private deviceWhisper: WhisperSttProvider | null = null
  private deviceKokoro: KokoroTtsProvider | null = null

  async transcribeFile(wavPath: string): Promise<string> {
    if (this.stt instanceof WhisperSttProvider) return this.stt.transcribeFile(wavPath)
    if (!this.deviceWhisper) {
      const s = SettingsService.getInstance().get()
      this.deviceWhisper = new WhisperSttProvider({
        model: s.whisperModel as WhisperModel, device: s.whisperDevice as WhisperDevice,
        language: s.whisperLanguage || undefined,
      })
    }
    return this.deviceWhisper.transcribeFile(wavPath)
  }

  async speakToFile(text: string, outPath: string): Promise<void> {
    const voice = SettingsService.getInstance().get().voiceName
    if (this.tts instanceof KokoroTtsProvider) return this.tts.synthesizeToFile(text, voice, outPath)
    if (!this.deviceKokoro) {
      let userDataPath = ''
      try { userDataPath = app.getPath('userData') } catch { }
      this.deviceKokoro = new KokoroTtsProvider(userDataPath)
    }
    return this.deviceKokoro.synthesizeToFile(text, voice, outPath)
  }

  /**
   * Graceful shutdown: stop all TTS child processes and dispose the STT
   * provider. Called from the Electron will-quit handler via a typed public
   * method — no (as any) casts needed in index.ts.
   */
  async shutdown(): Promise<void> {
    try { await this.tts.stopAndWait?.() } catch { }
    try { await this.fallbackTts.stopAndWait?.() } catch { }
    try { this.tts.dispose?.() } catch { }
    try { this.deviceKokoro?.dispose() } catch { }
    try { this.deviceWhisper?.dispose() } catch { }
    try {
      if ('dispose' in this.stt && typeof (this.stt as { dispose?: () => void }).dispose === 'function') {
        (this.stt as { dispose: () => void }).dispose()
      }
    } catch { }
  }
}
