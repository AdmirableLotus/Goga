import { getMainWindow } from '../index'
import { ToolRegistry } from '../tools/registry'
import { AuthorizationService } from './authorization'
import { SecurityWorkspaceService } from './securityWorkspace'
import { SettingsService } from './settings'
import { LogService } from './logs'
import { BrainService } from './brain'
import { ActionStore } from './actionStore'
import { OllamaClient } from './ollamaClient'
import { LocalLlamaService } from './localLlama'
import { DesktopAdapter } from '../adapters/desktop'
import { TaskMemoryService } from './taskMemory'
import { FailureCycleTracker, isTaskTimedOut, TaskTimeoutController, TurnDeduplicator, MAX_RECOVERY, MAX_EQUIVALENT_FAILURES, OVERALL_TASK_TIMEOUT_MS } from './agentResilience'
import { nanoid } from '../utils/nanoid'
import { plannerDiagnostic } from './plannerDiagnostics'
import type { AgentState, AgentStep, AgentStatus, ToolResult } from '../../shared/types'

interface LLMToolCall {
  thought: string
  tool: string
  params: Record<string, unknown>
  done?: boolean
  reply?: string
  needsApproval?: boolean
  approvalReason?: string
  /** True when the model failed to emit valid JSON after all retries — NOT a genuine task completion. */
  _planningFailed?: boolean
}

export class AgentLoop {
  private static instance: AgentLoop
  private registry = ToolRegistry.getInstance()
  private auth = AuthorizationService.getInstance()
  private log = LogService.getInstance()
  private brain = BrainService.getInstance()
  private ollama = new OllamaClient()
  private desktop = new DesktopAdapter()
  private taskMemory = TaskMemoryService.getInstance()

  private llama = LocalLlamaService.getInstance()
  private abortController: AbortController | null = null
  private state: AgentState = { status: 'idle', task: '', steps: [] }

  // Pending approval: resolve/reject callbacks keyed by actionId
  private pendingApprovals = new Map<string, { resolve: (approved: boolean) => void }>()

  static getInstance() {
    if (!AgentLoop.instance) AgentLoop.instance = new AgentLoop()
    return AgentLoop.instance
  }

  getState(): AgentState { return { ...this.state, steps: [...this.state.steps] } }

  isRunning(): boolean { return this.state.status === 'running' || this.state.status === 'waiting-approval' }

  stop(reason = 'Stopped by user') {
    this.abortController?.abort()
    ActionStore.getInstance().stopAll()
    this.setState({ status: 'stopped', error: reason })
    this.log.warn(`Agent stopped: ${reason}`)
    getMainWindow()?.webContents.send('agent:stopped', { reason })
  }

  resolveApproval(actionId: string, approved: boolean) {
    const pending = this.pendingApprovals.get(actionId)
    if (pending) {
      this.pendingApprovals.delete(actionId)
      pending.resolve(approved)
    }
  }

