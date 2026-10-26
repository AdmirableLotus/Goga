import { app, dialog, type IpcMain } from 'electron'
import { DeveloperService } from '../services/developer'
import { getMainWindow } from '../index'

let service: DeveloperService | undefined
export function stopDeveloperTask() { service?.stop() }

export function registerDeveloperHandlers(ipcMain: IpcMain) {
  const developer = new DeveloperService(state => getMainWindow()?.webContents.send('developer:state', state))
  service = developer
  void developer.detect().catch(() => {})
  ipcMain.handle('developer:state', () => developer.getState())
  ipcMain.handle('developer:self', () => {
    if (app.isPackaged) throw new Error('Open Goga’s source folder with Choose project; the installed app contains compiled files.')
    return developer.selectProject(app.getAppPath())
  })
  ipcMain.handle('developer:choose', async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose a source project', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return developer.getState()
    return developer.selectProject(result.filePaths[0])
  })
  ipcMain.handle('developer:refresh', () => developer.refresh())
  ipcMain.handle('developer:start', (_event, task: string, mode: 'plan' | 'build') => developer.start(task, mode))
  ipcMain.handle('developer:stop', () => { developer.stop(); return developer.getState() })
}
