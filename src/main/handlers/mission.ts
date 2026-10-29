import type { IpcMain } from 'electron'
import { MissionEngine, isMissionEngineEnabled } from '../services/missionEngine'
import { LogService } from '../services/logs'
import { getMainWindow } from '../index'

const log = LogService.getInstance()

export function registerMissionHandlers(ipcMain: IpcMain) {
  const engine = MissionEngine.getInstance()

  // Forward mission events to renderer
  engine.on('mission:event', (evt) => {
    getMainWindow()?.webContents.send('mission:event', evt)
  })

  // The tab is only shown while the experimental engine is on; Chat does multi-step tasks.
  ipcMain.handle('mission:enabled', async () => isMissionEngineEnabled())

  ipcMain.handle('mission:start', async (_e, goal: string) => {
    if (!isMissionEngineEnabled()) {
      throw new Error('MissionEngine is disabled. Set GOGA_MISSION_ENGINE=true to enable.')
    }
    log.info(`mission:start — ${goal.slice(0, 80)}`)
    return engine.start(goal)
  })

  ipcMain.handle('mission:stop', async (_e, missionId: string) => {
    engine.stop(missionId)
  })

  ipcMain.handle('mission:state', async (_e, missionId: string) => {
    return engine.getMission(missionId)
  })

  ipcMain.handle('mission:list', async () => {
    return engine.listMissions()
  })

  ipcMain.on('mission:resolveApproval', (_e, missionId: string, approved: boolean) => {
    engine.resolveApproval(missionId, approved)
  })
}
