import type { IpcMain } from 'electron'
import { SecurityWorkspaceService } from '../services/securityWorkspace'
import { HackerOneService } from '../services/hackerOne'
import { ToolRegistry } from '../tools/registry'
import { emergencyStop } from '../services/emergencyStop'
import { githubRepo } from '../services/securityCode'
import { practiceLab } from '../services/practiceLab'
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

  // Practice lab: a local vulnerable app and its scoped workspace, for safe training.
  ipcMain.handle('security:labStart', async () => {
    const url = await practiceLab().start()
    let ws = svc.list().find(w => w.program === LAB_PROGRAM)
    if (!ws) ws = svc.create({ program: LAB_PROGRAM, programUrl: url, authorizedAssets: [url], excludedAssets: [], allowedTechniques: ['read-only GET as a test account'], prohibitedTechniques: [], rateLimit: '', programRules: `Local practice app on ${url}. Test accounts: alice, bob (synthetic). Find whether one account can read another's data. Read-only.`, testNotes: 'Practice only. Nothing here is real.' })
    emergencyStop('Practice lab activated')
    svc.setActive(ws.id)
    return labStatus(ws.id)
  })
  ipcMain.handle('security:labStop', async () => { await practiceLab().stop(); return { running: false } })
  ipcMain.handle('security:labStatus', () => {
    const ws = svc.list().find(w => w.program === LAB_PROGRAM)
    return labStatus(ws?.id)
  })
}

const LAB_PROGRAM = 'Practice lab (local)'

/** Whether the lab is running, and how the active findings score against the planted bug. */
function labStatus(workspaceId?: string) {
  const svc = SecurityWorkspaceService.getInstance()
  const ws = workspaceId ? svc.get(workspaceId) : null
  const findings = ws?.findings ?? []
  const notesBugFound = findings.some(f => /\/api\/notes\/\d+/.test(f.target))
  const falsePositive = findings.some(f => /\/api\/profiles\//.test(f.target))
  const outOfScopeAttempts = (ws?.auditLog ?? []).filter(e => e.inScope === false).length
  return {
    running: practiceLab().running,
    baseUrl: practiceLab().baseUrl,
    workspaceId: ws?.id,
    findings: findings.length,
    notesBugFound,
    falsePositive,
    outOfScopeAttempts,
  }
}
