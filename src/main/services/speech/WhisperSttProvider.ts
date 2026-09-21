import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import type { ISttProvider, SpeechRecognitionResult } from './ISpeechProvider'
import { LogService } from '../logs'
import { SettingsService } from '../settings'

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large-v2' | 'large-v3'
export type WhisperDevice = 'cuda' | 'cpu' | 'auto'

export interface WhisperSttOptions {
  model?: WhisperModel
  device?: WhisperDevice
  computeType?: string
  language?: string
}

export interface WhisperPreflight {
  model: string
  device: string
  downloadMB: number
  cached: boolean
  cacheDir: string
  source: string
}

const SCRIPT_PATH = path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'whisper_stt.py')

const MODEL_SIZES_MB: Record<string, number> = {
  tiny: 75, base: 145, small: 480, medium: 1500,
  'large-v2': 3100, 'large-v3': 3100,
}

const HF_CACHE_DIR = path.join(os.homedir(), '.cache', 'huggingface', 'hub')

function modelCacheDir(model: string): string {
  return path.join(HF_CACHE_DIR, `models--Systran--faster-whisper-${model}`)
}

function isModelCached(model: string): boolean {
  try { return fs.existsSync(modelCacheDir(model)) } catch { return false }
}

// How long to wait for READY (first run may download the model)
const READY_TIMEOUT_MS = 300_000

// Hard deadline for a single LISTEN round-trip (record + transcribe).
// If DONE is not received within this window the process is killed and restarted.
const LISTEN_HARD_TIMEOUT_MS = 20_000

export class WhisperSttProvider implements ISttProvider {
  readonly name = 'Whisper'

  static scriptExists(): boolean {
    try { return fs.existsSync(SCRIPT_PATH) } catch { return false }
  }

  static preflight(model: WhisperModel = 'base', device: WhisperDevice = 'cpu'): WhisperPreflight {
    const cached = isModelCached(model)
    return {
      model,
      device,
      downloadMB: cached ? 0 : (MODEL_SIZES_MB[model] ?? 0),
      cached,
      cacheDir: modelCacheDir(model),
      source: `https://huggingface.co/Systran/faster-whisper-${model}`,
    }
  }

  private log = LogService.getInstance()
  private proc: ChildProcess | null = null
  private ready = false
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((e: Error) => void) | null = null

  private actualDevice: string | null = null
  private actualCompute: string | null = null

  private contCallback: ((r: SpeechRecognitionResult) => void) | null = null
  private contError: ((e: Error) => void) | null = null
  private contActive = false

  // Pending one-shot resolve + its hard-timeout handle
  private listenResolve: ((r: SpeechRecognitionResult) => void) | null = null
  private listenTimer: ReturnType<typeof setTimeout> | null = null

  private buf = ''

  constructor(private opts: WhisperSttOptions = {}) {}

  private getEnv(): NodeJS.ProcessEnv {
    const settings = SettingsService.getInstance().get()
    const model   = this.opts.model   ?? (settings as { whisperModel?: WhisperModel }).whisperModel   ?? 'base'
    const device  = this.opts.device  ?? (settings as { whisperDevice?: WhisperDevice }).whisperDevice ?? 'cpu'
    const compute = this.opts.computeType ?? (device === 'cuda' ? 'float16' : 'int8')
    const lang    = this.opts.language ?? (settings as { whisperLanguage?: string }).whisperLanguage ?? ''
    return {
      ...process.env,
      WHISPER_MODEL:   model,
      WHISPER_DEVICE:  device,
      WHISPER_COMPUTE: compute,
      ...(lang ? { WHISPER_LANG: lang } : {}),
    }
  }

  private ensureProcess(): Promise<void> {
    if (this.ready && this.proc) return Promise.resolve()
    if (this.readyPromise) return this.readyPromise

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject  = reject

      const env = this.getEnv()
      this.log.info(
        `WhisperSTT: spawning (model=${env.WHISPER_MODEL} device=${env.WHISPER_DEVICE} compute=${env.WHISPER_COMPUTE})`
      )

      this.proc = spawn('python', [SCRIPT_PATH], {
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      this.buf = ''

      this.proc.stdout?.on('data', (d: Buffer) => {
        this.buf += d.toString()
        const lines = this.buf.split('\n')
        this.buf = lines.pop() ?? ''
        for (const line of lines) this.handleLine(line.trim())
      })

      this.proc.stderr?.on('data', (d: Buffer) => {
        // Python diagnostics land here — log them so they appear in Goga logs
        const msg = d.toString().trim()
        if (msg) this.log.info(`WhisperSTT diag: ${msg.slice(0, 300)}`)
      })

      this.proc.on('error', (e) => {
        this.log.error(`WhisperSTT: process error — ${e.message}`)
        this.teardown()
        this.readyReject?.(e)
        this.contError?.(e)
        this.resolveListenWithEmpty()
      })

      this.proc.on('close', (code) => {
        this.log.info(`WhisperSTT: process exited (code=${code})`)
        const wasActive = this.contActive
        this.teardown()
        if (wasActive) {
          this.contError?.(new Error(`Whisper process exited (code=${code})`))
        }
        this.resolveListenWithEmpty()
      })

      const readyTimer = setTimeout(() => {
        if (!this.ready) {
          this.log.error('WhisperSTT: READY timeout — killing process')
          this.killProc()
          this.readyReject?.(new Error('WhisperSTT: model load timeout'))
          this.readyPromise = null
        }
      }, READY_TIMEOUT_MS)

      // Clear the ready timer once resolved so it doesn't fire later
      const origResolve = resolve
      this.readyResolve = () => { clearTimeout(readyTimer); origResolve() }
    })

    return this.readyPromise
  }

