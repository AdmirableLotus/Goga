/**
 * KokoroTtsProvider — local, offline TTS via kokoro-js (Apache-2.0).
 *
 * CONTRACT:
 *   - speak() NEVER downloads anything. If the model is absent or the manifest
 *     is stale it throws KokoroModelMissingError. The orchestrator owns fallback.
 *   - No user text or generated audio leaves the machine through this provider.
 *   - Initialization is synchronous model-file validation only — no network.
 *   - env.allowRemoteModels = false is set in the synthesis child script so
 *     the @huggingface/transformers runtime cannot fetch missing artifacts.
 *   - speak() is single-flight: a new call cancels and awaits the previous
 *     operation before starting a new one.
 *   - The WAV path is passed to PowerShell via an environment variable
 *     (GOGA_WAV_PATH), never interpolated into the script string.
 *   - Temporary WAV files are deleted only after the playback process exits,
 *     with a bounded retry for Windows file-lock errors.
 *
 * Model location: {userData}/models/kokoro-v1.0/
 * Download + per-artifact SHA-256 verification is handled by ModelManager.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { spawn, ChildProcess } from 'child_process'
import type { ITtsProvider } from './ISpeechProvider'
import { LogService } from '../logs'
import { MANIFEST_HASH } from '../modelManager'
import { wavEnvelope } from './wavEnvelope'

export const KOKORO_MODEL_DIR = 'kokoro-v1.0'
const VERIFIED_SENTINEL = '.verified'
// Voice-level updates to the visual: fine enough to follow syllables, cheap over IPC.
const AMPLITUDE_WINDOW_MS = 50

// English voices bundled with kokoro-js (node_modules/kokoro-js/voices), by the name Settings shows.
export const KOKORO_VOICES: Record<string, string> = {
  'Heart (American, female)': 'af_heart',
  'Bella (American, female)': 'af_bella',
  'Nicole (American, female)': 'af_nicole',
  'Sarah (American, female)': 'af_sarah',
  'Sky (American, female)': 'af_sky',
  'Emma (British, female)': 'bf_emma',
  'Isabella (British, female)': 'bf_isabella',
  'Michael (American, male)': 'am_michael',
  'Adam (American, male)': 'am_adam',
  'Eric (American, male)': 'am_eric',
  'Fenrir (American, male)': 'am_fenrir',
  'Liam (American, male)': 'am_liam',
  'Onyx (American, male)': 'am_onyx',
  'Puck (American, male)': 'am_puck',
  'George (British, male)': 'bm_george',
  'Daniel (British, male)': 'bm_daniel',
  'Fable (British, male)': 'bm_fable',
  'Lewis (British, male)': 'bm_lewis',
}
const DEFAULT_KOKORO_VOICE = 'af_heart'

/** Settings stores the display name; anything unknown (e.g. a Windows voice) gets the default. */
export function kokoroVoiceId(voiceName: string): string {
  return KOKORO_VOICES[voiceName] ?? DEFAULT_KOKORO_VOICE
}

export class KokoroModelMissingError extends Error {
  readonly code = 'KOKORO_MODEL_MISSING'
  constructor(modelDir: string, reason: string) {
    super(
      `Kokoro model not ready at ${modelDir}: ${reason}. ` +
      `Use Settings → Download Voice Model to install it.`
    )
    this.name = 'KokoroModelMissingError'
  }
}

export class KokoroTtsProvider implements ITtsProvider {
  readonly name = 'Kokoro'

  private log = LogService.getInstance()
  private modelDir: string

  // Single-flight: the promise for the currently active speak() call.
  // A new speak() awaits this before starting.
  private activeSpeak: Promise<void> = Promise.resolve()

  // The currently running child process (synthesis or playback).
  private proc: ChildProcess | null = null

  // Per-call generation counter. Each runSpeak() captures its generation at
  // entry and checks it before every async step. A new speak() increments the
  // counter, which causes any in-flight runSpeak() to treat itself as cancelled.
  private gen = 0

  onPlaybackStart?: () => void
  onAmplitude?: (amp: number) => void

  constructor(userDataPath: string) {
    this.modelDir = path.join(userDataPath, 'models', KOKORO_MODEL_DIR)
  }

  /**
   * Returns true only if the .verified sentinel exists AND contains the
   * current manifest hash. A sentinel from an older manifest is rejected.
   * No network call.
   */
  isModelReady(): boolean {
    const sentinel = path.join(this.modelDir, VERIFIED_SENTINEL)
    if (!fs.existsSync(sentinel)) return false
    try {
      return fs.readFileSync(sentinel, 'utf8').trim() === MANIFEST_HASH
    } catch {
      return false
    }
  }

