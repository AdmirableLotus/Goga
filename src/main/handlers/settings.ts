import type { IpcMain } from 'electron'
import { SettingsService } from '../services/settings'

const settings = SettingsService.getInstance()

export function registerSettingsHandlers(ipcMain: IpcMain) {
  ipcMain.handle('settings:get', async () => settings.get())
  ipcMain.handle('settings:set', async (_e, patch: Record<string, unknown>) => settings.set(patch))
}
