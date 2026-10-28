import type { IpcMain } from 'electron'
import { app, safeStorage, shell } from 'electron'
import path from 'path'
import { FluxLink } from '../services/fluxLink'
import { LogService } from '../services/logs'
import { ToolRegistry } from '../tools/registry'

let link: FluxLink | null = null

function getLink(): FluxLink {
  if (link) return link
  const log = LogService.getInstance()
  link = new FluxLink({
    file: path.join(app.getPath('userData'), 'flux-auth.bin'),
    // The Flux sign-in is only ever stored encrypted with the Windows account's key.
    encrypt: text => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('secure storage is not available on this PC')
      return safeStorage.encryptString(text)
    },
    decrypt: data => safeStorage.decryptString(data),
    openBrowser: url => { void shell.openExternal(url) },
    registry: ToolRegistry.getInstance(),
    log: { info: m => log.info(m), warn: m => log.warn(m) },
  })
  return link
}

/** At startup, reconnect with a saved sign-in (never opens the browser by itself). */
export function resumeFluxLink(): void {
  const l = getLink()
  if (l.hasSavedSignIn()) void l.connect(false)
}

export function stopFluxLink(): void { void link?.disconnect(false) }

export function registerFluxHandlers(ipcMain: IpcMain) {
  ipcMain.handle('flux:status', async () => getLink().status())
  ipcMain.handle('flux:connect', async () => getLink().connect(true))
  ipcMain.handle('flux:disconnect', async () => { await getLink().disconnect(true); return getLink().status() })
}
