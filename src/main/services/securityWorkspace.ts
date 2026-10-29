import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { SecurityWorkspace, SecurityFinding, EvidenceEntry, SecurityAuditEntry } from '../../shared/types'
import { nanoid } from '../utils/nanoid'
import { LogService } from './logs'
import { matchesSecurityAsset, securityActionTarget } from './securityScope'
import { policyFingerprint } from './securityGuide'
import { githubRepo } from './securityCode'
import { POLICY_TOPICS } from '../../shared/securityGuide'

const POLICY_REVIEW_NEEDED = 'The program policy review is not finished. In the Security tab, open Program policy review, click "Refresh policy and scope", fill in all 7 checklist topics (a quote from the policy, or "not specified"), then click "Save reviewed checklist". It expires after 24 hours.'

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
      policyReview: undefined,
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

  beginPolicyRefresh(id: string) {
    const ws = this.get(id)
    if (!ws?.hackerOne) throw new Error('Imported workspace required')
    this.invalidateApprovals()
    ws.policyReview = undefined
    this.save()
  }

  refreshPolicy(id: string, imported: Awaited<ReturnType<import('./hackerOne').HackerOneService['importProgram']>>): SecurityWorkspace {
    const ws = this.get(id)
    if (!ws?.hackerOne || ws.hackerOne.handle !== imported.hackerOne.handle) throw new Error('Matching imported workspace required')
    const previous = policyFingerprint(ws)
    const next = policyFingerprint(imported)
    this.invalidateApprovals()
    Object.assign(ws, imported, { testNotes: ws.testNotes, updatedAt: Date.now(), policyReview: { fingerprint: next, refreshedAt: Date.now(), changed: previous !== next, answers: [] } })
    this.save()
    this.logAudit(id, { tool: 'policy.refresh', target: ws.programUrl, params: {}, result: previous === next ? 'Policy unchanged; review required' : 'Policy or scope changed; review required', inScope: true })
    return ws
  }

  reviewPolicy(id: string, fingerprint: string, answers: string[]): SecurityWorkspace {
    const ws = this.get(id)
    if (!ws?.policyReview || ws.policyReview.fingerprint !== fingerprint || policyFingerprint(ws) !== fingerprint || Date.now() - ws.policyReview.refreshedAt > 86_400_000) throw new Error('Refresh current policy before review')
    if (!Array.isArray(answers) || answers.length !== POLICY_TOPICS.length || answers.some(a => typeof a !== 'string' || !a.trim() || a.length > 4000)) throw new Error('Record a policy passage or explicit uncertainty for every checklist topic')
    this.invalidateApprovals()
    ws.policyReview = { ...ws.policyReview, answers: answers.map(a => a.trim()), reviewedAt: Date.now() }
    this.save()
    this.logAudit(id, { tool: 'policy.review', target: ws.programUrl, params: {}, result: 'Checklist reviewed; individual testing approvals still required', inScope: true })
    return ws
  }

  /** What the chat brain must know in security mode, so it does not invent progress it has not made. */
  chatStatus(): string | null {
    const ws = this.getActive()
    if (!ws) return null
    const reviewed = !ws.hackerOne || (!!ws.policyReview?.reviewedAt && Date.now() - ws.policyReview.refreshedAt <= 86_400_000 && ws.policyReview.fingerprint === policyFingerprint(ws))
    const repos = this.codeRepos(ws)
    return [
      `SECURITY MODE is on: workspace "${ws.program}". In scope: ${ws.authorizedAssets.join(', ') || 'nothing yet'}.`,
      reviewed ? 'The program policy review is done.' : `Not ready to test: ${POLICY_REVIEW_NEEDED}`,
      repos.length ? `In-scope source code (${repos.join(', ')}) is reviewed by copying it with security.code.fetch (approved in the approval prompt or the Approvals tab, never by typing "approved" in chat), then searching and reading the copy. Nothing from it is run.` : '',
      `In security mode you cannot use the browser, a terminal, the keyboard or mouse, or download software. You have not read any code unless a tool result in this conversation shows it: never describe a project's language, files, endpoints or bugs from memory, and never say you are fetching, cloning or opening something. To start the review, tell the user to ask, for example: "review the repository for the bounty".`,
    ].filter(Boolean).join('\n')
  }

  /** The GitHub repositories this workspace lists as eligible source-code assets. */
  codeRepos(ws: SecurityWorkspace): string[] {
    const assets = ws.hackerOne
      ? ws.hackerOne.scopes.filter(s => s.eligible && s.type === 'SOURCE_CODE').map(s => s.identifier)
      : ws.authorizedAssets.filter(a => !ws.excludedAssets.some(x => githubRepo(x) === githubRepo(a)))
    // A scope entry is a repository only when it names github.com itself.
    return [...new Set(assets.filter(a => /^(https?:\/\/)?(www\.)?github\.com\//i.test(a.trim())).map(githubRepo).filter((r): r is string => !!r))]
  }

  /** The repository a code tool works on: the one named, or the only one in scope. */
  codeRepo(ws: SecurityWorkspace, requested: unknown): { repo: string | null; reason: string } {
    const repos = this.codeRepos(ws)
    if (requested === undefined || requested === '') {
      return repos.length === 1 ? { repo: repos[0], reason: `Eligible source-code asset: ${repos[0]}` }
        : { repo: null, reason: repos.length ? `Name the repository: ${repos.join(', ')}` : 'This workspace has no GitHub source-code asset in scope' }
    }
    const repo = githubRepo(requested)
    // Not a repository address at all (a folder name, "."): the tools can only ever use the one in scope.
    if (!repo && repos.length === 1) return { repo: repos[0], reason: `Eligible source-code asset: ${repos[0]}` }
    if (!repo) return { repo: null, reason: `"${String(requested).slice(0, 80)}" is not a repository. Give it as https://github.com/owner/name: ${repos.join(', ') || 'none in scope'}` }
    return repos.includes(repo) ? { repo, reason: `Eligible source-code asset: ${repo}` }
      : { repo: null, reason: `${repo} is not an eligible source-code asset in this workspace` }
  }

  evaluateAction(tool: string, params: Record<string, unknown>, workspaceId?: string): { allowed: boolean; reason: string; target: string; approval?: boolean } {
    const active = this.getActive()
    if (!active || (workspaceId && workspaceId !== active.id)) return { allowed: false, reason: 'An active matching security workspace is required', target: '' }
    if (tool.startsWith('security.code.')) return this.evaluateCodeAction(active, tool, params)
    const target = securityActionTarget(tool, params)
    if (!target) return { allowed: false, reason: 'Blocked: missing verifiable target or unsupported security action. This release permits only individually approved web.fetch requests; shell, scans, browser navigation and desktop inputs are disabled in security mode.', target: '' }
    if (active.hackerOne && (!active.policyReview?.reviewedAt || Date.now() - active.policyReview.refreshedAt > 86_400_000 || active.policyReview.fingerprint !== policyFingerprint(active))) return { allowed: false, reason: 'Refresh and review program policy before testing (review expires after 24 hours)', target }
    const scope = this.checkScope(active.id, target)
    return { allowed: scope.inScope, reason: scope.reason, target }
  }

  // Copying the repository reaches the network and needs the same approval as a request;
  // reading the copy on this computer touches nothing outside it, so it runs without one.
  private evaluateCodeAction(active: SecurityWorkspace, tool: string, params: Record<string, unknown>) {
    const { repo, reason } = this.codeRepo(active, params.repo)
    if (!repo) return { allowed: false, reason, target: '' }
    if (tool === 'security.code.fetch') {
      if (active.hackerOne && (!active.policyReview?.reviewedAt || Date.now() - active.policyReview.refreshedAt > 86_400_000 || active.policyReview.fingerprint !== policyFingerprint(active))) return { allowed: false, reason: POLICY_REVIEW_NEEDED, target: repo }
      if (active.hackerOne && active.hackerOne.submissionState !== 'open') return { allowed: false, reason: 'Imported program is not open for submissions', target: repo }
      return { allowed: true, reason, target: repo }
    }
    if (['security.code.list', 'security.code.search', 'security.code.read', 'security.code.draftFinding'].includes(tool)) return { allowed: true, reason: `Local read of ${repo}`, target: repo, approval: false }
    return { allowed: false, reason: `Unknown code tool: ${tool}`, target: repo }
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
    const approved = decision.allowed && (decision.approval === false || grant && grant.epoch === this.approvalEpoch && grant.workspaceId === active?.id && grant.tool === tool && grant.params === JSON.stringify(params))
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
