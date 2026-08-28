import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
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

const SCRIPT_PATH = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'whisper_stt.py')
const READY_TIMEOUT_MS = 60_000  // model download can take a while on first run

export class WhisperSttProvider implements ISttProvider {
  readonly name = 'Whisper'

  /** True only when the Whisper Python script is present on disk. */
  static scriptExists(): boolean {
    try { return fs.existsSync(SCRIPT_PATH) } catch { return false }
  }

  private log = LogService.getInstance()
  private proc: ChildProcess | null = null
  private ready = false
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((e: Error) => void) | null = null

  private contCallback: ((r: SpeechRecognitionResult) => void) | null = null
  private contError: ((e: Error) => void) | null = null
  private contActive = false

  // Pending one-shot resolve
  private listenResolve: ((r: SpeechRecognitionResult) => void) | null = null

  private buf = ''

  constructor(private opts: WhisperSttOptions = {}) {}

  private getEnv(): NodeJS.ProcessEnv {
    const settings = SettingsService.getInstance().get()
    const model   = this.opts.model   ?? (settings as { whisperModel?: WhisperModel }).whisperModel ?? 'base'
    const device  = this.opts.device  ?? (settings as { whisperDevice?: WhisperDevice }).whisperDevice ?? 'cuda'
    const compute = this.opts.computeType ?? (device === 'cuda' ? 'float16' : 'int8')
    const lang    = this.opts.language ?? (settings as { whisperLanguage?: string }).whisperLanguage ?? ''
    return {
      ...process.env,
      WHISPER_MODEL:   model,
      WHISPER_DEVICE:  device,
      WHISPER_COMPUTE: compute,
      ...(lang ? { WHISPER_LANG: lang } : {})
    }
  }

  private ensureProcess(): Promise<void> {
    if (this.ready && this.proc) return Promise.resolve()
    if (this.readyPromise) return this.readyPromise

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject  = reject

      this.log.info(`WhisperSTT: spawning Python process (model=${this.getEnv().WHISPER_MODEL}, device=${this.getEnv().WHISPER_DEVICE})`)

      this.proc = spawn('python', [SCRIPT_PATH], {
        env: this.getEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      this.buf = ''

      this.proc.stdout?.on('data', (d: Buffer) => {
        this.buf += d.toString()
        const lines = this.buf.split('\n')
        this.buf = lines.pop() ?? ''
        for (const line of lines) this.handleLine(line.trim())
      })

      this.proc.stderr?.on('data', (d: Buffer) => {
        // faster-whisper logs model download progress to stderr — not errors
        const msg = d.toString().trim()
        if (msg) this.log.info(`WhisperSTT stderr: ${msg.slice(0, 120)}`)
      })

      this.proc.on('error', (e) => {
        this.log.error(`WhisperSTT: process error — ${e.message}`)
        this.ready = false
        this.proc = null
        this.readyPromise = null
        this.readyReject?.(e)
        this.contError?.(e)
      })

      this.proc.on('close', (code) => {
        this.log.info(`WhisperSTT: process exited (code=${code})`)
        this.ready = false
        this.proc = null
        this.readyPromise = null
        if (this.contActive) {
          this.contError?.(new Error(`Whisper process exited unexpectedly (code=${code})`))
        }
      })

      // Timeout if model never loads
      setTimeout(() => {
        if (!this.ready) {
          this.readyReject?.(new Error('WhisperSTT: model load timeout'))
          this.readyPromise = null
        }
      }, READY_TIMEOUT_MS)
    })

    return this.readyPromise
  }

  private handleLine(line: string) {
    if (!line) return

    if (line === 'READY') {
      this.ready = true
      this.log.info('WhisperSTT: model ready')
      this.readyResolve?.()
      return
    }

    if (line.startsWith('ERROR ')) {
      const msg = line.slice(6)
      this.log.error(`WhisperSTT: ${msg}`)
      if (!this.ready) {
        this.readyReject?.(new Error(msg))
        this.readyPromise = null
      }
      this.listenResolve?.({ transcript: '' })
      this.listenResolve = null
      this.contError?.(new Error(msg))
      return
    }

    if (line.startsWith('TRANSCRIPT ')) {
      const text = line.slice(11).trim()
      if (this.listenResolve) {
        this.listenResolve({ transcript: text, confidence: 0.95 })
        this.listenResolve = null
      } else if (this.contActive && this.contCallback) {
        this.contCallback({ transcript: text, confidence: 0.95 })
      }
      return
    }

    if (line === 'DONE') {
      // One-shot completed with no transcript
      if (this.listenResolve) {
        this.listenResolve({ transcript: '' })
        this.listenResolve = null
      }
    }
  }

  private send(cmd: string) {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(cmd + '\n')
    }
  }

  async recognize(timeoutMs = 12000): Promise<SpeechRecognitionResult> {
    try {
      await this.ensureProcess()
    } catch (e) {
      this.log.error(`WhisperSTT: not ready — ${e}`)
      return { transcript: '' }
    }

    return new Promise<SpeechRecognitionResult>((resolve) => {
      this.listenResolve = resolve
      const secs = Math.ceil(timeoutMs / 1000)
      this.send(`LISTEN ${secs}`)

      // Safety timeout slightly longer than the recording window
      setTimeout(() => {
        if (this.listenResolve === resolve) {
          this.listenResolve = null
          resolve({ transcript: '' })
        }
      }, timeoutMs + 5000)
    })
  }

  startContinuous(onResult: (r: SpeechRecognitionResult) => void, onError?: (e: Error) => void): void {
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
    this.contActive   = false
    this.contCallback = null
    this.contError    = null
    if (this.ready) this.send('CONTINUOUS_STOP')
  }

  abort(): void {
    this.listenResolve?.({ transcript: '' })
    this.listenResolve = null
    this.stopContinuous()
    // Don't kill the process — keep it warm for next call
    if (this.ready) this.send('CONTINUOUS_STOP')
  }

  /** Fully shut down the Python process (call on app quit). */
  dispose(): void {
    this.contActive = false
    if (this.proc) {
      try { this.send('QUIT') } catch { }
      setTimeout(() => { try { this.proc?.kill() } catch { } }, 500)
      this.proc = null
    }
    this.ready = false
    this.readyPromise = null
  }
}
