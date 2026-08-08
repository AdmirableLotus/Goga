/**
 * VoiceOrchestrator
 *
 * Manages the full voice lifecycle:
 *   - Wake word detection loop (optional)
 *   - Barge-in: stops TTS, starts STT immediately
 *   - Routes transcript → same chat pipeline as typed input
 *   - Speaks Goga's responses (if autoSpeakResponses)
 *   - Narrates short mission status updates
 *   - Approval detection from voice ("yes"/"no"/"cancel")
 *
 * SECURITY:
 *   - Only actual STT events are treated as user voice input
 *   - Screen/page text NEVER enters this pipeline
 *   - Voice does NOT bypass AuthorizationService
 */

import { EventEmitter } from 'events'
import { WindowsSttProvider } from './speech/WindowsSpeechProvider'
import { WindowsTtsProvider } from './speech/WindowsSpeechProvider'
import type { ISttProvider, ITtsProvider } from './speech/ISpeechProvider'
import { SettingsService } from './settings'
import { LogService } from './logs'

export type VoiceStatus =
  | 'idle'
  | 'wake_listening'   // background wake-word loop
  | 'listening'        // active STT
  | 'transcribing'     // processing transcript
  | 'speaking'         // TTS playing
  | 'disabled'

export interface VoiceOrchestratorEvents {
  'status': (s: VoiceStatus) => void
  /** Fired when a transcript is ready — caller routes to chat pipeline */
  'transcript': (text: string) => void
  /** Fired when user says a voice approval word while approval is pending */
  'voice:approve': (approved: boolean) => void
}

