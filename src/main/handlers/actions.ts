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
    // ── Guard: unknown action ─────────────────────────────────────────────
    let action
    try {
      action = store.get(actionId)
    } catch {
      log.warn(`action:approve ignored — unknown actionId: ${actionId}`)
      return null
    }

    // ── Guard: already resolved, cancelled, or completed ─────────────────
    // Duplicate approvals (e.g. UI double-click, retry after Stop) must be
    // silently dropped. Only 'pending' actions may be approved.
    if (action.status !== 'pending') {
      log.warn(`action:approve ignored — action ${actionId} is already ${action.status}`)
      return action
    }

    // ── Guard: agent stopped before approval arrived ──────────────────────
    // If the agent is no longer running (stopped/done/error/idle) and this
    // action is agent-owned, the approval is stale — the agent loop has
    // already exited and there is no pending promise to resolve.
    if (action.agentOwned && !AgentLoop.getInstance().isRunning()) {
      log.warn(`action:approve ignored — agent-owned action ${actionId} arrived after agent stopped`)
      store.reject(actionId)
      getMainWindow()?.webContents.send('action:update', store.get(actionId))
      return action
    }

    // ── Approve in store ──────────────────────────────────────────────────
    store.approve(actionId)
    log.info(`Action approved: ${action.label}`, { actionId, agentOwned: action.agentOwned })

    if (action.agentOwned) {
      // ── Agent-owned path: unblock the agent loop gate only ───────────────
      // The agent loop will execute the tool itself via the registry.
      // desktop.execute must NOT be called here — that would run the action twice.
      AgentLoop.getInstance().resolveApproval(actionId, true)
    } else {
      // ── Legacy path: execute via desktop adapter directly ─────────────────
      // These are actions created outside the agent loop (e.g. direct UI
      // actions from the Approvals panel). resolveApproval must NOT be called
      // here — there is no pending agent promise to resolve.
      orchestrator.executeAction(action).then(() => {
        getMainWindow()?.webContents.send('action:update', store.get(actionId))
      }).catch(() => {
        getMainWindow()?.webContents.send('action:update', store.get(actionId))
      })
    }

    return action
  })

  ipcMain.handle('action:reject', async (_e, actionId: string) => {
    let action
    try {
      action = store.get(actionId)
    } catch {
      log.warn(`action:reject ignored — unknown actionId: ${actionId}`)
      return null
    }

    if (action.status !== 'pending') {
      log.warn(`action:reject ignored — action ${actionId} is already ${action.status}`)
      return action
    }

    store.reject(actionId)
    log.info(`Action rejected: ${action.label}`, { actionId })
    // Unblock agent loop gate with rejection (no-op if not agent-owned)
    AgentLoop.getInstance().resolveApproval(actionId, false)
    return action
  })

  ipcMain.handle('action:stop', async () => {
    store.stopAll()
    AgentLoop.getInstance().stop('Stopped by user')
    log.warn('All actions stopped by user')
  })
}
