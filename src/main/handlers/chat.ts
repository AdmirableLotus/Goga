import type { IpcMain } from 'electron'
import { OrchestratorService } from '../services/orchestrator'
import { VoiceOrchestrator } from '../services/voiceOrchestrator'
import type { ChatMessage } from '../../shared/types'
import { nanoid } from '../utils/nanoid'

const orchestrator = new OrchestratorService()

export function registerChatHandlers(ipcMain: IpcMain) {
  ipcMain.handle('chat:send', async (event, message: string): Promise<ChatMessage> => {
    const turnId = nanoid()
    const userMsg: ChatMessage = {
      id: nanoid(),
      role: 'user',
      content: message,
      timestamp: Date.now(),
      turnId,
    }
    const onToken = (token: string) => event.sender.send('chat:token', { token, turnId })
    const reply = await orchestrator.process(userMsg, onToken)
    // Stamp the canonical reply with the same turnId before returning
    const stamped: ChatMessage = { ...reply, turnId }
    // Speak the reply — fire-and-forget so IPC returns immediately
    VoiceOrchestrator.getInstance().speak(stamped.content).catch(() => {})
    return stamped
  })
}