  /**
   * Single-flight speak: increments the generation counter (cancelling any
   * in-progress call), kills the active process, awaits full cleanup of the
   * previous call, then starts the new utterance.
   */
  async speak(text: string, rate: number, volume: number, voiceName: string): Promise<void> {
    // Increment generation — any in-flight runSpeak() will see its gen is stale
    // and return early without starting new work.
    const myGen = ++this.gen

    // Kill the active process so the previous runSpeak() unblocks quickly.
    if (this.proc) {
      try { this.proc.kill() } catch { }
    }

    // Wait for the previous call's finally block (WAV cleanup) to complete.
    await this.activeSpeak.catch(() => {})

    // If another speak() arrived while we were waiting, yield to it.
    if (this.gen !== myGen) return

    if (!this.isModelReady()) {
      const sentinel = path.join(this.modelDir, VERIFIED_SENTINEL)
      const reason = !fs.existsSync(sentinel)
        ? 'model not installed'
        : 'manifest version mismatch'
      throw new KokoroModelMissingError(this.modelDir, reason)
    }

    const clean = text.slice(0, 5000)
    this.log.info('TTS:Kokoro: synthesis started')

    // crypto.randomUUID() guarantees uniqueness even under rapid calls.
    const tmpWav = path.join(os.tmpdir(), `goga-kokoro-${crypto.randomUUID()}.wav`)

    this.activeSpeak = this.runSpeak(myGen, clean, rate, volume, tmpWav, kokoroVoiceId(voiceName))
    return this.activeSpeak
  }

  private async runSpeak(
    myGen: number,
    text: string,
    rate: number,
    volume: number,
    tmpWav: string,
    voice: string
  ): Promise<void> {
    try {
      await this.synthesize(myGen, text, rate, tmpWav, voice)
      if (this.gen !== myGen) return
      await this.playWav(myGen, tmpWav, volume)
      this.log.info('TTS:Kokoro: playback ended')
    } finally {
      // proc is null here — process has already exited before we reach finally.
      await this.cleanupWav(tmpWav)
    }
  }

  stop(): void {
    this.gen++ // invalidate any in-flight runSpeak()
    if (this.proc) {
      try { this.proc.kill() } catch { }
      this.proc = null
    }
    this.onAmplitude?.(0)
    this.log.info('TTS:Kokoro: stopped')
  }

  async stopAndWait(): Promise<void> {
    this.gen++ // invalidate any in-flight runSpeak()
    // Kill this.proc directly — do not capture into a local variable first,
    // so a process spawned between the increment and the kill is also covered.
    if (this.proc) {
      const p = this.proc
      await new Promise<void>(resolve => {
        let done = false
        const finish = () => { if (!done) { done = true; resolve() } }
        p.once('close', finish)
        p.once('exit', finish)
        try { p.kill() } catch { finish() }
        setTimeout(finish, 1500)
      })
      this.proc = null
    }
    // Await the active speak promise so WAV cleanup completes before caller proceeds.
    await this.activeSpeak.catch(() => {})
    this.onAmplitude?.(0)
  }

  isPlaying(): boolean {
    return this.proc !== null
  }

  async getVoices(): Promise<string[]> {
    return Object.keys(KOKORO_VOICES)
  }

  // ── Synthesis via kokoro-js Node child script ─────────────────────────────
  // Runs in a child process so the ONNX runtime does not block the main thread.
  // env.allowRemoteModels = false prevents @huggingface/transformers from
  // fetching any missing artifact from the network.
  // All parameters are passed via process.argv — no user content is interpolated
  // into the script string.

  private synthesize(myGen: number, text: string, rate: number, outPath: string, voice: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.gen !== myGen) { resolve(); return }

      const script = `
const { KokoroTTS } = require('kokoro-js')
const { env } = require('@huggingface/transformers')
const fs = require('fs')
const modelDir = process.argv[1]
const outPath  = process.argv[2]
const text     = process.argv[3]
const speed    = parseFloat(process.argv[4]) || 1.0
const voice    = process.argv[5]

// Fail closed: no remote model access permitted.
env.allowRemoteModels = false
env.localModelPath    = modelDir
env.cacheDir          = modelDir

;(async () => {
  const tts = await KokoroTTS.from_pretrained(modelDir, { dtype: 'q8', device: 'cpu' })
  const audio = await tts.generate(text, { voice, speed })
  await audio.save(outPath)
  // Verify the file was written before signalling success
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 100) {
    throw new Error('WAV file missing or empty after save')
  }
})().then(() => process.exit(0)).catch(e => {
  process.stderr.write(String(e.message || e))
  process.exit(1)
})
`
      const child = spawn(
        process.execPath,
        ['-e', script, '--', this.modelDir, outPath, text, String(rate), voice],
        {
          windowsHide: true,
          timeout: 60_000,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        }
      )
      this.proc = child

