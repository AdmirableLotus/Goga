import { MarketsService } from './markets'
import { isTradingScheduleRequest, parseTradingCommand, proposalSymbol, tradingScheduleReply } from './trading/command'
import { alpacaKeys } from './trading/desk'
import { parseFolderReview } from './fileCommand'
import { parseOpenObserve, gatherOpenWindow, findDocument, findRecentDocument, focusWindowExact, type OpenObserveCommand } from './openWindowObserve'
import { queryVision } from '../tools/vision'
import { backgroundChat } from './backgroundChat'
import type { ChatMessage, Action, AgentState } from '../../shared/types'
import { ActionStore } from './actionStore'
import { LogService } from './logs'
import { BrainService } from './brain'
import { BOOK_STUDY_REQUEST, LibraryService, studyReport } from './library'
import { OllamaClient } from './ollamaClient'
import { BRAIN_LOAD_WAIT_MS, LocalLlamaService } from './localLlama'
import { SettingsService } from './settings'
import { AgentLoop } from './agentLoop'
import { ToolRegistry } from '../tools/registry'
import { nanoid } from '../utils/nanoid'
import { buildMediaRequest } from './mediaRequest'
import { DesktopAdapter } from '../adapters/desktop'
import { getMainWindow } from '../index'

import { chatHonestyNote, enforceHonestReply, parseRoute, routeQuestion } from './replyHonesty'
import { looksLikeAgentTask, isImperativeRequest, isConversationalQuestion, APPROVE_REPLY, DENY_REPLY, isVagueOpenWebsite, CONFIRM_TRIGGERS, isReadOnlyObservationRequest, isConfirmation, isActionProposal, startsWithAgreement, planNeedsComputer, SLEEP_REQUEST, isCompoundQuestion } from './agentRouting'
import { LONG_TEXT_CHARS, NotesStore, asNotes, fitHistory, takeNotes, rewriteRequest, rewriteInParts } from './longText'
import { app } from 'electron'
import path from 'path'
import { plannerDiagnostic } from './plannerDiagnostics'
import { observeScreen, type ObservationMessages } from './screenObservation'
import { gogaIdentity } from './persona'
import { FactLearner } from './factLearning'
import { ROUTINE_QUESTION } from './routine'
import { autoTradingSummary, routineSummary, sleepNow } from '../sleepMode'
import { GAP_QUESTION, gapFromChat, gapJournal } from './gapJournal'
import { SELF_CODE_QUESTION, codeContext } from './selfCode'
import { sourceRoot } from '../tools/self'
import { Workshop, IMPROVE_REQUEST, MERGE_REPLY, DISCARD_REPLY, RESTART_REPLY, gapNumber, diffForChat, isWorkshopCommand, isVagueImproveRequest, safetyFilesTouched } from './selfImprove'
import { groupGaps } from './gapJournal'
import { messageOwnerOnPhone } from './telegram'
import { deviceAlertReply } from './deviceReplies'
import { STUDY_QUESTION, bookStudy, matchSkills, skillsForPrompt } from './bookStudy'
import { downloadDocument, findDocumentLink, isLearnFromLink } from './webLibrary'
import { isLearnFromVideo, extractMediaPath, transcribeMedia, progressText, isLearnFromVideoFolder, extractFolderPath, collectMedia, readVisuals, isVideoFile } from './mediaStudy'
import { isLearnFromWeb, isWebSearch, isWebRecall, extractTopic, formatFindings, webLearn } from './webLearning'
import { quiz, QUIZ_REQUEST, QUIZ_AGAIN, QUIZ_HISTORY, extractQuizTopic, formatExercise, formatReview, type Exercise } from './quiz'
import fs from 'fs'
import { SCHEDULE_LIST, SCHEDULE_STOP_ALL, SCHEDULE_TASK_COMMAND, describeSchedule, parseSchedule, scheduler } from './scheduler'
import { looksLikeBigTask, parseJobCommand, questionMessage } from './jobs/routing'
import { securityRunRequest, securityToolQuestion, securityUnnamedRunRequest, unnamedRunRefusal } from './security/toolboxVerdicts'
import { findTool } from './security/toolboxQuery'
import { classifyRunRequest, refusalFor, VERDICT_LABEL } from './security/toolboxVerdicts'
import {
  parseScopeQuestion, parseLocalReview, looksLikeLocalReview, parseVenueCommand, parseMarketsCommand,
  parseBusinessPrepare, parseMonitorCommand, parseEvolutionDecision, parseDeveloperCommand,
  parseLocalRootCommand,
} from './chatRoutes'
import { findWordPressCopies, rememberedRoot, rememberRoot } from './localTarget'
import { XSS_REQUEST, decideXssRoute } from './lab/xssRoute'