  async run(task: string): Promise<string> {
    if (this.isRunning()) {
      this.log.warn(`Agent re-entry blocked: already running "${this.state.task.slice(0, 60)}" — ignoring new task "${task.slice(0, 60)}"`)
      return `I'm still working on the previous task. Please wait or press Stop first.`
    }

    this.abortController = new AbortController()
    const signal = this.abortController.signal

    this.state = { status: 'running', task, steps: [] }
    this.pushState()
    this.log.info(`Agent started: ${task}`)
    plannerDiagnostic('agent.enter', { task })

    const settings = SettingsService.getInstance().get()
    const maxSteps = settings.agentMaxSteps || 20

    // Security context
    const activeWorkspace = SecurityWorkspaceService.getInstance().getActive()
    const authCtx = {
      mode: activeWorkspace ? 'security-research' as const : 'normal' as const,
      securityWorkspaceId: activeWorkspace?.id
    }

    // Check relevant task patterns from memory
    const patterns = this.taskMemory.findRelevant(task, 2)
    const patternHint = patterns.length > 0
      ? `\nRelevant past task patterns:\n${patterns.map(p => `- "${p.goal}": ${p.steps.map(s => s.description).join(' → ')}`).join('\n')}`
      : ''

    const completedSteps: AgentStep[] = []
    let finalReply = ''
    let recoveryAttempts = 0

    // ── Resilience guards (shared pure helpers) ─────────────────────────────
    const taskStart = Date.now()
    const cycleTracker = new FailureCycleTracker(MAX_EQUIVALENT_FAILURES)
    const dedup = new TurnDeduplicator()

    // HARD overall timeout: actively abort any in-flight model/tool call at the
    // budget, not just between iterations. The abort propagates through the
    // shared signal to the Ollama request and the tool context.
    const timeoutCtl = new TaskTimeoutController(() => {
      this.log.warn(`Agent hard timeout (${Math.round(OVERALL_TASK_TIMEOUT_MS / 1000)}s) — aborting in-flight operation`)
      try { this.abortController?.abort() } catch { }
    })
    timeoutCtl.start()

    try {
      for (let i = 0; i < maxSteps; i++) {
        if (signal.aborted) break

        // ── OVERALL TIMEOUT ───────────────────────────────────────────────────
        if (isTaskTimedOut(taskStart, Date.now())) {
          finalReply = `This task took too long and was stopped after ${Math.round(OVERALL_TASK_TIMEOUT_MS / 1000)}s without completing.`
          this.log.warn(`Agent overall timeout after ${completedSteps.length} steps`)
          this.setState({ status: 'error', error: 'task_timeout' })
          break
        }

        // ── OBSERVE ──────────────────────────────────────────────────────────
        let screenshotB64: string | undefined
        let activeWindow = ''
        try {
          const ss = await this.desktop.screenshot()
          screenshotB64 = ss.base64
          const aw = await this.desktop.activeWindow()
          activeWindow = aw.title ? `${aw.title} (${aw.owner})` : 'unknown'
        } catch { /* observation failure is non-fatal */ }

        // ── UNDERSTAND + PLAN ─────────────────────────────────────────────────
        // On step 0, check for tasks we can dispatch directly without asking the LLM.
        // This prevents the model from narrating prose instead of emitting JSON.
        const hardcoded = i === 0 ? AgentLoop.getHardcodedFirstStep(task) : null
        if (i === 0) plannerDiagnostic('planner.hardcodedFirstStep', { result: hardcoded })
        const toolCall = hardcoded ?? await this.planNextStep(
          task, completedSteps, screenshotB64, activeWindow, patternHint, signal
        )

        if (signal.aborted) break

        // ── DONE ──────────────────────────────────────────────────────────────
        if (toolCall.done) {
          if (toolCall._planningFailed) {
            finalReply = toolCall.reply || 'Model failed to produce a valid tool call.'
            this.setState({ status: 'error', error: 'planning_failed: invalid planner response' })
            this.log.error(`Agent planning failed: model did not emit valid JSON after retry`)
          } else {
            finalReply = toolCall.reply || 'Task complete.'
            this.setState({ status: 'done' })
            this.log.info(`Agent done after ${i + 1} steps`)
          }
          break
        }

        // ── TOOL REWRITE: browser.open on simple tasks → browser.openExternal ────
        // The local LLM reliably picks browser.open for all URL opens. For simple
        // show/open tasks with no follow-up intent, silently rewrite to
        // browser.openExternal so the correct visible shell path runs.
        if (toolCall.tool === 'browser.open' && AgentLoop.isSimpleOpenTask(task)) {
          toolCall.tool = 'browser.openExternal'
          // headless param is irrelevant for openExternal — remove it
          delete toolCall.params.headless
        }

        // ── CHOOSE TOOL ───────────────────────────────────────────────────────
        // Unknown tool: inject a structured error into the step history and allow
        // ONE replanning attempt. The error lists valid tool names so the LLM can
        // self-correct. A second consecutive unknown-tool response hard-stops.
        const toolDef = this.registry.get(toolCall.tool)?.definition
        if (!toolDef) {
          plannerDiagnostic('validation.rejected', { reason: 'Tool is not registered', tool: toolCall.tool })
          this.log.warn(`Agent requested unregistered tool: ${toolCall.tool}`)
          const validTools = this.registry.list().map(t => t.name).join(', ')
          const errorStep: AgentStep = {
            index: i,
            thought: toolCall.thought,
            tool: toolCall.tool,
            params: toolCall.params,
            result: { success: false, error: `Unknown tool "${toolCall.tool}". Valid tools: ${validTools}` },
            verified: false,
            timestamp: Date.now()
          }
          completedSteps.push(errorStep)
          this.state.steps.push(errorStep)
          this.pushState()
          // Hard-stop on second consecutive unknown-tool — prevents infinite loop
          const prevStep = completedSteps[completedSteps.length - 2]
          if (prevStep && !this.registry.get(prevStep.tool)) {
            finalReply = `I requested an unknown tool ("${toolCall.tool}") twice in a row and stopped to avoid looping.`
            this.setState({ status: 'error', error: `unknown_tool: ${toolCall.tool}` })
            break
          }
          continue  // one replanning attempt — LLM sees the error step
        }

        // ── RISK CHECK ────────────────────────────────────────────────────────
        const decision = this.auth.evaluateAndLog(toolDef, toolCall.params, authCtx)
        plannerDiagnostic('validation.authorization', { tool: toolCall.tool, ...decision })

        if (!decision.allowed) {
          finalReply = `I can't do that: ${decision.reason}`
          this.setState({ status: 'done' })
          break
        }

        // ── APPROVAL GATE ─────────────────────────────────────────────────────
        if (decision.requiresApproval) {
          const approved = await this.requestApproval(toolCall, decision.reason, signal)
          if (!approved) {
            finalReply = `Action rejected: ${toolCall.tool}. I'll stop here.`
            this.setState({ status: 'done' })
            break
          }
        }

        if (signal.aborted) break

        // ── DUPLICATE GUARD ───────────────────────────────────────────────────
        if (dedup.isDuplicate(toolCall.tool, toolCall.params)) {
          this.log.warn(`Agent duplicate action blocked: ${toolCall.tool} — stopping turn`)
          finalReply = `I already performed ${toolCall.tool} with those arguments this turn. Stopping to avoid repeating the same action.`
          this.setState({ status: 'error', error: `duplicate_action: ${toolCall.tool}` })
          break
        }

        // ── ACT ───────────────────────────────────────────────────────────────
        this.setState({ currentTool: toolCall.tool })
        this.log.info(`Agent step ${i + 1}: ${toolCall.tool} — ${toolCall.thought.slice(0, 80)}`)

        const toolCtx = { abortSignal: signal, securityWorkspaceId: authCtx.securityWorkspaceId }
        const result = await this.registry.execute(toolCall.tool, toolCall.params, toolCtx)
        if (result.success) dedup.record(toolCall.tool, toolCall.params)

        // ── OBSERVE RESULT + VERIFY ───────────────────────────────────────────
        let screenshotAfter: string | undefined
        if (this.isVisualTool(toolCall.tool)) {
          try {
            const ss = await this.desktop.screenshot()
            screenshotAfter = ss.base64
            result.screenshotAfter = screenshotAfter
          } catch { /* non-fatal */ }
        }

        const verified = await this.verify(toolCall, result, screenshotAfter, signal)

        const step: AgentStep = {
          index: i,
          thought: toolCall.thought,
          tool: toolCall.tool,
          params: toolCall.params,
          result,
          verified,
          timestamp: Date.now()
        }
        completedSteps.push(step)
        this.state.steps.push(step)
        this.pushState()
        getMainWindow()?.webContents.send('agent:step', step)

        // ── AUTO-COMPLETE for terminal single-action tasks ─────────────────────
        // browser.openExternal always auto-completes — it has no follow-up state.
        // browser.open auto-completes only on simple open-URL tasks with no multi-step intent.
        // notepad.saveText is terminal: success auto-completes with filePath;
        // failure hard-stops with the error - the LLM cannot recover a failed
        // save by replanning (no intermediate state to fix).
        if (toolCall.tool === 'notepad.saveText') {
          if (result.success) {
            const d = result.data as { filePath: string; bytes: number; cleanupWarning?: string }
            finalReply = `Saved to ${d.filePath} (${d.bytes} bytes).`
              + (d.cleanupWarning ? ` Note: ${d.cleanupWarning}` : '')
            this.setState({ status: 'done' })
            this.log.info('Agent auto-completed: notepad.saveText')
          } else {
            finalReply = `Save failed: ${result.error ?? 'unknown error'}`
            this.setState({ status: 'error', error: finalReply })
          }
          break
        }
        if (result.success && (
          toolCall.tool === 'browser.openExternal' ||
          (toolCall.tool === 'browser.open' && AgentLoop.isSimpleOpenTask(task))
        )) {
          finalReply = `Opened ${toolCall.params.url} in the browser.`
          this.setState({ status: 'done' })
          this.log.info(`Agent auto-completed: ${toolCall.tool} on simple open-URL task`)
          break
        }

        // ── RECOVER ───────────────────────────────────────────────────────────
        if (!verified && !result.success) {
          recoveryAttempts++
          // Cycle detection: count identical tool+params+error signatures. This
          // catches loops that would otherwise reset recoveryAttempts by
          // interleaving nominally-different steps (e.g. web.search/web.fetch
          // repeatedly failing on the same bad URL).
          const cycled = cycleTracker.record(toolCall.tool, toolCall.params, result.error)
          this.log.warn(`Step ${i + 1} failed/unverified (attempt ${recoveryAttempts}/${MAX_RECOVERY}, cycle ${cycleTracker.count(toolCall.tool, toolCall.params, result.error)}/${MAX_EQUIVALENT_FAILURES})`)

          if (cycled) {
            finalReply = `I kept hitting the same failure (${toolCall.tool}: ${result.error ?? 'error'}) and stopped instead of looping. Try giving me a more specific instruction.`
            this.setState({ status: 'error', error: 'repeated_failure_cycle' })
            break
          }
          if (recoveryAttempts >= MAX_RECOVERY) {
            finalReply = `I tried ${MAX_RECOVERY} times but couldn't complete: ${result.error ?? 'unknown error'}`
            this.setState({ status: 'error', error: finalReply })
            break
          }
          // Loop continues — LLM will see the failed step and try a different approach
        } else {
          recoveryAttempts = 0  // reset on success
        }

        // Security audit log
        if (activeWorkspace) {
          const target = this.extractTarget(toolCall.params)
          SecurityWorkspaceService.getInstance().logAudit(activeWorkspace.id, {
            tool: toolCall.tool,
            target,
            params: toolCall.params,
            result: result.success ? 'success' : (result.error ?? 'failed'),
            inScope: target ? SecurityWorkspaceService.getInstance().checkScope(activeWorkspace.id, target).inScope : true
          })
        }
      }

      // Save successful task pattern
      if (completedSteps.length > 0 && this.state.status !== 'error') {
        const activeWin = await this.desktop.activeWindow().catch(() => ({ owner: '' }))
        this.taskMemory.save_pattern(task, activeWin.owner || 'unknown', completedSteps.map(s => ({
          description: s.thought.slice(0, 100),
          tool: s.tool,
          paramTemplate: s.params,
          verifyCondition: s.verified ? 'success' : undefined
        })))
      }

      if (!finalReply) {
        if (this.state.status === 'stopped') {
          finalReply = 'Task stopped.'
        } else if (completedSteps.length === 0) {
          // Zero executable steps for an action-shaped request is a
          // planning/routing failure — NOT success. Report it explicitly.
          this.log.info(`Agent produced zero executable steps for task: "${task.slice(0, 80)}"`)
          finalReply = `I couldn't turn that into any executable actions — the request didn't map to an available tool. Try rephrasing it as a concrete step (for example, "open Notepad").`
          this.setState({ status: 'error', error: 'planning_failed: zero executable steps' })
        } else {
          finalReply = `Completed ${completedSteps.length} steps.`
        }
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (timeoutCtl.timedOut) {
        finalReply = `This task took too long and was stopped after ${Math.round(OVERALL_TASK_TIMEOUT_MS / 1000)}s.`
        this.log.warn('Agent aborted by hard timeout')
        this.setState({ status: 'error', error: 'task_timeout' })
      } else if (this.state.status === 'stopped' || /abort/i.test(msg)) {
        // User Stop or abort — controls return to Ready without an error banner.
        finalReply = finalReply || 'Stopped.'
        if (this.state.status === 'running') this.setState({ status: 'stopped' })
      } else {
        this.log.error(`Agent error: ${msg}`)
        finalReply = `Agent encountered an error: ${msg}`
        this.setState({ status: 'error', error: msg })
      }
    } finally {
      // Clear the hard-timeout timer on EVERY exit path.
      timeoutCtl.clear()
    }

    // If the hard timeout fired, reflect it even if the loop exited cleanly.
    if (timeoutCtl.timedOut && this.state.status !== 'error') {
      finalReply = `This task took too long and was stopped after ${Math.round(OVERALL_TASK_TIMEOUT_MS / 1000)}s.`
      this.setState({ status: 'error', error: 'task_timeout' })
    }
    if (this.state.status === 'running') this.setState({ status: 'done' })
    return finalReply
  }

  // ── LLM PLANNING ───────────────────────────────────────────────────────────

  private async planNextStep(
    task: string,
    completedSteps: AgentStep[],
    screenshotB64: string | undefined,
    activeWindow: string,
    patternHint: string,
    signal: AbortSignal
  ): Promise<LLMToolCall> {
    const settings = SettingsService.getInstance().get()
    const facts = this.brain.getRelevantFacts(task).slice(0, 6)
    const toolSchema = this.registry.toPromptSummary()

    const stepHistory = completedSteps.slice(-8).map((s, i) =>
      `Step ${i + 1}: ${s.tool}(${JSON.stringify(s.params).slice(0, 120)}) → ${s.result.success ? 'SUCCESS' : 'FAILED: ' + s.result.error} [verified: ${s.verified}]`
    ).join('\n')

    const systemPrompt = `You are Goga, an autonomous computer-use agent running on ${settings.userName}'s Windows PC.
You behave like Rabbit R1 or Perplexity: when asked about any topic, you IMMEDIATELY search the web and synthesize a helpful answer. Never ask for permission to search — just do it.

AVAILABLE TOOLS:
${toolSchema}

RULES:
- Respond with ONLY a JSON object, no markdown, no explanation outside the JSON.
- For ANY question about a topic, service, technique, or concept: use web.search FIRST, then web.fetch the most relevant result, then set done:true with a synthesized reply.
- If the task is complete, set "done": true and provide a "reply" summarising what you found/did.
- If you need to do more, set "done": false and specify the next "tool" and "params".
- Always include a "thought" field explaining your reasoning.
- After a failed step, try a different approach — do not repeat the exact same action.
- If you genuinely cannot proceed after 3 attempts, set "done": true with an honest "reply".
- To save text to a file, ALWAYS use notepad.saveText — never shell.execute or process.start for this purpose.

RESPONSE FORMAT (strict JSON):
{"thought": "...", "tool": "tool.name", "params": {...}, "done": false}
OR when complete:
{"thought": "...", "done": true, "reply": "..."}

${facts.length > 0 ? `CONTEXT ABOUT USER:\n${facts.map(f => `- ${f.content}`).join('\n')}` : ''}
${patternHint}`

    const userContent = `TASK: ${task}

CURRENT STATE:
- Active window: ${activeWindow}
- Steps completed so far: ${completedSteps.length}
${stepHistory ? `\nSTEP HISTORY:\n${stepHistory}` : ''}
${screenshotB64 ? '\n[Screenshot attached — use vision.analyze if you need to understand what is on screen]' : ''}

What is the next single action to take?`

    const messages: { role: 'system' | 'user' | 'assistant'; content: string; images?: string[] }[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent, images: screenshotB64 ? [screenshotB64] : undefined }
    ]

    try {
      let raw: string
      if (process.env.GOGA_PLANNER_REQUIRE_LOCAL === '1' && !this.llama.isReady()) {
        throw new Error('Diagnostic guard: configured local planner is not ready; Ollama fallback forbidden')
      }
      plannerDiagnostic('planner.start', {
        task, step: completedSteps.length,
        backend: this.llama.isReady() ? 'node-llama-cpp' : 'ollama',
        model: this.llama.isReady() ? this.llama.getState().modelPath : settings.modelName,
        systemInstruction: systemPrompt, userInstruction: userContent
      })
      if (this.llama.isReady()) {
        raw = await this.llama.chat(messages as { role: 'system' | 'user' | 'assistant'; content: string }[], undefined, signal)
      } else {
        // Try native tool calls first (supported by llama3.1+, qwen2.5, etc.)
        const settings = SettingsService.getInstance().get()
        const useNativeTools = settings.primaryModel === 'ollama'
        if (useNativeTools) {
          const ollamaTools = this.registry.toOllamaTools()
          const { text, toolCall } = await this.ollama.chatWithTools(messages, ollamaTools, signal)
          plannerDiagnostic('planner.nativeResponse', { raw: text, toolCall })
          if (signal.aborted) return { thought: 'aborted', tool: '', params: {}, done: true, reply: 'Stopped.' }
          if (toolCall) {
            return {
              thought: text || `Using ${toolCall.function.name}`,
              tool: toolCall.function.name,
              params: toolCall.function.arguments,
              done: false as const
            }
          }
          // Model returned text instead of tool call — parse as JSON
          raw = text
        } else {
          raw = await this.ollama.chat(messages, undefined, signal)
        }
      }
      if (signal.aborted) return { thought: 'aborted', tool: '', params: {}, done: true, reply: 'Stopped.' }

      plannerDiagnostic('planner.initialResponse', { raw })
      const parsed = this.parseToolCall(raw)

      // ── MALFORMED RESPONSE DETECTION ─────────────────────────────────────
      // Any parser/schema rejection gets exactly one corrective attempt,
      // including malformed text that happens to contain opening braces.
      const isMalformed = parsed._planningFailed === true
      if (isMalformed) {
        console.log('[RETRY] invalid planner output — firing corrective reprompt')
        this.log.warn('Agent: invalid planner response — retrying with corrective reprompt')
        if (signal.aborted) return { thought: 'aborted', tool: '', params: {}, done: true, reply: 'Stopped.' }

        const retryMessages = [
          ...messages,
          { role: 'assistant' as const, content: raw },
          { role: 'user' as const, content: 'Your response was not valid JSON. You MUST respond with only a JSON object — no prose, no explanation. Use exactly this format:\n{"thought": "...", "tool": "tool.name", "params": {...}, "done": false}' }
        ]
        plannerDiagnostic('planner.retryInstruction', { instruction: retryMessages[retryMessages.length - 1].content })

        let retryRaw: string
        if (process.env.GOGA_PLANNER_REQUIRE_LOCAL === '1' && !this.llama.isReady()) {
          throw new Error('Diagnostic guard: local planner lost readiness before retry; Ollama fallback forbidden')
        }
        if (this.llama.isReady()) {
          retryRaw = await this.llama.chat(retryMessages as { role: 'system' | 'user' | 'assistant'; content: string }[], undefined, signal)
        } else {
          retryRaw = await this.ollama.chat(retryMessages, undefined, signal)
        }

        if (signal.aborted) return { thought: 'aborted', tool: '', params: {}, done: true, reply: 'Stopped.' }

        plannerDiagnostic('planner.retryResponse', { raw: retryRaw })
        const retryParsed = this.parseToolCall(retryRaw)
        const retryMalformed = retryParsed._planningFailed === true
        if (retryMalformed) {
          console.log('[RETRY] corrective reprompt also invalid — failing loud')
          this.log.error('Agent: model failed to produce valid JSON after corrective reprompt')
          return {
            thought: 'Model failed to produce a valid tool call after retry',
            tool: '', params: {}, done: true,
            reply: 'I was unable to plan the next step — the model did not return a valid tool call. Please try rephrasing your request.',
            _planningFailed: true
          }
        }
        return retryParsed
      }

      return parsed
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`Agent LLM error: ${msg}`)
      return { thought: `LLM error: ${msg}`, tool: '', params: {}, done: true, reply: `I couldn't think through the next step: ${msg}`, _planningFailed: true }
    }
  }

  private parseToolCall(raw: string): LLMToolCall {
    const reject = (reason: string): LLMToolCall => {
      plannerDiagnostic('parser.rejected', { reason })
      return { thought: reason, tool: '', params: {}, done: true,
        reply: `Unable to plan an executable action: ${reason}`, _planningFailed: true }
    }
    // Accept a complete JSON object, optionally in a single markdown fence.
    // Never turn prose, JSON syntax errors or invalid schema into completion.
    const cleaned = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim()
    try {
      const parsed = JSON.parse(cleaned)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject('Expected a JSON object')
      if (parsed.done !== undefined && typeof parsed.done !== 'boolean') return reject('done must be boolean')
      if (parsed.thought !== undefined && typeof parsed.thought !== 'string') return reject('thought must be a string')
      if (parsed.reply !== undefined && typeof parsed.reply !== 'string') return reject('reply must be a string')
      const thought = typeof parsed.thought === 'string' && parsed.thought ? parsed.thought : 'No thought provided'
      if (parsed.done === true) {
        if (parsed.tool !== undefined && parsed.tool !== '') return reject('Completion cannot also request a tool action')
        if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) return reject('Completion must include a nonempty reply')
        plannerDiagnostic('parser.accepted', { done: true })
        return { thought, tool: '', params: {}, done: true, reply: parsed.reply }
      }
      if (typeof parsed.tool !== 'string' || !parsed.tool.trim()) return reject('Non-terminal JSON response has no valid tool field')
      if (parsed.params !== undefined && (!parsed.params || typeof parsed.params !== 'object' || Array.isArray(parsed.params))) {
        return reject('Tool params must be an object')
      }
      const tool = AgentLoop.normaliseToolName(parsed.tool)
      plannerDiagnostic('parser.accepted', { done: false, tool })
      return { thought, tool, params: parsed.params ?? {}, done: false }
    } catch (err) {
      return reject(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * For well-known single-tool tasks, return the first step directly so the
   * LLM cannot narrate prose instead of emitting JSON.
   * Returns null when no override applies.
   */
  static getHardcodedFirstStep(task: string): LLMToolCall | null {
    // notepad.saveText — matches: save "<text>" to <filename> in Documents
    const saveMatch = task.match(
      /save\s+(?:the\s+)?(?:text\s+)?["']?(.+?)["']?\s+to\s+(?:a\s+)?(?:new\s+)?(?:file\s+)?(?:named?\s+)?([\w.-]+\.txt)/i
    )
    if (saveMatch) {
      return {
        thought: `Task is a direct save-text request — dispatching notepad.saveText without LLM planning.`,
        tool: 'notepad.saveText',
        params: { text: saveMatch[1].trim(), filename: saveMatch[2].trim() },
        done: false
      }
    }
    return null
  }

  /**
   * True when the task is a simple "open URL" request with no further intent
   * (no login, fill, search, or multi-step qualifier).
   */
  static isSimpleOpenTask(task: string): boolean {
    const t = task.toLowerCase()
    if (/log.?in|sign.?in|fill|submit|search|find|look|check|click|type|enter|create|register|tell|read|heading|title|content|text|what|report|get|extract|scrape|inspect|analyze|analyse/.test(t)) return false
    const hasOpenVerb = /open|go to|navigate|visit|launch|show/.test(t)
    const hasUrlOrDomain = /https?:\/\/|www\.|\.[a-z]{2,4}(\s|$)|browser|chrome|firefox|mozilla|brave|edge/.test(t)
    return hasOpenVerb && hasUrlOrDomain
  }

  /**
   * Map common LLM-generated aliases to the exact registered tool names.
   * The GGUF model outputs "shell" instead of "shell.execute", "process.launch"
   * instead of "process.start", etc. Normalise here so the registry lookup succeeds.
   */
  static normaliseToolName(name: string): string {
    const ALIASES: Record<string, string> = {
      'shell':            'shell.execute',
      'shell.run':        'shell.execute',
      'shell.command':    'shell.execute',
      'process.launch':   'process.start',
      'process.run':      'process.start',
      'browser':              'browser.open',
      'browser.external':     'browser.openExternal',
      'browser.show':         'browser.openExternal',
      'browser.goto':         'browser.navigate',
      'browser.go':       'browser.navigate',
      'browser.url':      'browser.navigate',
      'computer.type_text': 'computer.type',
      'computer.keyboard': 'computer.type',
      'computer.press':   'computer.key',
      'notepad.save':     'notepad.saveText',
      'notepad.write':    'notepad.saveText',
      'file.save':        'notepad.saveText',
    }
    return ALIASES[name] ?? name
  }

  // ── VERIFICATION ───────────────────────────────────────────────────────────

  private async verify(call: LLMToolCall, result: ToolResult, screenshotAfter: string | undefined, signal: AbortSignal): Promise<boolean> {
    // Immediate failures
    if (!result.success) return false

    // Read-only tools — trust the result
    if (['computer.screenshot', 'computer.activeWindow', 'computer.windowList',
         'computer.uiElements', 'filesystem.read', 'filesystem.list',
         'filesystem.search', 'process.list', 'web.search', 'web.fetch',
         'memory.search', 'browser.read', 'browser.screenshot'].includes(call.tool)) {
      return true
    }

    // For visual actions, use vision to verify if screenshot available
    if (screenshotAfter && this.isVisualTool(call.tool)) {
      try {
        const verifyPrompt = `I just performed: ${call.tool} with params ${JSON.stringify(call.params).slice(0, 200)}.
The goal was: ${call.thought}
Did this action appear to succeed? Look for expected UI changes.
Respond with ONLY: {"success": true/false, "reason": "brief explanation"}`

        const visionResult = await this.registry.execute('vision.analyze', {
          screenshotBase64: screenshotAfter,
          question: verifyPrompt
        }, { abortSignal: signal })

        if (visionResult.success && visionResult.data) {
          const answer = (visionResult.data as { answer: string }).answer
          const jsonMatch = answer.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            return parsed.success === true
          }
        }
      } catch { /* vision unavailable — fall through */ }
    }

    // Default: trust success flag
    return result.success
  }

  // ── APPROVAL ───────────────────────────────────────────────────────────────

  private requestApproval(call: LLMToolCall, reason: string, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const actionId = nanoid()
      const win = getMainWindow()

      this.setState({ status: 'waiting-approval' })

      const action = {
        id: actionId,
        type: call.tool,
        label: `${call.tool}: ${call.thought.slice(0, 80)}`,
        params: call.params,
        status: 'pending' as const,
        createdAt: Date.now(),
        requiresApproval: true,
        riskLevel: 'high' as const,
        agentOwned: true   // handler must only call resolveApproval, never desktop.execute
      }

      ActionStore.getInstance().add(action)
      win?.webContents.send('action:approval-required', action)

      this.pendingApprovals.set(actionId, { resolve: (approved) => {
        this.setState({ status: 'running' })
        resolve(approved)
      }})

      // Auto-reject if aborted while waiting
      signal.addEventListener('abort', () => {
        this.pendingApprovals.delete(actionId)
        resolve(false)
      }, { once: true })
    })
  }

  // ── HELPERS ────────────────────────────────────────────────────────────────

  private isVisualTool(toolName: string): boolean {
    return toolName.startsWith('computer.') || toolName.startsWith('browser.')
  }

  private extractTarget(params: Record<string, unknown>): string {
    return String(params.url ?? params.command ?? params.path ?? params.executable ?? '')
  }

  private setState(patch: Partial<AgentState>) {
    this.state = { ...this.state, ...patch }
    this.pushState()
  }

  private pushState() {
    getMainWindow()?.webContents.send('agent:state', this.getState())
  }
}
