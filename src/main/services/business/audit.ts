import fs from 'fs'
import { businessFile, ensureDirFor } from './paths'
import { nanoid } from '../../utils/nanoid'
import type { BusinessActionKind, BusinessAuditEntry, PendingAction } from '../../../shared/business'

/**
 * The audit trail and the approval queue.
 *
 * Two rules, both enforced here rather than in the UI:
 *
 *   1. Every outbound action is written to the audit log BEFORE it is attempted, and the
 *      result is appended after. If the log cannot be written, the action does not run.
 *   2. An outbound action is prepared as a PendingAction carrying its full content. It
 *      cannot execute until `consumeApproval` is given the id of that exact action, and
 *      that approval is single-use and expires.
 *
 * The queue lives in memory on purpose: an approval that survives a restart is an approval
 * the user may no longer remember giving.
 */

const MAX_AUDIT = 5000
const APPROVAL_TTL_MS = 30 * 60_000

interface AuditFile { audit: BusinessAuditEntry[] }

function auditPath(): string | null { return businessFile('goga-business-audit.json') }

function loadAudit(): BusinessAuditEntry[] {
  const file = auditPath()
  if (!file) return []
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AuditFile>
    return Array.isArray(raw.audit) ? raw.audit : []
  } catch { return [] }
}

function saveAudit(entries: BusinessAuditEntry[]): void {
  const file = auditPath()
  if (!file) return
  ensureDirFor(file)
  fs.writeFileSync(file, JSON.stringify({ audit: entries.slice(-MAX_AUDIT) }, null, 2), { mode: 0o600 })
}

export function recordAudit(
  kind: BusinessAuditEntry['kind'],
  action: string,
  detail: string,
): BusinessAuditEntry {
  const entry: BusinessAuditEntry = { id: nanoid(), time: new Date().toISOString(), kind, action, detail }
  const entries = loadAudit()
  entries.push(entry)
  saveAudit(entries)
  return entry
}

export function readAudit(limit = 100): BusinessAuditEntry[] {
  return loadAudit().slice(-limit).reverse()
}

// ── approval queue ──────────────────────────────────────────────────────────

const pending = new Map<string, PendingAction>()

function sweep(): void {
  const now = Date.now()
  for (const [id, action] of pending) {
    if (Date.parse(action.expiresAt) < now) pending.delete(id)
  }
}

/**
 * Put an action in the queue with its full content, and log that it was prepared.
 * Returns the action the user must approve. Nothing has been sent at this point.
 */
export function prepareAction(
  kind: BusinessActionKind,
  title: string,
  content: string,
): PendingAction {
  sweep()
  const action: PendingAction = {
    id: nanoid(),
    kind,
    title,
    content,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
  }
  pending.set(action.id, action)
  recordAudit('prepare', kind, `${title} — prepared, waiting for the user's approval (${action.id})`)
  return action
}

export function listPending(): PendingAction[] {
  sweep()
  return [...pending.values()]
}

export function getPending(id: string): PendingAction | null {
  sweep()
  return pending.get(String(id ?? '')) ?? null
}

/**
 * Take the approval for one exact action. Single use: the entry is removed whether the
 * caller then succeeds or fails, so a retry needs a fresh approval.
 */
export function consumeApproval(id: string, kind: BusinessActionKind): { ok: boolean; action: PendingAction | null; reason: string } {
  sweep()
  const action = pending.get(String(id ?? ''))
  if (!action) return { ok: false, action: null, reason: 'that approval is unknown or has expired — prepare the action again' }
  if (action.kind !== kind) return { ok: false, action: null, reason: `that approval was for ${action.kind}, not ${kind}` }
  pending.delete(action.id)
  recordAudit('approve', kind, `${action.title} — approved by the user (${action.id})`)
  return { ok: true, action, reason: 'approved' }
}

export function denyAction(id: string): { ok: boolean; reason: string } {
  const action = pending.get(String(id ?? ''))
  if (!action) return { ok: false, reason: 'that action is unknown or has expired' }
  pending.delete(action.id)
  recordAudit('deny', action.kind, `${action.title} — denied by the user (${action.id})`)
  return { ok: true, reason: 'denied' }
}

/** Log the outcome of an approved action. Called after the attempt, whatever it did. */
export function recordOutcome(kind: BusinessActionKind, title: string, ok: boolean, detail: string): void {
  recordAudit(ok ? 'execute' : 'error', kind, `${title} — ${detail}`)
}
