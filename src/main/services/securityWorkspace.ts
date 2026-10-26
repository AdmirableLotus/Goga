import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { SecurityWorkspace, SecurityFinding, EvidenceEntry, SecurityAuditEntry } from '../../shared/types'
import { nanoid } from '../utils/nanoid'
import { LogService } from './logs'
import { matchesSecurityAsset, securityActionTarget } from './securityScope'

interface WorkspaceStore {
  workspaces: SecurityWorkspace[]
  activeWorkspaceId: string | null
}

export class SecurityWorkspaceService {
  private static instance: SecurityWorkspaceService
  private store: WorkspaceStore = { workspaces: [], activeWorkspaceId: null }
  private filePath: string
  private log = LogService.getInstance()
  private approvalEpoch = 0
  private approvals = new WeakMap<object, { epoch: number; workspaceId: string; tool: string; params: string }>()

  static getInstance() {
    if (!SecurityWorkspaceService.instance) SecurityWorkspaceService.instance = new SecurityWorkspaceService()
    return SecurityWorkspaceService.instance
  }

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'goga-security-workspaces.json')
    this.load()
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.store = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      }
    } catch { this.store = { workspaces: [], activeWorkspaceId: null } }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2))
  }

  list(): SecurityWorkspace[] { return [...this.store.workspaces] }

  get(id: string): SecurityWorkspace | null {
    return this.store.workspaces.find(w => w.id === id) ?? null
  }

  getActive(): SecurityWorkspace | null {
    if (!this.store.activeWorkspaceId) return null
    return this.get(this.store.activeWorkspaceId)
  }

  setActive(id: string | null) {
    if (id && !this.get(id)) throw new Error('Workspace not found')
    this.invalidateApprovals()
    this.store.activeWorkspaceId = id
    this.save()
    if (id) this.log.info(`Security workspace activated: ${this.get(id)?.program}`)
    else this.log.info('Security workspace deactivated — normal mode')
  }

  create(data: Omit<SecurityWorkspace, 'id' | 'findings' | 'evidence' | 'auditLog' | 'createdAt' | 'updatedAt'>, trustedImport = false): SecurityWorkspace {
    if (data.hackerOne && !trustedImport) throw new Error('HackerOne scope must be imported through the official API')
    const ws: SecurityWorkspace = {
      ...data,
      id: nanoid(),
      findings: [],
      evidence: [],
      auditLog: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.store.workspaces.push(ws)
    this.save()
    this.log.info(`Security workspace created: ${ws.program}`)
    return ws
  }

  update(id: string, patch: Partial<SecurityWorkspace>): SecurityWorkspace {
    this.invalidateApprovals()
    const idx = this.store.workspaces.findIndex(w => w.id === id)
    if (idx === -1) throw new Error(`Workspace not found: ${id}`)
    const allowed = this.store.workspaces[idx].hackerOne ? ['testNotes'] : ['program', 'programUrl', 'authorizedAssets', 'excludedAssets', 'allowedTechniques', 'prohibitedTechniques', 'rateLimit', 'programRules', 'testNotes']
    if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Imported policy, scope, audit and report records cannot be overwritten')
    this.store.workspaces[idx] = { ...this.store.workspaces[idx], ...patch, updatedAt: Date.now() }
    this.save()
    return this.store.workspaces[idx]
  }

  delete(id: string) {
    this.invalidateApprovals()
    this.store.workspaces = this.store.workspaces.filter(w => w.id !== id)
    if (this.store.activeWorkspaceId === id) this.store.activeWorkspaceId = null
    this.save()
  }

  addFinding(workspaceId: string, data: Omit<SecurityFinding, 'id' | 'createdAt' | 'updatedAt'>): SecurityFinding {
    const ws = this.get(workspaceId)
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`)
    const finding: SecurityFinding = { ...data, status: 'draft', id: nanoid(), createdAt: Date.now(), updatedAt: Date.now() }
    ws.findings.push(finding)
    ws.updatedAt = Date.now()
    this.save()
    this.log.info(`Finding added [${finding.severity}]: ${finding.title}`)
    return finding
  }

  addEvidence(workspaceId: string, data: Omit<EvidenceEntry, 'id' | 'createdAt'>): EvidenceEntry {
    const ws = this.get(workspaceId)
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`)
    const entry: EvidenceEntry = { ...data, id: nanoid(), createdAt: Date.now() }
    ws.evidence.push(entry)
    ws.updatedAt = Date.now()
    this.save()
    return entry
  }

  logAudit(workspaceId: string, entry: Omit<SecurityAuditEntry, 'id' | 'timestamp'>) {
    const ws = this.get(workspaceId)
    if (!ws) return
    ws.auditLog.push({ ...entry, id: nanoid(), timestamp: Date.now() })
    // Keep audit log bounded
    if (ws.auditLog.length > 5000) ws.auditLog = ws.auditLog.slice(-5000)
    ws.updatedAt = Date.now()
    this.save()
  }

  invalidateApprovals() { this.approvalEpoch++ }

  evaluateAction(tool: string, params: Record<string, unknown>, workspaceId?: string): { allowed: boolean; reason: string; target: string } {
    const active = this.getActive()
    if (!active || (workspaceId && workspaceId !== active.id)) return { allowed: false, reason: 'An active matching security workspace is required', target: '' }
    const target = securityActionTarget(tool, params)
    if (!target) return { allowed: false, reason: 'Blocked: missing verifiable target or unsupported security action. This release permits only individually approved web.fetch requests; shell, scans, browser navigation and desktop inputs are disabled in security mode.', target: '' }
    const scope = this.checkScope(active.id, target)
    return { allowed: scope.inScope, reason: scope.reason, target }
  }

  issueApproval(workspaceId: string, tool: string, params: Record<string, unknown>): object {
    const decision = this.evaluateAction(tool, params, workspaceId)
    if (!decision.allowed) throw new Error(decision.reason)
    const ticket = Object.freeze({})
    this.approvals.set(ticket, { epoch: this.approvalEpoch, workspaceId, tool, params: JSON.stringify(params) })
    this.logAudit(workspaceId, { tool, target: decision.target, params: {}, result: 'explicit approval granted', inScope: true })
    return ticket
  }

  enforceDispatch(tool: string, params: Record<string, unknown>, workspaceId?: string, ticket?: object): string | null {
    const active = this.getActive()
    if (!active && !workspaceId) return null
    const decision = this.evaluateAction(tool, params, workspaceId)
    const grant = ticket ? this.approvals.get(ticket) : undefined
    if (ticket) this.approvals.delete(ticket)
    const approved = decision.allowed && grant && grant.epoch === this.approvalEpoch && grant.workspaceId === active?.id && grant.tool === tool && grant.params === JSON.stringify(params)
    const reason = !decision.allowed ? decision.reason : !approved ? 'Fresh explicit security approval required' : null
    if (active) this.logAudit(active.id, { tool, target: decision.target, params: {}, result: reason ? `blocked: ${reason}` : 'approved dispatch', inScope: decision.allowed })
    return reason
  }

  // ── Scope checking ────────────────────────────────────────────────────────

  checkScope(workspaceId: string, target: string): { inScope: boolean; reason: string; ambiguous: boolean } {
    const ws = this.get(workspaceId)
    if (!ws) return { inScope: false, reason: 'Workspace not found', ambiguous: false }
    if (typeof target !== 'string' || !target.trim()) return { inScope: false, reason: 'Explicit target required', ambiguous: false }
    if (ws.hackerOne) {
      if (ws.hackerOne.submissionState !== 'open') return { inScope: false, reason: 'Imported program is not open for submissions', ambiguous: false }
      const supported = new Set(['URL', 'WILDCARD', 'IP_ADDRESS', 'CIDR'])
      const matches = ws.hackerOne.scopes.filter(scope => supported.has(scope.type) && matchesSecurityAsset(target, scope.identifier))
      if (matches.some(scope => !scope.eligible)) return { inScope: false, reason: 'Target is explicitly ineligible for submission', ambiguous: false }
      const eligible = matches.find(scope => scope.eligible)
      return eligible ? { inScope: true, reason: `Eligible imported asset: ${eligible.identifier}`, ambiguous: false }
        : { inScope: false, reason: 'Target is not an explicitly eligible supported asset in the imported scope', ambiguous: false }
    }

    const normalised = target.toLowerCase().trim()

    // Check exclusions first
    for (const excluded of ws.excludedAssets) {
      if (matchesSecurityAsset(normalised, excluded.toLowerCase())) {
        return { inScope: false, reason: `Target matches excluded asset: ${excluded}`, ambiguous: false }
      }
    }

    // Check authorized assets
    for (const asset of ws.authorizedAssets) {
      if (matchesSecurityAsset(normalised, asset.toLowerCase())) {
        return { inScope: true, reason: `Matches authorized asset: ${asset}`, ambiguous: false }
      }
    }

    // Not explicitly listed — ambiguous
    return {
      inScope: false,
      reason: `Target "${target}" is not in the authorized scope for "${ws.program}". Authorized: ${ws.authorizedAssets.join(', ')}`,
      ambiguous: true
    }
  }

}
