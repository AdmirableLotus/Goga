import type { ChatMessage, Action } from '../../shared/types'
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

// Phrases that clearly signal an autonomous multi-step task
const AGENT_TRIGGERS = [
  /\b(open|launch|start)\b.{0,40}\b(and|then|to)\b/i,
  /\b(open|launch|start)\b.{0,40}\b(browser|brave|chrome|firefox|edge|app|terminal|notepad|explorer|spotify|discord|slack|vscode|code)\b/i,
  /\b(go to|navigate to|browse to)\b/i,
  /\b(find|search for|look up|research)\b/i,
  /\b(organize|sort|move|rename|delete)\b.{0,30}\b(files?|folders?)\b/i,
  /\b(fix|debug|edit|update|modify)\b.{0,40}\b(code|file|project)\b/i,
  /\b(help|assist).{0,30}\b(bounty|bug\s*bounty|pentest|hack|ctf|exploit|vuln|recon|security)\b/i,
  /\b(help me with|work on|complete|finish|do)\b.{0,60}\b(task|project|bounty|workflow)\b/i,
  /\b(run|execute|install|build|compile)\b/i,
  /\bdo (this|that|it)\b/i,
  /\b(what is|what are|how (do|does|to)|tell me about|explain|show me).{0,60}\b(hackerone|bugcrowd|intigriti|synack|bounty|cve|exploit|payload|xss|sqli|rce|ssrf|lfi|idor)\b/i,
]

const CONFIRM_TRIGGERS = /^(yes|yeah|yep|sure|ok|okay|go ahead|do it|proceed|please|yup|affirmative|correct|right|exactly|absolutely)[.!]?$/i

function looksLikeAgentTask(message: string, lastAssistantMsg?: string): boolean {
  if (AGENT_TRIGGERS.some(r => r.test(message))) return true
  if (CONFIRM_TRIGGERS.test(message.trim()) && lastAssistantMsg) {
    return /\b(search|look|find|open|navigate|run|execute|install|shall i|want me|would you like|should i|can i)\b/i.test(lastAssistantMsg)
  }
  return false
}

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

  async process(userMessage: ChatMessage, onToken?: (token: string) => void): Promise<ChatMessage> {
    this.log.info(`Processing: ${userMessage.content.slice(0, 80)}`)
    this.brain.addMessage(userMessage)

    const content = userMessage.content.trim()
    const history = this.brain.getHistory()
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content

    // Route to agent loop for multi-step tasks
    if (looksLikeAgentTask(content, lastAssistant)) {
      const task = CONFIRM_TRIGGERS.test(content.trim()) && lastAssistant
        ? `${lastAssistant.slice(0, 200)} — User confirmed: proceed.`
        : content
      return this.startAgentTask(task)
    }

    // ── PRIMARY: node-llama-cpp local model ───────────────────────────────────
    if (this.llama.isReady()) {
      const reply = await this.thinkWithLocalLlama(content, onToken)
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
        const reply = await this.thinkWithLocalLlama(content, onToken)
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
      const reply = await this.thinkWithOllama(content)
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

  private startAgentTask(task: string): ChatMessage {
    this.agent.run(task).then((reply) => {
      const msg: ChatMessage = { id: nanoid(), role: 'assistant', content: reply, timestamp: Date.now() }
      this.brain.addMessage(msg)
      getMainWindow()?.webContents.send('chat:message', msg)
    }).catch((err) => {
      const msg: ChatMessage = {
        id: nanoid(), role: 'assistant',
        content: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now()
      }
      getMainWindow()?.webContents.send('chat:message', msg)
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

    return `You are Goga, a loyal, intelligent AI assistant and computer operator living on ${settings.userName}'s PC.

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

  private async thinkWithLocalLlama(userInput: string, onToken?: (token: string) => void): Promise<ChatMessage> {
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
      const content = await this.llama.chat(messages, onToken)
      this.log.info(`LocalLlama response: ${content.slice(0, 60)}…`)
      return { id: nanoid(), role: 'assistant', content: content.trim(), timestamp: Date.now() }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`LocalLlama chat error: ${msg}`)
      return { id: nanoid(), role: 'assistant', content: `Model error: ${msg}`, timestamp: Date.now() }
    }
  }

  private async thinkWithOllama(userInput: string): Promise<ChatMessage> {
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
      const content = await this.ollama.chat(messages)
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
    this.log.info(`Executing approved action: ${action.label}`, { actionId: action.id })
    AgentLoop.getInstance().resolveApproval(action.id, true)
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