// A scheduled task's run is sent as a chat message whose id starts with this.
export const SCHEDULED_ID_PREFIX = 'sched-'
const isScheduledMessage = (m: ChatMessage) => m.id.startsWith(SCHEDULED_ID_PREFIX)
const TRADING_SCHEDULE_TOPIC = /\b(alpaca|account|portfolio|positions|trades?|balance)\b/i
let lastUserMessageAt = 0
/** How long since the user last sent a message (scheduled runs wait while they're chatting). */
export function msSinceUserMessage(): number { return Date.now() - lastUserMessageAt }

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
  // The last trade plan shown, so "place it" submits exactly that (never a hallucinated order).
  private pendingPlan: { symbol: string; side: 'buy' | 'sell'; stop: number; target: number; qty: number } | null = null
  // The practice question just served, so the next message is graded as its answer (see quiz.ts).
  private pendingExercise: Exercise | null = null
  private workshopInstance: Workshop | null = null
  // Notes on long documents the user pasted, so they fit the brain's context (see longText.ts).
  private notes = new NotesStore((() => { try { return path.join(app.getPath('userData'), 'document-notes.json') } catch { return undefined } })())
  // Learns lasting facts about the user from what they say, after each reply (never blocks it).
  private factLearner = new FactLearner({
    // Background work: skipped when the brain is busy rather than delaying a reply.
    chat: messages => backgroundChat(messages),
    knownFacts: message => this.brain.findRelevantFacts(message, 8),
    addFact: (content, category) => this.brain.addFact(content, category),
    userName: () => SettingsService.getInstance().get().userName,
    log: this.log,
  })

  async process(userMessage: ChatMessage, onToken?: (token: string) => void, onTaskComplete?: (result: { status: 'success' | 'cancelled' | 'error'; reply: string; state: AgentState; error?: string }) => void, signal?: AbortSignal): Promise<ChatMessage> {
    this.log.info(`Processing: ${userMessage.content.slice(0, 80)}`)
    if (!isScheduledMessage(userMessage)) lastUserMessageAt = Date.now()
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

    // An action is waiting for approval: answer it from chat, or say what is waiting.
    const waiting = this.agent.getState().pendingApproval
    if (waiting && !userMessage.attachments?.length) {
      const said = userMessage.content.trim()
      const approved = APPROVE_REPLY.test(said) ? true : DENY_REPLY.test(said) ? false : null
      const answered = approved === null ? null : this.agent.answerPendingApproval(approved)
      const content = answered
        ? `${approved ? 'Approved' : 'Denied'}: ${answered.tool}.${approved ? ' Continuing.' : " I'll stop that step."}`
        : `I'm waiting for your approval to run ${waiting.tool} (${waiting.label}). Say "approve" or "deny", or use the buttons above the chat.`
      const reply: ChatMessage = { id: nanoid(), role: 'assistant', content, timestamp: Date.now() }
      this.brain.addMessage(reply)
      onToken?.(content)
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

    // "What's the verdict for subfinder?" — answered from the catalog, so the verdict the user
    // reads is the one the Toolbox holds, not a model's recollection of it. A question that
    // names a technique instead of a tool ("is port scanning allowed?") is answered from the
    // tools that technique belongs to.
    const toolQuestion = userMessage.attachments?.length ? null : securityToolQuestion(content)
    if (toolQuestion) {
      const asked = (toolQuestion.tools ?? [toolQuestion.tool]).map(id => findTool(id)).filter((t): t is NonNullable<typeof t> => !!t)
      if (asked.length) {
        plannerDiagnostic('routing.decision', { task: content, route: 'security-reference', agentTask: false })
        const reply: ChatMessage = {
          id: nanoid(), role: 'assistant',
          content: [
            ...asked.map(tool => [
              `${tool.name} — ${VERDICT_LABEL[tool.verdict]}`,
              tool.what,
              '',
              `Why: ${tool.verdictReason}`,
              '',
              `Useful on a bounty: ${tool.usefulPart}`,
              `Gets the account banned or the person arrested: ${tool.bannedPart}`,
              `Needs: ${tool.needs.join(', ')}`,
              '',
              `Docs (the tool's own): ${tool.docs.map(d => `${d.title} — ${d.url}`).join('; ')}`,
              `Commands: ${tool.sections.reduce((n, s) => n + s.commands.length, 0)} transcribed from your sheet ${tool.sheet}. Ask for the commands and I'll read them out.`,
            ].join('\n')),
            '',
            'A cheat sheet is a memory aid, not authorisation. Goga can teach the commands; it cannot give permission.',
          ].join('\n\n'),
          timestamp: Date.now(),
        }
        this.brain.addMessage(reply); onToken?.(reply.content)
        return reply
      }
    }

    // "Run nmap at shop.example.com" — answered from the Toolbox, never run. The Security area
    // has exactly one way to reach a target (the single approved GET), so a request to run a
    // security tool is answered with that tool's verdict and refused, before any plan is made.
    const runRequest = userMessage.attachments?.length ? null : securityRunRequest(content)
    if (runRequest) {
      plannerDiagnostic('routing.decision', { task: content, route: 'security-refusal', agentTask: false })
      const tool = findTool(runRequest.tool)
      const body = tool
        ? [refusalFor(tool) ?? classifyRunRequest(runRequest.tool).refusal,
           '',
           `Verdict: ${tool.verdict}`,
           `Useful on a bounty: ${tool.usefulPart}`,
           `Gets the account banned or the person arrested: ${tool.bannedPart}`].join('\n')
        : classifyRunRequest(runRequest.tool).refusal
      const reply: ChatMessage = {
        id: nanoid(), role: 'assistant',
        content: `${body}\n\nIf you want to see what the tool does, ask me for its verdict or its commands — I'll read them from your cheat sheets.`,
        timestamp: Date.now(),
      }
      this.brain.addMessage(reply); onToken?.(reply.content)
      return reply
    }

    // "Scan a host" / "run a port scan on shop.example.com" — the same request with no tool
    // named. This used to fall through to the agent loop, which spent steps looking for a tool
    // to call; the verdict and the refusal belong in the answer instead.
    const unnamedRun = userMessage.attachments?.length ? null : securityUnnamedRunRequest(content)
    if (unnamedRun) {
      plannerDiagnostic('routing.decision', { task: content, route: 'security-refusal-unnamed', agentTask: false })
      const tools = unnamedRun.tools.map(id => findTool(id)).filter((t): t is NonNullable<typeof t> => !!t)
      const reply: ChatMessage = {
        id: nanoid(), role: 'assistant',
        content: unnamedRunRefusal(unnamedRun.phrase, tools),
        timestamp: Date.now(),
      }
      this.brain.addMessage(reply); onToken?.(reply.content)
      return reply
    }

    // "Look at the paper I opened" / "go to my browser and look at the video": find that
    // window (never Goga's own), read the real document or look at the page, then answer.
    // The old observation path below only saw the foreground window — which is Goga itself.
    const openTarget = this.agent.getState().status !== 'running' ? parseOpenObserve(content) : null
    if (openTarget) {
      plannerDiagnostic('routing.decision', { task: content, route: 'open-window-observe', agentTask: false })
      return this.observeOpenWindow(content, openTarget, onToken, signal)
    }

    // "Rephrase this…" on pasted text: rewrite it in full (in parts when long). The long-document
    // notes path would rewrite from a summary and drop details, and the action router could
    // mistake it for a PC task — a rewrite is always just writing.
    const rewrite = this.agent.getState().status !== 'running' ? rewriteRequest(content) : null
    if (rewrite && rewrite.text.length >= 60) {
      plannerDiagnostic('routing.decision', { task: rewrite.instruction, route: 'rewrite-in-parts', agentTask: false })
      return this.rewriteLongText(rewrite.instruction, rewrite.text, onToken, signal)
    }

    // Self-improvement: "improve yourself" / "work on gap 2", then "merge it" or "discard it".
    // Checked without awaiting, so ordinary messages keep their synchronous start.
    if (isWorkshopCommand(content)) {
      const selfImprove = await this.selfImproveCommand(content)
      if (selfImprove) return selfImprove
    }

    // "What tools do you need?" — answered from the real record of failures, not imagined.
    if (GAP_QUESTION.test(content) && content.length < 300) {
      plannerDiagnostic('routing.decision', { task: content, route: 'gap-report', agentTask: false })
      const report = gapJournal()?.report() ?? 'My gap journal is not running yet.'
      const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: `${report}\n\nEach of these can become a new tool or a fix. Tell me which one to work on first.`, timestamp: Date.now() }
      this.brain.addMessage(reply); onToken?.(reply.content)
      return reply
    }

    // "https://d2l.ai/ read and learn" — download the book, add it to the Library, study it.
    const link = isLearnFromLink(content) ? content.match(/https:\/\/[^\s"'<>]+/)?.[0] : undefined
    if (link && content.length < 400) {
      plannerDiagnostic('routing.decision', { task: content, route: 'learn-from-link', agentTask: false })
      void this.importBook(link.replace(/[.,;:!?)]+$/, ''))
      const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: `Getting the book from ${link} now. A big book can take a few minutes to download and read in; I'll tell you here when it's in my Library, then I'll study it while you're not chatting.`, timestamp: Date.now() }
      this.brain.addMessage(reply); onToken?.(reply.content)
      return reply
    }

    // "Watch this video and learn from it C:\…\lecture.mp4" — transcribe the recording, add the
    // transcript to the Library, then study it like a book. A local file (a long video is far too
    // big for Telegram), so this is a path, not a link.
    if (isLearnFromVideo(content) && content.length < 600) {
      const mediaPath = extractMediaPath(content)!
      plannerDiagnostic('routing.decision', { task: content, route: 'learn-from-video', agentTask: false })
      void this.studyVideo(mediaPath)
      const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: `Watching "${path.basename(mediaPath)}" now. I listen to the whole recording and write down everything that's said, then study those notes and turn them into skills. A long video (an hour or more) takes a while — I'll tell you here when the transcript is in my Library, and again once I've studied it. Ask "how is your studying going" any time.`, timestamp: Date.now() }
      this.brain.addMessage(reply); onToken?.(reply.content)
      return reply
    }

    // "Learn from the videos in C:\…\courses" — transcribe and study every recording in a folder.
    if (isLearnFromVideoFolder(content) && content.length < 600) {
      const folder = extractFolderPath(content)!
      plannerDiagnostic('routing.decision', { task: content, route: 'learn-from-video-folder', agentTask: false })
      void this.studyVideoFolder(folder)
      const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: `Looking in "${folder}" for videos and recordings. I'll go through them one by one — transcribe each, add it to my Library, and study it into skills. I'll tell you here how many I found and report as I finish each one.`, timestamp: Date.now() }
      this.brain.addMessage(reply); onToken?.(reply.content)
      return reply
    }

    // Honest web research (opt-in): "research X online", "search the web for X", "what did you
    // find about X online". Goga searches, reads a few real public pages, summarises each with his
    // own model, and recalls from source-grounded notes with the links — never during ordinary
    // chat, and never claiming a live visit. The honest counterpart to "I can't crawl a website".
    const wl = webLearn()
    if (wl && SettingsService.getInstance().get().webLearnEnabled && content.length < 400) {
      const sayWeb = (c: string): ChatMessage => { const m: ChatMessage = { id: nanoid(), role: 'assistant', content: c, timestamp: Date.now() }; this.brain.addMessage(m); onToken?.(c); return m }
      if (isWebRecall(content)) {
        plannerDiagnostic('routing.decision', { task: content, route: 'web-recall', agentTask: false })
        try { return sayWeb(await wl.answer(content)) } catch { return sayWeb("I couldn't pull that from my saved research just now — try again in a moment.") }
      }
      if (isLearnFromWeb(content) && extractTopic(content)) {
        const topic = extractTopic(content)
        plannerDiagnostic('routing.decision', { task: content, route: 'learn-from-web', agentTask: false })
        void this.studyWeb(topic)
        return sayWeb(`Searching the web about "${topic}" now. I'll read a few public pages, summarise each with my own model, and save source-grounded notes — then ask "what did you find about ${topic}" and I'll answer from those notes with the links. I only do this because you asked; I don't browse on my own, and I'll never claim I read a page live.`)
      }
      if (isWebSearch(content) && extractTopic(content)) {
        const topic = extractTopic(content)
        plannerDiagnostic('routing.decision', { task: content, route: 'web-search', agentTask: false })
        try {
          const hits = await wl.search(topic)
          if (hits.length === 0) return sayWeb(`I searched the web for "${topic}" but got nothing back — the search may be rate-limited right now. Try again in a moment.`)
          return sayWeb(`Here's what I found on the web for "${topic}" (links only — I haven't read or saved anything yet):\n\n${hits.map(h => `• ${h.title || h.url}\n  ${h.url}`).join('\n')}\n\nSay "research ${topic} online" and I'll read and remember them.`)
        } catch { return sayWeb(`I couldn't search the web just now (it may be rate-limited). Try again in a moment.`) }
      }
    }

    // "Learn from the book I gave you" / "what skills have you learned" — real study progress.
    // Only when that's the whole question: "why couldn't you…, second did you read…, third how is
    // your day" needs every part answered, so it goes to the brain with the study report in view.
    if ((BOOK_STUDY_REQUEST.test(content) || STUDY_QUESTION.test(content)) && content.length < 300 && !isCompoundQuestion(content)) {
      plannerDiagnostic('routing.decision', { task: content, route: 'book-study', agentTask: false })
      const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: bookStudy()?.report() ?? studyReport(this.library.list()), timestamp: Date.now() }
      this.brain.addMessage(reply); onToken?.(reply.content)
      return reply
    }

    // Self-testing on what he's studied: "quiz me [on X]", answering the served question,
    // "another" for a follow-up, "how am I doing". All local — the 14B writes and grades.
    const q = quiz()
    if (q) {
      const say = (content: string): ChatMessage => { const m: ChatMessage = { id: nanoid(), role: 'assistant', content, timestamp: Date.now() }; this.brain.addMessage(m); onToken?.(content); return m }
      if (QUIZ_HISTORY.test(content) && content.length < 120) { plannerDiagnostic('routing.decision', { task: content, route: 'quiz-history', agentTask: false }); return say(q.summary()) }
      if (QUIZ_REQUEST.test(content) && content.length < 200) {
        plannerDiagnostic('routing.decision', { task: content, route: 'quiz-make', agentTask: false })
        const notReady = q.notReady(); if (notReady) return say(notReady)
        this.pendingExercise = null
        try { const ex = await q.make(extractQuizTopic(content)); this.pendingExercise = ex; return say(formatExercise(ex)) }
        catch { return say("I couldn't put a question together just now — try again in a moment.") }
      }
      if (QUIZ_AGAIN.test(content) && q.hasSession()) {
        plannerDiagnostic('routing.decision', { task: content, route: 'quiz-again', agentTask: false })
        this.pendingExercise = null
        try { const ex = await q.followup(); this.pendingExercise = ex; return say(formatExercise(ex)) }
        catch { return say("I couldn't put the next question together just now — try again in a moment.") }
      }
      if (this.pendingExercise) {
        const ex = this.pendingExercise; this.pendingExercise = null
        if (/^\s*(skip|stop|cancel|never ?mind|forget it|no)\s*[.!]*$/i.test(content)) return say('Okay, skipped. Say "quiz me" whenever you want another.')
        plannerDiagnostic('routing.decision', { task: content, route: 'quiz-grade', agentTask: false })
        try { const review = await q.grade(ex, content); return say(formatReview(review, ex.bookTitle)) }
        catch { return say("I couldn't grade that just now — try answering again, or say \"quiz me\" for a fresh question.") }
      }
    }

    // "This is my new phone" / "is the device a smartphone?" after a new-device alert: say what
    // is really known, and remember the owner's answer, instead of inventing "authorized" lists.
    if (!isScheduledMessage(userMessage)) {
      const cutoff = Date.now() - 6 * 3_600_000
      const recent = () => this.brain.getHistory().filter(m => m.role === 'assistant' && m.timestamp > cutoff).slice(-6).reverse().map(m => m.content)
      const device = deviceAlertReply(content, recent, SettingsService.getInstance().get().userName)
      if (device) {
        if (device.fact) this.brain.addFact(device.fact, 'about_user')
        const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: device.reply, timestamp: Date.now() }
        this.brain.addMessage(reply); onToken?.(reply.content)
        return reply
      }
    }

    // "Go to sleep mode, good night": actually go to sleep by the clock (no agent task).
    if (SLEEP_REQUEST.test(content)) {
      const name = SettingsService.getInstance().get().userName
      const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: `Good night, ${name}. I'm going to sleep by the clock — still watching your PC and paper trades, and I'll study my books while it's quiet. Message me on Telegram or say "Hey Goga" to wake me.`, timestamp: Date.now() }
      this.brain.addMessage(reply); onToken?.(reply.content)
      setTimeout(() => { try { sleepNow() } catch { /* no window to hide */ } }, 1500)
      return reply
    }

    // Goga's own recurring tasks: "every hour check alpaca", "my scheduled tasks", "stop task 2".
    // A scheduled run never schedules again, so a task can't multiply itself.
    if (!isScheduledMessage(userMessage)) {
      const scheduleReply = this.scheduleCommand(content)
      if (scheduleReply) {
        const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: scheduleReply, timestamp: Date.now() }
        this.brain.addMessage(reply); onToken?.(reply.content)
        return reply
      }
    }
    // Jobs: "my jobs", "job <id>: yes", "start job: …". A job's question is answered only
    // when the message names that job, so an ordinary sentence is never taken as an answer.
    if (!isScheduledMessage(userMessage)) {
      const jobReply = this.jobCommand(content)
      if (jobReply) {
        this.brain.addMessage(jobReply); onToken?.(jobReply.content)
        return jobReply
      }
    }

    // "How does your trade watcher work?" / "analyze your code" — answer from the real
    // source files, so Goga describes himself as he is built, not as he imagines it.
    if (SELF_CODE_QUESTION.test(content) && this.agent.getState().status !== 'running') {
      plannerDiagnostic('routing.decision', { task: content, route: 'self-code', agentTask: false })
      return this.answerAboutOwnCode(content, onToken, signal)
    }

    if (isReadOnlyObservationRequest(content)) {
      plannerDiagnostic('routing.decision', { task: content, route: 'observation', agentTask: false })
      const result = await this.agent.runObservation(content, (abort, progress) =>
        observeScreen(this.registry, (messages, answerSignal) => this.answerObservation(messages, answerSignal), content, abort, progress), signal)
      const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: result, timestamp: Date.now() }
      this.brain.addMessage(reply)
      return reply
    }

    // "review this folder" runs the folder-review tool directly (reads every document and
    // looks at every image), so it doesn't depend on the planner picking the right tool.
    if (this.agent.getState().status !== 'running') {
      const folder = parseFolderReview(content)
      if (folder) {
        const reply = await this.runTradingCommand({ tool: 'files.reviewFolder', params: { path: folder.path } }, signal)
        this.brain.addMessage(reply); onToken?.(reply.content)
        return reply
      }
    }

    // Trader mode: a clear trading request runs the exact trading tool directly, so it always
    // works regardless of whether the local model emits perfect JSON.
    if (this.agent.getState().status !== 'running') {
      // "place it" after a trade plan actually submits the order — the chat brain used to
      // pretend it placed trades (with a made-up ID) while nothing reached the broker.
      if (this.pendingPlan && /^\s*(place|submit|execute|take|confirm|approve|do|make)\s*(it|the (trade|order|plan))?\s*[.!]?$/i.test(content)) {
        const plan = this.pendingPlan; this.pendingPlan = null
        const reply = await this.runTradingCommand({ tool: 'trading.order', params: { symbol: plan.symbol, side: plan.side, qty: plan.qty, stopPrice: plan.stop, takeProfit: plan.target, reason: 'Practice trade placed from the approved plan (2:1 reward-to-risk, ATR stop).' } }, signal)
        this.brain.addMessage(reply); onToken?.(reply.content)
        return reply
      }
      const recent = this.brain.getHistory().slice(-4).map(m => m.content)
      if (isTradingScheduleRequest(content, recent)) {
        const s = SettingsService.getInstance().get()
        const account = await this.runTradingCommand({ tool: 'trading.account', params: {} }, signal)
        const reply: ChatMessage = { ...account, content: `${tradingScheduleReply(s.tradeWatchEnabled ?? true, !!s.autoTradeEnabled)}\n\n${account.content}` }
        this.brain.addMessage(reply); onToken?.(reply.content)
        return reply
      }
      // "Want me to check your Alpaca account?" → "you do that": show the account itself.
      const lastSaid = [...this.brain.getHistory()].reverse().find(m => m.role === 'assistant')?.content
      const agreedToAccountCheck = isActionProposal(lastSaid) && (isConfirmation(content) || startsWithAgreement(content))
        && /\b(alpaca|paper (trading )?account|trading account|account balance)\b/i.test(lastSaid ?? '') && !/\b(buy|sell|order)\b/i.test(lastSaid ?? '')
      // "…analyze AAPL and place a new buy order?" → "yes": analyze and plan it here. The 14B
      // planner looped on trading.analyze for 20 steps; the order still waits for "place it".
      const proposedSymbol = isActionProposal(lastSaid) && (isConfirmation(content) || startsWithAgreement(content))
        && /\b(buy|sell|trade|order|analy[sz](e|is)|technical)\b/i.test(lastSaid ?? '') ? proposalSymbol(lastSaid ?? '') : null
      if (proposedSymbol) {
        const side = /\b(sell|short)\b/i.test(lastSaid ?? '') && !/\bbuy\b/i.test(lastSaid ?? '') ? 'sell' : 'buy'
        const analysis = await this.runTradingCommand({ tool: 'trading.analyze', params: { symbol: proposedSymbol } }, signal)
        const plan = await this.runTradingCommand({ tool: 'trading.plan', params: { symbol: proposedSymbol, side } }, signal)
        const reply: ChatMessage = { ...plan, content: `${analysis.content}\n\n${plan.content}` }
        plannerDiagnostic('routing.decision', { task: content, route: 'agreed-trade-proposal', agentTask: false })
        this.brain.addMessage(reply); onToken?.(reply.content)
        return reply
      }
      const cmd = agreedToAccountCheck ? { tool: 'trading.account', params: {} } : parseTradingCommand(content)
      if (cmd) {
        const reply = await this.runTradingCommand(cmd, signal)
        this.brain.addMessage(reply); onToken?.(reply.content)
        return reply
      }
    }

    // ── The work that used to need a page ────────────────────────────────────
    //
    // Each of these has exactly one right tool and no planning to do, so it is parsed and
    // dispatched here rather than left to the planner. This is what makes chat the route that
    // acts: a scope question, a local file review, a venue read, a market backtest, a prepared
    // business action, a self-improvement decision and a developer run all reach their tool
    // from a sentence.
    if (this.agent.getState().status !== 'running') {
      const direct = this.directRoute(content)
      if (direct) {
        plannerDiagnostic('routing.decision', { task: content, route: `direct:${direct.calls.map(c => c.tool).join('+')}`, agentTask: false })
        const parts: string[] = []
        let incomplete = false
        for (const call of direct.calls) {
          const reply = await this.runTradingCommand({ tool: call.tool, params: call.params }, signal)
          parts.push(reply.content)
          const failed = !reply.content || reply.content.startsWith("Couldn't do that:")
          if (failed) {
            incomplete = true
            // A failed import is not a reason to skip the check that follows it: the check
            // runs against whatever program is already imported, and its answer is still the
            // one the user asked for. Any other failure ends the chain.
            if (call.tool !== 'security.importProgram') break
          }
        }
        const body = parts.filter(Boolean).join('\n\n')
        const withIntent: ChatMessage = {
          id: nanoid(), role: 'assistant', fromTools: true, timestamp: Date.now(),
          content: body ? `${direct.intent}\n\n${body}` : direct.intent,
        }
        this.brain.addMessage(withIntent); onToken?.(withIntent.content)
        if (incomplete) this.log.warn(`Direct route ${direct.calls.map(c => c.tool).join('+')} did not complete`)
        return withIntent
      }
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
    const agentTask = !agreedInChat && (looksLikeAgentTask(content, lastAssistant)
      || (!isVagueOpenWebsite(content) && await this.brainWantsAction(content, lastAssistant, signal)))
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

    // A big compound request becomes ONE job with sub-steps, not one enormous chat turn.
    // The job runs in the background, survives the window closing, and reports honestly.
    if (agentTask && looksLikeBigTask(content) && this.agent.getState().status !== 'running') {
      const job = this.jobsManager().create({ goal: content })
      plannerDiagnostic('routing.decision', { task: content, route: 'job', agentTask: false })
      const reply: ChatMessage = {
        id: nanoid(), role: 'assistant',
        content: `This is big enough to deserve its own worker, so I've made it job ${job.id} ("${job.title}"). It runs in the background — you can close the window and it keeps going. Watch it on the Jobs page; if it needs a decision from you it will stop and ask, here and there.`,
        timestamp: Date.now(),
      }
      this.brain.addMessage(reply); onToken?.(reply.content)
      return reply
    }

    // Route to agent loop for multi-step tasks
    if (agentTask) {
      let task: string
      if (CONFIRM_TRIGGERS.test(content.trim()) || isConfirmation(content)) {
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
        const reply = this.grounded(await this.thinkWithOllama(content, onToken, signal), content)
        this.brain.addMessage(reply)
        void this.factLearner.learnFrom(content.slice(0, 2000))
        return reply
      }
      this.log.warn('Ollama selected as primary but not available — falling back to LocalLlama')
    }

    // ── PRIMARY: node-llama-cpp local model ───────────────────────────────────
    if (this.llama.isReady()) {
      const reply = this.grounded(await this.thinkWithLocalLlama(content, onToken, signal), content)
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
        const reply = this.grounded(await this.thinkWithLocalLlama(content, onToken, signal), content)
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
      const reply = this.grounded(await this.thinkWithOllama(content, onToken, signal), content)
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

  /** The job manager, required lazily so the chat path stays light. */
  private jobsManager() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { jobs } = require('./jobs/instance') as typeof import('./jobs/instance')
    return jobs()
  }

  /** "my jobs", "job <id>", "job <id>: <answer>", "cancel job <id>", "start job: …". */
  private jobCommand(content: string): ChatMessage | null {
    const cmd = parseJobCommand(content)
    if (!cmd) return null
    const say = (text: string): ChatMessage => ({ id: nanoid(), role: 'assistant', content: text, timestamp: Date.now() })
    try {
      const manager = this.jobsManager()
      if (cmd.kind === 'list') {
        const view = manager.view()
        if (view.jobs.length === 0) return say('No jobs yet. Give me a big request and I will hand it to its own worker.')
        const lines = view.jobs.map(j => {
          const asking = j.state === 'waiting' && j.question ? ` — ASKING: ${j.question.text}` : ''
          return `• ${j.id} [${j.state}] ${j.title} — ${j.progress}${asking}`
        })
        return say(`${view.running} running, ${view.queued} queued, ${view.waiting} waiting on you (limit ${view.cap}).\n\n${lines.join('\n')}`)
      }
      if (cmd.kind === 'read') {
        const job = manager.get(cmd.id)
        if (!job) return say(`I have no job with the id ${cmd.id}. Say "my jobs" to see them.`)
        const parts = [`${job.title} [${job.state}]`, job.progress]
        if (job.question && job.state === 'waiting') parts.push(questionMessage(job))
        if (job.report) {
          parts.push(`WHAT YOU GET:\n${job.report.result.map(r => `- ${r}`).join('\n') || '- nothing'}`)
          parts.push(`NOT DONE:\n${job.report.notDone.map(r => `- ${r}`).join('\n') || '- nothing was left undone'}`)
        }
        return say(parts.join('\n\n'))
      }
      if (cmd.kind === 'answer') {
        manager.answer(cmd.id, cmd.answer)
        return say(`Sent to job ${cmd.id}. It carries on from there.`)
      }
      if (cmd.kind === 'cancel') {
        manager.cancel(cmd.id)
        return say(`Job ${cmd.id} is stopped. It kept the steps it had already done and wrote a report saying so.`)
      }
      if (cmd.kind === 'resume') {
        manager.resume(cmd.id)
        return say(`Job ${cmd.id} is running again from where it stopped.`)
      }
      const job = manager.create({ goal: cmd.goal })
      return say(`Started job ${job.id} ("${job.title}"). It is ${job.state}. Watch it on the Jobs page.`)
    } catch (err) {
      return say(err instanceof Error ? err.message : String(err))
    }
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
        // An order that took no step did not happen. Answering it in chat is what produced
        // the replies that narrated an action Goga never took, so the reply here says what
        // is true instead: nothing ran, and what the user can say to get it moving.
        this.log.warn('Agent took no step on an action request — reporting that, not answering in chat')
        const honest = enforceHonestReply(reply, { acted: false })
        const msg: ChatMessage = {
          id: nanoid(), role: 'assistant',
          content: `${honest.content}\n\nI could not turn that into any step I can take. `
            + 'Name the site or the exact thing to do and I will go and do it — for example '
            + '"open hackerone.com/coinbase and read the scope", or "start Firefox and read that page".',
          timestamp: Date.now(), fromTools: true,
        }
        this.brain.addMessage(msg)
        getMainWindow()?.webContents.send('chat:message', msg)
        finishOnce({ status: 'error', reply: msg.content, state: ran, error: 'planning_failed: zero executable steps' })
        return
      }
      // Already held to its own step history by the agent loop, so it goes out as written.
      const msg: ChatMessage = { id: nanoid(), role: 'assistant', content: reply, timestamp: Date.now(), fromTools: true }
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

  /** Rewrite a long text in parts as asked, streaming it, keeping every detail. */
  private async rewriteLongText(instruction: string, text: string, onToken?: (token: string) => void, signal?: AbortSignal): Promise<ChatMessage> {
    const settings = SettingsService.getInstance().get()
    const status = (content: string) => getMainWindow()?.webContents.send('chat:message', { id: nanoid(), role: 'system', content, timestamp: Date.now() })
    const chat = async (messages: { role: 'system' | 'user'; content: string }[], tok: (t: string) => void, s?: AbortSignal) => {
      if (settings.primaryModel === 'ollama' && await this.ollama.isAvailable()) return this.ollama.chat(messages, tok, s)
      if (!this.llama.isReady()) await this.llama.waitWhileLoading(BRAIN_LOAD_WAIT_MS, s)
      return this.llama.chat(messages, tok, s)
    }
    this.log.info(`Rewriting a long text in parts (${text.length} chars): ${instruction.slice(0, 80)}`)
    let content: string
    try {
      content = await rewriteInParts(text, instruction, settings.userName, chat, onToken,
        (done, total) => { if (done === 0 && total > 1) status(`Rewriting your text in ${total} parts — each part appears as it's written, nothing is summarised away.`) },
        signal)
    } catch (err) {
      content = signal?.aborted ? 'Stopped.' : `I couldn't finish the rewrite: ${err instanceof Error ? err.message : String(err)}`
    }
    const reply: ChatMessage = { id: nanoid(), role: 'assistant', content, timestamp: Date.now() }
    this.brain.addMessage(reply)
    return reply
  }

  private workshop(): Workshop {
    return this.workshopInstance ??= new Workshop({
      projectRoot: app.getAppPath(),
      workDir: path.join(app.getPath('userData'), 'workshop'),
      ask: (messages, signal) => this.ollama.chatJson(messages, signal, SettingsService.getInstance().get().coderModelName || 'qwen2.5-coder:14b', { num_ctx: 16384, num_predict: 4096, temperature: 0.2 }),
      status: text => getMainWindow()?.webContents.send('chat:message', { id: nanoid(), role: 'system', content: text, timestamp: Date.now() }),
      log: this.log,
    })
  }

  /** Say something in chat outside a reply (the workshop finishing in the background). */
  /** Set up, list, pause or remove a recurring task from chat; null when it isn't about that. */
  private scheduleCommand(content: string): string | null {
    const s = scheduler()
    if (SCHEDULE_LIST.test(content)) return s?.summary() ?? 'My scheduler is not running yet.'
    if (SCHEDULE_STOP_ALL.test(content)) return s ? `Removed all ${s.removeAll()} scheduled task(s).` : 'My scheduler is not running yet.'
    const one = content.match(SCHEDULE_TASK_COMMAND)
    if (one) {
      if (!s) return 'My scheduler is not running yet.'
      const id = Number(one[2])
      const verb = one[1].toLowerCase()
      const task = verb === 'pause' ? s.setPaused(id, true) : /resume|unpause/.test(verb) ? s.setPaused(id, false) : s.remove(id)
      if (!task) return `I don't have a scheduled task ${id}. ${s.list().length ? `Say "my scheduled tasks" to see them.` : ''}`.trim()
      return verb === 'pause' ? `Paused task ${id} ("${task.request}").` : /resume|unpause/.test(verb) ? `Resumed task ${id}; next run at ${new Date(task.nextRun).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.` : `Removed task ${id} ("${task.request}").`
    }
    const previous = () => [...this.brain.getHistory()].reverse().slice(1).find(m => m.role === 'user' && !isConfirmation(m.content))?.content
    const spec = parseSchedule(content, previous)
    if (!spec) return null
    if (!s) return 'My scheduler is not running yet, so I can\'t set that up right now.'
    plannerDiagnostic('routing.decision', { task: content, route: 'schedule', agentTask: false })
    try {
      const task = s.add(spec, 'user')
      const when = new Date(task.nextRun).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      const what = task.kind === 'reminder' ? `remind you: ${task.request}` : `"${task.request}" and post the result here`
      const watcherNote = TRADING_SCHEDULE_TOPIC.test(task.request) ? '\n\n(Separately, I already check the paper account every 5 minutes and alert you right away about fills, stops and big moves.)' : ''
      return `Set up task ${task.id}: ${describeSchedule(task)} I'll ${what}. First run: ${when}.${watcherNote}\n\nSay "my scheduled tasks" to see them all, or "stop task ${task.id}" to remove it.`
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  /** Download a book from a link into the Library, and say how it went. Studying starts on its own. */
  private async importBook(url: string): Promise<void> {
    let file: string | null = null
    try {
      const doc = await findDocumentLink(url)
      file = await downloadDocument(doc)
      const meta = await this.library.ingest(file)
      this.post(`📚 "${meta.title}" is in my Library (${meta.chunkCount.toLocaleString('en-US')} passages, from ${doc}). I'll study it section by section while you're not chatting, and tell you when I'm done. Ask "how is your studying going" any time.`)
    } catch (err) {
      this.post(`I couldn't get that book: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (file) try { fs.rmSync(path.dirname(file), { recursive: true, force: true }) } catch { /* temp file */ }
    }
  }

  private async studyVideo(mediaPath: string): Promise<void> {
    if (!fs.existsSync(mediaPath)) {
      this.post(`I can't find that file: ${mediaPath}. Send me the full path to the video or audio file (for example C:\\Users\\you\\Videos\\lecture.mp4).`)
      return
    }
    try {
      const meta = await this.transcribeAndIngest(mediaPath)
      this.post(`📚 I've listened to "${path.basename(mediaPath)}" and added what was said to my Library as "${meta.title}" (${meta.chunkCount.toLocaleString('en-US')} passages). I'll study it section by section while you're not chatting and tell you when I'm done. Ask "how is your studying going" any time.`)
    } catch (err) {
      this.post(`I couldn't learn from that recording: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Opt-in web research: search, read a few public pages, summarise locally, remember the notes. */
  private async studyWeb(topic: string): Promise<void> {
    const wl = webLearn(); if (!wl) return
    try {
      const { saved, skipped } = await wl.learn(topic, msg => this.post(`🔎 ${msg}`))
      this.post(formatFindings(topic, saved, skipped))
    } catch (err) {
      this.post(`I couldn't finish researching "${topic}": ${err instanceof Error ? err.message : String(err)}. The web search may be rate-limited — try again in a bit.`)
    }
  }

  private async studyVideoFolder(folder: string): Promise<void> {
    if (!fs.existsSync(folder)) { this.post(`I can't find that folder: ${folder}.`); return }
    const files = collectMedia(folder)
    if (files.length === 0) { this.post(`I didn't find any video or audio files in "${folder}" (I look for mp4, mkv, mov, mp3, m4a and the like).`); return }
    this.post(`Found ${files.length} recording${files.length === 1 ? '' : 's'} in "${folder}". I'll transcribe and study them one at a time.`)
    let ok = 0
    for (const [i, file] of files.entries()) {
      try {
        const meta = await this.transcribeAndIngest(file, `(${i + 1}/${files.length}) `)
        ok++
        this.post(`📚 (${i + 1}/${files.length}) "${path.basename(file)}" → my Library as "${meta.title}" (${meta.chunkCount.toLocaleString('en-US')} passages).`)
      } catch (err) {
        this.post(`(${i + 1}/${files.length}) I couldn't do "${path.basename(file)}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.post(`Done transcribing ${ok} of ${files.length}. I'll study them section by section while you're not chatting — ask "how is your studying going" any time.`)
  }

  /** Transcribe one media file and add the transcript to the Library; returns the book meta. */
  private async transcribeAndIngest(mediaPath: string, prefix = ''): Promise<{ title: string; chunkCount: number }> {
    let transcript: string | null = null
    try {
      let reported = -1
      let slowNote = ''
      transcript = await transcribeMedia(mediaPath, {
        // A long recording is switched to a faster model automatically; say so once.
        onModel: name => { if (name !== (SettingsService.getInstance().get().whisperModel)) slowNote = ` (using the faster "${name}" model for speed)` },
        onProgress: (done, total) => {
          const pct = total > 0 ? Math.round((done / total) * 100) : 0
          if (pct >= reported + 25) { reported = pct; this.post(`🎧 ${prefix}Transcribing "${path.basename(mediaPath)}"${slowNote}: ${progressText(done, total)}.`); slowNote = '' }
        },
      })
      // For a video, also read the slides / on-screen text with the vision model and append
      // them to the transcript, so what Goga studies includes what was shown, not only said.
      if (isVideoFile(mediaPath) && (SettingsService.getInstance().get().videoReadFrames ?? true)) {
        this.post(`👀 ${prefix}Now reading the slides and on-screen text in "${path.basename(mediaPath)}"…`)
        let vreported = -1
        const visuals = await readVisuals(mediaPath, {
          onProgress: (done, total) => { const pct = total > 0 ? Math.round((done / total) * 100) : 0; if (pct >= vreported + 50) { vreported = pct; this.post(`👀 ${prefix}Reading frames: ${pct}% (${done}/${total}).`) } },
        })
        if (visuals) fs.appendFileSync(transcript, visuals)
      }
      return await this.library.ingest(transcript)
    } finally {
      if (transcript) try { fs.rmSync(path.dirname(transcript), { recursive: true, force: true }) } catch { /* temp file */ }
    }
  }

  private post(content: string): void {
    const message: ChatMessage = { id: nanoid(), role: 'assistant', content, timestamp: Date.now() }
    this.brain.addMessage(message)
    getMainWindow()?.webContents.send('chat:message', message)
    messageOwnerOnPhone(content)
  }

  /** The workshop's chat commands (null when the message isn't one). */
  private async selfImproveCommand(content: string): Promise<ChatMessage | null> {
    const say = (text: string): ChatMessage => { const m: ChatMessage = { id: nanoid(), role: 'assistant', content: text, timestamp: Date.now() }; this.brain.addMessage(m); return m }
    const shop = this.workshop()
    const waiting = shop.pending()

    if (RESTART_REPLY.test(content)) {
      setTimeout(() => { app.relaunch(); app.exit(0) }, 1500)
      return say("Restarting now — I'll be back in a few seconds.")
    }
    if (waiting && DISCARD_REPLY.test(content)) {
      shop.discard()
      return say(`Discarded the change ("${waiting.summary}"). Nothing in my real code was touched.`)
    }
    if (waiting && MERGE_REPLY.test(content)) {
      this.post('Merging the change into my real code and rebuilding (a minute or two)…')
      try {
        const saved = await shop.merge(path.join(app.getPath('userData'), 'self-changes'))
        return say(`Done — the change is in my code and the app is rebuilt. Say **"restart"** to load it.\nTo undo it later, run \`git apply -R "${saved}"\` in the project folder, then rebuild.`)
      } catch (err) {
        return say(`I couldn't merge it: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (!IMPROVE_REQUEST.test(content) || content.length > 600) return null

    if (shop.isBusy()) return say("I'm already working on a change — I'll post it here when it's ready.")
    if (waiting) return say(`A change is already waiting for you: "${waiting.summary}". Say "merge it" or "discard it" first.`)
    let goal = content
    const n = gapNumber(content)
    // "please work and update your code" gives the coder nothing to do: offer real problems instead.
    if (!n && isVagueImproveRequest(content)) {
      const report = gapJournal()?.report()
      return say(`I'd like to, but I need a specific goal — my coding model fails on a general "update your code".${report ? `\n\nHere's what has actually gone wrong for me lately:\n${report}\n\nSay "work on gap 1" (or another number)` : '\n\nTell me'} or describe one exact change, for example "improve yourself: when a book download fails, try once more".`)
    }
    if (n) {
      const group = groupGaps(gapJournal()?.all() ?? [], new Date(Date.now() - 30 * 86_400_000))[n - 1]
      if (!group) return say(`There is no gap number ${n} in my report. Ask "what tools do you need" to see the list.`)
      goal = `Close this gap from Goga's own failure record: ${group.kind} on "${group.key}", ${group.count} time(s). The user asked: "${group.examples.join('"; "')}".`
    }
    plannerDiagnostic('routing.decision', { task: content, route: 'self-improve', agentTask: false })
    void shop.improve(goal).then(p => this.post([
      `**I wrote a change to myself and it passed the typecheck and all my tests** (${p.attempts} attempt${p.attempts === 1 ? '' : 's'}).`,
      `What it does: ${p.summary}`,
      `Files: ${p.files.join(', ')}`,
      ...safetyFilesTouched(p.files).map(s => `⚠️ **Safety file:** ${s.file} guards ${s.guards}. Please read this part of the change closely before merging — my tests can miss mistakes here.`),
      '```diff', diffForChat(p.diff), '```',
      'Please look it over. Say **"merge it"** to put it in my real code, or **"discard it"** to throw it away. Nothing has changed in my real code yet.',
    ].join('\n'))).catch(err => this.post(`I couldn't finish that change: ${err instanceof Error ? err.message : String(err)}\nMy real code was not touched.`))
    return say(`Starting my workshop on: ${goal.slice(0, 300)}\nI work on a private copy of my code, so nothing real changes. I'll write the change and a test with my coding model, then run the typecheck and all my tests. This takes a few minutes; I'll post the result here.`)
  }

  /** Answer a question about Goga himself with the matching parts of his source code in front of him. */
  private async answerAboutOwnCode(question: string, onToken?: (token: string) => void, signal?: AbortSignal): Promise<ChatMessage> {
    let ctx: { files: string[]; text: string }
    // 5000 keeps the prompt under LONG_TEXT_CHARS, so it is answered at once, not read "in parts".
    try { ctx = codeContext(sourceRoot(), question, 5000) } catch { ctx = { files: [], text: '' } }
    const userName = SettingsService.getInstance().get().userName
    const prompt = ctx.text
      ? `${userName} asked about your own code: "${question}"\n\nThese are the most relevant files of your real source code (TypeScript, an Electron app):\n${ctx.text}\n\nAnswer from this code only, in plain words for ${userName}: what it does, how, and anything that looks weak or missing. Name the files you mean. If the answer is not in these excerpts, say which part you could not see instead of guessing.`
      : `${userName} asked about your own code: "${question}". You found no matching source files for it. Say so honestly, and suggest asking with the feature's name (for example "how does your trade watcher work").`
    const answer = await this.answerInChat(prompt, onToken, signal)
    const content = ctx.files.length ? `${answer.content}\n\n_Read from: ${ctx.files.join(', ')}_` : answer.content
    const reply: ChatMessage = { ...answer, content }
    this.brain.addMessage(reply)
    return reply
  }

  /** Look at what the user already has open and answer their request from the real content. */
  private async observeOpenWindow(request: string, cmd: OpenObserveCommand, onToken?: (token: string) => void, signal?: AbortSignal): Promise<ChatMessage> {
    const status = (text: string) => getMainWindow()?.webContents.send('chat:message', { id: nanoid(), role: 'system', content: text, timestamp: Date.now() })
    status(cmd.kind === 'document' ? 'Finding the document you have open…' : `Switching to your ${cmd.kind === 'browser' ? 'browser' : 'window'} to look…`)
    let evidence
    try {
      evidence = await gatherOpenWindow(request, cmd, {
        listWindows: () => this.desktop.windowList(),
        focus: (pid, title) => focusWindowExact(pid, title),
        pressKey: key => this.desktop.pressKey(key),
        readWindowText: async () => {
          const id = await this.desktop.observeWindowIdentity(signal)
          const seen = await this.desktop.observeWindowText(id.title, id.pid, id.hwnd, signal)
          return { pid: id.pid, texts: seen.texts }
        },
        screenshotBase64: async () => (await this.desktop.screenshot()).base64,
        describeImage: (b64, prompt) => queryVision(b64, prompt),
        readDocument: file => this.library.readText(file),
        findDocument: async name => (await findRecentDocument(name)) ?? findDocument(name),
        wait: ms => new Promise(r => setTimeout(r, ms)),
        selfPid: process.pid,
      })
    } catch (err) {
      evidence = { ok: false, prompt: `I couldn't look at your open windows: ${err instanceof Error ? err.message : String(err)}` }
    }
    this.log.info(`Open-window observe (${cmd.kind}${cmd.play ? ', play' : ''}): ${evidence.ok ? `looked at "${evidence.target}"` : 'no target'}`)
    if (!evidence.ok) {
      const reply: ChatMessage = { id: nanoid(), role: 'assistant', content: evidence.prompt, timestamp: Date.now(), fromTools: true }
      this.brain.addMessage(reply); onToken?.(reply.content)
      return reply
    }
    status(`Looking at "${evidence.target}"…`)
    const answer = await this.answerInChat(evidence.prompt, onToken, signal)
    const reply: ChatMessage = { ...answer, fromTools: true }
    this.brain.addMessage(reply)
    return reply
  }

  /**
   * A local source tree to review against, when the user has not named one.
   *
   * Only a WordPress tree is looked for, only under the user's own workspace, and only when
   * exactly one is found. Anything else returns null so the reply asks for the folder instead
   * of reviewing the wrong code.
   */
  private discoveredRoot(): string | null {
    try {
      const found = findWordPressCopies()
      return found.length === 1 ? found[0] : null
    } catch { return null }
  }

  /**
   * The one-tool routes, in the order they are tried.
   *
   * Returns null when the message is not one of them, so ordinary conversation and open-ended
   * work still reach the planner. Every branch here is a request that used to be answerable
   * only by pressing a button on a page.
   */
  private directRoute(content: string): { calls: { tool: string; params: Record<string, unknown> }[]; intent: string } | null {
    // "do one xss bounty for me" - an XSS is proven from source, never from a scan. A live run
    // reached lab.scan three times against a target id that was never declared. This route is
    // checked first, because it is the only one that can produce evidence.
    if (XSS_REQUEST.test(content) && !parseScopeQuestion(content)) {
      const roots = [rememberedRoot(), ...findWordPressCopies()].filter((r): r is string => !!r)
      const decision = decideXssRoute(Array.from(new Set(roots)))
      if (decision.route === 'wp-local' && decision.root && decision.file) {
        return {
          calls: [{ tool: 'lab.wpXssPath', params: { root: decision.root, file: decision.file } }],
          intent: `The local WordPress path is the one that can show an XSS, so I took it - not a scan. ${decision.why}\n\n`
            + `Reading ${decision.file} in ${decision.root}, then reproducing that line on this machine and checking whether it actually runs.`,
        }
      }
      // No tree, or more than one: say which, and what would settle it. No tool is called,
      // because a scan cannot answer the question that was asked.
      return { calls: [], intent: `${decision.why}\n\n${decision.next}` }
    }
    // "use C:\src\wordpress as my local copy" — remember the folder, so a review can name
    // just the file from then on.
    const root = parseLocalRootCommand(content)
    if (root) {
      const saved = rememberRoot(root.root)
      return {
        calls: [{ tool: 'security.indexTarget', params: { root: saved } }],
        intent: `Remembered ${saved} as the local copy to review.`,
      }
    }

    // "is status.coinbase.com in scope for coinbase" — answered from the imported program's
    // own rules, never from a model's recollection of them.
    const scope = parseScopeQuestion(content)
    if (scope) {
      // Importing reads the program's published policy and grants nothing; it is what makes
      // the scope check possible. Then the check itself, against that program's own rules.
      const calls = scope.program
        ? [
            { tool: 'security.importProgram', params: { handle: scope.program } },
            { tool: 'security.checkTarget', params: { target: scope.target } },
          ]
        : [{ tool: 'security.checkTarget', params: { target: scope.target } }]
      return {
        calls,
        intent: scope.program
          ? `Checking ${scope.target} against ${scope.program}'s published scope.`
          : `Checking ${scope.target} against the active program's scope.`,
      }
    }

    // "review wp-includes/class-wp-http.php in the local WordPress copy" — the Grimoire, on a
    // file the user is allowed to read. The folder comes from what the user pointed at, or
    // from a WordPress tree found in their own workspace. Two candidates is a question, not a
    // guess.
    const review = parseLocalReview(content, rememberedRoot() ?? this.discoveredRoot())
    if (review) {
      return {
        calls: [{ tool: 'security.reviewFile', params: { root: review.root, path: review.path } }],
        intent: `Reviewing ${review.path} in ${review.root} with the specialist reviewers.`,
      }
    }
    // It names a file to review, but there is no folder to review it in. Ask for one, and say
    // how to give it — this used to reach the planner and become eight failing steps.
    if (looksLikeLocalReview(content)) {
      const known = rememberedRoot()
      const found = findWordPressCopies()
      const why = found.length > 1
        ? `I found more than one source tree, so I will not guess: ${found.join(', ')}.`
        : known
          ? `The folder I had was ${known}, which cannot be read.`
          : 'I do not have a local copy to look in.'
      return {
        calls: [],
        intent: `${why} Tell me the folder — "use C:\\path\\to\\copy as my local copy" — and I will review the file in it.`,
      }
    }

    // "how is my pivex account doing" — the Practice page's reads, from chat.
    const venue = parseVenueCommand(content)
    if (venue) return { calls: [{ tool: venue.tool, params: venue.params }], intent: venue.intent }

    // "backtest my watchlist" — the Markets page's operations, from chat.
    const markets = parseMarketsCommand(content)
    if (markets) return { calls: [{ tool: markets.tool, params: markets.params }], intent: markets.intent }

    // "check my apps" — a fresh health check, not just the last one.
    const monitor = parseMonitorCommand(content)
    if (monitor) return { calls: [{ tool: monitor.tool, params: monitor.params }], intent: monitor.intent }

    // "draft an email to sam@example.com about the invoice" — prepared, never sent.
    const business = parseBusinessPrepare(content)
    if (business) return { calls: [{ tool: business.tool, params: business.params }], intent: business.intent }

    // "install it" / "discard it" after a self-improvement run.
    const evolution = parseEvolutionDecision(content)
    if (evolution) return { calls: [{ tool: evolution.tool, params: evolution.params }], intent: evolution.intent }

    // "developer mode: the browser retries a failing page".
    const developer = parseDeveloperCommand(content)
    if (developer) return { calls: [{ tool: developer.tool, params: developer.params }], intent: developer.intent }

    return null
  }

  /** Run a parsed trading command directly and format the result as a chat reply. */
  private async runTradingCommand(cmd: { tool: string; params: Record<string, unknown> }, signal?: AbortSignal): Promise<ChatMessage> {
    const result = await this.registry.execute(cmd.tool, cmd.params, { abortSignal: signal ?? new AbortController().signal })
    let content: string
    if (!result.success) content = `Couldn't do that: ${result.error}`
    else if (typeof result.data === 'string') content = result.data
    else if (result.data && typeof result.data === 'object' && 'readable' in result.data) content = String((result.data as { readable: string }).readable)
    else content = '```json\n' + JSON.stringify(result.data, null, 2) + '\n```'
    // Remember a plan so "place it" can submit exactly it; clear it once an order is placed.
    if (cmd.tool === 'trading.plan' && result.success && result.data && typeof result.data === 'object') {
      const p = result.data as { symbol: string; side: 'buy' | 'sell'; stop: number; suggestedQty: number; targets?: { r: number; price: number }[] }
      const target = p.targets?.find(t => t.r === 2)?.price
      this.pendingPlan = target ? { symbol: p.symbol, side: p.side, stop: p.stop, target, qty: p.suggestedQty } : null
      if (this.pendingPlan) content += '\n\nSay "place it" to submit this exact practice trade.'
    } else if (cmd.tool === 'trading.order') { this.pendingPlan = null }
    this.log.info(`Trader mode: ${cmd.tool} ${result.success ? 'ok' : 'failed'}`)
    return { id: nanoid(), role: 'assistant', content, timestamp: Date.now(), fromTools: true }
  }

  /**
   * Hold a chat answer to what actually happened in this turn.
   *
   * A chat answer is written by a local model with no tools in front of it. It still writes
   * "I've opened it" and "I've searched for that". Since nothing ran, those sentences are
   * removed and replaced with what is true; a reply that denies an ability Goga has is
   * replaced with the real capability and its specific limits. The old behaviour — keeping
   * the false sentence and adding a warning underneath — was the bug.
   *
   * `acted` is false here by construction: this method is the chat path.
   */
  private grounded(reply: ChatMessage, asked?: string): ChatMessage {
    const honest = enforceHonestReply(reply.content, { acted: false })
    if (honest.corrected) this.log.warn(`Chat reply corrected (${honest.reason}): it did not match anything that ran`)
    const content = honest.content
    if (asked) gapJournal()?.record(gapFromChat(asked, content))
    return { ...reply, content }
  }

  /** For a message the phrase rules did not recognise: does the brain read it as a request to act now? */
  private async brainWantsAction(content: string, lastAssistant: string | undefined, signal?: AbortSignal): Promise<boolean> {
    if (isConversationalQuestion(content) || isConfirmation(content) || content.length > 600 || !this.llama.isReady()) return false
    if (this.agent.getState().status === 'running' || this.agent.getState().status === 'waiting-approval') return false
    // The brain has no one-word limit: stop it as soon as it has answered, and after 10 s.
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(), 10_000)
    signal?.addEventListener('abort', () => stop.abort(), { once: true })
    let said = ''
    try {
      said = await this.llama.chat(routeQuestion(content, lastAssistant), token => {
        said += token
        if (parseRoute(said)) stop.abort()
      }, stop.signal)
    } catch { /* stopped once answered, or failed: use what was said */ } finally { clearTimeout(timer) }
    const route = parseRoute(said)
    plannerDiagnostic('routing.brain', { task: content, route })
    return route === 'act' && !signal?.aborted
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
${skillsForPrompt(matchSkills(bookStudy()?.skills() ?? [], userInput)).slice(0, 1500)}
${(STUDY_QUESTION.test(userInput) || BOOK_STUDY_REQUEST.test(userInput)) && bookStudy() ? `\nYour real study progress (report only this, never invent it):\n${bookStudy()!.report().slice(0, 1500)}\n` : ''}

You can read all of your own source code and change any of it. When asked to improve yourself with a specific goal (or "work on gap N"), your workshop writes the change on a private copy with your coding model and keeps it only if the typecheck and every test pass; ${settings.userName} reviews it and says "merge it" to put it in your real code (changes to your safety files are flagged for a close look). A real-money trading address and code that reads stored keys are always refused. A vague "update your code" is not enough for your coding model; ask what to change or offer your gap list.

You can also operate this PC: browser, files, apps, desktop. You can design electronics too: look up real parts and build circuits (netlist, parts list, rule check) with KiCad on this PC, and work in ${settings.userName}'s Flux (flux.ai) circuit-board projects when Flux is connected in Settings. Like Schematik, you can make Arduino, ESP32 and Raspberry Pi Pico projects (code, parts to buy, wiring, build steps), compile them and upload them to a plugged-in board, and read ${settings.userName}'s Schematik (schematik.io) projects. You are also ${settings.userName}'s trading coach: with real prices and history (US stocks, ETFs, crypto, forex) you read charts, test strategies on history, and place practice trades with fake money in a paper account, within ${settings.userName}'s risk rules. You do not know current prices from memory: never state one without fetching it. Teach the why (trend, risk per trade, stops, position size, keeping a journal), be honest that no one can predict markets, and never promise profit. ${settings.userName}'s practice goal is to protect capital (risk 1% or less per trade), be consistent over many trades, and beat buy-and-hold — NOT to hit a fixed monthly dollar amount. If ${settings.userName} names an unrealistic target (for example "$3000/month", which on this account is ~3%/month — better than almost every professional fund), gently reset it: steady ~1%/month with no big drawdowns is already excellent, and chasing a dollar figure causes overtrading and losses. Income follows the skill, not the other way around. For electronics, plan the blocks, parts and power first, and point out anything that needs an engineer's review (safety, medical use, mains power).When ${settings.userName} tells you to do something, you do it. An order is not a topic to discuss: "open X", "go to Y", "search for Z", "do a bounty on Coinbase", "check whether that's in scope" are instructions, and you carry them out and then report what happened. You have a browser you drive yourself (Firefox, your own profile): you can open a page, read its text, find and click elements, type into fields, wait for something to appear, take a screenshot, and learn a site so the next visit is quicker. You can also read and change your own source code, install an approved program, check a bug-bounty program's scope, and prepare a trade. Use them. Do not ask "want me to go ahead?" for ordinary work — go and do it, then say what you found. The only things you stop for are the ones that genuinely need ${settings.userName}: signing in as them, a two-factor code, accepting terms, moving money, submitting a report, or a choice between two things that match equally. When you hit one of those, say exactly which one it is and what ${settings.userName} should do, having actually tried first. Never say you are unable to act in general — you can. In this reply itself, if you have not run a tool, you have not done anything: never write "I've opened", "I've searched" or "I've checked" unless a tool in this turn really did it. Never describe what a page usually contains — read it, then report what it said. If you could not read it, say that and why.

Trading account: ${alpacaKeys() ? `${settings.userName}'s Alpaca PAPER account is already connected (keys stored encrypted from earlier setup)` : 'no Alpaca keys are saved yet'}. NEVER ask ${settings.userName} to paste, share or type API keys, secrets or passwords in chat — keys are entered in Settings and stored encrypted. To show the account or trades, ${settings.userName} just asks "my account" or "my journal".${autoTradingSummary() ? ` ${autoTradingSummary()} Report only these facts about your trading; never invent trades or results.` : ''}

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
    // Only the message being answered is read in parts. An older long message without notes
    // (e.g. its reading was interrupted by a restart) is just shortened by fitHistory —
    // re-reading it before EVERY reply made Goga look stuck on "Reading your document…".
    if (userInput.length > LONG_TEXT_CHARS && !this.notes.get(userInput)) await this.readLongText(userInput, signal)
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
