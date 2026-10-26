import type { IpcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { BrainService } from '../services/brain'
import { OllamaClient } from '../services/ollamaClient'
import { LocalLlamaService } from '../services/localLlama'
import { SettingsService } from '../services/settings'

const brain = BrainService.getInstance()
const ollama = new OllamaClient()

export function registerBrainHandlers(ipcMain: IpcMain) {
  ipcMain.handle('brain:facts', async () => brain.getFacts())
  ipcMain.handle('brain:deleteFact', async (_e, id: string) => brain.deleteFact(id))
  ipcMain.handle('brain:clearHistory', async () => brain.clearHistory())
  ipcMain.handle('ollama:status', async () => ollama.isAvailable())
  ipcMain.handle('ollama:models', async () => ollama.listModels())
  ipcMain.handle('localModel:status', async () => LocalLlamaService.getInstance().getState())
  // GGUF brain models sitting next to the configured one (vision projectors excluded).
  ipcMain.handle('localModel:list', async () => {
    const dir = path.dirname(SettingsService.getInstance().get().localModelPath)
    try {
      return fs.readdirSync(dir)
        .filter(f => f.toLowerCase().endsWith('.gguf') && !f.toLowerCase().startsWith('mmproj'))
        .map(f => path.join(dir, f))
    } catch { return [] }
  })
}
