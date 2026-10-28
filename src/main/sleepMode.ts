import { app, BrowserWindow, Menu, Notification, Tray, powerMonitor } from 'electron'
import path from 'path'
import { nanoid } from './utils/nanoid'
import { BrainService } from './services/brain'
import { GuardianService, type GuardianAlert } from './services/guardian'
import { LogService } from './services/logs'
import { RoutineTracker } from './services/routine'
import { SettingsService } from './services/settings'
import { VoiceOrchestrator } from './services/voiceOrchestrator'
import { DesktopAdapter } from './adapters/desktop'

/**
 * Sleep mode: closing the window puts Goga in the tray by the clock instead of quitting.
 * Asleep he keeps watching the PC (guardian), learning the user's routine, and listening
 * for his name. He starts with Windows straight into sleep.
 */

export const SLEEP_ARG = '--sleep'
const ICON = path.join(__dirname, '../../../assets/icon.ico')

let tray: Tray | null = null
let quitting = false
let toldAboutTray = false
let routine: RoutineTracker | undefined
let guardian: GuardianService | undefined
let wakeUp: () => void = () => {}
const log = LogService.getInstance()
const settings = () => SettingsService.getInstance().get()

export function startedAsleep(): boolean { return process.argv.includes(SLEEP_ARG) }
export function isQuitting(): boolean { return quitting }
/** Open the window and stop listening for the wake word (tray click, a second start). */
export function wakeGoga(): void { wakeUp() }

/** Recent apps and windows, for questions about the user's day ('' when nothing is known). */
export function routineSummary(userName: string): string {
  return routine?.summary(userName) ?? ''
}

export function startSleepMode(getWindow: () => BrowserWindow | null, createWindow: () => void): void {
  app.on('before-quit', () => { quitting = true })
  wakeUp = () => wake(getWindow, createWindow)
  applySleepSettings()

  tray = new Tray(ICON)
  tray.setToolTip('Goga')
  tray.on('click', () => wake(getWindow, createWindow))
  refreshTrayMenu(getWindow, createWindow)

  const userData = app.getPath('userData')
  const desktop = new DesktopAdapter()
  routine = new RoutineTracker({
    activeWindow: () => desktop.activeWindow(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    enabled: () => settings().routineLearning,
    log,
  }, path.join(userData, 'routine.json'))
  routine.start()
  guardian = new GuardianService({ dir: userData, enabled: () => settings().guardianEnabled, onAlert: alert => tellUser(alert, getWindow, createWindow), log })
  guardian.start()

  if (startedAsleep()) fallAsleep()
}

/** Called for the main window's close: asleep in the tray unless the user is quitting. */
export function onWindowClose(event: Electron.Event, win: BrowserWindow): void {
  if (quitting || !settings().sleepOnClose) return
  event.preventDefault()
  win.hide()
  fallAsleep()
  if (!toldAboutTray) {
    toldAboutTray = true
    notify('Goga is sleeping', 'I\'m by the clock, still watching your PC. Say "Hey Goga" or click my icon to wake me. Right-click it to quit.')
  }
}

/** Start with Windows or not, as set. */
export function applySleepSettings(): void {
  const openAtLogin = settings().startWithWindows
  // Unpackaged (development) runs need the app folder as the first argument.
  const args = app.isPackaged ? [SLEEP_ARG] : [app.getAppPath(), SLEEP_ARG]
  try {
    app.setLoginItemSettings({ openAtLogin, path: process.execPath, args })
  } catch (err) {
    log.warn(`Could not set start with Windows: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function stopSleepMode(): void {
  guardian?.stop()
  routine?.stop()
  tray?.destroy()
  tray = null
}

function fallAsleep(): void {
  log.info('Goga is asleep in the tray')
  const s = settings()
  if (s.voiceEnabled && s.wakeWordEnabled) void VoiceOrchestrator.getInstance().startWakeLoop()
}

function wake(getWindow: () => BrowserWindow | null, createWindow: () => void): void {
  let win = getWindow()
  if (!win) { createWindow(); win = getWindow() }
  // With the window open the mic button is used; the always-on loop is for sleep.
  VoiceOrchestrator.getInstance().stopWakeLoop()
  if (win?.isMinimized()) win.restore()
  win?.show()
  win?.focus()
  log.info('Goga woke up')
}

function refreshTrayMenu(getWindow: () => BrowserWindow | null, createWindow: () => void): void {
  const s = settings()
  const toggle = (key: 'guardianEnabled' | 'routineLearning') => () => {
    SettingsService.getInstance().set({ [key]: !settings()[key] })
    refreshTrayMenu(getWindow, createWindow)
  }
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Goga', click: () => wake(getWindow, createWindow) },
    { type: 'separator' },
    { label: 'Watch and protect the PC', type: 'checkbox', checked: s.guardianEnabled, click: toggle('guardianEnabled') },
    { label: 'Learn my routine', type: 'checkbox', checked: s.routineLearning, click: toggle('routineLearning') },
    { type: 'separator' },
    { label: 'Quit Goga', click: () => { quitting = true; app.quit() } },
  ]))
}

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: ICON })
  if (onClick) n.on('click', onClick)
  n.show()
}

/** An alert pops up by the clock, joins the chat so it can be talked through, and danger is said aloud. */
function tellUser(alert: GuardianAlert, getWindow: () => BrowserWindow | null, createWindow: () => void): void {
  notify(`Goga: ${alert.title}`, alert.detail, () => wake(getWindow, createWindow))
  const message = { id: nanoid(), role: 'assistant' as const, content: `Heads up — ${alert.title.toLowerCase()}. ${alert.detail}`, timestamp: Date.now() }
  BrainService.getInstance().addMessage(message)
  getWindow()?.webContents.send('chat:message', message)
  if (alert.severity === 'danger' && settings().voiceEnabled) {
    void VoiceOrchestrator.getInstance().narrate(`${settings().userName}, heads up. ${alert.title}.`).catch(() => {})
  }
}
