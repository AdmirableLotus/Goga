import type { IpcMain } from 'electron'
import { SecurityWorkspaceService } from '../services/securityWorkspace'
import { HackerOneService } from '../services/hackerOne'
import { ToolRegistry } from '../tools/registry'
import { emergencyStop } from '../services/emergencyStop'
import { githubRepo } from '../services/securityCode'
import { inventoryTools, readResearch, searchResearch } from '../services/securityGuide'
import type { SecurityFinding, EvidenceEntry, SecurityWorkspace } from '../../shared/types'

export function registerSecurityHandlers(ipcMain: IpcMain) {
  const svc = SecurityWorkspaceService.getInstance()
  const hackerOne = HackerOneService.getInstance()
  ipcMain.handle('security:research', (_e, url: string) => readResearch(url))
  ipcMain.handle('security:searchResearch', (_e, query: string, kind: 'programs' | 'disclosures') => searchResearch(query, kind))
  ipcMain.handle('security:inventory', () => inventoryTools())
  ipcMain.handle('security:refreshPolicy', async (_e, id: string) => {
    const ws = svc.get(id)
    if (!ws?.hackerOne) throw new Error('Import a HackerOne program first')
    // Revoke grants before network I/O; a failed refresh must not preserve approval.
    emergencyStop('Program policy refresh')
    svc.beginPolicyRefresh(id)
    return svc.refreshPolicy(id, await hackerOne.importProgram(ws.hackerOne.handle))
  })
  ipcMain.handle('security:reviewPolicy', (_e, id: string, fingerprint: string, answers: string[]) => svc.reviewPolicy(id, fingerprint, answers))
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

  ipcMain.handle('security:checkScope', (_e, workspaceId: string, target: string) => {
    // A source-code asset is reviewed by copying and reading it, never by requests to its host.
    const ws = svc.get(workspaceId), repo = githubRepo(target)
    if (ws && repo && svc.codeRepos(ws).includes(repo)) return { inScope: true, reason: `Eligible source-code asset: ${repo}. Goga reviews it with its code tools (copy and read); requests to github.com stay out of scope.` }
    return svc.checkScope(workspaceId, target)
  })
}
