import { registerMarketsHandlers } from './handlers/markets'
import 'dotenv/config'
import { app, BrowserWindow, ipcMain, globalShortcut, Notification } from 'electron'
import path from 'path'
import dotenv from 'dotenv'
import { onWindowClose, startSleepMode, startedAsleep, stopSleepMode, wakeGoga } from './sleepMode'
import { registerChatHandlers } from './handlers/chat'
import { registerActionHandlers } from './handlers/actions'
import { registerMemoryHandlers } from './handlers/memory'
import { registerLogHandlers } from './handlers/logs'
import { registerSettingsHandlers } from './handlers/settings'
import { registerDesktopHandlers } from './handlers/desktop'
import { registerLibraryHandlers } from './handlers/library'
import { registerBrainHandlers } from './handlers/brain'
import { registerAgentHandlers } from './handlers/agent'
import { registerMissionHandlers } from './handlers/mission'
import { registerSttHandlers } from './handlers/stt'
import { registerVoiceHandlers } from './handlers/voice'
import { registerModelHandlers } from './handlers/model'
import { registerRemoteHandlers, applyRemoteSettings, stopRemoteLink } from './handlers/remote'
import { registerFluxHandlers, resumeFluxLink, stopFluxLink } from './handlers/flux'
import { registerTradingHandlers } from './handlers/trading'
import { registerBrokerHandlers } from './handlers/broker'
import { registerBrowserHandlers, registerVenueHandlers } from './handlers/browser'
import { registerSecurityHandlers } from './handlers/security'
import { registerGrimoireHandlers } from './handlers/grimoire'
import { registerLabHandlers } from './handlers/lab'
import { registerEvolutionHandlers } from './handlers/evolution'
import { registerSelfWorkHandlers } from './handlers/selfwork'
import { registerStrategyHandlers } from './handlers/strategy'
import { registerBusinessHandlers } from './handlers/business'
import { registerPersonaHandlers } from './handlers/persona'
import { registerOsintHandlers } from './handlers/osint'
import { registerJobsHandlers } from './handlers/jobs'
import { setLivePublisher } from './services/lab/liveRun'
import { registerSetupHandlers } from './handlers/setup'
import { startJobs, stopJobs } from './services/jobs/instance'
import { reconcileStaleRuns } from './services/lab/runs'
import { ActionStore } from './services/actionStore'
import { AgentLoop } from './services/agentLoop'
import { LocalLlamaService } from './services/localLlama'
import { SettingsService } from './services/settings'
import { LibraryService } from './services/library'
import { VoiceOrchestrator } from './services/voiceOrchestrator'
import { TelegramService, messageOwnerOnPhone, setPhoneMessagesEnabled } from './services/telegram'
import { OrchestratorService, SCHEDULED_ID_PREFIX, msSinceUserMessage } from './services/orchestrator'
import { describeSchedule, initScheduler, scheduler, type ScheduledTask } from './services/scheduler'
import { BrainService } from './services/brain'
import { bookStudy, initBookStudy } from './services/bookStudy'
import { backgroundChat, foregroundJson, foregroundText } from './services/backgroundChat'
import { initQuiz } from './services/quiz'
import { initWebLearn } from './services/webLearning'
import type { ChatMessage } from '../shared/types'
import { nanoid } from './utils/nanoid'
import { registerDeveloperHandlers, stopDeveloperTask } from './handlers/developer'
import { emergencyStop } from './services/emergencyStop'
// Bootstrap all tool registrations
import './tools/index'
import { plannerDiagnostic, loadedModuleIdentity } from './services/plannerDiagnostics'

// A diagnostic must never be the reason the app fails to start. `require.resolve` on a
// TypeScript path throws under a test runner, and this block runs at module load, so a
// resolution failure here would take the whole main process down with it.
try {
  plannerDiagnostic('build.loaded', {
    entry: loadedModuleIdentity(__filename),
    planner: loadedModuleIdentity(require.resolve('./services/agentLoop')),
    modelWrapper: loadedModuleIdentity(require.resolve('./services/localLlama')),
    executable: process.execPath, appPath: app.getAppPath(), version: app.getVersion()
  })
} catch { /* diagnostics are best-effort */ }

