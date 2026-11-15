import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { nanoid } from '../../utils/nanoid'
import type { JournalEntry, JournalKind, StrategySummary } from '../../../shared/strategy'

/**
 * The trade journal.
 *
 * One append-only JSON Lines file. Every signal, prepared intent, automatic decision,
 * refusal, send and closed trade goes in with the strategy name and the reason, so the
 * question "is this strategy actually working?" can be answered from a record rather
 * than from memory. Capped at the most recent 20,000 entries.
 */

const MAX_ENTRIES = 20_000

export function journalFile(): string {
  return path.join(app.getPath('userData'), 'strategy-journal.jsonl')
}

export function readJournal(limit = 200): JournalEntry[] {
  try {
    const lines = fs.readFileSync(journalFile(), 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit)
      .map(l => { try { return JSON.parse(l) as JournalEntry } catch { return null } })
      .filter((e): e is JournalEntry => e !== null)
  } catch { return [] }
}

export function recordJournal(entry: Omit<JournalEntry, 'id' | 'time'> & { time?: string }): JournalEntry {
  const full: JournalEntry = { ...entry, id: nanoid(), time: entry.time ?? new Date().toISOString() }
  const file = journalFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(full)}\n`, { mode: 0o600 })
  compact(file)
  return full
}

function compact(file: string): void {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= MAX_ENTRIES) return
    fs.writeFileSync(file, `${lines.slice(-MAX_ENTRIES).join('\n')}\n`, { mode: 0o600 })
  } catch { /* the append already succeeded */ }
}

/**
 * Per-strategy performance from closed trades only. A strategy with no closed trades
 * shows zeroes and a null last-trade time rather than a made-up number.
 */
export function summarise(entries: JournalEntry[]): StrategySummary[] {
  const groups = new Map<string, JournalEntry[]>()
  for (const e of entries) {
    if (e.kind !== 'exit' || e.pnl === null) continue
    const key = `${e.strategyId}|${e.symbol}`
    const list = groups.get(key) ?? []
    list.push(e)
    groups.set(key, list)
  }
  const out: StrategySummary[] = []
  for (const [key, list] of groups) {
    const [strategyId, symbol] = key.split('|')
    const wins = list.filter(e => (e.pnl ?? 0) > 0)
    const losses = list.filter(e => (e.pnl ?? 0) <= 0)
    const totalPnl = list.reduce((a, e) => a + (e.pnl ?? 0), 0)
    out.push({
      strategyId, symbol,
      closedTrades: list.length,
      wins: wins.length,
      losses: losses.length,
      winRate: list.length ? wins.length / list.length : 0,
      totalPnl,
      avgWin: wins.length ? wins.reduce((a, e) => a + (e.pnl ?? 0), 0) / wins.length : 0,
      avgLoss: losses.length ? losses.reduce((a, e) => a + (e.pnl ?? 0), 0) / losses.length : 0,
      avgPnlPct: list.length ? list.reduce((a, e) => a + (e.pnlPct ?? 0), 0) / list.length : 0,
      lastTradeAt: list[list.length - 1]?.time ?? null,
    })
  }
  return out.sort((a, b) => b.closedTrades - a.closedTrades)
}

export const JOURNAL_KINDS: JournalKind[] = [
  'signal', 'intent', 'auto-approved', 'awaiting-approval', 'sent', 'refused', 'exit', 'note',
]
