import type { IpcMain } from 'electron'
import { SettingsService } from '../services/settings'
import { VoiceOrchestrator } from '../services/voiceOrchestrator'

const settings = SettingsService.getInstance()

export function registerSettingsHandlers(ipcMain: IpcMain) {
  ipcMain.handle('settings:get', async () => settings.get())
  ipcMain.handle('settings:set', async (_e, patch: Record<string, unknown>) => {
    const updated = settings.set(patch)
    // Reload STT provider if voice settings changed
    if ('sttProvider' in patch || 'whisperModel' in patch || 'whisperDevice' in patch || 'whisperLanguage' in patch) {
      VoiceOrchestrator.getInstance().reloadSttProvider()
    }
    return updated
  })
}
