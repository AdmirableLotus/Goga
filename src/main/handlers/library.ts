import fs from 'fs'
import path from 'path'
import type { IpcMain } from 'electron'
import { dialog } from 'electron'
import { LibraryService } from '../services/library'
import { downloadDocument, githubDocs } from '../services/webLibrary'
import { getMainWindow } from '../index'

const library = LibraryService.getInstance()

export function registerLibraryHandlers(ipcMain: IpcMain) {
  ipcMain.handle('library:ingest', async (_e, filePath?: string) => {
    let target = filePath
    if (!target) {
      const win = getMainWindow()
      const result = await dialog.showOpenDialog(win!, {
        title: 'Add book to Goga',
        filters: [
          { name: 'Books & Documents', extensions: ['pdf', 'txt', 'epub'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) throw new Error('No file selected')
      target = result.filePaths[0]
    }
    return library.ingest(target)
  })

  ipcMain.handle('library:list', async () => library.list())

  ipcMain.handle('library:delete', async (_e, bookId: string) => library.delete(bookId))

  ipcMain.handle('library:search', async (_e, query: string, topK?: number) =>
    library.search(query, topK)
  )

  // Read from the web: list a GitHub repo's documents, or import one by URL.
  ipcMain.handle('library:listRepo', async (_e, repoUrl: string) => githubDocs(repoUrl))
  ipcMain.handle('library:importUrl', async (_e, url: string) => {
    const file = await downloadDocument(url)
    try { return await library.ingest(file) }
    finally { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }) } catch { /* temp */ } }
  })
}
