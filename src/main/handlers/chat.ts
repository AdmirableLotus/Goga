import type { IpcMain } from 'electron'
import { OrchestratorService } from '../services/orchestrator'
import { VoiceOrchestrator } from '../services/voiceOrchestrator'
import type { ChatMessage } from '../../shared/types'
import { nanoid } from '../utils/nanoid'
import { validateAttachments } from '../../shared/attachments'

/**
 * Built on first use, not at import time.
 *
 * `agentLoop` imports `../index` for the window handle, and `index` imports this handler, so a
 * module-scope instance here would be constructed while `AgentLoop` is still half-loaded — the
 * circular import then throws on `AgentLoop.getInstance()`. Creating it when the first message
 * arrives means the cycle is already resolved.
 */
let orchestratorInstance: OrchestratorService | null = null
function orchestrator(): OrchestratorService {
  if (!orchestratorInstance) orchestratorInstance = new OrchestratorService()
  return orchestratorInstance
}

export function registerChatHandlers(ipcMain: IpcMain) {
  ipcMain.handle('chat:send', async (event, message: string, attachments?: unknown): Promise<ChatMessage> => {
    if (typeof message !== 'string' || message.length > 100_000) throw new Error('Invalid message.')
    const media = validateAttachments(attachments)
    if (!message.trim() && !media.length) throw new Error('Enter a message or attach media.')
    const turnId = nanoid()
    const userMsg: ChatMessage = {
      id: nanoid(),
      role: 'user',
      content: message,
      timestamp: Date.now(),
      turnId,
      attachments: media,
    }
    // Speech starts with the first finished sentence, while the rest is still being written.
    const speech = VoiceOrchestrator.getInstance().speakReply()
    const onToken = (token: string) => {
      event.sender.send('chat:token', { token, turnId })
      speech.push(token)
    }
    let reply: ChatMessage
    try {
      reply = await orchestrator().process(userMsg, onToken)
    } catch (err) {
      speech.cancel()
      throw err
    }
    // Stamp the canonical reply with the same turnId before returning
    const stamped: ChatMessage = { ...reply, turnId }
    // Finish speaking — fire-and-forget so IPC returns immediately
    speech.finish(stamped.content).catch(() => {})
    return stamped
  })
}
