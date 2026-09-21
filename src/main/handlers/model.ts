import type { IpcMain, BrowserWindow } from 'electron'
import { app } from 'electron'
import { ModelManager, KOKORO_ARTIFACTS, KOKORO_MANIFEST_VERSION, TOTAL_SIZE_LABEL, HF_COMMIT } from '../services/modelManager'

// Re-export so tests can import without going through electron
export { ModelManager }

let downloadInProgress = false

/** Exported only for test resets — do not call in production code. */
export function _resetDownloadFlag() { downloadInProgress = false }

export function registerModelHandlers(ipcMain: IpcMain, getWindow: () => BrowserWindow | null): void {
  const mgr = () => ModelManager.getInstance(app.getPath('userData'))

  // ── Status ────────────────────────────────────────────────────────────────
  ipcMain.handle('model:kokoro-status', async () => {
    return { installed: mgr().isModelReady(), downloading: downloadInProgress }
  })

  // ── Preflight — zero network, returns manifest info only ──────────────────
  ipcMain.handle('model:kokoro-preflight', async () => {
    return {
      commit: HF_COMMIT,
      manifestVersion: KOKORO_MANIFEST_VERSION,
      totalSize: TOTAL_SIZE_LABEL,
      destination: mgr().modelDir,
      artifacts: KOKORO_ARTIFACTS.map(a => ({
        filename: a.filename,
        sha256: a.sha256,
        sizeMB: (a.sizeBytes / 1_048_576).toFixed(1),
      })),
    }
  })

  // ── Download — only starts after explicit renderer confirmation ───────────
  ipcMain.handle('model:kokoro-download', async (event) => {
    if (downloadInProgress) {
      throw new Error('A download is already in progress.')
    }
    downloadInProgress = true

    // Capture the sender's webContents id so progress goes only to that window.
    const senderId = event.sender.id

    const sendProgress = (payload: unknown) => {
      const win = getWindow()
      if (win && win.webContents.id === senderId && !win.webContents.isDestroyed()) {
        win.webContents.send('model:kokoro-progress', payload)
      }
    }

    try {
      await mgr().downloadKokoro(sendProgress)
    } finally {
      downloadInProgress = false
    }
  })
}
