import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { VenueId } from '../../../shared/venues'

/**
 * Per-venue halt state and the event log.
 *
 * A halt is the venue's own kill switch: while it is on, no ticket can be prepared and no
 * approved ticket can be sent. It is a separate file from the Alpaca broker's risk state
 * so halting Pivex cannot silently stop Alpaca paper, and the other way round.
 */

export interface VenueHalt {
  halted: boolean
  reason: string | null
  at: string | null
}

export interface VenueEvent {
  time: string
  venue: VenueId
  kind: 'prepared' | 'refused' | 'sent' | 'error' | 'halt' | 'cleared' | 'note'
  detail: string
}

function stateFile(): string {
  return path.join(app.getPath('userData'), 'venue-state.json')
}

function eventsFile(): string {
  return path.join(app.getPath('userData'), 'venue-events.jsonl')
}

interface StateFile {
  halts: Partial<Record<VenueId, VenueHalt>>
}

function readStateFile(): StateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as StateFile
    return { halts: parsed.halts ?? {} }
  } catch { return { halts: {} } }
}

function writeStateFile(state: StateFile): void {
  const file = stateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 })
}

export function readHalt(venue: VenueId): VenueHalt {
  return readStateFile().halts[venue] ?? { halted: false, reason: null, at: null }
}

export function setHalt(venue: VenueId, halted: boolean, reason: string | null): VenueHalt {
  const state = readStateFile()
  const next: VenueHalt = halted
    ? { halted: true, reason: reason?.trim() || 'halted by the user', at: new Date().toISOString() }
    : { halted: false, reason: null, at: null }
  state.halts[venue] = next
  writeStateFile(state)
  recordVenueEvent(venue, halted ? 'halt' : 'cleared', next.reason ?? 'halt cleared')
  return next
}

export function recordVenueEvent(venue: VenueId, kind: VenueEvent['kind'], detail: string): VenueEvent {
  const event: VenueEvent = { time: new Date().toISOString(), venue, kind, detail }
  try {
    const file = eventsFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 })
  } catch { /* the caller's action already happened; a log failure must not undo it */ }
  return event
}

export function readVenueEvents(limit = 200): VenueEvent[] {
  try {
    return fs.readFileSync(eventsFile(), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) as VenueEvent } catch { return null } })
      .filter((e): e is VenueEvent => e !== null)
      .slice(-limit)
  } catch { return [] }
}
