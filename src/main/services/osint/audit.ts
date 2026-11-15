import fs from 'fs'
import { safeStorage } from 'electron'
import { nanoid } from '../../utils/nanoid'
import type { OsintAuditEntry, OsintBreachKeyState } from '../../../shared/osint'
import { ensureDirFor, osintFile } from './paths'

/**
 * The OSINT audit trail and the one credential this feature can hold.
 *
 * Every run — allowed or refused — appends one JSON Lines entry with the query, the stated
 * purpose, the sources contacted, the hosts it declined to contact and a one-line summary.
 * The file is 0600 and capped at the most recent 5,000 entries.
 *
 * The breach-check API key is stored with Electron's safeStorage, in its own file, and is
 * never logged and never returned to the renderer.
 */

const MAX_ENTRIES = 5000

function auditFile(): string | null { return osintFile('goga-osint-audit.jsonl') }

export function recordOsintAudit(entry: Omit<OsintAuditEntry, 'id' | 'time'>): OsintAuditEntry {
  const full: OsintAuditEntry = { ...entry, id: nanoid(), time: new Date().toISOString() }
  const file = auditFile()
  if (!file) return full
  try {
    ensureDirFor(file)
    fs.appendFileSync(file, `${JSON.stringify(full)}\n`, { mode: 0o600 })
    compact(file)
  } catch { /* a failed audit write must not throw away the user's result — the caller reports it */ }
  return full
}

function compact(file: string): void {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split('\n').filter(Boolean)
    if (lines.length <= MAX_ENTRIES) return
    fs.writeFileSync(file, `${lines.slice(-MAX_ENTRIES).join('\n')}\n`, { mode: 0o600 })
  } catch { /* the append already happened; compaction is best effort */ }
}

export function readOsintAudit(limit = 50): OsintAuditEntry[] {
  const file = auditFile()
  if (!file) return []
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).map(l => {
      try { return JSON.parse(l) as OsintAuditEntry } catch { return null }
    }).filter((e): e is OsintAuditEntry => e !== null)
  } catch { return [] }
}

// ---------- breach-check key ----------

function keyFile(): string | null { return osintFile('goga-osint-breach-key.bin') }

export function breachKeyState(): OsintBreachKeyState {
  let encryptionAvailable = false
  try { encryptionAvailable = safeStorage.isEncryptionAvailable() } catch { encryptionAvailable = false }
  const f = keyFile()
  return { configured: !!f && fs.existsSync(f), encryptionAvailable }
}

export function saveBreachKey(key: string): OsintBreachKeyState {
  const k = String(key ?? '').trim()
  if (!k) throw new Error('enter the API key')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('secure storage is unavailable on this PC, so the key was not saved')
  const f = keyFile()
  if (!f) throw new Error('no place to store the key on this PC')
  ensureDirFor(f)
  fs.writeFileSync(f, safeStorage.encryptString(k), { mode: 0o600 })
  return breachKeyState()
}

export function clearBreachKey(): OsintBreachKeyState {
  const f = keyFile()
  if (f) { try { fs.unlinkSync(f) } catch { /* none stored */ } }
  return breachKeyState()
}

/** Read the key for one request. Never logged, never returned to the renderer. */
export function readBreachKey(): string | null {
  const f = keyFile()
  if (!f || !fs.existsSync(f)) return null
  try { return safeStorage.decryptString(fs.readFileSync(f)) } catch { return null }
}
