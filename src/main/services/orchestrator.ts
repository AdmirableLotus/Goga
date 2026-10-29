import { MarketsService } from './markets'
import type { ChatMessage, Action, AgentState } from '../../shared/types'
import { ActionStore } from './actionStore'
import { LogService } from './logs'
import { BrainService } from './brain'
import { LibraryService } from './library'
import { OllamaClient } from './ollamaClient'
import { BRAIN_LOAD_WAIT_MS, LocalLlamaService } from './localLlama'
import { SettingsService } from './settings'
import { AgentLoop } from './agentLoop'
import { ToolRegistry } from '../tools/registry'
import { nanoid } from '../utils/nanoid'
import { buildMediaRequest } from './mediaRequest'
import { SecurityWorkspaceService } from './securityWorkspace'
import { DesktopAdapter } from '../adapters/desktop'
import { getMainWindow } from '../index'

import { looksLikeAgentTask, isVagueOpenWebsite, CONFIRM_TRIGGERS, isReadOnlyObservationRequest, isConfirmation, isActionProposal, startsWithAgreement, planNeedsComputer } from './agentRouting'
import { LONG_TEXT_CHARS, NotesStore, asNotes, fitHistory, takeNotes } from './longText'
import { app } from 'electron'
import path from 'path'
import { plannerDiagnostic } from './plannerDiagnostics'
import { observeScreen, type ObservationMessages } from './screenObservation'
import { gogaIdentity } from './persona'
import { FactLearner } from './factLearning'
import { ROUTINE_QUESTION } from './routine'
import { routineSummary } from '../sleepMode'

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
  // Notes on long documents the user pasted, so they fit the brain's context (see longText.ts).
  private notes = new NotesStore((() => { try { return path.join(app.getPath('userData'), 'document-notes.json') } catch { return undefined } })())
  // Learns lasting facts about the user from what they say, after each reply (never blocks it).
  private factLearner = new FactLearner({
    // Background work: skipped when the brain is busy rather than delaying a reply.
    chat: messages => this.llama.isReady() ? this.llama.chat(messages, undefined, undefined, { ifIdle: true }) : Promise.reject(new Error('local brain not ready')),
    knownFacts: message => this.brain.findRelevantFacts(message, 8),
    addFact: (content, category) => this.brain.addFact(content, category),
    userName: () => SettingsService.getInstance().get().userName,
    log: this.log,
  })

  async process(userMessage: ChatMessage, onToken?: (token: string) => void, onTaskComplete?: (result: { status: 'success' | 'cancelled' | 'error'; reply: string; state: AgentState; error?: string }) => void, signal?: AbortSignal): Promise<ChatMessage> {
    this.log.info(`Processing: ${userMessage.content.slice(0, 80)}`)
    // Retain text context without persisting large media payloads in electron-store.
    this.brain.addMessage(userMessage.attachments?.length
      ? { ...userMessage, attachments: undefined, content: `${userMessage.content}\n[Attached media: ${userMessage.attachments.map(a => a.name).join(', ')}]` }
      : userMessage)

    if (/^\/markets(?:\s|$)/i.test(userMessage.content.trim()) && !userMessage.attachments?.length) {
      const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: MarketsService.getInstance().report(), timestamp: Date.now() }
      this.brain.addMessage(reply)
      onToken?.(reply.content)
      return reply
    }

    if (userMessage.attachments?.length) {
      let content: string
      try {
        if (!await this.ollama.isAvailable()) throw new Error('Ollama is not running. Start Ollama and install a vision model, then set its name in Settings.')
        const request = buildMediaRequest(userMessage.content, userMessage.attachments, this.brain.getHistory())
        content = await this.ollama.chatWith(SettingsService.getInstance().get().visionModelName || 'qwen3-vl:4b', request.messages, onToken, signal, request.options)
      } catch (error) {
        content = `I could not analyze the attachments. ${error instanceof Error ? error.message : String(error)} Check the vision model in Settings.`
      }
      const reply: ChatMessage = { id: nanoid(), role: 'assistant', content, timestamp: Date.now() }
      this.brain.addMessage(reply)
      return reply
    }

    const content = userMessage.content.trim()
    if (isReadOnlyObservationRequest(content)) {
      plannerDiagnostic('routing.decision', { task: content, route: 'observation', agentTask: false })
      const result = await this.agent.runObservation(content, (abort, progress) =>
        observeScreen(this.registry, (messages, answerSignal) => this.answerObservation(messages, answerSignal), content, abort, progress), signal)
      const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: result, timestamp: Date.now() }
      this.brain.addMessage(reply)
      return reply
    }
    const history = this.brain.getHistory()
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content

    // Discuss, then act: Goga described what it would do and asked; the user agreed.
    // A plan that operates the PC becomes a task; writing, organising or advice is
    // answered right here in chat, where the brain can see the conversation.
    let agreedInChat = false
    if (isActionProposal(lastAssistant) && (isConfirmation(content) || startsWithAgreement(content))) {
      if (planNeedsComputer(lastAssistant!) && this.agent.getState().status !== 'running') {
        const userName = SettingsService.getInstance().get().userName
        const asked = [...history].reverse().slice(1).find(m => m.role === 'user' && !isConfirmation(m.content))?.content ?? ''
        const added = isConfirmation(content) ? '' : `\n\n${userName} also said: ${content.slice(0, 600)}`
        const task = `${asked.slice(0, 1500)}\n\nPlan agreed with ${userName}: ${lastAssistant!.slice(0, 1200)}${added}`.trim()
        plannerDiagnostic('routing.decision', { task: content, route: 'agreed-proposal', agentTask: true })
        return this.startAgentTask(task, onTaskComplete)
      }
      agreedInChat = true
    }

    const vagueWebsite = !agreedInChat && isVagueOpenWebsite(content)
    const agentTask = !agreedInChat && looksLikeAgentTask(content, lastAssistant)
    plannerDiagnostic('routing.decision', { task: content, vagueWebsite, agentTask, route: vagueWebsite ? 'clarify' : agentTask ? 'agent' : 'chat' })

    // "Open a website" with no named site/URL → ask which one instead of
    // starting an agent loop that would flail on an unknown target.
    if (vagueWebsite) {
      const reply = {
        id: nanoid(), role: 'assistant' as const,
        content: 'Which website would you like me to open? Tell me the site name or URL (for example, "open youtube.com").',
        timestamp: Date.now()
      }
      this.brain.addMessage(reply)
      return reply
    }

    // Route to agent loop for multi-step tasks
    if (agentTask) {
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
        void this.factLearner.learnFrom(content.slice(0, 2000))
        return reply
      }
      this.log.warn('Ollama selected as primary but not available — falling back to LocalLlama')
    }

    // ── PRIMARY: node-llama-cpp local model ───────────────────────────────────
    if (this.llama.isReady()) {
      const reply = await this.thinkWithLocalLlama(content, onToken, signal)
      this.brain.addMessage(reply)
      void this.factLearner.learnFrom(content.slice(0, 2000))
      return reply
    }

    // If still loading, wait for it rather than answering with the weaker backup model
    const llamaState = this.llama.getState()
    if (llamaState.status === 'loading') {
      this.log.info(`LocalLlama still loading — waiting up to ${BRAIN_LOAD_WAIT_MS / 1000}s…`)
      const ready = await this.llama.waitWhileLoading(BRAIN_LOAD_WAIT_MS, signal)
      if (ready) {
        const reply = await this.thinkWithLocalLlama(content, onToken, signal)
        this.brain.addMessage(reply)
        void this.factLearner.learnFrom(content.slice(0, 2000))
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
      void this.factLearner.learnFrom(content.slice(0, 2000))
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

  private async answerObservation(messages: ObservationMessages, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('cancelled')
    const settings = SettingsService.getInstance().get()
    if (settings.primaryModel === 'ollama') return this.ollama.chat(messages, undefined, signal)
    if (!this.llama.isReady()) await this.llama.waitWhileLoading(BRAIN_LOAD_WAIT_MS, signal)
    if (signal.aborted) throw new Error('cancelled')
    if (!this.llama.isReady()) throw new Error('Configured local observation answerer is not ready')
    return this.llama.chat(messages, undefined, signal)
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

    this.agent.run(task).then(async (reply) => {
      // The planner found nothing to do on the PC (a writing or thinking request routed
      // here): answer in chat instead of reporting a planning error.
      const ran = this.agent.getState()
      if (ran.status === 'error' && ran.error?.startsWith('planning_failed') && !ran.steps.some(s => s.tool)) {
        this.log.info('Agent found no PC step — answering in chat instead')
        const answer = await this.answerInChat(task).catch((err): ChatMessage => ({ id: nanoid(), role: 'assistant', content: `Model error: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() }))
        this.brain.addMessage(answer)
        getMainWindow()?.webContents.send('chat:message', answer)
        finishOnce({ status: 'success', reply: answer.content, state: ran })
        return
      }
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
      content: `On it, ${settings.userName}.`,
      timestamp: Date.now()
    }
  }

  private async buildSystemPrompt(userInput: string): Promise<string> {
    const settings = SettingsService.getInstance().get()
    const facts = await this.brain.findRelevantFacts(userInput)
    const books = this.library.list()
    const bookChunks = this.library.search(userInput, 3)
    const remembered = await this.brain.rememberConversations(userInput)
    const routine = ROUTINE_QUESTION.test(userInput) ? routineSummary(settings.userName) : ''

    const now = new Date()
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const currentDate = new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz }).format(now)
    const currentTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZone: tz }).format(now)

    return `${gogaIdentity(settings.userName, settings.personality)}

Right now you are chatting with ${settings.userName} (by text, voice or Telegram).

Current date and time: ${currentDate}, ${currentTime} (${tz})

What you know about ${settings.userName}:
${facts.length > 0 ? facts.map(f => `- ${f.content}`).join('\n') : '- Still getting to know them.'}
${remembered ? `\n${remembered}\nWhen ${settings.userName} asks about an earlier conversation or says "continue", use these notes. If they don't cover what was asked, say you don't remember that part rather than guessing.\n` : ''}${routine ? `\n${routine}\n` : ''}
Books you have read:
${books.length > 0 ? books.map(b => `- "${b.title}"`).join('\n') : '- None yet.'}

${bookChunks.length > 0 ? `Relevant book passages:\n${bookChunks.map(c => c.text).join('\n---\n').slice(0, 1200)}` : ''}

You can also operate this PC: browser, files, apps, desktop. You can design electronics too: look up real parts and build circuits (netlist, parts list, rule check) with KiCad on this PC, and work in ${settings.userName}'s Flux (flux.ai) circuit-board projects when Flux is connected in Settings. Like Schematik, you can make Arduino, ESP32 and Raspberry Pi Pico projects (code, parts to buy, wiring, build steps), compile them and upload them to a plugged-in board, and read ${settings.userName}'s Schematik (schematik.io) projects. You are also ${settings.userName}'s trading coach: with real prices and history (US stocks, ETFs, crypto, forex) you read charts, test strategies on history, and place practice trades with fake money in a paper account, within ${settings.userName}'s risk rules. You do not know current prices from memory: never state one without fetching it. Teach the why (trend, risk per trade, stops, position size, keeping a journal), be honest that no one can predict markets, and never promise profit. For electronics, plan the blocks, parts and power first, and point out anything that needs an engineer's review (safety, medical use, mains power).When ${settings.userName} wants something done, talk it through like a partner: say in a few plain sentences what you would do, mention anything risky or irreversible and anything ${settings.userName} must do personally (such as typing a password or a two-factor code), then end by asking "Want me to go ahead?". When ${settings.userName} agrees, you will carry out that plan. Do not refuse reasonable requests or tell ${settings.userName} to rephrase; if you have a concern, explain it and let ${settings.userName} decide. In this reply itself you have not acted yet: never write out tool calls, JSON or commands as if you were acting, and never claim to have done something on the computer.

You have the full conversation history. Read it before replying and don't ignore earlier context.`
  }

  /** Answer in chat with whichever brain is available. */
  private async answerInChat(userInput: string, onToken?: (token: string) => void, signal?: AbortSignal): Promise<ChatMessage> {
    if (SettingsService.getInstance().get().primaryModel === 'ollama' && await this.ollama.isAvailable()) return this.thinkWithOllama(userInput, onToken, signal)
    if (!this.llama.isReady()) await this.llama.waitWhileLoading(BRAIN_LOAD_WAIT_MS, signal)
    if (this.llama.isReady()) return this.thinkWithLocalLlama(userInput, onToken, signal)
    return this.thinkWithOllama(userInput, onToken, signal)
  }

  /**
   * The conversation as the brain sees it, sized to its context: long documents are read
   * in parts once and replaced by notes, other long turns are shortened, oldest go first.
   */
  private async buildChatMessages(userInput: string, signal?: AbortSignal) {
    const history = this.brain.getHistory().slice(-20).filter(m => m.role !== 'system').slice(-14)
    // The current message is usually already the last history entry; it is sent separately below.
    if (history[history.length - 1]?.role === 'user' && history[history.length - 1]?.content === userInput) history.pop()
    for (const text of [...history.map(m => m.content), userInput]) {
      if (text.length > LONG_TEXT_CHARS && !this.notes.get(text)) await this.readLongText(text, signal)
    }
    const systemPrompt = await this.buildSystemPrompt(userInput.slice(0, 2000))
    const current = userInput.length > LONG_TEXT_CHARS ? asNotes(userInput, this.notes.get(userInput) ?? '') : userInput
    return [
      { role: 'system' as const, content: systemPrompt },
      ...fitHistory(history, text => this.notes.get(text)).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: current },
    ]
  }

  private async readLongText(text: string, signal?: AbortSignal): Promise<void> {
    const userName = SettingsService.getInstance().get().userName
    const status = (content: string) => getMainWindow()?.webContents.send('chat:message', { id: nanoid(), role: 'system', content, timestamp: Date.now() })
    this.log.info(`Reading a long document in parts (${text.length} chars)`)
    const started = Date.now()
    const notes = await takeNotes(text, userName,
      (messages, s) => SettingsService.getInstance().get().primaryModel === 'ollama' ? this.ollama.chat(messages, undefined, s) : this.llama.chat(messages, undefined, s),
      (done, total) => { if (done === 0) status(`Reading your document in ${total} part${total === 1 ? '' : 's'}... this takes a minute or two.`) },
      signal)
    this.notes.set(text, notes)
    this.log.info(`Long document read: ${notes.length} chars of notes in ${((Date.now() - started) / 1000).toFixed(0)}s`)
  }

  private async thinkWithLocalLlama(userInput: string, onToken?: (token: string) => void, signal?: AbortSignal): Promise<ChatMessage> {
    try {
      const messages = await this.buildChatMessages(userInput, signal)
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
    try {
      const messages = await this.buildChatMessages(userInput, signal)
      const content = await this.ollama.chat(messages, onToken, signal)
      return { id: nanoid(), role: 'assistant', content: content.trim(), timestamp: Date.now() }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`Ollama error: ${msg}`)
      return { id: nanoid(), role: 'assistant', content: `Ollama error: ${msg}`, timestamp: Date.now() }
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
    if (SecurityWorkspaceService.getInstance().getActive()) throw new Error('Legacy desktop execution is disabled in security mode; use scoped approved tools.')
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
