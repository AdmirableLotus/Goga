import type { IpcMain } from 'electron'
import { BrainService } from '../services/brain'
import { OllamaClient } from '../services/ollamaClient'
import { LocalLlamaService } from '../services/localLlama'

const brain = BrainService.getInstance()
const ollama = new OllamaClient()

export function registerBrainHandlers(ipcMain: IpcMain) {
  ipcMain.handle('brain:facts', async () => brain.getFacts())
  ipcMain.handle('brain:deleteFact', async (_e, id: string) => brain.deleteFact(id))
  ipcMain.handle('brain:clearHistory', async () => brain.clearHistory())
  ipcMain.handle('ollama:status', async () => ollama.isAvailable())
  ipcMain.handle('localModel:status', async () => LocalLlamaService.getInstance().getState())
}
