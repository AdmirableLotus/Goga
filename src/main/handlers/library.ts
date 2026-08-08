import type { IpcMain } from 'electron'
import { dialog } from 'electron'
import { LibraryService } from '../services/library'
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
}
