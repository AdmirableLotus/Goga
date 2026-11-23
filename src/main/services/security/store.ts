import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { Finding, PlatformConnection, ProgramImport, ProgramSource, SecurityAuditEntry } from '../../../shared/security'
import { nanoid } from '../../utils/nanoid'

/**
 * Local storage for imported programs, finding DRAFTS and the security audit trail.
 * Plain JSON files under the Goga user-data folder, written 0600. Nothing here is sent
 * anywhere: reports stay drafts on this machine.
 */

interface Store {
  programs: ProgramImport[]
  findings: Finding[]
  audit: SecurityAuditEntry[]
  /** Which program's scope currently governs requests. Empty means none. */
  activeProgramId: string | null
  /** What the last live call to each platform said. Written only by a real check. */
  connections: Partial<Record<ProgramSource, PlatformConnection>>
}

const MAX_AUDIT = 5000

function file(): string { return path.join(app.getPath('userData'), 'goga-security-store.json') }

function fresh(): Store { return { programs: [], findings: [], audit: [], activeProgramId: null, connections: {} } }

function load(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Store>
    return { ...fresh(), ...raw, programs: raw.programs ?? [], findings: raw.findings ?? [], audit: raw.audit ?? [], connections: raw.connections ?? {} }
  } catch { return fresh() }
}

