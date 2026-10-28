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
import type { ITtsProvider, SpeechStream } from './ISpeechProvider'
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

// Kokoro synthesis, run with `node -e` in a child process; parameters arrive via process.argv.
const SYNTH_SCRIPT = `
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

// Long-lived synthesis worker for streamed speech: loads the model once, then turns
// JSON-line requests {id, gen, text, voice, speed, out} into WAV files, one at a time.
// {skipBelow: n} drops queued requests from streams that were stopped. Exits when Goga
// closes its stdin (including when Goga itself exits).
const WORKER_SCRIPT = `
const { KokoroTTS } = require('kokoro-js')
const { env } = require('@huggingface/transformers')
const readline = require('readline')
const modelDir = process.argv[1]
env.allowRemoteModels = false
env.localModelPath    = modelDir
env.cacheDir          = modelDir
const ready = KokoroTTS.from_pretrained(modelDir, { dtype: 'q8', device: 'cpu' })
ready.catch(() => {})
const reply = r => process.stdout.write('@@' + JSON.stringify(r) + '\\n')
let skipBelow = 0
let chain = Promise.resolve()
readline.createInterface({ input: process.stdin }).on('line', line => {
  let req
  try { req = JSON.parse(line) } catch { return }
  if (typeof req.skipBelow === 'number') { skipBelow = Math.max(skipBelow, req.skipBelow); return }
  chain = chain.then(async () => {
    if (req.gen < skipBelow) return reply({ id: req.id, ok: false, error: 'skipped' })
    try {
      const tts = await ready
      const audio = await tts.generate(String(req.text), { voice: req.voice, speed: req.speed })
      await audio.save(req.out)
      reply({ id: req.id, ok: true })
    } catch (e) {
      reply({ id: req.id, ok: false, error: String((e && e.message) || e) })
    }
  })
})
process.stdin.on('end', () => chain.then(() => process.exit(0)))
`

// One player for a whole streamed reply, so sentences follow each other without a
// PowerShell start-up gap. WAV paths (Goga's own temp files) arrive on stdin, one per line.
const STREAM_PLAYER_SCRIPT = `
$player = New-Object System.Media.SoundPlayer
while ($null -ne ($wavPath = [Console]::In.ReadLine())) {
  $player.SoundLocation = $wavPath
  $player.Load()
  [Console]::WriteLine('PLAYBACK_STARTED')
  $player.PlaySync()
  [Console]::WriteLine('DONE')
}
`
const WORKER_SYNTH_TIMEOUT_MS = 45_000

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

  // Streamed speech: the warm synthesis worker, its open requests, and a way to wake a
  // stream that is waiting for more text so it notices it was stopped.
  private worker: ChildProcess | null = null
  private workerRequests = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; worker: ChildProcess }>()
  private nextWorkerRequest = 1
  private wakeStream: (() => void) | null = null

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
    this.endStreams()

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
    this.endStreams()
    if (this.proc) {
      try { this.proc.kill() } catch { }
      this.proc = null
    }
    this.onAmplitude?.(0)
    this.log.info('TTS:Kokoro: stopped')
  }

  async stopAndWait(): Promise<void> {
    this.gen++ // invalidate any in-flight runSpeak()
    this.endStreams()
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

  /**
   * Speak into a WAV file without playing it (replies for a paired device such as the R1).
   * Independent of speak(): it never interrupts, or is interrupted by, speech on the PC.
   */
  synthesizeToFile(text: string, voiceName: string, outPath: string, rate = 1.0): Promise<void> {
    if (!this.isModelReady()) return Promise.reject(new KokoroModelMissingError(this.modelDir, 'model not installed'))
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath,
        ['-e', SYNTH_SCRIPT, '--', this.modelDir, outPath, text.slice(0, 5000), String(rate), kokoroVoiceId(voiceName)],
        { windowsHide: true, timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      let stderr = ''
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Kokoro synthesis failed: ${stderr.slice(0, 200)}`)))
    })
  }

  /**
   * Streamed speech for a reply that is still being written. Each pushed sentence goes to
   * the warm worker at once and plays as soon as the one before it has finished.
   * Stopping works as for speak(): stop(), stopAndWait() or a new speak() end the stream.
   * `done` rejects only if nothing could be played, so the caller can fall back.
   */
  speakStream(rate: number, _volume: number, voiceName: string): SpeechStream {
    const myGen = ++this.gen
    this.endStreams()
    if (this.proc) {
      try { this.proc.kill() } catch { }
    }

    const voice = kokoroVoiceId(voiceName)
    const items: { wav: string; ready: Promise<void> }[] = []
    let ended = false
    let wake: (() => void) | null = null
    const notify = () => { const w = wake; wake = null; w?.() }
    const stale = () => this.gen !== myGen
    const previous = this.activeSpeak

    const run = async (): Promise<void> => {
      await previous.catch(() => {})
      if (stale()) return
      if (!this.isModelReady()) throw new KokoroModelMissingError(this.modelDir, 'model not installed')
      this.wakeStream = notify
      this.log.info('TTS:Kokoro: streamed speech started')

      const player = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', STREAM_PLAYER_SCRIPT], { windowsHide: true })
      player.stdin?.on('error', () => { })
      player.on('error', () => { })
      this.proc = player

      let played = 0
      let next = 0
      try {
        while (!stale()) {
          if (next < items.length) {
            const item = items[next++]
            try {
              await item.ready
            } catch (err) {
              if (stale()) break
              // Nothing heard yet: let the caller say the whole reply another way.
              if (played === 0) throw err
              this.log.info(`TTS:Kokoro: skipped a sentence (${err instanceof Error ? err.message : String(err)})`)
              continue
            }
            if (stale()) break
            await this.playStreamClip(myGen, player, item.wav)
            played++
            continue
          }
          if (ended) break
          await new Promise<void>(resolve => { wake = resolve })
        }
        this.log.info(`TTS:Kokoro: streamed speech ended (${played} part${played === 1 ? '' : 's'})`)
      } finally {
        if (this.wakeStream === notify) this.wakeStream = null
        try { player.stdin?.end() } catch { }
        try { player.kill() } catch { }
        if (this.proc === player) this.proc = null
        this.onAmplitude?.(0)
        // A clip may still be synthesizing; delete each file once its worker request settles.
        for (const item of items) void item.ready.catch(() => {}).then(() => this.cleanupWav(item.wav))
      }
    }

    const done = run()
    this.activeSpeak = done
    return {
      push: (text: string) => {
        if (ended || stale() || !text.trim()) return
        const wav = path.join(os.tmpdir(), `goga-kokoro-${crypto.randomUUID()}.wav`)
        const ready = this.workerSynth(myGen, text.slice(0, 2000), voice, rate, wav)
        ready.catch(() => { })   // handled by the play loop, or ignored once stopped
        items.push({ wav, ready })
        notify()
      },
      end: () => { ended = true; notify() },
      done,
    }
  }

  /** Start the synthesis worker ahead of the first reply, so the model is already loaded. */
  warmUp(): void {
    if (this.isModelReady()) this.ensureWorker()
  }

  /** Ends the warm worker. Called when Goga switches voice provider or quits. */
  dispose(): void {
    this.stop()
    const w = this.worker
    this.worker = null
    try { w?.stdin?.end() } catch { }
    try { w?.kill() } catch { }
  }

  /** Wake any waiting stream (so it sees it was stopped) and drop its queued sentences. */
  private endStreams(): void {
    this.wakeStream?.()
    if (this.worker?.stdin?.writable) this.worker.stdin.write(JSON.stringify({ skipBelow: this.gen }) + '\n')
  }

  private ensureWorker(): ChildProcess {
    if (this.worker && this.worker.exitCode === null) return this.worker
    const w = spawn(process.execPath, ['-e', WORKER_SCRIPT, '--', this.modelDir], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    this.worker = w
    let buf = ''
    let stderr = ''
    w.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('@@')) continue   // the model runtime's own chatter
        let r: { id?: number; ok?: boolean; error?: string }
        try { r = JSON.parse(line.slice(2)) } catch { continue }
        const req = this.workerRequests.get(r.id ?? -1)
        if (!req) continue
        this.workerRequests.delete(r.id!)
        clearTimeout(req.timer)
        if (r.ok) req.resolve()
        else req.reject(new Error(`Kokoro synthesis failed: ${String(r.error).slice(0, 200)}`))
      }
    })
    w.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-500) })
    w.stdin?.on('error', () => { })
    const failAll = (why: string) => {
      if (this.worker === w) this.worker = null
      for (const [id, req] of this.workerRequests) {
        if (req.worker !== w) continue
        this.workerRequests.delete(id)
        clearTimeout(req.timer)
        req.reject(new Error(why))
      }
    }
    w.on('close', code => failAll(`Kokoro worker exited (code=${code}): ${stderr.slice(0, 200)}`))
    w.on('error', err => failAll(`Kokoro worker failed: ${err.message}`))
    return w
  }

  private workerSynth(gen: number, text: string, voice: string, speed: number, out: string): Promise<void> {
    const worker = this.ensureWorker()
    const id = this.nextWorkerRequest++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.workerRequests.delete(id)
        reject(new Error('Kokoro synthesis timeout'))
      }, WORKER_SYNTH_TIMEOUT_MS)
      this.workerRequests.set(id, { resolve, reject, timer, worker })
      worker.stdin?.write(JSON.stringify({ id, gen, text, voice, speed, out }) + '\n')
    })
  }

  /** Play one streamed clip on the stream's player; resolves when it ends or is stopped. */
  private playStreamClip(myGen: number, player: ChildProcess, wavPath: string): Promise<void> {
    return new Promise(resolve => {
      if (player.exitCode !== null || player.signalCode !== null) { resolve(); return }
      let envelope: number[] = []
      try { envelope = wavEnvelope(fs.readFileSync(wavPath), AMPLITUDE_WINDOW_MS) } catch { /* gentle pulse instead */ }

      let ampInterval: ReturnType<typeof setInterval> | null = null
      let buf = ''
      const finish = () => {
        if (ampInterval) { clearInterval(ampInterval); ampInterval = null }
        clearTimeout(ceiling)
        player.stdout?.off('data', onData)
        player.off('close', finish)
        resolve()
      }
      const onData = (d: Buffer) => {
        buf += d.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const msg = line.trim()
          if (msg === 'PLAYBACK_STARTED') {
            this.onPlaybackStart?.()
            const startedAt = Date.now()
            let tick = 0
            ampInterval = setInterval(() => {
              if (this.gen !== myGen) return
              if (envelope.length === 0) { this.onAmplitude?.(Math.sin(tick++ * 0.3) * 0.3 + 0.35); return }
              const i = Math.floor((Date.now() - startedAt) / AMPLITUDE_WINDOW_MS)
              this.onAmplitude?.(envelope[Math.min(i, envelope.length - 1)] ?? 0)
            }, AMPLITUDE_WINDOW_MS)
          } else if (msg === 'DONE') {
            finish()
          }
        }
      }
      // Safety ceiling for one sentence.
      const ceiling = setTimeout(finish, 120_000)
      player.stdout?.on('data', onData)
      player.once('close', finish)
      player.stdin?.write(wavPath + '\n')
    })
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

      const child = spawn(
        process.execPath,
        ['-e', SYNTH_SCRIPT, '--', this.modelDir, outPath, text, String(rate), voice],
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
