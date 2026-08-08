import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { SecurityWorkspace, SecurityFinding, EvidenceEntry, SecurityAuditEntry } from '../../shared/types'
import { nanoid } from '../utils/nanoid'
import { LogService } from './logs'

interface WorkspaceStore {
  workspaces: SecurityWorkspace[]
  activeWorkspaceId: string | null
}

export class SecurityWorkspaceService {
  private static instance: SecurityWorkspaceService
  private store: WorkspaceStore = { workspaces: [], activeWorkspaceId: null }
  private filePath: string
  private log = LogService.getInstance()

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
    try { fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2)) } catch { /* ignore */ }
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
    this.store.activeWorkspaceId = id
    this.save()
    if (id) this.log.info(`Security workspace activated: ${this.get(id)?.program}`)
    else this.log.info('Security workspace deactivated — normal mode')
  }

  create(data: Omit<SecurityWorkspace, 'id' | 'findings' | 'evidence' | 'auditLog' | 'createdAt' | 'updatedAt'>): SecurityWorkspace {
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
    const idx = this.store.workspaces.findIndex(w => w.id === id)
    if (idx === -1) throw new Error(`Workspace not found: ${id}`)
    this.store.workspaces[idx] = { ...this.store.workspaces[idx], ...patch, updatedAt: Date.now() }
    this.save()
    return this.store.workspaces[idx]
  }

  delete(id: string) {
    this.store.workspaces = this.store.workspaces.filter(w => w.id !== id)
    if (this.store.activeWorkspaceId === id) this.store.activeWorkspaceId = null
    this.save()
  }

  addFinding(workspaceId: string, data: Omit<SecurityFinding, 'id' | 'createdAt' | 'updatedAt'>): SecurityFinding {
    const ws = this.get(workspaceId)
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`)
    const finding: SecurityFinding = { ...data, id: nanoid(), createdAt: Date.now(), updatedAt: Date.now() }
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

  // ── Scope checking ────────────────────────────────────────────────────────

  checkScope(workspaceId: string, target: string): { inScope: boolean; reason: string; ambiguous: boolean } {
    const ws = this.get(workspaceId)
    if (!ws) return { inScope: false, reason: 'Workspace not found', ambiguous: false }

    const normalised = target.toLowerCase().trim()

    // Check exclusions first
    for (const excluded of ws.excludedAssets) {
      if (this.matchAsset(normalised, excluded.toLowerCase())) {
        return { inScope: false, reason: `Target matches excluded asset: ${excluded}`, ambiguous: false }
      }
    }

    // Check authorized assets
    for (const asset of ws.authorizedAssets) {
      if (this.matchAsset(normalised, asset.toLowerCase())) {
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

  private matchAsset(target: string, pattern: string): boolean {
    // Exact match
    if (target === pattern) return true

    // Wildcard glob: *.example.com matches sub.example.com
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // .example.com
      return target.endsWith(suffix) || target === pattern.slice(2)
    }

    // CIDR range check (basic IPv4)
    if (pattern.includes('/')) {
      return this.ipInCidr(target, pattern)
    }

    // URL — extract hostname and compare
    try {
      const url = new URL(target.startsWith('http') ? target : `https://${target}`)
      return this.matchAsset(url.hostname, pattern)
    } catch { /* not a URL */ }

    return false
  }

  private ipInCidr(ip: string, cidr: string): boolean {
    try {
      const [range, bits] = cidr.split('/')
      const mask = ~(0xffffffff >>> parseInt(bits)) >>> 0
      const ipNum = this.ipToNum(ip)
      const rangeNum = this.ipToNum(range)
      return (ipNum & mask) === (rangeNum & mask)
    } catch { return false }
  }

  private ipToNum(ip: string): number {
    return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet), 0) >>> 0
  }
}
