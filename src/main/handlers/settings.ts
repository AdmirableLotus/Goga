import type { IpcMain } from 'electron'
import { SettingsService } from '../services/settings'
import { VoiceOrchestrator } from '../services/voiceOrchestrator'
import { LocalLlamaService } from '../services/localLlama'
import type { AppSettings } from '../../shared/types'
import { applyRemoteSettings } from './remote'
import { applySleepSettings } from '../sleepMode'

const LOCAL_MODEL_KEYS: (keyof AppSettings)[] = ['localModelPath', 'localModelContextSize', 'localModelGpuLayers']

const settings = SettingsService.getInstance()

export function registerSettingsHandlers(ipcMain: IpcMain) {
  ipcMain.handle('settings:get', async () => settings.get())
  // A settings file that could not be parsed is reported here, so the window can
  // say so in plain words instead of the app dying before it opens.
  ipcMain.handle('settings:load-error', async () => settings.getLoadError())
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
    if (previous.startWithWindows !== updated.startWithWindows) applySleepSettings()
    if ('ttsProvider' in patch) {
      // Fire-and-forget; renderer can call voice:reload-tts explicitly for the result.
      VoiceOrchestrator.getInstance().reloadTtsProvider()
    }
    // Start/stop the "hey goga" wake listener the moment the toggle (or voice
    // enable) changes, so it works without an app restart. Starting is awaited:
    // if there is no microphone, or Windows will not open it, the listener turns
    // the setting back off and the renderer is handed the corrected value.
    if (previous.voiceEnabled !== updated.voiceEnabled || previous.wakeWordEnabled !== updated.wakeWordEnabled) {
      const voice = VoiceOrchestrator.getInstance()
      if (updated.voiceEnabled && updated.wakeWordEnabled) await voice.startWakeLoop()
      else voice.stopWakeLoop()
      return settings.get()
    }
    return updated
  })

  // Explicit reload with error reporting — renderer calls this after settings:set
  // when it needs to know whether the new provider initialized successfully.
  ipcMain.handle('voice:reload-tts', async () => {
    return VoiceOrchestrator.getInstance().reloadTtsProvider()
  })
}