// Started with Windows, the working folder is not the app's, so the keys in .env are
// loaded from the app folder too (never overriding ones already set).
dotenv.config({ path: path.join(app.getAppPath(), '.env') })

// Windows: Chromium's native window-occlusion tracker can decide the window is covered
// and never clear that after it is restored, so the renderer stays "hidden", stops
// painting and the window shows blank. Turning that one feature off keeps it painting.
if (process.platform === 'win32') {
  const existing = app.commandLine.getSwitchValue('disable-features')
  const features = new Set(existing.split(',').map(f => f.trim()).filter(Boolean))
  features.add('CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-features', Array.from(features).join(','))
}

let mainWindow: BrowserWindow | null = null
let telegram: TelegramService | undefined

// One-time shutdown guard. app.exit(0) fires will-quit again; without this
// guard the handler would re-enter, call preventDefault() a second time, and
// loop until the OS kills the process.
let quitting = false

function createWindow() {
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    icon: path.join(__dirname, '../../../assets/icon.ico'),
    autoHideMenuBar: true,
    // Started with Windows, Goga wakes up asleep in the tray.
    show: !startedAsleep(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
  // hiddenInset is a macOS-only title bar style; on Windows it is meaningless.
  if (process.platform === 'darwin') windowOptions.titleBarStyle = 'hiddenInset'

  mainWindow = new BrowserWindow(windowOptions)

  // Grant microphone permission automatically
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') return callback(true)
    callback(false)
  })

  const devServerUrl = 'http://localhost:5173'
  const builtFile = path.join(__dirname, '../../renderer/index.html')
  const isDev = !app.isPackaged && process.env.VITE_DEV === '1'
  if (isDev) {
    mainWindow.loadURL(devServerUrl)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(builtFile)
  }

  mainWindow.on('close', event => { if (mainWindow) onWindowClose(event, mainWindow) })
  mainWindow.on('closed', () => { mainWindow = null })
}

export function getMainWindow() { return mainWindow }

// One Goga at a time: a second start (say, from the Start menu while asleep) wakes this one.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => wakeGoga())
}