function save(store: Store): void {
  const target = file()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export function listPrograms(): ProgramImport[] { return load().programs }

/** The last live result for each platform. Nothing here is inferred from a stored file. */
export function connections(): Partial<Record<ProgramSource, PlatformConnection>> { return load().connections }

export function recordConnection(connection: PlatformConnection): PlatformConnection {
  const s = load()
  s.connections = { ...s.connections, [connection.source]: connection }
  s.audit = [...s.audit.slice(-(MAX_AUDIT - 1)), {
    id: nanoid(), time: connection.checkedAt ?? new Date().toISOString(), kind: 'note',
    detail: `${connection.source} connection check: ${connection.state} — ${connection.detail}`,
  }]
  save(s)
  return connection
}

/** Drop a stale verdict when the credential it described is replaced or removed. */
export function clearConnectionRecord(source: ProgramSource): void {
  const s = load()
  if (!s.connections[source]) return
  const next = { ...s.connections }
  delete next[source]
  s.connections = next
  save(s)
}

/** Remember the directory listing so the Security page can offer handles without a second call. */
export function recordListing(source: ProgramSource, programs: PlatformConnection['programs'], pages: number, participating: number): PlatformConnection | null {
  const s = load()
  const existing = s.connections[source]
  if (!existing) return null
  const updated: PlatformConnection = { ...existing, programs, listedAt: new Date().toISOString() }
  s.connections = { ...s.connections, [source]: updated }
  s.audit = [...s.audit.slice(-(MAX_AUDIT - 1)), {
    id: nanoid(), time: updated.listedAt as string, kind: 'note',
    detail: `${source} program directory listed: ${programs.length} program(s) visible, ${participating} this account has submitted to (${pages} page(s))`,
  }]
  save(s)
  return updated
}

export function getProgram(id: string): ProgramImport | null {
  return load().programs.find(p => p.id === id) ?? null
}

/**
 * What the stored pointer to the active program actually means.
 *
 * Three states, because `null` alone cannot tell "nothing is imported" from "something is
 * imported but the pointer names a program that is no longer here". The second is a real state: a
 * program is re-imported under a new id and replaces the old copy, so any pointer still naming the
 * old id dangles. Reporting that as "none" would say something false — that no scope exists —
 * when programs are in fact imported and the user simply has to pick one.
 */
export type ActiveProgramState =
  | { state: 'active'; program: ProgramImport }
  | { state: 'none' }
  | { state: 'stale'; staleId: string; programCount: number }

export function activeProgramState(): ActiveProgramState {
  const s = load()
  if (!s.activeProgramId) return { state: 'none' }
  const found = s.programs.find(p => p.id === s.activeProgramId)
  if (found) return { state: 'active', program: found }
  return { state: 'stale', staleId: s.activeProgramId, programCount: s.programs.length }
}

export function activeProgram(): ProgramImport | null {
  const state = activeProgramState()
  return state.state === 'active' ? state.program : null
}

export function setActiveProgram(id: string | null): void {
  const s = load()
  if (id && !s.programs.some(p => p.id === id)) throw new Error('no such program is imported')
  s.activeProgramId = id
  s.audit.push({ id: nanoid(), time: new Date().toISOString(), kind: 'note', detail: id ? `active program set to ${s.programs.find(p => p.id === id)?.name}` : 'no active program — all requests will be refused' })
  save(s)
}

export function addProgram(program: Omit<ProgramImport, 'id' | 'importedAt'>): ProgramImport {
  const s = load()
  const full: ProgramImport = { ...program, id: nanoid(), importedAt: new Date().toISOString() }
  // Re-importing the same program replaces the old copy, so scope never goes stale in two places.
  const replaced = s.programs.find(p => p.source === full.source && p.handle === full.handle) ?? null
  s.programs = [...s.programs.filter(p => !(p.source === full.source && p.handle === full.handle)), full]
  // The pointer must follow the program it named. If the copy being replaced was the active one,
  // the stored id would otherwise name a program that no longer exists and every request would be
  // refused as "no program". Re-pointing it here keeps the user's choice across a re-import.
  if (replaced && s.activeProgramId === replaced.id) {
    s.activeProgramId = full.id
  } else if (!s.activeProgramId) {
    s.activeProgramId = full.id
  }
  s.audit.push({ id: nanoid(), time: new Date().toISOString(), kind: 'import', detail: `imported ${full.source} ${full.handle}: ${full.assets.filter(a => a.eligibleForSubmission).length} eligible asset(s), ${full.assets.filter(a => !a.eligibleForSubmission).length} deny rule(s), ${full.exclusions.length} exclusion(s)` })
  save(s)
  return full
}

export function removeProgram(id: string): void {
  const s = load()
  s.programs = s.programs.filter(p => p.id !== id)
  if (s.activeProgramId === id) s.activeProgramId = null
  save(s)
}

export function listFindings(): Finding[] { return load().findings }

export function addFinding(input: Omit<Finding, 'id' | 'status' | 'createdAt' | 'updatedAt'>): Finding {
  const s = load()
  const now = new Date().toISOString()
  const finding: Finding = { ...input, id: nanoid(), status: 'draft', createdAt: now, updatedAt: now }
  s.findings.push(finding)
  s.audit.push({ id: nanoid(), time: now, kind: 'finding', detail: `draft saved: ${finding.title}` })
  save(s)
  return finding
}

export function updateFinding(id: string, patch: Partial<Omit<Finding, 'id' | 'status' | 'createdAt'>>): Finding {
  const s = load()
  const i = s.findings.findIndex(f => f.id === id)
  if (i < 0) throw new Error('no such finding')
  // Status is forced back to draft: Goga does not submit reports.
  s.findings[i] = { ...s.findings[i], ...patch, status: 'draft', updatedAt: new Date().toISOString() }
  save(s)
  return s.findings[i]
}

export function deleteFinding(id: string): void {
  const s = load()
  s.findings = s.findings.filter(f => f.id !== id)
  save(s)
}

export function audit(kind: SecurityAuditEntry['kind'], detail: string): SecurityAuditEntry {
  const s = load()
  const entry: SecurityAuditEntry = { id: nanoid(), time: new Date().toISOString(), kind, detail }
  s.audit = [...s.audit.slice(-(MAX_AUDIT - 1)), entry]
  save(s)
  return entry
}

export function readAudit(limit = 100): SecurityAuditEntry[] {
  return load().audit.slice(-limit)
}

/**
 * Requests the user has approved, by an opaque id. A grant is single-use and expires in
 * five minutes; the tool that sends a request must present one that matches its exact
 * target and method.
 */
interface Grant { id: string; target: string; method: string; createdAt: number; used: boolean }
const grants = new Map<string, Grant>()
const GRANT_TTL_MS = 5 * 60_000

export function issueGrant(target: string, method: string): string {
  const id = nanoid()
  grants.set(id, { id, target: normalise(target), method: method.toUpperCase(), createdAt: Date.now(), used: false })
  for (const [key, g] of grants) if (Date.now() - g.createdAt > GRANT_TTL_MS) grants.delete(key)
  return id
}

export function consumeGrant(id: string, target: string, method: string): { ok: boolean; reason: string } {
  const g = grants.get(String(id ?? ''))
  if (!g) return { ok: false, reason: 'no such approval — approve this exact request first' }
  if (g.used) return { ok: false, reason: 'that approval has already been used' }
  if (Date.now() - g.createdAt > GRANT_TTL_MS) { grants.delete(g.id); return { ok: false, reason: 'that approval expired' } }
  if (g.target !== normalise(target) || g.method !== method.toUpperCase()) return { ok: false, reason: 'the approval was for a different target or method' }
  g.used = true
  return { ok: true, reason: 'approved' }
}

export function pendingGrants(): Grant[] {
  return [...grants.values()].filter(g => !g.used && Date.now() - g.createdAt <= GRANT_TTL_MS)
}

function normalise(target: string): string {
  return String(target ?? '').trim().toLowerCase().replace(/\/+$/, '')
}
