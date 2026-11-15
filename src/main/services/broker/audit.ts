import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { nanoid } from '../../utils/nanoid'
import type { OrderAuditEntry } from '../../../shared/broker'

/**
 * Every order intent, refusal, approval decision and result is written here before
 * anything is sent, and the send result is appended after. JSON Lines, append-only,
 * capped at the most recent 5,000 entries when it is compacted.
 */

const MAX_ENTRIES = 5000

export function auditFile(): string {
  return path.join(app.getPath('userData'), 'broker-order-audit.jsonl')
}

export function readAudit(limit = 100): OrderAuditEntry[] {
  try {
    const lines = fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).map(l => { try { return JSON.parse(l) as OrderAuditEntry } catch { return null } }).filter((e): e is OrderAuditEntry => e !== null)
  } catch { return [] }
}

/** Append one entry and return it. Throws only if the disk itself refuses the write. */
export function recordAudit(entry: Omit<OrderAuditEntry, 'id' | 'time'>): OrderAuditEntry {
  const full: OrderAuditEntry = { ...entry, id: nanoid(), time: new Date().toISOString() }
  const file = auditFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(full)}\n`, { mode: 0o600 })
  compactIfHuge(file)
  return full
}

function compactIfHuge(file: string): void {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= MAX_ENTRIES) return
    fs.writeFileSync(file, `${lines.slice(-MAX_ENTRIES).join('\n')}\n`, { mode: 0o600 })
  } catch { /* the append already succeeded; compaction is best effort */ }
}
