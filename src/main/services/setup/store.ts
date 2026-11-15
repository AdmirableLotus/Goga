import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { SetupAuditEntry, SetupAuditKind } from '../../../shared/setup'
import { nanoid } from '../../utils/nanoid'

/**
 * The setup audit trail: every proposal, approval, refusal and completed install, plus the
 * same for virtual machines.
 *
 * A plain JSON file under Goga's data folder, written 0600. It is the record the user can
 * read to see what Goga asked for and what it did, and it is written before the action, not
 * after, so a crash mid-install still leaves the proposal on record.
 */

const MAX_AUDIT = 2000

interface Store { audit: SetupAuditEntry[] }

function file(): string { return path.join(app.getPath('userData'), 'goga-setup-audit.json') }

function load(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Store>
    return { audit: Array.isArray(raw.audit) ? raw.audit : [] }
  } catch { return { audit: [] } }
}

function save(store: Store): void {
  const target = file()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export function auditSetup(kind: SetupAuditKind, detail: string): SetupAuditEntry {
  const entry: SetupAuditEntry = { id: nanoid(), time: new Date().toISOString(), kind, detail }
  const store = load()
  store.audit = [...store.audit.slice(-(MAX_AUDIT - 1)), entry]
  try { save(store) } catch { /* the audit must never break the action it records */ }
  return entry
}

export function readSetupAudit(limit = 200): SetupAuditEntry[] {
  return load().audit.slice(-limit)
}
