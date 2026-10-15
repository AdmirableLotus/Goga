import type { ChatMessage, Action, AgentState } from '../../shared/types'
import { ActionStore } from './actionStore'
import { LogService } from './logs'
import { BrainService } from './brain'
import { LibraryService } from './library'
import { OllamaClient } from './ollamaClient'
import { LocalLlamaService } from './localLlama'
import { SettingsService } from './settings'
import { AgentLoop } from './agentLoop'
import { ToolRegistry } from '../tools/registry'
import { nanoid } from '../utils/nanoid'
import { DesktopAdapter } from '../adapters/desktop'
import { getMainWindow } from '../index'

import { looksLikeAgentTask, isVagueOpenWebsite, CONFIRM_TRIGGERS } from './agentRouting'

export class OrchestratorService {
  private store    = ActionStore.getInstance()
  private log      = LogService.getInstance()
  private brain    = BrainService.getInstance()
  private library  = LibraryService.getInstance()
  private ollama   = new OllamaClient()
  private llama    = LocalLlamaService.getInstance()
  private desktop  = new DesktopAdapter()
  private agent    = AgentLoop.getInstance()
  private registry = ToolRegistry.getInstance()

  async process(userMessage: ChatMessage, onToken?: (token: string) => void, onTaskComplete?: (result: { status: 'success' | 'cancelled' | 'error'; reply: string; state: AgentState; error?: string }) => void, signal?: AbortSignal): Promise<ChatMessage> {
    this.log.info(`Processing: ${userMessage.content.slice(0, 80)}`)
    this.brain.addMessage(userMessage)

    const content = userMessage.content.trim()
    const history = this.brain.getHistory()
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content

    // "Open a website" with no named site/URL → ask which one instead of
    // starting an agent loop that would flail on an unknown target.
    if (isVagueOpenWebsite(content)) {
      const reply = {
        id: nanoid(), role: 'assistant' as const,
        content: 'Which website would you like me to open? Tell me the site name or URL (for example, "open youtube.com").',
        timestamp: Date.now()
      }
      this.brain.addMessage(reply)
      return reply
    }

    // Route to agent loop for multi-step tasks
    if (looksLikeAgentTask(content, lastAssistant)) {
      let task: string
      if (CONFIRM_TRIGGERS.test(content.trim())) {
        // "Proceed" is only valid when there is an identifiable pending user task:
        // the last non-confirm user message must itself be agent-routable, AND
        // the agent must not already be running, done, or stopped from a prior run.
        // Completed/cancelled tasks cannot be restarted through "proceed".
        const agentStatus = this.agent.getState().status
        const pendingUserMsg = [...history].reverse()
          .find(m => m.role === 'user' && !CONFIRM_TRIGGERS.test(m.content.trim()))
        const hasPendingTask = pendingUserMsg &&
          looksLikeAgentTask(pendingUserMsg.content) &&
          agentStatus === 'idle'
        if (!hasPendingTask) {
          const clarify: ChatMessage = {
            id: nanoid(), role: 'assistant',
            content: 'What would you like me to proceed with? Please describe the task.',
            timestamp: Date.now()
          }
          this.brain.addMessage(clarify)
          return clarify
        }
        task = pendingUserMsg!.content
      } else {
        task = content
      }
      return this.startAgentTask(task, onTaskComplete)
    }

    const settings = SettingsService.getInstance().get()
    const useOllama = settings.primaryModel === 'ollama'

    // ── PRIMARY: Ollama (when selected) ──────────────────────────────────────
    if (useOllama) {
      const ollamaAvailable = await this.ollama.isAvailable()
      if (ollamaAvailable) {
        const reply = await this.thinkWithOllama(content, onToken, signal)
        this.brain.addMessage(reply)
        this.extractAndStoreFacts(content, reply.content)
        return reply
      }
      this.log.warn('Ollama selected as primary but not available — falling back to LocalLlama')
    }

    // ── PRIMARY: node-llama-cpp local model ───────────────────────────────────
    if (this.llama.isReady()) {
      const reply = await this.thinkWithLocalLlama(content, onToken, signal)
      this.brain.addMessage(reply)
      this.extractAndStoreFacts(content, reply.content)
      return reply
    }

    // If still loading, wait up to 30s for it to become ready
    const llamaState = this.llama.getState()
    if (llamaState.status === 'loading') {
      this.log.info('LocalLlama still loading — waiting up to 30s…')
      const ready = await this.waitForLlama(30_000)
      if (ready) {
        const reply = await this.thinkWithLocalLlama(content, onToken, signal)
        this.brain.addMessage(reply)
        this.extractAndStoreFacts(content, reply.content)
        return reply
      }
    }

    // ── FALLBACK: Ollama text (optional) ─────────────────────────────────────
    const ollamaAvailable = await this.ollama.isAvailable()
    this.log.info(`LocalLlama status: ${llamaState.status} | Ollama available: ${ollamaAvailable}`)

    if (ollamaAvailable) {
      this.log.warn('LocalLlama unavailable — falling back to Ollama')
      const reply = await this.thinkWithOllama(content, onToken, signal)
      this.brain.addMessage(reply)
      this.extractAndStoreFacts(content, reply.content)
      return reply
    }

    // ── LAST RESORT: book search ──────────────────────────────────────────────
    const chunks = this.library.search(content, 4)
    if (chunks.length > 0) {
      const reply = this.answerFromBooks(content, chunks)
      this.brain.addMessage(reply)
      return reply
    }

    // ── HONEST ERROR — report the real failure ────────────────────────────────
    const errorMsg = llamaState.error
      ? `Primary model failed to load: ${llamaState.error}`
      : `Primary model is ${llamaState.status}. Check Settings for model path and GPU configuration.`

    const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: errorMsg, timestamp: Date.now() }
    this.brain.addMessage(reply)
    return reply
  }

  private waitForLlama(timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const start = Date.now()
      const check = () => {
        if (this.llama.isReady()) return resolve(true)
        if (this.llama.getState().status === 'error') return resolve(false)
        if (Date.now() - start > timeoutMs) return resolve(false)
        setTimeout(check, 500)
      }
      check()
    })
  }

  private startAgentTask(task: string, onTaskComplete?: (result: { status: 'success' | 'cancelled' | 'error'; reply: string; state: AgentState; error?: string }) => void): ChatMessage {
    let finished = false
    const finishOnce = (r: { status: 'success' | 'cancelled' | 'error'; reply: string; state: AgentState; error?: string }) => {
      if (finished) return
      finished = true
      try { onTaskComplete?.(r) } catch (cbErr) {
        this.log.warn(`onTaskComplete callback threw: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`)
      }
    }

    this.agent.run(task).then((reply) => {
      const msg: ChatMessage = { id: nanoid(), role: 'assistant', content: reply, timestamp: Date.now() }
      this.brain.addMessage(msg)
      getMainWindow()?.webContents.send('chat:message', msg)
      const agentState = this.agent.getState()
      finishOnce({ status: agentState.status === 'stopped' ? 'cancelled' : 'success', reply, state: agentState })
    }, (err) => {
      const errMsg = err instanceof Error ? err.message : String(err)
      const msg: ChatMessage = {
        id: nanoid(), role: 'assistant',
        content: `Agent error: ${errMsg}`,
        timestamp: Date.now()
      }
      getMainWindow()?.webContents.send('chat:message', msg)
      finishOnce({ status: 'error', reply: msg.content, state: this.agent.getState(), error: errMsg })
    }).catch((unexpected) => {
      // Guards against synchronous throws inside the fulfilled handler leaking out unhandled.
      // finishOnce's boolean guard prevents double-completion if the fulfilled path already fired.
      const msg = unexpected instanceof Error ? unexpected.message : String(unexpected)
      this.log.warn(`startAgentTask: unexpected error in fulfilled handler: ${msg}`)
      finishOnce({ status: 'error', reply: `Agent error: ${msg}`, state: this.agent.getState(), error: msg })
    })

    const settings = SettingsService.getInstance().get()
    return {
      id: nanoid(), role: 'assistant',
      content: `On it, ${settings.userName} — working through this now.`,
      timestamp: Date.now()
    }
  }

  private buildSystemPrompt(userInput: string): string {
    const settings = SettingsService.getInstance().get()
    const facts = this.brain.getRelevantFacts(userInput)
    const books = this.library.list()
    const bookChunks = this.library.search(userInput, 3)
    const toolSummary = this.registry.toPromptSummary()

    const now = new Date()
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const currentDate = new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz }).format(now)
    const currentTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZone: tz }).format(now)

    return `You are Goga, a loyal, intelligent AI assistant and computer operator living on ${settings.userName}'s PC.

Current date and time: ${currentDate}, ${currentTime} (${tz})

Your personality: direct, warm, honest, proactive. You speak like a trusted friend who happens to be brilliant.

What you know about ${settings.userName}:
${facts.length > 0 ? facts.map(f => `- ${f.content}`).join('\n') : '- Still getting to know them.'}

Books you have read:
${books.length > 0 ? books.map(b => `- "${b.title}"`).join('\n') : '- None yet.'}

${bookChunks.length > 0 ? `Relevant book passages:\n${bookChunks.map(c => c.text).join('\n---\n').slice(0, 1200)}` : ''}

Your computer-use capabilities (you can do all of these autonomously):
${toolSummary}

IMPORTANT: You have full conversation history. Always read it before responding — never ignore context from earlier in the conversation.
Address ${settings.userName} by name occasionally. Keep responses concise unless detail is needed.`
  }

  private async thinkWithLocalLlama(userInput: string, onToken?: (token: string) => void, signal?: AbortSignal): Promise<ChatMessage> {
    const history = this.brain.getHistory().slice(-20)
    const systemPrompt = this.buildSystemPrompt(userInput)

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history.filter(m => m.role !== 'system').slice(-14).map(m => ({
        role: m.role as 'user' | 'assistant', content: m.content
      })),
      { role: 'user' as const, content: userInput }
    ]

    try {
      const content = await this.llama.chat(messages, onToken, signal)
      this.log.info(`LocalLlama response: ${content.slice(0, 60)}…`)
      return { id: nanoid(), role: 'assistant', content: content.trim(), timestamp: Date.now() }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`LocalLlama chat error: ${msg}`)
      return { id: nanoid(), role: 'assistant', content: `Model error: ${msg}`, timestamp: Date.now() }
    }
  }

  private async thinkWithOllama(userInput: string, onToken?: (token: string) => void, signal?: AbortSignal): Promise<ChatMessage> {
    const history = this.brain.getHistory().slice(-20)
    const systemPrompt = this.buildSystemPrompt(userInput)

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history.filter(m => m.role !== 'system').slice(-14).map(m => ({
        role: m.role as 'user' | 'assistant', content: m.content
      })),
      { role: 'user' as const, content: userInput }
    ]

    try {
      const content = await this.ollama.chat(messages, onToken, signal)
      return { id: nanoid(), role: 'assistant', content: content.trim(), timestamp: Date.now() }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`Ollama error: ${msg}`)
      return { id: nanoid(), role: 'assistant', content: `Ollama error: ${msg}`, timestamp: Date.now() }
    }
  }

  private extractAndStoreFacts(userInput: string, _reply: string) {
    const lower = userInput.toLowerCase()
    const nameMatch = userInput.match(/my name is ([A-Z][a-z]+)/i) || userInput.match(/i(?:'m| am) ([A-Z][a-z]+)/i)
    if (nameMatch) this.brain.addFact(`User's name is ${nameMatch[1]}`, 'about_user')
    const likeMatch = userInput.match(/i (?:love|like|enjoy|prefer) (.+?)(?:\.|$)/i)
    if (likeMatch) this.brain.addFact(`${SettingsService.getInstance().get().userName} likes: ${likeMatch[1]}`, 'preference')
    const hateMatch = userInput.match(/i (?:hate|dislike|don't like) (.+?)(?:\.|$)/i)
    if (hateMatch) this.brain.addFact(`${SettingsService.getInstance().get().userName} dislikes: ${hateMatch[1]}`, 'preference')
    if (lower.includes('i work') || lower.includes('my job') || lower.includes('i am a ') || lower.includes("i'm a ")) {
      this.brain.addFact(`About ${SettingsService.getInstance().get().userName}'s work: "${userInput.slice(0, 120)}"`, 'about_user')
    }
  }

  private answerFromBooks(question: string, chunks: ReturnType<LibraryService['search']>): ChatMessage {
    const bookTitle = this.library.getBookTitle(chunks[0].bookId)
    const context = chunks.map(c => c.text).join('\n\n')
    const settings = SettingsService.getInstance().get()
    return {
      id: nanoid(), role: 'assistant', timestamp: Date.now(),
      content: `From **${bookTitle}** — here's what I found, ${settings.userName}:\n\n${context.slice(0, 1400)}${context.length > 1400 ? '…' : ''}`
    }
  }

  async executeAction(action: Action): Promise<unknown> {
    this.store.setStatus(action.id, 'running')
    this.log.info(`Executing legacy action: ${action.label}`, { actionId: action.id })
    // Legacy path only — agent-owned actions are never routed here.
    // resolveApproval is NOT called: that is the handler's responsibility
    // for agent-owned actions, and legacy actions have no pending promise.
    try {
      const result = await this.desktop.execute(action.params)
      this.store.setResult(action.id, result)
      getMainWindow()?.webContents.send('action:update', this.store.get(action.id))
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.store.setError(action.id, msg)
      getMainWindow()?.webContents.send('action:update', this.store.get(action.id))
      throw err
    }
  }
}
