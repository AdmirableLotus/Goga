import type { IpcMain } from 'electron'
import { OrchestratorService } from '../services/orchestrator'
import type { ChatMessage } from '../../shared/types'
import { nanoid } from '../utils/nanoid'

const orchestrator = new OrchestratorService()

export function registerChatHandlers(ipcMain: IpcMain) {
  ipcMain.handle('chat:send', async (_event, message: string): Promise<ChatMessage> => {
    const userMsg: ChatMessage = {
      id: nanoid(),
      role: 'user',
      content: message,
      timestamp: Date.now()
    }
    const reply = await orchestrator.process(userMsg)
    return reply
  })
}
