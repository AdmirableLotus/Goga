import { getMainWindow } from '../index'
import { ToolRegistry } from '../tools/registry'
import { AuthorizationService } from './authorization'
import { SecurityWorkspaceService } from './securityWorkspace'
import { SettingsService } from './settings'
import { LogService } from './logs'
import { BrainService } from './brain'
import { ActionStore } from './actionStore'
import { OllamaClient } from './ollamaClient'
import { DesktopAdapter } from '../adapters/desktop'
import { TaskMemoryService } from './taskMemory'
import { nanoid } from '../utils/nanoid'
import type { AgentState, AgentStep, AgentStatus, ToolResult } from '../../shared/types'

interface LLMToolCall {
  thought: string
  tool: string
  params: Record<string, unknown>
  done?: boolean
  reply?: string
  needsApproval?: boolean
  approvalReason?: string
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
      this.stop('New task started')
    }

    this.abortController = new AbortController()
    const signal = this.abortController.signal

    this.state = { status: 'running', task, steps: [] }
    this.pushState()
    this.log.info(`Agent started: ${task}`)

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
    const MAX_RECOVERY = 3

    try {
      for (let i = 0; i < maxSteps; i++) {
        if (signal.aborted) break

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
        const toolCall = await this.planNextStep(
          task, completedSteps, screenshotB64, activeWindow, patternHint, signal
        )

        if (signal.aborted) break

        // ── DONE ──────────────────────────────────────────────────────────────
        if (toolCall.done) {
          finalReply = toolCall.reply ?? 'Task complete.'
          this.setState({ status: 'done' })
          this.log.info(`Agent done after ${i + 1} steps`)
          break
        }

        // ── CHOOSE TOOL ───────────────────────────────────────────────────────
        const toolDef = this.registry.get(toolCall.tool)?.definition
        if (!toolDef) {
          this.log.warn(`Agent requested unknown tool: ${toolCall.tool}`)
          recoveryAttempts++
          if (recoveryAttempts >= MAX_RECOVERY) {
            finalReply = `I couldn't find the right tool to complete this task (unknown: ${toolCall.tool}).`
            this.setState({ status: 'error', error: finalReply })
            break
          }
          continue
        }

        // ── RISK CHECK ────────────────────────────────────────────────────────
        const decision = this.auth.evaluateAndLog(toolDef, toolCall.params, authCtx)

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

        // ── ACT ───────────────────────────────────────────────────────────────
        this.setState({ currentTool: toolCall.tool })
        this.log.info(`Agent step ${i + 1}: ${toolCall.tool} — ${toolCall.thought.slice(0, 80)}`)

        const toolCtx = { abortSignal: signal, securityWorkspaceId: authCtx.securityWorkspaceId }
        const result = await this.registry.execute(toolCall.tool, toolCall.params, toolCtx)

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

        // ── RECOVER ───────────────────────────────────────────────────────────
        if (!verified && !result.success) {
          recoveryAttempts++
          this.log.warn(`Step ${i + 1} failed/unverified (attempt ${recoveryAttempts}/${MAX_RECOVERY})`)
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
        finalReply = this.state.status === 'stopped'
          ? 'Task stopped.'
          : `Completed ${completedSteps.length} steps.`
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`Agent error: ${msg}`)
      finalReply = `Agent encountered an error: ${msg}`
      this.setState({ status: 'error', error: msg })
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
      const raw = await this.ollama.chat(messages)
      if (signal.aborted) return { thought: 'aborted', tool: '', params: {}, done: true, reply: 'Stopped.' }
      return this.parseToolCall(raw)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`Agent LLM error: ${msg}`)
      return { thought: `LLM error: ${msg}`, tool: '', params: {}, done: true, reply: `I couldn't think through the next step: ${msg}` }
    }
  }

  private parseToolCall(raw: string): LLMToolCall {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    // Find the first JSON object
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) {
      return { thought: 'Could not parse LLM response', tool: '', params: {}, done: true, reply: raw.slice(0, 300) }
    }
    try {
      const parsed = JSON.parse(match[0]) as LLMToolCall
      if (!parsed.thought) parsed.thought = 'No thought provided'
      if (parsed.done) return parsed
      if (!parsed.tool) return { ...parsed, done: true, reply: parsed.reply ?? 'No tool specified' }
      if (!parsed.params) parsed.params = {}
      return parsed
    } catch {
      return { thought: 'JSON parse failed', tool: '', params: {}, done: true, reply: raw.slice(0, 300) }
    }
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
        riskLevel: 'high' as const
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
