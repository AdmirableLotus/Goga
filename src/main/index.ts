import 'dotenv/config'
import { app, BrowserWindow, ipcMain, globalShortcut } from 'electron'
import path from 'path'
import { registerChatHandlers } from './handlers/chat'
import { registerActionHandlers } from './handlers/actions'
import { registerMemoryHandlers } from './handlers/memory'
import { registerLogHandlers } from './handlers/logs'
import { registerSettingsHandlers } from './handlers/settings'
import { registerDesktopHandlers } from './handlers/desktop'
import { registerLibraryHandlers } from './handlers/library'
import { registerBrainHandlers } from './handlers/brain'
import { registerSecurityHandlers } from './handlers/security'
import { registerAgentHandlers } from './handlers/agent'
import { registerMissionHandlers } from './handlers/mission'
import { registerSttHandlers } from './handlers/stt'
import { registerVoiceHandlers } from './handlers/voice'
import { registerModelHandlers } from './handlers/model'
import { ActionStore } from './services/actionStore'
import { AgentLoop } from './services/agentLoop'
import { LocalLlamaService } from './services/localLlama'
import { VoiceOrchestrator } from './services/voiceOrchestrator'
// Bootstrap all tool registrations
import './tools/index'

let mainWindow: BrowserWindow | null = null

// One-time shutdown guard. app.exit(0) fires will-quit again; without this
// guard the handler would re-enter, call preventDefault() a second time, and
// loop until the OS kills the process.
let quitting = false

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    icon: path.join(__dirname, '../../../assets/icon.ico'),
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

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

  mainWindow.on('closed', () => { mainWindow = null })
}

export function getMainWindow() { return mainWindow }

app.whenReady().then(() => {
  registerChatHandlers(ipcMain)
  registerActionHandlers(ipcMain)
  registerMemoryHandlers(ipcMain)
  registerLogHandlers(ipcMain)
  registerSettingsHandlers(ipcMain)
  registerDesktopHandlers(ipcMain)
  registerLibraryHandlers(ipcMain)
  registerBrainHandlers(ipcMain)
  registerSecurityHandlers(ipcMain)
  registerAgentHandlers(ipcMain)
  registerMissionHandlers(ipcMain)
  registerVoiceHandlers(ipcMain, getMainWindow)
  registerModelHandlers(ipcMain, getMainWindow)
  createWindow()

  // Start loading the primary local model immediately (non-blocking)
  LocalLlamaService.getInstance().initialize().catch(() => { /* errors logged inside */ })

  // Global emergency stop: Ctrl+Shift+Escape
  globalShortcut.register('CommandOrControl+Shift+Escape', () => {
    ActionStore.getInstance().stopAll()
    AgentLoop.getInstance().stop('Emergency stop (Ctrl+Shift+Escape)')
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
