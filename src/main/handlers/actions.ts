import type { IpcMain } from 'electron'
import { ActionStore } from '../services/actionStore'
import { LogService } from '../services/logs'
import { OrchestratorService } from '../services/orchestrator'
import { AgentLoop } from '../services/agentLoop'
import { getMainWindow } from '../index'

const store = ActionStore.getInstance()
const log = LogService.getInstance()
const orchestrator = new OrchestratorService()

export function registerActionHandlers(ipcMain: IpcMain) {
  ipcMain.handle('actions:list', async () => store.list())

  ipcMain.handle('action:approve', async (_e, actionId: string) => {
    const action = store.approve(actionId)
    log.info(`Action approved: ${action.label}`, { actionId })
    // Unblock agent loop approval gate
    AgentLoop.getInstance().resolveApproval(actionId, true)
    // Execute legacy desktop actions (non-agent path)
    orchestrator.executeAction(action).then(() => {
      getMainWindow()?.webContents.send('action:update', store.get(actionId))
    }).catch(() => {
      getMainWindow()?.webContents.send('action:update', store.get(actionId))
    })
    return action
  })

  ipcMain.handle('action:reject', async (_e, actionId: string) => {
    const action = store.reject(actionId)
    log.info(`Action rejected: ${action.label}`, { actionId })
    // Unblock agent loop approval gate with rejection
    AgentLoop.getInstance().resolveApproval(actionId, false)
    return action
  })

  ipcMain.handle('action:stop', async () => {
    store.stopAll()
    AgentLoop.getInstance().stop('Stopped by user')
    log.warn('All actions stopped by user')
  })
}
