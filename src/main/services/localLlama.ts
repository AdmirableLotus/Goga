import fs from 'fs'
import { LogService } from './logs'
import { SettingsService } from './settings'

export type LocalModelStatus = 'uninitialized' | 'loading' | 'ready' | 'error'

export interface LocalModelState {
  status: LocalModelStatus
  modelPath: string
  error?: string
  gpuLayers?: number
  contextSize?: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// Bypass TypeScript's import()-to-require() rewrite for ESM-only packages.
// Same pattern used in desktop.ts for active-win.
const esmImport = new Function('pkg', 'return import(pkg)')

export class LocalLlamaService {
  private static instance: LocalLlamaService
  private log = LogService.getInstance()

  private llama: Any = null
  private model: Any = null
  private context: Any = null
  private state: LocalModelState = { status: 'uninitialized', modelPath: '' }
  private initPromise: Promise<void> | null = null

  static getInstance() {
    if (!LocalLlamaService.instance) LocalLlamaService.instance = new LocalLlamaService()
    return LocalLlamaService.instance
  }

  getState(): LocalModelState { return { ...this.state } }
  isReady(): boolean { return this.state.status === 'ready' }

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this._init()
    return this.initPromise
  }

  private async _init(): Promise<void> {
    const settings = SettingsService.getInstance().get()
    const modelPath = settings.localModelPath
    const gpuLayers = settings.localModelGpuLayers ?? 35
    const contextSize = settings.localModelContextSize ?? 4096

    this.state = { status: 'loading', modelPath }
    this.log.info(`LocalLlama: loading model from ${modelPath}`)
    this.log.info(`LocalLlama: gpuLayers=${gpuLayers} contextSize=${contextSize}`)

    if (!fs.existsSync(modelPath)) {
      const err = `Model file not found: ${modelPath}`
      this.log.error(`LocalLlama: ${err}`)
      this.state = { status: 'error', modelPath, error: err }
      return
    }

    try {
      const { getLlama } = await esmImport('node-llama-cpp')

      this.log.info('LocalLlama: getLlama() — requesting best available GPU backend (auto)')
      this.llama = await getLlama({ gpu: 'auto' })
      this.log.info(`LocalLlama: backend=${this.llama.gpu ?? 'cpu'}`)

      this.log.info('LocalLlama: loading model weights…')
      this.model = await this.llama.loadModel({ modelPath, gpuLayers })
      this.log.info('LocalLlama: model loaded ✓')

      this.context = null  // context is now created per-call in chat()
      this.state = { status: 'ready', modelPath, gpuLayers, contextSize }
      this.log.info('LocalLlama: READY ✓')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`LocalLlama: init failed — ${msg}`)
      this.state = { status: 'error', modelPath, error: msg }
      this.llama = null; this.model = null; this.context = null
    }
  }

  async chat(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    onToken?: (token: string) => void
  ): Promise<string> {
    if (!this.isReady() || !this.model) {
      throw new Error(`LocalLlama not ready: ${this.state.status} — ${this.state.error ?? ''}`)
    }

    const settings = SettingsService.getInstance().get()
    const contextSize = settings.localModelContextSize ?? 4096
    // Create a fresh context per call — avoids "No sequences left" from reuse
    const ctx = await this.model.createContext({ contextSize })

    try {
      const { LlamaChatSession } = await esmImport('node-llama-cpp')

      const session = new LlamaChatSession({
        contextSequence: ctx.getSequence(),
      })

      const systemMsg = messages.find(m => m.role === 'system')?.content ?? ''
      const history   = messages.filter(m => m.role !== 'system')
      const lastUser  = [...history].reverse().find(m => m.role === 'user')?.content ?? ''

      // Replay prior turns so the model has conversation context
      const priorTurns = history.slice(0, -1)
      for (const msg of priorTurns) {
        if (msg.role === 'user') {
          await session.prompt(msg.content, { onTextChunk: () => {} })
        }
      }

      // Final prompt: system context prepended to user message
      const finalPrompt = systemMsg ? `${systemMsg}\n\n${lastUser}` : lastUser

      let result = ''
      await session.prompt(finalPrompt, {
        onTextChunk: (chunk: string) => {
          result += chunk
          onToken?.(chunk)
        },
      })

      return result.trim()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`LocalLlama: chat error — ${msg}`)
      throw new Error(msg)
    } finally {
      await ctx.dispose().catch(() => {})
    }
  }

  async dispose() {
    try {
      await this.context?.dispose?.()
      await this.model?.dispose?.()
      await this.llama?.dispose?.()
    } catch { /* ignore */ }
    this.llama = null; this.model = null; this.context = null
    this.state = { status: 'uninitialized', modelPath: '' }
    this.initPromise = null
  }
}
