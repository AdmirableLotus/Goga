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
import { ActionStore } from './services/actionStore'
import { AgentLoop } from './services/agentLoop'
import { LocalLlamaService } from './services/localLlama'
// Bootstrap all tool registrations
import './tools/index'

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    icon: path.join(__dirname, '../../../assets/icon.ico'),
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

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})
