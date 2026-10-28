import fs from 'fs'
import { LogService } from './logs'
import { SettingsService } from './settings'
import { plannerDiagnostic } from './plannerDiagnostics'
import { runLocalConversation } from './localConversation'
import { exposeCudaRuntime } from './cudaRuntime'

// A cold load of the local brain from disk takes ~1 minute; callers wait this long rather
// than answering with the weaker backup model.
export const BRAIN_LOAD_WAIT_MS = 120_000
// Context kept free for the model's thinking (512 tokens) and its answer.
const REPLY_ROOM_TOKENS = 2048

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

/** Wait for the conversation ahead to finish, or return early on Stop. */
function waitTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous
  return new Promise<void>(resolve => {
    const done = () => { signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
    previous.then(done)
  })
}

export class LocalLlamaService {
  private static instance: LocalLlamaService
  private log = LogService.getInstance()

  private llama: Any = null
  private model: Any = null
  // One GPU context, made when the model loads and reused by every conversation (they run one
  // at a time). Making a fresh ~1 GB context per message failed once something else, such as a
  // browser window, had taken that VRAM in the meantime.
  private context: Any = null
  private sequence: Any = null
  private state: LocalModelState = { status: 'uninitialized', modelPath: '' }
  private initPromise: Promise<void> | null = null
  private queue: Promise<void> = Promise.resolve()
  private pending = 0

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
      const cudaDirs = exposeCudaRuntime()
      if (cudaDirs.length > 0) this.log.info(`LocalLlama: CUDA runtime folders added to PATH: ${cudaDirs.join('; ')}`)
      const { getLlama } = await esmImport('node-llama-cpp')

      this.log.info('LocalLlama: getLlama() — requesting best available GPU backend (auto)')
      this.llama = await getLlama({ gpu: 'auto' })
      this.log.info(`LocalLlama: backend=${this.llama.gpu ?? 'cpu'}`)
      plannerDiagnostic('model.backend', { backend: this.llama.gpu ?? 'cpu', modelPath, gpuLayers, contextSize })

      this.log.info('LocalLlama: loading model weights…')
      this.model = await this.llama.loadModel({ modelPath, gpuLayers })
      this.log.info('LocalLlama: model loaded ✓')

      try {
        await this.sharedSequence(contextSize)
      } catch (err) {
        // Not fatal: chat() tries again when it is first needed.
        this.log.warn(`LocalLlama: could not reserve the context yet — ${err instanceof Error ? err.message : String(err)}`)
      }
      this.state = { status: 'ready', modelPath, gpuLayers, contextSize }
      this.log.info('LocalLlama: READY ✓')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`LocalLlama: init failed — ${msg}`)
      this.state = { status: 'error', modelPath, error: msg }
      this.llama = null; this.model = null; this.context = null
    }
  }

  /**
   * Runs one conversation at a time, all on the one shared context (~1 GB at 8K). With the
   * brain and Whisper loaded there is room for only one: a chat, a task step and
   * background fact learning overlapping failed with "context size is too large for the
   * available VRAM". Callers queue in order; `ifIdle` callers (background work) are turned
   * away instead of making the user wait.
   */
  async chat(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    onToken?: (token: string) => void,
    signal?: AbortSignal,
    opts: { ifIdle?: boolean } = {}
  ): Promise<string> {
    if (!this.isReady() || !this.model) {
      throw new Error(`LocalLlama not ready: ${this.state.status} — ${this.state.error ?? ''}`)
    }
    if (opts.ifIdle && this.pending > 0) throw new Error('local brain busy')
    this.checkFits(messages)

    this.pending++
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>(resolve => { release = resolve })
    try {
      const queuedAt = Date.now()
      await waitTurn(previous, signal)
      signal?.throwIfAborted()
      // Timing for each reply, to see where a slow answer spent its time.
      const startedAt = Date.now()
      let firstTokenAt = 0
      const timedOnToken = (token: string) => { if (!firstTokenAt) firstTokenAt = Date.now(); onToken?.(token) }
      const contextSize = SettingsService.getInstance().get().localModelContextSize ?? 4096
      // The conversation "creates" and "disposes" a context; here that means borrowing the
      // shared sequence and wiping it afterwards.
      const shared = {
        createContext: async () => {
          const sequence = await this.sharedSequence(contextSize)
          return { getSequence: () => sequence, dispose: () => sequence.clearHistory() }
        },
      }
      const reply = await runLocalConversation(shared, await this.chatSessionClass(), messages,
        contextSize, timedOnToken, signal)
      const s = (ms: number) => (ms / 1000).toFixed(1) + 's'
      this.log.info(`LocalLlama: timing — waited ${s(startedAt - queuedAt)}, first words ${firstTokenAt ? s(firstTokenAt - startedAt) : 'n/a'}, ` +
        `total ${s(Date.now() - startedAt)}, ${reply.length} chars`)
      return reply
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!signal?.aborted) {
        this.log.error(`LocalLlama: chat error — ${msg}`)
        await this.dropContext()   // start the next conversation from a fresh context
      }
      throw new Error(msg)
    } finally {
      // An aborted caller leaves the line at once, but the next one still waits for
      // whoever was ahead of it.
      previous.then(release)
      this.pending--
    }
  }

  /**
   * Refuse at once a conversation that cannot fit the context, with room left for thinking
   * and the answer. Sent anyway, an oversized prompt kept the brain busy for minutes.
   */
  private checkFits(messages: { content: string }[]): void {
    if (typeof this.model?.tokenize !== 'function') return
    const contextSize = SettingsService.getInstance().get().localModelContextSize ?? 4096
    const limit = contextSize - REPLY_ROOM_TOKENS
    const tokens = messages.reduce((n, m) => n + this.model.tokenize(m.content).length, 0)
    if (tokens > limit) throw new Error(`That is too long for the local brain to read at once (${tokens} tokens; it holds about ${limit}).`)
  }

  private async sharedSequence(contextSize: number): Promise<Any> {
    if (this.sequence && this.context && !this.context.disposed) return this.sequence
    this.context = await this.model.createContext({ contextSize })
    this.sequence = this.context.getSequence()
    this.log.info(`LocalLlama: context reserved (${contextSize} tokens)`)
    return this.sequence
  }

  private async dropContext(): Promise<void> {
    const context = this.context
    this.context = null
    this.sequence = null
    await context?.dispose?.().catch?.(() => {})
  }

  private async chatSessionClass(): Promise<Any> {
    return (await esmImport('node-llama-cpp')).LlamaChatSession
  }

  /** While the model is loading, wait for the load to finish (bounded by timeoutMs and Stop).
   *  A cold load of a 6 GB model from disk takes ~1 minute. Returns whether it is ready. */
  async waitWhileLoading(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.state.status !== 'loading' || !this.initPromise) return this.isReady()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    await Promise.race([
      this.initPromise.catch(() => {}),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs)
        onAbort = resolve
        signal?.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    return this.isReady()
  }

  /** Unload the current model and load whatever the settings now point at. */
  async reload(): Promise<void> {
    await this.dispose()
    return this.initialize()
  }

  async dispose() {
    try {
      await this.context?.dispose?.()
      await this.model?.dispose?.()
      await this.llama?.dispose?.()
    } catch { /* ignore */ }
    this.llama = null; this.model = null; this.context = null; this.sequence = null
    this.state = { status: 'uninitialized', modelPath: '' }
    this.initPromise = null
  }
}
