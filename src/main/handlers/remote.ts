import type { IpcMain } from 'electron'
import { app } from 'electron'
import path from 'path'
import { RemoteLink, lanAddresses } from '../services/remoteLink'
import { SettingsService } from '../services/settings'
import { LogService } from '../services/logs'
import { VoiceOrchestrator } from '../services/voiceOrchestrator'
import { OrchestratorService } from '../services/orchestrator'
import { emergencyStop } from '../services/emergencyStop'
import { nanoid } from '../utils/nanoid'

let link: RemoteLink | null = null
let lastError: string | null = null

function getLink(): RemoteLink {
  if (link) return link
  const log = LogService.getInstance()
  const orchestrator = new OrchestratorService()
  const voice = VoiceOrchestrator.getInstance()
  link = new RemoteLink({
    devicesFile: path.join(app.getPath('userData'), 'remote-devices.json'),
    processText: async (content, completed) => {
      const reply = await orchestrator.process({ id: nanoid(), role: 'user', content, timestamp: Date.now() },
        undefined, result => completed(result.reply))
      return reply.content
    },
    transcribe: wav => voice.transcribeFile(wav),
    speak: (text, out) => voice.speakToFile(text, out),
    stop: () => emergencyStop('Stop from paired device'),
    log: { info: m => log.info(m), warn: m => log.warn(m) },
  })
  return link
}

/** Start or stop listening to match Settings. Called at startup and after each save. */
export async function applyRemoteSettings(): Promise<void> {
  const { remoteEnabled, remotePort } = SettingsService.getInstance().get()
  const current = getLink()
  if (!remoteEnabled) { await current.stop(); lastError = null; return }
  if (current.port === remotePort) return
  await current.stop()
  try {
    await current.start(remotePort)
    lastError = null
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    LogService.getInstance().warn(`RemoteLink: could not listen on port ${remotePort}: ${lastError}`)
  }
}

export function stopRemoteLink(): void { void link?.stop() }

export function registerRemoteHandlers(ipcMain: IpcMain) {
  ipcMain.handle('remote:status', async () => {
    const l = getLink()
    return { listening: l.port !== null, port: l.port, addresses: lanAddresses(), devices: l.listDevices(), error: lastError }
  })
  ipcMain.handle('remote:pair', async () => getLink().startPairing())
  ipcMain.handle('remote:forget', async (_e, id: string) => { getLink().forget(id) })
}
