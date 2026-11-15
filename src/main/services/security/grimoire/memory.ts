import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { Hypothesis, MemoryEntry, SpecialistId } from '../../../../shared/grimoire'

/**
 * Per-program memory: what was tried, and what turned out to be nothing.
 *
 * BountyGrimoire's fourth idea, and the one that saves the most time in practice. A candidate
 * that was raised and dropped is recorded with the reason, so the next run does not re-argue
 * it. A candidate the user confirmed is recorded too, so it is not lost.
 *
 * Stored as plain JSON under the Goga user-data folder, written 0600, next to the security
 * store. Nothing here is sent anywhere.
 */

interface MemoryFile {
  version: number
  entries: MemoryEntry[]
}

const MAX_ENTRIES = 4000

function file(): string { return path.join(app.getPath('userData'), 'goga-grimoire-memory.json') }

function load(): MemoryFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<MemoryFile>
    return { version: 1, entries: Array.isArray(raw.entries) ? raw.entries : [] }
  } catch { return { version: 1, entries: [] } }
}

function save(data: MemoryFile): void {
  const target = file()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify({ version: 1, entries: data.entries.slice(-MAX_ENTRIES) }, null, 2), { mode: 0o600 })
}

export function memoryEntries(programId?: string): MemoryEntry[] {
  const all = load().entries
  return programId ? all.filter(e => e.programId === programId) : all
}

export function memoryFor(key: string): MemoryEntry | null {
  return load().entries.find(e => e.key === key) ?? null
}

/**
 * Record what happened to one candidate. Called once per hypothesis per run, so the memory
 * reflects the latest judgement rather than accumulating duplicates.
 */
export function remember(input: {
  key: string
  programId: string
  programName: string
  specialist: SpecialistId
  title: string
  location: string
  outcome: MemoryEntry['outcome']
  reason: string
}): MemoryEntry {
  const data = load()
  const now = new Date().toISOString()
  const existing = data.entries.find(e => e.key === input.key)
  if (existing) {
    existing.outcome = input.outcome
    existing.reason = input.reason
    existing.lastSeen = now
    existing.title = input.title
    save(data)
    return existing
  }
  const entry: MemoryEntry = {
    key: input.key,
    programId: input.programId,
    programName: input.programName,
    specialist: input.specialist,
    title: input.title,
    location: input.location,
    outcome: input.outcome,
    reason: input.reason,
    firstSeen: now,
    lastSeen: now,
  }
  data.entries.push(entry)
  save(data)
  return entry
}

/**
 * Mark a candidate dead after the 7-question gate, so it is never raised again.
 *
 * An entry is created when one does not exist yet. A review run only records against an active
 * program, so a gate decision on a candidate from a local-file review would otherwise have
 * nothing to mark — and the UI would say "recorded as dead" while nothing was written. The
 * caller's hypothesis is passed in for that case, so the record is complete rather than a key
 * with no title.
 */
export function markDead(key: string, reason: string, seed?: {
  programId?: string
  programName?: string
  specialist?: SpecialistId
  title?: string
  location?: string
}): MemoryEntry {
  const data = load()
  const now = new Date().toISOString()
  let entry = data.entries.find(e => e.key === key)
  if (!entry) {
    entry = {
      key,
      programId: seed?.programId ?? 'local',
      programName: seed?.programName ?? 'Local review',
      specialist: seed?.specialist ?? 'recon',
      title: seed?.title ?? key,
      location: seed?.location ?? '',
      outcome: 'dead',
      reason,
      firstSeen: now,
      lastSeen: now,
    }
    data.entries.push(entry)
    save(data)
    return entry
  }
  entry.outcome = 'dead'
  entry.reason = reason
  entry.lastSeen = now
  save(data)
  return entry
}

export function markUserConfirmed(key: string, reason: string, seed?: {
  programId?: string
  programName?: string
  specialist?: SpecialistId
  title?: string
  location?: string
}): MemoryEntry {
  const data = load()
  const now = new Date().toISOString()
  let entry = data.entries.find(e => e.key === key)
  if (!entry) {
    entry = {
      key,
      programId: seed?.programId ?? 'local',
      programName: seed?.programName ?? 'Local review',
      specialist: seed?.specialist ?? 'recon',
      title: seed?.title ?? key,
      location: seed?.location ?? '',
      outcome: 'user-confirmed',
      reason,
      firstSeen: now,
      lastSeen: now,
    }
    data.entries.push(entry)
    save(data)
    return entry
  }
  entry.outcome = 'user-confirmed'
  entry.reason = reason
  entry.lastSeen = now
  save(data)
  return entry
}

export function forgetMemory(key: string): void {
  const data = load()
  data.entries = data.entries.filter(e => e.key !== key)
  save(data)
}

/** A short summary for the page: how much has been tried, and how much was nothing. */
export function memorySummary(programId?: string): { total: number; dropped: number; dead: number; confirmed: number; raised: number } {
  const entries = memoryEntries(programId)
  return {
    total: entries.length,
    dropped: entries.filter(e => e.outcome === 'dropped').length,
    dead: entries.filter(e => e.outcome === 'dead').length,
    confirmed: entries.filter(e => e.outcome === 'user-confirmed').length,
    raised: entries.filter(e => e.outcome === 'raised').length,
  }
}

/** True when this candidate was already settled as nothing, so a run can skip re-arguing it. */
export function alreadySettled(key: string): MemoryEntry | null {
  const entry = memoryFor(key)
  if (!entry) return null
  return entry.outcome === 'dropped' || entry.outcome === 'dead' ? entry : null
}

export type { Hypothesis }
