import type { IpcMain, BrowserWindow } from 'electron'
import { VoiceOrchestrator } from '../services/voiceOrchestrator'
import { OrchestratorService } from '../services/orchestrator'
import { MissionEngine } from '../services/missionEngine'
import { SettingsService } from '../services/settings'
import { nanoid } from '../utils/nanoid'
import type { ChatMessage } from '../../shared/types'

export function registerVoiceHandlers(ipcMain: IpcMain, getWindow: () => BrowserWindow | null) {
  const voice = VoiceOrchestrator.getInstance()
  const chat  = new OrchestratorService()

  // ── Forward voice status to renderer ─────────────────────────────────────
  voice.on('status', (status) => {
    getWindow()?.webContents.send('voice:status', { status })
  })

  voice.on('wake:detected', () => {
    getWindow()?.webContents.send('voice:status', { status: 'listening' })
  })

  // ── TTS amplitude → renderer ──────────────────────────────────────────────
  voice.on('amplitude', (value: number) => {
    getWindow()?.webContents.send('voice:amplitude', { value })
  })

  // ── Transcript → conversation pipeline ───────────────────────────────────
  voice.on('transcript', async (text: string) => {
    const win = getWindow()
    if (!win) return

    // Echo transcript as user message
    const userMsg: ChatMessage = { id: nanoid(), role: 'user', content: text, timestamp: Date.now() }
    win.webContents.send('chat:message', userMsg)
    win.webContents.send('voice:transcript', { text })

    // ── Stop command ──────────────────────────────────────────────────────
    if (/^(stop|halt|cancel|abort|quit)[.!]?$/i.test(text.trim())) {
      MissionEngine.getInstance().listMissions()
        .filter(m => ['running','planning','recovering','verifying'].includes(m.status))
        .forEach(m => MissionEngine.getInstance().stop(m.id))
      win.webContents.send('agent:stopped', { reason: 'Voice stop command' })
      await voice.narrate('Stopped.')
      return
    }

    // ── Mid-mission conversation ──────────────────────────────────────────
    const activeMissions = MissionEngine.getInstance().listMissions()
      .filter(m => ['running','planning','recovering','verifying','waiting_approval'].includes(m.status))

    if (activeMissions.length > 0) {
      const classification = MissionEngine.getInstance().injectConversation(text)

      if (classification === 'cancel') {
        await voice.narrate('Stopped.')
        return
      }

      if (classification === 'question') {
        // Answer the question about progress without interrupting the mission
        const onToken = (token: string) => win.webContents.send('chat:token', { token })
        try {
          const reply = await chat.process(userMsg, onToken)
          win.webContents.send('chat:message', reply)
          await voice.speak(reply.content)
        } catch { }
        return
      }

      if (classification === 'clarification') {
        await voice.narrate('Got it.')
        return
      }
    }

    // ── Normal conversation ───────────────────────────────────────────────
    const onToken = (token: string) => win.webContents.send('chat:token', { token })
    try {
      const reply = await chat.process(userMsg, onToken)
      win.webContents.send('chat:message', reply)
      await voice.speak(reply.content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errMsg: ChatMessage = { id: nanoid(), role: 'assistant', content: `Error: ${msg}`, timestamp: Date.now() }
      win.webContents.send('chat:message', errMsg)
    }
  })

  // ── Voice approval ────────────────────────────────────────────────────────
  voice.on('voice:approve', (approved: boolean) => {
    const win = getWindow()
    MissionEngine.getInstance().listMissions()
      .filter(m => m.status === 'waiting_approval')
      .forEach(m => MissionEngine.getInstance().resolveApproval(m.id, approved))
    const msg = approved ? 'Voice approval: proceeding.' : 'Voice rejection: cancelled.'
    win?.webContents.send('chat:message', { id: nanoid(), role: 'system', content: msg, timestamp: Date.now() })
  })

  // ── IPC handlers ──────────────────────────────────────────────────────────

  ipcMain.handle('voice:listenOnce', async () => {
    await voice.listenOnce()
  })

  ipcMain.handle('voice:stopListening', async () => {
    voice.stopListening()
  })

  ipcMain.handle('voice:stopSpeaking', async () => {
    voice.stopSpeaking()
  })

  ipcMain.handle('voice:startWakeLoop', async () => {
    voice.startWakeLoop()
  })

  ipcMain.handle('voice:stopWakeLoop', async () => {
    voice.stopWakeLoop()
  })

  ipcMain.handle('voice:status', async () => {
    return voice.getStatus()
  })

  // ── Mission narration ─────────────────────────────────────────────────────
  const mission = MissionEngine.getInstance()
  mission.on('mission:event', async (evt) => {
    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled || !settings.autoSpeakResponses) return

    if (evt.type === 'step.authorizing') {
      voice.setApprovalPending(true)
      await voice.narrate("I need your permission before I do that. Want me to continue?")
      return
    }
    if (evt.type === 'step.approved') { voice.setApprovalPending(false); return }
    if (['mission.cancelled','mission.completed','mission.failed'].includes(evt.type)) {
      voice.setApprovalPending(false)
    }

    const narrations: Record<string, string> = {
      'step.failed':       "I ran into something unexpected. Let me try another way.",
      'step.retrying':     "Let me try that again.",
      'mission.completed': "Done.",
      'mission.failed':    "I wasn't able to complete that.",
      'mission.cancelled': "Stopped.",
    }
    const text = narrations[evt.type]
    if (text) await voice.narrate(text)
  })

  // ── Backward-compat TTS/STT handlers ─────────────────────────────────────
  ipcMain.handle('tts:speak', async (_e, text: string) => {
    const settings = SettingsService.getInstance().get()
    if (!settings.voiceEnabled) return
    await voice['tts'].speak(text, settings.voiceRate, settings.voiceVolume, settings.voiceName)
  })

  ipcMain.handle('tts:stop', async () => { voice.stopSpeaking() })

  ipcMain.handle('tts:voices', async () => { return voice.getVoices() })

  ipcMain.handle('stt:start', async () => {
    const result = await voice['stt'].recognize(12000)
    return { transcript: result.transcript }
  })

  ipcMain.handle('stt:stop', async () => { voice['stt'].abort() })
}
