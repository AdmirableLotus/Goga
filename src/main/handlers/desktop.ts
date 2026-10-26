import type { IpcMain } from 'electron'
import { DesktopAdapter } from '../adapters/desktop'
import { LogService } from '../services/logs'
import { SecurityWorkspaceService } from '../services/securityWorkspace'

function requireNormalMode() {
  if (SecurityWorkspaceService.getInstance().getActive()) throw new Error('Direct desktop controls are disabled while a security workspace is active. Security actions require scoped explicit approval.')
}

const desktop = new DesktopAdapter()
const log = LogService.getInstance()

export function registerDesktopHandlers(ipcMain: IpcMain) {
  ipcMain.handle('desktop:screenshot', async (_e, displayId?: number) => {
    log.info('Taking screenshot', { displayId })
    return desktop.screenshot(displayId)
  })

  ipcMain.handle('desktop:activeWindow', async () => {
    return desktop.activeWindow()
  })

  ipcMain.handle('desktop:moveCursor', async (_e, x: number, y: number) => {
    requireNormalMode()
    log.info(`Moving cursor to (${x}, ${y})`)
    return desktop.moveCursor(x, y)
  })

  ipcMain.handle('desktop:click', async (_e, x: number, y: number, button?: 'left' | 'right') => {
    requireNormalMode()
    log.info(`Clicking ${button ?? 'left'} at (${x}, ${y})`)
    return desktop.click(x, y, button)
  })

  ipcMain.handle('desktop:typeText', async (_e, text: string) => {
    requireNormalMode()
    log.info(`Typing text (${text.length} chars)`)
    return desktop.typeText(text)
  })

  ipcMain.handle('desktop:pressKey', async (_e, key: string) => {
    requireNormalMode()
    log.info(`Pressing key: ${key}`)
    return desktop.pressKey(key)
  })

  ipcMain.handle('desktop:listDisplays', async () => {
    return desktop.listDisplays()
  })
}
