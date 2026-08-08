import type { IpcMain } from 'electron'
import { MemoryService } from '../services/memory'

const memory = MemoryService.getInstance()

export function registerMemoryHandlers(ipcMain: IpcMain) {
  ipcMain.handle('memory:get', async (_e, key: string) => memory.get(key))
  ipcMain.handle('memory:set', async (_e, key: string, value: unknown) => memory.set(key, value))
  ipcMain.handle('memory:list', async () => memory.list())
  ipcMain.handle('memory:delete', async (_e, key: string) => memory.delete(key))
}