// Words that approve a pending action (only when approval IS pending)
const APPROVE_WORDS = /^(yes|yeah|yep|sure|ok|okay|go ahead|do it|proceed|affirmative|absolutely|correct|right)[.!]?$/i
const REJECT_WORDS  = /^(no|nope|don'?t|cancel|stop|reject|abort|never)[.!]?$/i
const STOP_WORDS    = /^(stop|halt|cancel|abort|quit)[.!]?$/i

export class VoiceOrchestrator extends EventEmitter {
  private static instance: VoiceOrchestrator

  private stt: ISttProvider = new WindowsSttProvider()
  private tts: ITtsProvider = new WindowsTtsProvider()
  private log = LogService.getInstance()

  private status: VoiceStatus = 'disabled'
  private wakeLoopActive = false
  private approvalPending = false
  private abortWake = false

  static getInstance() {
    if (!VoiceOrchestrator.instance) VoiceOrchestrator.instance = new VoiceOrchestrator()
    return VoiceOrchestrator.instance
  }

  // ── Providers (swappable for Whisper/Piper etc.) ──────────────────────────

  setSttProvider(p: ISttProvider) { this.stt = p }
  setTtsProvider(p: ITtsProvider) { this.tts = p }

  // ── Status ────────────────────────────────────────────────────────────────

  getStatus(): VoiceStatus { return this.status }

  private setStatus(s: VoiceStatus) {
    this.status = s
    this.emit('status', s)
  }

  // ── Wake word loop ────────────────────────────────────────────────────────

  startWakeLoop() {
    if (this.wakeLoopActive) return
    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled) return
    this.wakeLoopActive = true
    this.abortWake = false
    this.setStatus('wake_listening')
    this.log.info('VoiceOrchestrator: wake loop started')
    this.wakeLoop()
  }

  stopWakeLoop() {
    this.abortWake = true
    this.wakeLoopActive = false
    this.stt.abort()
    if (this.status === 'wake_listening') this.setStatus('idle')
    this.log.info('VoiceOrchestrator: wake loop stopped')
  }

  private async wakeLoop() {
    const settings = SettingsService.getInstance().get()
    const wakePhrase = (settings.wakePhrase ?? 'hey goga').toLowerCase()

    while (this.wakeLoopActive && !this.abortWake) {
      try {
        const result = await this.stt.recognize(4000)
        if (this.abortWake) break
        if (!result.transcript) continue

        const lower = result.transcript.toLowerCase().trim()

        // Wake word detected
        if (lower.includes(wakePhrase) || lower.startsWith('hey goga') || lower.startsWith('goga')) {
          this.log.info(`VoiceOrchestrator: wake word detected: "${result.transcript}"`)
          // Strip wake phrase from transcript — rest may be the actual command
          const afterWake = result.transcript.replace(/hey\s+goga[,.]?\s*/i, '').replace(/^goga[,.]?\s*/i, '').trim()
          if (afterWake.length > 2) {
            // Inline command: "Hey Goga, open Brave"
            await this.handleTranscript(afterWake)
          } else {
            // Just the wake word — start active listening
            await this.listenOnce()
          }
        }
      } catch {
        // STT error — brief pause then retry
        await new Promise(r => setTimeout(r, 500))
      }
    }
  }

  // ── Active listening (mic button or post-wake) ────────────────────────────

  async listenOnce(): Promise<void> {
    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled) return

    // Barge-in: stop any current speech
    if (this.status === 'speaking') {
      this.tts.stop()
    }

    this.setStatus('listening')
    try {
      const result = await this.stt.recognize(12000)
      if (!result.transcript) { this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle'); return }
      await this.handleTranscript(result.transcript)
    } catch {
      this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
    }
  }

  stopListening() {
    this.stt.abort()
    this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
  }

  // ── Transcript routing ────────────────────────────────────────────────────

  private async handleTranscript(text: string) {
    this.setStatus('transcribing')
    this.log.info(`VoiceOrchestrator: transcript: "${text.slice(0, 80)}"`)

    // Stop word — cancel speech + mission
    if (STOP_WORDS.test(text.trim())) {
      this.tts.stop()
      this.emit('transcript', text)   // let chat pipeline handle stop
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

    // Normal transcript → chat pipeline
    this.emit('transcript', text)
    this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
  }

  // ── TTS ───────────────────────────────────────────────────────────────────

  async speak(text: string): Promise<void> {
    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled || !settings.autoSpeakResponses) return

    // Strip markdown, JSON, selectors, coordinates — never read technical content aloud
    const clean = this.cleanForSpeech(text)
    if (!clean) return

    this.setStatus('speaking')
    try {
      await this.tts.speak(clean, settings.voiceRate, settings.voiceVolume, settings.voiceName)
    } catch { /* ignore — user may have stopped */ }
    finally {
      this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
    }
  }

  stopSpeaking() {
    this.tts.stop()
    this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
  }

  /** Short mission narration — strips all technical content */
  async narrate(text: string): Promise<void> {
    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled || !settings.autoSpeakResponses) return
    const clean = this.cleanForSpeech(text)
    if (!clean || clean.length < 4) return
    // Don't interrupt user listening
    if (this.status === 'listening' || this.status === 'transcribing') return
    this.setStatus('speaking')
    try {
      await this.tts.speak(clean, settings.voiceRate, settings.voiceVolume, settings.voiceName)
    } catch { }
    finally {
      if (this.status === 'speaking') this.setStatus(this.wakeLoopActive ? 'wake_listening' : 'idle')
    }
  }

  // ── Approval state ────────────────────────────────────────────────────────

  setApprovalPending(pending: boolean) {
    this.approvalPending = pending
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private cleanForSpeech(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, '')          // code blocks
      .replace(/`[^`]+`/g, '')                  // inline code
      .replace(/\*\*/g, '').replace(/\*/g, '')  // bold/italic
      .replace(/__/g, '')
      .replace(/\[UNTRUSTED_DATA[^\]]*\][\s\S]*?\[\/UNTRUSTED_DATA[^\]]*\]/g, '') // injection guard blocks
      .replace(/\{[\s\S]{0,300}\}/g, '')        // JSON objects
      .replace(/https?:\/\/\S+/g, '')           // URLs
      .replace(/[#>\-]{2,}/g, '')               // markdown headers/lists
      .replace(/\d+,\d+/g, '')                  // coordinates
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 400)                            // max 400 chars spoken
  }

  async getVoices(): Promise<string[]> {
    return this.tts.getVoices()
  }
}
