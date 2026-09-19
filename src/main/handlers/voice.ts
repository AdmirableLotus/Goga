import type { IpcMain, BrowserWindow } from 'electron'
import { VoiceOrchestrator } from '../services/voiceOrchestrator'
import { OrchestratorService } from '../services/orchestrator'
import { MissionEngine } from '../services/missionEngine'
import { SettingsService } from '../services/settings'
import { WhisperSttProvider } from '../services/speech/WhisperSttProvider'
import { nanoid } from '../utils/nanoid'
import type { ChatMessage } from '../../shared/types'

// Bounded timeout for TTS shutdown on Stop (ms).
const STOP_TTS_TIMEOUT_MS = 3_000

export function registerVoiceHandlers(ipcMain: IpcMain, getWindow: () => BrowserWindow | null) {
  const voice = VoiceOrchestrator.getInstance()
  const chat  = new OrchestratorService()

  // ── Turn-generation guard ─────────────────────────────────────────────────
  // Monotonically increasing. Each new transcript increments it. Every async
  // step captures its generation at entry and checks before emitting tokens,
  // committing messages, starting TTS, or emitting idle. An old turn whose
  // generation no longer matches the current one is silently discarded.
  let currentGen = 0

  // AbortController for the currently in-flight LLM request.
  // Replaced on every new transcript; aborted by Stop.
  let currentAbort: AbortController | null = null

  // Whether a Stop is in progress (prevents re-entrant Stop calls).
  let stopping = false

  // ── Forward voice status to renderer ─────────────────────────────────────
  voice.on('status', (status) => {
    getWindow()?.webContents.send('voice:status', { status })
  })

  voice.on('wake:detected', () => {
    getWindow()?.webContents.send('voice:status', { status: 'listening' })
  })

  voice.on('amplitude', (value: number) => {
    getWindow()?.webContents.send('voice:amplitude', { value })
  })

  voice.on('partial', (text: string) => {
    getWindow()?.webContents.send('voice:partial', { text })
  })

  voice.on('whisper:download-required', (info) => {
    getWindow()?.webContents.send('whisper:download-required', info)
  })

  // ── Authoritative idle emitter ────────────────────────────────────────────
  // Only called when the generation that started a turn is still current.
  // Prevents an old turn's finally block from overwriting a newer turn's state.
  function finalizeIdle(gen: number) {
    if (gen !== currentGen) return
    getWindow()?.webContents.send('voice:status', { status: voice.getStatus() })
  }

  // ── Transcript → conversation pipeline ───────────────────────────────────
  voice.on('transcript', async (text: string) => {
    const win = getWindow()
    if (!win) return

    // Assign this turn's generation and abort any previous in-flight LLM call.
    const myGen = ++currentGen
    currentAbort?.abort()
    const abort = new AbortController()
    currentAbort = abort

    const turnId = nanoid()
    const userMsg: ChatMessage = {
      id: nanoid(), role: 'user', content: text, timestamp: Date.now(), turnId
    }
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
      if (classification === 'cancel') { await voice.narrate('Stopped.'); return }
      if (classification === 'question') {
        const onToken = (token: string) => {
          if (myGen !== currentGen || abort.signal.aborted) return
          win.webContents.send('chat:token', { token, turnId })
        }
        try {
          const reply = await chat.process(userMsg, onToken, undefined, abort.signal)
          if (myGen !== currentGen || abort.signal.aborted) return
          const stamped: ChatMessage = { ...reply, turnId }
          win.webContents.send('chat:message', stamped)
          voice.speak(stamped.content).catch(() => {})
        } catch { }
        return
      }
      if (classification === 'clarification') { await voice.narrate('Got it.'); return }
    }

    // ── Normal conversation ───────────────────────────────────────────────
    const onToken = (token: string) => {
      if (myGen !== currentGen || abort.signal.aborted) return
      win.webContents.send('chat:token', { token, turnId })
    }

    try {
      const reply = await chat.process(userMsg, onToken, undefined, abort.signal)

      // Guard: discard if this turn was superseded or stopped.
      if (myGen !== currentGen || abort.signal.aborted) return

      const stamped: ChatMessage = { ...reply, turnId }
      win.webContents.send('chat:message', stamped)

      // Guard again before starting TTS — Stop may have fired between
      // chat:message send and speak() call.
      if (myGen !== currentGen || abort.signal.aborted) return

      voice.speak(stamped.content).catch(() => {})

    } catch (err) {
      if (myGen !== currentGen || abort.signal.aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      const errMsg: ChatMessage = {
        id: nanoid(), role: 'assistant',
        content: `Error: ${msg}`, timestamp: Date.now(), turnId
      }
      win.webContents.send('chat:message', errMsg)
    } finally {
      // Emit current status so renderer loading state syncs.
      // Only acts if this turn is still the active one.
      finalizeIdle(myGen)
    }
  })

  // ── Voice approval ────────────────────────────────────────────────────────
  voice.on('voice:approve', (approved: boolean) => {
    const win = getWindow()
    MissionEngine.getInstance().listMissions()
      .filter(m => m.status === 'waiting_approval')
      .forEach(m => MissionEngine.getInstance().resolveApproval(m.id, approved))
    const msg = approved ? 'Voice approval: proceeding.' : 'Voice rejection: cancelled.'
    win?.webContents.send('chat:message', {
      id: nanoid(), role: 'system', content: msg, timestamp: Date.now()
    })
  })

  // ── IPC handlers ──────────────────────────────────────────────────────────

  ipcMain.handle('voice:listenOnce', async () => {
    await voice.listenOnce()
  })

  ipcMain.handle('voice:stopListening', async () => {
    voice.stopListening()
  })

  ipcMain.handle('voice:stopSpeaking', async () => {
    if (stopping) return
    stopping = true
    try {
      // 1. Abort in-flight LLM — real cancellation for Ollama (HTTP destroyed),
      //    output suppression only for LocalLlama (node-llama-cpp has no abort API).
      currentAbort?.abort()
      currentAbort = null

      // 2. Invalidate current generation so no old turn can emit tokens,
      //    commit messages, start TTS, or call finalizeIdle.
      currentGen++
      const stopGen = currentGen

      // 3. Await TTS shutdown with a bounded timeout so a hung child cannot
      //    block Stop indefinitely.
      const ttsStop = voice.getTtsProvider().stopAndWait
        ? voice.getTtsProvider().stopAndWait!().catch(() => {})
        : Promise.resolve(voice.getTtsProvider().stop())

      await Promise.race([
        ttsStop,
        new Promise<void>(r => setTimeout(r, STOP_TTS_TIMEOUT_MS))
      ])

      // 4. Emit idle from the single authoritative path, only if no newer
      //    turn has started since Stop began.
      if (stopGen === currentGen) {
        voice.stopSpeaking()  // ensures orchestrator internal state is idle
        getWindow()?.webContents.send('voice:status', { status: 'idle' })
      }
    } finally {
      stopping = false
    }
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

  // Whisper pre-download disclosure — no network, no process spawned
  ipcMain.handle('whisper:preflight', async (_e, model: string, device: string) => {
    return WhisperSttProvider.preflight(
      (model as Parameters<typeof WhisperSttProvider.preflight>[0]) ?? 'base',
      (device as Parameters<typeof WhisperSttProvider.preflight>[1]) ?? 'cuda'
    )
  })
}
