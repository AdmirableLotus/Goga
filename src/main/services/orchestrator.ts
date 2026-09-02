import type { ChatMessage } from '../../shared/types'
import { ActionStore } from './actionStore'
import { LogService } from './logs'
import { BrainService } from './brain'
import { LibraryService } from './library'
import { OllamaClient } from './ollamaClient'
import { SettingsService } from './settings'
import { AgentLoop } from './agentLoop'
import { ToolRegistry } from '../tools/registry'
import { nanoid } from '../utils/nanoid'
import { DesktopAdapter } from '../adapters/desktop'
import { getMainWindow } from '../index'
import type { Action } from '../../shared/types'

// Phrases that clearly signal an autonomous multi-step task
const AGENT_TRIGGERS = [
  /\b(open|launch|start)\b.{0,40}\b(and|then|to)\b/i,
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

// Short confirmations that mean "yes, proceed" in context of a previous question
const CONFIRM_TRIGGERS = /^(yes|yeah|yep|sure|ok|okay|go ahead|do it|proceed|please|yup|affirmative|correct|right|exactly|absolutely)[.!]?$/i

function looksLikeAgentTask(message: string, lastAssistantMsg?: string): boolean {
  if (AGENT_TRIGGERS.some(r => r.test(message))) return true
  // "yes" / "go ahead" after assistant asked a question or offered to search/do something
  if (CONFIRM_TRIGGERS.test(message.trim()) && lastAssistantMsg) {
    return /\b(search|look|find|open|navigate|run|execute|install|shall i|want me|would you like|should i|can i)\b/i.test(lastAssistantMsg)
  }
  return false
}

export class OrchestratorService {
  private store = ActionStore.getInstance()
  private log = LogService.getInstance()
  private brain = BrainService.getInstance()
  private library = LibraryService.getInstance()
  private ollama = new OllamaClient()
  private desktop = new DesktopAdapter()
  private agent = AgentLoop.getInstance()
  private registry = ToolRegistry.getInstance()

  async process(userMessage: ChatMessage): Promise<ChatMessage> {
    this.log.info(`Processing: ${userMessage.content.slice(0, 80)}`)
    this.brain.addMessage(userMessage)

    const content = userMessage.content.trim()

    // Get last assistant message for context-aware routing
    const history = this.brain.getHistory()
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content

    // Route to agent loop for multi-step tasks or confirmed follow-ups
    if (looksLikeAgentTask(content, lastAssistant)) {
      // For confirmations, build a full task from context
      const task = CONFIRM_TRIGGERS.test(content.trim()) && lastAssistant
        ? `${lastAssistant.slice(0, 200)} — User confirmed: proceed.`
        : content
      return this.startAgentTask(task)
    }

    // Conversational — use Ollama with full context
    const ollamaAvailable = await this.ollama.isAvailable()
    this.log.info(`Ollama available: ${ollamaAvailable} (endpoint: ${SettingsService.getInstance().get().modelEndpoint})`)
    if (ollamaAvailable) {
      const reply = await this.thinkWithOllama(content)
      this.brain.addMessage(reply)
      this.extractAndStoreFacts(content, reply.content)
      return reply
    }

    // Fallback: books or canned reply
    const chunks = this.library.search(content, 4)
    if (chunks.length > 0) {
      const reply = this.answerFromBooks(content, chunks)
      this.brain.addMessage(reply)
      return reply
    }

    const reply = this.fallbackReply(content)
    this.brain.addMessage(reply)
    return reply
  }

  private startAgentTask(task: string): ChatMessage {
    // Fire agent loop in background — it pushes agent:step and chat:message events
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
      content: `On it, ${settings.userName} — searching and working through this now.`,
      timestamp: Date.now()
    }
  }

  private async thinkWithOllama(userInput: string): Promise<ChatMessage> {
    const settings = SettingsService.getInstance().get()
    const facts = this.brain.getRelevantFacts(userInput)
    const books = this.library.list()
    const bookChunks = this.library.search(userInput, 3)
    const history = this.brain.getHistory().slice(-20)
    const toolSummary = this.registry.toPromptSummary()

    const systemPrompt = `You are Goga, a loyal, intelligent AI assistant and computer operator living on ${settings.userName}'s PC.

Your personality: direct, warm, honest, proactive. You speak like a trusted friend who happens to be brilliant.

What you know about ${settings.userName}:
${facts.length > 0 ? facts.map(f => `- ${f.content}`).join('\n') : '- Still getting to know them.'}

Books you have read:
${books.length > 0 ? books.map(b => `- "${b.title}"`).join('\n') : '- None yet.'}

${bookChunks.length > 0 ? `Relevant book passages:\n${bookChunks.map(c => c.text).join('\n---\n').slice(0, 1200)}` : ''}

Your computer-use capabilities (you can do all of these autonomously):
${toolSummary}

IMPORTANT: You have full conversation history. Always read it before responding — never ignore context from earlier in the conversation.
If the user asks about something you just discussed, continue that thread naturally.
If you offer to search or do something, and the user says "yes", tell them you're on it (the agent loop will handle it).
Address ${settings.userName} by name occasionally. Keep responses concise unless detail is needed.`

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
      content: `From **${bookTitle}** — here's what I found, ${settings.userName}:\n\n${context.slice(0, 1400)}${context.length > 1400 ? '…' : ''}\n\n*(Ollama isn't running — start it for full reasoning)*`
    }
  }

  private fallbackReply(message: string): ChatMessage {
    const settings = SettingsService.getInstance().get()
    const books = this.library.list()
    const facts = this.brain.getFacts()
    if (message.toLowerCase().match(/^(hi|hello|hey|howdy|sup|good morning|good evening)/)) {
      return {
        id: nanoid(), role: 'assistant', timestamp: Date.now(),
        content: `Hey ${settings.userName}! Ollama isn't running so I can't think fully. Start Ollama and run \`ollama pull llama3\` to bring me fully online. I have ${facts.length} memories and ${books.length} book(s) ready.`
      }
    }
    return {
      id: nanoid(), role: 'assistant', timestamp: Date.now(),
      content: `I need Ollama running to help with that, ${settings.userName}. Start it and run \`ollama pull llama3\` — I'll be fully alive.`
    }
  }

  // Used by actions handler when user approves an action from the Approvals tab
  async executeAction(action: Action): Promise<unknown> {
    this.store.setStatus(action.id, 'running')
    this.log.info(`Executing approved action: ${action.label}`, { actionId: action.id })

    // Resolve agent approval gate if this action came from the agent loop
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
