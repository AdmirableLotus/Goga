import type { IpcMain } from 'electron'
import { SettingsService } from '../services/settings'
import { VoiceOrchestrator } from '../services/voiceOrchestrator'

const settings = SettingsService.getInstance()

export function registerSettingsHandlers(ipcMain: IpcMain) {
  ipcMain.handle('settings:get', async () => settings.get())
  ipcMain.handle('settings:set', async (_e, patch: Record<string, unknown>) => {
    const updated = settings.set(patch)
    if ('sttProvider' in patch || 'whisperModel' in patch || 'whisperDevice' in patch || 'whisperLanguage' in patch) {
      VoiceOrchestrator.getInstance().reloadSttProvider()
    }
    if ('ttsProvider' in patch) {
      // Fire-and-forget; renderer can call voice:reload-tts explicitly for the result.
      VoiceOrchestrator.getInstance().reloadTtsProvider()
    }
    return updated
  })

  // Explicit reload with error reporting — renderer calls this after settings:set
  // when it needs to know whether the new provider initialized successfully.
  ipcMain.handle('voice:reload-tts', async () => {
    return VoiceOrchestrator.getInstance().reloadTtsProvider()
  })
}
