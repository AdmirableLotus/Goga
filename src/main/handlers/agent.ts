import type { IpcMain } from 'electron'
import { AgentLoop } from '../services/agentLoop'
import { LogService } from '../services/logs'
import { getMainWindow } from '../index'
import { nanoid } from '../utils/nanoid'
import type { ChatMessage } from '../../shared/types'

// Built on first use: `agentLoop` imports `../index`, which imports this handler, so a
// module-scope instance would be constructed while AgentLoop is still half-loaded.
let agentInstance: AgentLoop | null = null
function agentLoop(): AgentLoop {
  if (!agentInstance) agentInstance = AgentLoop.getInstance()
  return agentInstance
}
const log = LogService.getInstance()

export function registerAgentHandlers(ipcMain: IpcMain) {
  // Start an autonomous agent task — returns immediately, pushes agent:step events
  ipcMain.handle('agent:start', async (_e, task: string) => {
    log.info(`agent:start — ${task.slice(0, 80)}`)

    // Run in background, push final reply as a chat message when done
    agentLoop().run(task).then((reply) => {
      const msg: ChatMessage = {
        id: nanoid(),
        role: 'assistant',
        content: reply,
        timestamp: Date.now()
      }
      getMainWindow()?.webContents.send('chat:message', msg)
    }).catch((err) => {
      const msg: ChatMessage = {
        id: nanoid(),
        role: 'assistant',
        content: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now()
      }
      getMainWindow()?.webContents.send('chat:message', msg)
    })
  })

  ipcMain.handle('agent:stop', async () => {
    agentLoop().stop('Stopped by user')
  })

  ipcMain.handle('agent:state', async () => {
    return agentLoop().getState()
  })

  // Called by ApprovalsPage when user approves/rejects an agent-requested action
  // The existing action:approve/reject handlers in actions.ts handle the ActionStore side;
  // we additionally need to unblock the agent's approval promise.
  ipcMain.on('agent:resolveApproval', (_e, actionId: string, approved: boolean) => {
    agentLoop().resolveApproval(actionId, approved)
  })
}
