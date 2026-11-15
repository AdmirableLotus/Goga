import path from 'path'
import { app } from 'electron'
import { JobsManager } from './manager'
import { JobFileStore } from './store'
import { ToolRegistry } from '../../tools/registry'
import { AuthorizationService } from '../authorization'
import { SettingsService } from '../settings'
import { LogService } from '../logs'
import { LocalLlamaService } from '../localLlama'
import { OllamaClient } from '../ollamaClient'
import { plannerOffers } from '../agentRouting'
import { gogaIdentity } from '../persona'
import { getMainWindow } from '../../index'
import { messageOwnerOnPhone } from '../telegram'
import { BrainService } from '../brain'
import { nanoid } from '../../utils/nanoid'
import type { ChatMessage } from '../../../shared/types'
import type { JobsView } from '../../../shared/jobs'

/**
 * The single JobsManager, wired to the real brain, the real tool registry and the real
 * authorization service.
 *
 * The planner here is the same one the agent loop uses, with the same tool filtering, so a
 * job cannot see a tool the chat path would not offer for that kind of work. The gate is the
 * same AuthorizationService instance, so every guard — the always-ask list, the risk
 * thresholds, the security scope, the broker's own per-order confirmation — still applies.
 */

let manager: JobsManager | null = null

function jobsDir(): string {
  return path.join(app.getPath('userData'), 'jobs')
}

function concurrency(): number {
  const raw = (SettingsService.getInstance().get() as unknown as { jobConcurrency?: number }).jobConcurrency
  return typeof raw === 'number' ? raw : 2
}

/** Tell the user in chat, and on their phone when they have that switched on. */
function tell(text: string, opts?: { alert?: boolean }): void {
  const message: ChatMessage = { id: nanoid(), role: 'assistant', content: text, timestamp: Date.now() }
  try { BrainService.getInstance().addMessage(message) } catch { /* brain not open yet */ }
  getMainWindow()?.webContents.send('chat:message', message)
  if (opts?.alert) messageOwnerOnPhone(text)
}

export function jobs(): JobsManager {
  if (manager) return manager
  const registry = ToolRegistry.getInstance()
  const auth = AuthorizationService.getInstance()
  const log = LogService.getInstance()
  const llama = LocalLlamaService.getInstance()
  const ollama = new OllamaClient()

  manager = new JobsManager({
    store: new JobFileStore(jobsDir()),
    tools: {
      definition: name => {
        const t = registry.get(name)?.definition
        return t ? { name: t.name, riskLevel: t.riskLevel } : null
      },
      decide: (name, params) => {
        const t = registry.get(name)?.definition
        if (!t) return { allowed: false, requiresApproval: false, reason: `there is no tool called "${name}"` }
        return auth.evaluateAndLog(t, params, { mode: 'normal' })
      },
      run: (name, params, signal) => registry.execute(name, params, { abortSignal: signal }),
    },
    plan: async (messages, signal) => {
      const settings = SettingsService.getInstance().get()
      const withIdentity = [
        { role: 'system' as const, content: `${gogaIdentity(settings.userName, settings.personality)}\n\n${messages[0].content}` },
        ...messages.slice(1),
      ]
      if (settings.primaryModel === 'ollama' && await ollama.isAvailable()) {
        return ollama.chatJson(withIdentity, signal, settings.modelName, { num_ctx: 8192, num_predict: 900, temperature: 0.2 })
      }
      if (!llama.isReady()) await llama.waitWhileLoading(60_000, signal)
      if (!llama.isReady()) throw new Error('the local brain is not loaded, so the job cannot plan its next step')
      return llama.chat(withIdentity, undefined, signal)
    },
    // A worker never gets the job tools: a job that could start jobs would multiply itself.
    toolBlock: goal => registry.toPromptSummary(name => !name.startsWith('jobs.') && plannerOffers(goal)(name)),
    notify: (text, opts) => tell(text, opts),
    publish: (view: JobsView) => getMainWindow()?.webContents.send('jobs:update', view),
  }, concurrency())

  log.info('Jobs manager ready')
  return manager
}

/** Start the board: load saved jobs and mark anything that was mid-run as interrupted. */
export function startJobs(): void {
  jobs().start()
}

/** Stop every worker on shutdown, leaving the jobs marked interrupted rather than failed. */
export function stopJobs(): void {
  try { manager?.shutdown('Goga closed') } catch { /* nothing running */ }
}