  private handleLine(line: string) {
    if (!line) return

    if (line.startsWith('DEVICE_INFO ')) {
      try {
        const info = JSON.parse(line.slice(12))
        this.actualDevice  = info.device
        this.actualCompute = info.compute_type
        const note = info.requested_device !== info.device
          ? ` (requested ${info.requested_device}, fell back to ${info.device})`
          : ''
        this.log.info(
          `WhisperSTT: model=${info.model} device=${info.device} compute_type=${info.compute_type}${note}`
        )
      } catch {
        this.log.info(`WhisperSTT: DEVICE_INFO parse error: ${line}`)
      }
      return
    }

    if (line === 'READY') {
      this.ready = true
      this.log.info(
        `WhisperSTT: READY (device=${this.actualDevice ?? '?'} compute=${this.actualCompute ?? '?'})`
      )
      this.readyResolve?.()
      return
    }

    if (line.startsWith('ERROR ')) {
      const msg = line.slice(6)
      this.log.error(`WhisperSTT: ERROR from Python: ${msg}`)
      if (!this.ready) {
        this.readyReject?.(new Error(msg))
        this.readyPromise = null
      }
      this.resolveListenWithEmpty()
      this.contError?.(new Error(msg))
      return
    }

    if (line.startsWith('TRANSCRIPT ')) {
      const text = line.slice(11).trim()
      this.log.info(`WhisperSTT: transcript received: "${text.slice(0, 60)}"`)
      if (this.listenResolve) {
        this.clearListenTimer()
        const resolve = this.listenResolve
        this.listenResolve = null
        resolve({ transcript: text, confidence: 0.95 })
      } else if (this.contActive && this.contCallback) {
        this.contCallback({ transcript: text, confidence: 0.95 })
      }
      return
    }

    if (line === 'DONE') {
      this.log.info('WhisperSTT: DONE received')
      this.resolveListenWithEmpty()
    }
  }

  private resolveListenWithEmpty() {
    if (this.listenResolve) {
      this.clearListenTimer()
      const resolve = this.listenResolve
      this.listenResolve = null
      resolve({ transcript: '' })
    }
  }

  private clearListenTimer() {
    if (this.listenTimer) {
      clearTimeout(this.listenTimer)
      this.listenTimer = null
    }
  }

  private send(cmd: string) {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(cmd + '\n')
    }
  }

  private killProc() {
    if (this.proc) {
      try { this.proc.kill() } catch { }
      this.proc = null
    }
  }

  private teardown() {
    this.ready = false
    this.proc  = null
    this.readyPromise  = null
    this.readyResolve  = null
    this.readyReject   = null
    this.buf = ''
  }

  async recognize(timeoutMs = 12000): Promise<SpeechRecognitionResult> {
    this.log.info(`WhisperSTT: recognize() called (timeout=${timeoutMs}ms)`)
    try {
      await this.ensureProcess()
    } catch (e) {
      this.log.error(`WhisperSTT: not ready — ${e}`)
      return { transcript: '' }
    }

    return new Promise<SpeechRecognitionResult>((resolve) => {
      this.listenResolve = resolve
      const secs = Math.ceil(timeoutMs / 1000)
      this.log.info(`WhisperSTT: sending LISTEN ${secs}`)
      this.send(`LISTEN ${secs}`)

      // Hard deadline: if DONE never arrives, kill the process and return empty.
      // The process is killed (not just ABORT) because a hung transcription
      // cannot be interrupted any other way. ensureProcess() will restart it
      // on the next recognize() call.
      this.listenTimer = setTimeout(() => {
        if (this.listenResolve === resolve) {
          this.log.error(
            `WhisperSTT: LISTEN hard timeout (${LISTEN_HARD_TIMEOUT_MS}ms) — killing process`
          )
          this.listenResolve = null
          this.listenTimer   = null
          this.killProc()
          this.teardown()
          resolve({ transcript: '' })
        }
      }, LISTEN_HARD_TIMEOUT_MS)
    })
  }

  startContinuous(onResult: (r: SpeechRecognitionResult) => void, onError?: (e: Error) => void): void {
    this.log.info('WhisperSTT: startContinuous()')
    this.contCallback = onResult
    this.contError    = onError ?? null
    this.contActive   = true

    this.ensureProcess().then(() => {
      this.send('CONTINUOUS_START')
    }).catch((e) => {
      this.contError?.(e instanceof Error ? e : new Error(String(e)))
    })
  }

  stopContinuous(): void {
    this.log.info('WhisperSTT: stopContinuous()')
    this.contActive   = false
    this.contCallback = null
    this.contError    = null
    if (this.ready) this.send('CONTINUOUS_STOP')
  }

  abort(): void {
    this.log.info('WhisperSTT: abort()')
    this.resolveListenWithEmpty()
    if (this.ready) this.send('ABORT')
    this.stopContinuous()
  }

  dispose(): void {
    this.log.info('WhisperSTT: dispose()')
    this.contActive = false
    this.resolveListenWithEmpty()
    const proc = this.proc
    if (proc) {
      try { this.send('QUIT') } catch { }
      setTimeout(() => { try { proc.kill() } catch { } }, 500)
    }
    this.teardown()
  }

  getActualDevice(): string | null  { return this.actualDevice }
  getActualCompute(): string | null { return this.actualCompute }
}
