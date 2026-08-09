import type { IpcMain } from 'electron'
import { OrchestratorService } from '../services/orchestrator'
import { VoiceOrchestrator } from '../services/voiceOrchestrator'
import type { ChatMessage } from '../../shared/types'
import { nanoid } from '../utils/nanoid'

const orchestrator = new OrchestratorService()

export function registerChatHandlers(ipcMain: IpcMain) {
  ipcMain.handle('chat:send', async (event, message: string): Promise<ChatMessage> => {
    const userMsg: ChatMessage = {
      id: nanoid(),
      role: 'user',
      content: message,
      timestamp: Date.now()
    }
    const onToken = (token: string) => event.sender.send('chat:token', { token })
    const reply = await orchestrator.process(userMsg, onToken)
    // Speak the reply — fire-and-forget so IPC returns immediately
    VoiceOrchestrator.getInstance().speak(reply.content).catch(() => {})
    return reply
  })
}
