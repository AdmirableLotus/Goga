import type { IpcMain } from 'electron'
import { SettingsService } from '../services/settings'
import { VoiceOrchestrator } from '../services/voiceOrchestrator'
import { LocalLlamaService } from '../services/localLlama'
import type { AppSettings } from '../../shared/types'
import { applyRemoteSettings } from './remote'

const LOCAL_MODEL_KEYS: (keyof AppSettings)[] = ['localModelPath', 'localModelContextSize', 'localModelGpuLayers']

const settings = SettingsService.getInstance()

export function registerSettingsHandlers(ipcMain: IpcMain) {
  ipcMain.handle('settings:get', async () => settings.get())
  ipcMain.handle('settings:set', async (_e, patch: Record<string, unknown>) => {
    const previous = settings.get()
    const updated = settings.set(patch)
    // The renderer saves the whole form, so reload the brain only when its config really changed.
    if (LOCAL_MODEL_KEYS.some(k => previous[k] !== updated[k])) {
      LocalLlamaService.getInstance().reload().catch(() => { /* errors logged inside */ })
    }
    if ('sttProvider' in patch || 'whisperModel' in patch || 'whisperDevice' in patch || 'whisperLanguage' in patch) {
      VoiceOrchestrator.getInstance().reloadSttProvider()
    }
    if (previous.remoteEnabled !== updated.remoteEnabled || previous.remotePort !== updated.remotePort) {
      await applyRemoteSettings()
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