      let stderr = ''
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

      child.on('close', code => {
        this.proc = null
        if (this.gen !== myGen) { resolve(); return }
        if (code === 0) resolve()
        else {
          this.log.info(`TTS:Kokoro: synthesis failed (code=${code}): ${stderr.slice(0, 300)}`)
          reject(new Error(`Kokoro synthesis failed: ${stderr.slice(0, 200)}`))
        }
      })

      child.on('error', err => {
        this.proc = null
        if (this.gen !== myGen) { resolve(); return }
        reject(err)
      })
    })
  }

  // ── WAV playback via PowerShell SoundPlayer ───────────────────────────────
  // The WAV path is passed via the GOGA_WAV_PATH environment variable.
  // The PowerShell script reads $env:GOGA_WAV_PATH — no string interpolation,
  // no quote-escaping, no injection surface regardless of path content.

  private playWav(myGen: number, wavPath: string, volume: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.gen !== myGen) { resolve(); return }

      // Real loudness of this clip, replayed in sync so the visual moves with the words.
      let envelope: number[] = []
      try { envelope = wavEnvelope(fs.readFileSync(wavPath), AMPLITUDE_WINDOW_MS) } catch { /* fall back to a gentle pulse */ }

      // Constant script — WAV path comes from the environment, not the script string.
      const script = `
Add-Type -AssemblyName System.Windows.Forms
$wavPath = $env:GOGA_WAV_PATH
$player = New-Object System.Media.SoundPlayer($wavPath)
$player.Load()
[Console]::WriteLine('PLAYBACK_STARTED')
$player.PlaySync()
[Console]::WriteLine('DONE')
`
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        env: { ...process.env, GOGA_WAV_PATH: wavPath },
      })
      this.proc = child

      let started = false
      let ampInterval: ReturnType<typeof setInterval> | null = null
      let buf = ''

      const clearAmp = () => {
        if (ampInterval) { clearInterval(ampInterval); ampInterval = null }
        this.onAmplitude?.(0)
      }

      child.stdout?.on('data', (d: Buffer) => {
        buf += d.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() === 'PLAYBACK_STARTED' && !started) {
            started = true
            this.onPlaybackStart?.()
            const startedAt = Date.now()
            let tick = 0
            ampInterval = setInterval(() => {
              if (this.gen !== myGen || !this.proc) { clearAmp(); return }
              if (envelope.length === 0) { this.onAmplitude?.(Math.sin(tick++ * 0.3) * 0.3 + 0.35); return }
              const i = Math.floor((Date.now() - startedAt) / AMPLITUDE_WINDOW_MS)
              this.onAmplitude?.(envelope[Math.min(i, envelope.length - 1)] ?? 0)
            }, AMPLITUDE_WINDOW_MS)
          }
        }
      })

      let playStderr = ''
      child.stderr?.on('data', (d: Buffer) => { playStderr += d.toString() })

      child.on('close', code => {
        this.proc = null
        clearAmp()
        if (this.gen !== myGen) { resolve(); return }
        if (code === 0) resolve()
        else {
          this.log.info(`TTS:Kokoro: playback failed (code=${code}): ${playStderr.slice(0, 200)}`)
          reject(new Error('Kokoro: WAV playback failed'))
        }
      })

      child.on('error', err => {
        this.proc = null
        clearAmp()
        if (this.gen !== myGen) { resolve(); return }
        reject(err)
      })

      // Safety ceiling: 3 minutes
      setTimeout(() => {
        if (this.gen === myGen) { this.stop(); reject(new Error('Kokoro: playback timeout')) }
      }, 180_000)
    })
  }

  /**
   * Delete the temporary WAV file after the playback process has exited
   * (proc is null when this is called from the finally block of runSpeak).
   * Retries up to 3 times with a 200 ms gap to handle file-lock on Windows.
   */
  private async cleanupWav(tmpWav: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav)
        return
      } catch {
        if (attempt < 2) await new Promise(r => setTimeout(r, 200))
      }
    }
  }
}