/** Something Goga says on his own: in chat, and with `alert`, also on Telegram and as a pop-up. */
function tellOwner(content: string, alert: boolean): void {
  const message: ChatMessage = { id: nanoid(), role: 'assistant', content, timestamp: Date.now() }
  BrainService.getInstance().addMessage(message)
  getMainWindow()?.webContents.send('chat:message', message)
  if (alert) messageOwnerOnPhone(content)
  if (alert && Notification.isSupported()) new Notification({ title: 'Goga', body: content.replace(/[*_`]/g, '').slice(0, 180) }).show()
}

/** Goga studies the books in his Library while nobody is chatting (see bookStudy.ts). */
function startBookStudy(): void {
  const library = LibraryService.getInstance()
  initBookStudy(path.join(app.getPath('userData'), 'book-study.json'), {
    // JSON mode: without it the 14B's notes were often broken JSON.
    chat: messages => backgroundChat(messages, { json: true, numPredict: 1200 }),
    idle: () => !['running', 'waiting-approval'].includes(AgentLoop.getInstance().getState().status) && msSinceUserMessage() > 5 * 60_000,
    books: () => library.list().sort((a, b) => a.ingestedAt - b.ingestedAt).map(b => ({ id: b.id, title: b.title })),
    chunks: id => library.chunksOf(id),
    report: text => tellOwner(text, true),
  }).start()
  // Self-testing: generate and grade practice questions from what he's studied (local model).
  initQuiz(path.join(app.getPath('userData'), 'quizzes.json'), {
    chat: (messages, numPredict) => foregroundJson(messages, numPredict),
    studied: () => bookStudy()?.all() ?? [],
  })
  // Opt-in web research with honest, source-grounded memory (see webLearning.ts).
  initWebLearn(path.join(app.getPath('userData'), 'web-learning.json'), {
    chat: (messages, numPredict) => foregroundText(messages, numPredict),
  })
}

/**
 * Goga's own recurring tasks. Each run is sent through its own orchestrator as a chat
 * message, so it gets the same routing, approvals and safety checks as anything typed.
 */
function startScheduledTasks(): void {
  const orchestrator = new OrchestratorService()
  const report = tellOwner
  const busy = () => {
    const status = AgentLoop.getInstance().getState().status
    return status === 'running' || status === 'waiting-approval' || msSinceUserMessage() < 90_000
  }
  const run = (task: ScheduledTask) => new Promise<{ ok: boolean; text: string }>(resolve => {
    let settled = false
    const finish = (ok: boolean, text: string) => { if (!settled) { settled = true; clearTimeout(limit); resolve({ ok, text }) } }
    const limit = setTimeout(() => finish(false, 'it took longer than 20 minutes'), 20 * 60_000)
    report(`⏰ Scheduled task ${task.id} (${describeSchedule(task)}): ${task.request}`, false)
    orchestrator.process({ id: `${SCHEDULED_ID_PREFIX}${nanoid()}`, role: 'user', content: task.request, timestamp: Date.now() },
      undefined, result => {
        messageOwnerOnPhone(`⏰ ${task.request} (${describeSchedule(task)}):\n\n${result.reply}`)
        finish(result.status === 'success', result.reply)
      })
      .then(reply => {
        // A multi-step task posts its own result when it finishes (see onTaskComplete above).
        if (AgentLoop.getInstance().getState().status === 'running') return
        getMainWindow()?.webContents.send('chat:message', reply)
        messageOwnerOnPhone(`⏰ ${task.request} (${describeSchedule(task)}):\n\n${reply.content}`)
        finish(!/^(Couldn't do that|Model error|Agent error)/.test(reply.content), reply.content)
      }, err => finish(false, err instanceof Error ? err.message : String(err)))
  })
  initScheduler(path.join(app.getPath('userData'), 'scheduled-tasks.json'), { run, report, busy }).start()
}

app.whenReady().then(() => {
  registerChatHandlers(ipcMain)
  registerMarketsHandlers(ipcMain)
  registerDeveloperHandlers(ipcMain)
  registerActionHandlers(ipcMain)
  registerMemoryHandlers(ipcMain)
  registerLogHandlers(ipcMain)
  registerSettingsHandlers(ipcMain)
  registerDesktopHandlers(ipcMain)
  LibraryService.getInstance().open(path.join(app.getPath('userData'), 'library-index.json'))
  registerLibraryHandlers(ipcMain)
  registerBrainHandlers(ipcMain)
  registerAgentHandlers(ipcMain)
  registerMissionHandlers(ipcMain)
  registerVoiceHandlers(ipcMain, getMainWindow)
  registerModelHandlers(ipcMain, getMainWindow)
  registerRemoteHandlers(ipcMain)
  registerFluxHandlers(ipcMain)
  registerTradingHandlers(ipcMain)
  registerBrokerHandlers(ipcMain)
  registerBrowserHandlers(ipcMain)
  registerVenueHandlers(ipcMain)
  registerSecurityHandlers(ipcMain)
  registerGrimoireHandlers(ipcMain)
  registerLabHandlers(ipcMain)
  registerEvolutionHandlers(ipcMain)
  registerSelfWorkHandlers(ipcMain)
  registerOsintHandlers(ipcMain)
  registerStrategyHandlers(ipcMain)
  registerBusinessHandlers(ipcMain)
  registerPersonaHandlers(ipcMain)
  registerJobsHandlers(ipcMain)
  registerSetupHandlers(ipcMain)
  createWindow()
  startSleepMode(getMainWindow, createWindow)

  // Jobs outlive the window, so the board is loaded here — not when the page opens — and
  // anything that was mid-run when the app last closed is marked interrupted, not lost.
  startJobs()
  // The live view: every entry and picture a Lab run produces is forwarded to the renderer as
  // it happens. This is a forward only â€” it has no way to start, approve or send anything.
  setLivePublisher(event => getMainWindow()?.webContents.send('lab:live', event))

  // A Lab run left 'running' by a crash is marked stopped, so the record never lies that an
  // offensive process is still going when no process exists.
  reconcileStaleRuns()

  // Hands-free "hey goga": start the always-on wake listener at launch when
  // enabled, so it works with the window open — not only when asleep in the tray.
  {
    const s = SettingsService.getInstance().get()
    if (s.voiceEnabled && s.wakeWordEnabled) void VoiceOrchestrator.getInstance().startWakeLoop()
  }

  startScheduledTasks()
  startBookStudy()
  void applyRemoteSettings()
  resumeFluxLink()

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (telegramToken) {
    try {
      const orchestrator = new OrchestratorService()
      telegram = new TelegramService(telegramToken, path.join(app.getPath('userData'), 'telegram-owner.json'),
        async (content, completed) => {
          const reply = await orchestrator.process({ id: nanoid(), role: 'user', content, timestamp: Date.now() },
            undefined, result => completed(result.reply))
          return reply.content
        },
        () => emergencyStop('Telegram /stop'),
        async file => {
          const meta = await LibraryService.getInstance().ingest(file)
          tellOwner(`📚 "${meta.title}" arrived from Telegram and is in my Library (${meta.chunkCount.toLocaleString('en-US')} passages).`, false)
          return `📚 "${meta.title}" is in my Library (${meta.chunkCount.toLocaleString('en-US')} passages). I'll study it section by section while you're not chatting with me, and message you here as I go. Ask "how is your studying going" any time.`
        })
      telegram.makeActive()
      setPhoneMessagesEnabled(() => SettingsService.getInstance().get().telegramNotify ?? true)
      telegram.start().catch(() => console.warn('[Telegram] Could not connect. Check TELEGRAM_BOT_TOKEN and network access.'))
    } catch {
      console.warn('[Telegram] Could not initialize. Check the local Telegram owner configuration.')
    }
  }

  // Start loading the local 9B brain immediately — unless the brain is an Ollama model
  // (e.g. a 14B), in which case loading the 9B too would exhaust the GPU. Let Ollama own it.
  if (SettingsService.getInstance().get().primaryModel !== 'ollama') {
    LocalLlamaService.getInstance().initialize().catch(() => { /* errors logged inside */ })
  }

  // Global emergency stop: Ctrl+Shift+Escape
  globalShortcut.register('CommandOrControl+Shift+Escape', () => {
    emergencyStop('Emergency stop (Ctrl+Shift+Escape)')
    mainWindow?.webContents.send('agent:stopped', { reason: 'Emergency stop (Ctrl+Shift+Escape)' })
  })
})

app.on('will-quit', async (event) => {
  // Synchronous guard — must be checked and set before any await.
  if (quitting) return   // second entry from app.exit(0): let Electron proceed
  quitting = true
  // preventDefault() must remain here, before any await, because Electron does
  // not await the async callback. Moving it below an await would let the quit
  // proceed before cleanup finishes.
  event.preventDefault()
  globalShortcut.unregisterAll()
  stopSleepMode()
  scheduler()?.stop()
  bookStudy()?.stop()
  stopJobs()
  telegram?.stop()
  stopRemoteLink()
  stopFluxLink()
  stopDeveloperTask()
  // Stop all TTS/STT child processes through the typed public shutdown() method.
  try { await VoiceOrchestrator.getInstance().shutdown() } catch { }
  app.exit(0)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})
