import type { IpcMain } from 'electron'
import { SecurityWorkspaceService } from '../services/securityWorkspace'
import { HackerOneService } from '../services/hackerOne'
import { ToolRegistry } from '../tools/registry'
import { emergencyStop } from '../services/emergencyStop'
import type { SecurityFinding, EvidenceEntry, SecurityWorkspace } from '../../shared/types'

export function registerSecurityHandlers(ipcMain: IpcMain) {
  const svc = SecurityWorkspaceService.getInstance()
  const hackerOne = HackerOneService.getInstance()
  ToolRegistry.getInstance().setSecurityBoundary((tool, params, ctx) => svc.enforceDispatch(tool, params, ctx.securityWorkspaceId, ctx.securityApproval))
  ipcMain.handle('security:h1Status', () => hackerOne.status())
  ipcMain.handle('security:h1SaveCredentials', (_e, username: string, token: string) => hackerOne.saveCredentials(username, token))
  ipcMain.handle('security:h1ClearCredentials', () => hackerOne.clearCredentials())
  ipcMain.handle('security:h1Import', async (_e, handle: string) => {
    const ws = svc.create(await hackerOne.importProgram(handle), true)
    svc.logAudit(ws.id, { tool: 'hackerone.import', target: ws.programUrl, params: {}, result: 'Imported policy and explicitly eligible scope; no testing started', inScope: true })
    return ws
  })
  ipcMain.handle('security:list', () => svc.list())
  ipcMain.handle('security:get', (_e, id: string) => svc.get(id))
  ipcMain.handle('security:getActive', () => svc.getActive())
  ipcMain.handle('security:setActive', (_e, id: string | null) => { emergencyStop('Security workspace changed'); svc.setActive(id) })

  ipcMain.handle('security:create', (_e, data: Omit<SecurityWorkspace, 'id' | 'findings' | 'evidence' | 'auditLog' | 'createdAt' | 'updatedAt'>) =>
    svc.create(data)
  )

  ipcMain.handle('security:update', (_e, id: string, patch: Partial<SecurityWorkspace>) =>
    svc.update(id, patch)
  )

  ipcMain.handle('security:delete', (_e, id: string) => svc.delete(id))

  ipcMain.handle('security:addFinding', (_e, workspaceId: string, finding: Omit<SecurityFinding, 'id' | 'createdAt' | 'updatedAt'>) =>
    svc.addFinding(workspaceId, finding)
  )

  ipcMain.handle('security:addEvidence', (_e, workspaceId: string, evidence: Omit<EvidenceEntry, 'id' | 'createdAt'>) =>
    svc.addEvidence(workspaceId, evidence)
  )

  ipcMain.handle('security:checkScope', (_e, workspaceId: string, target: string) =>
    svc.checkScope(workspaceId, target)
  )
}
