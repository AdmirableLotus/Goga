import type { IpcMain } from 'electron'
import { LogService } from '../services/logs'

const log = LogService.getInstance()

export function registerLogHandlers(ipcMain: IpcMain) {
  ipcMain.handle('logs:list', async () => log.list())
  ipcMain.handle('logs:clear', async () => log.clear())
}
