import type { IpcMain } from 'electron'
import { SecurityWorkspaceService } from '../services/securityWorkspace'
import type { SecurityFinding, EvidenceEntry, SecurityWorkspace } from '../../shared/types'

const svc = SecurityWorkspaceService.getInstance()

export function registerSecurityHandlers(ipcMain: IpcMain) {
  ipcMain.handle('security:list', () => svc.list())
  ipcMain.handle('security:get', (_e, id: string) => svc.get(id))
  ipcMain.handle('security:getActive', () => svc.getActive())
  ipcMain.handle('security:setActive', (_e, id: string | null) => svc.setActive(id))

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
