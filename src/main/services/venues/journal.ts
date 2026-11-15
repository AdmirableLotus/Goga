import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { LoopStats, TradeRecord, VenueId, VenueTicket } from '../../../shared/venues'
import { MIN_TRADES_FOR_STATS } from '../../../shared/venues'

/**
 * The learning loop, shared by both venues.
 *
 * It records every trade with the reason the user gave at the time — that reason is never
 * rewritten, because the point of a journal is to catch the reasoning that looked good
 * before the outcome was known. Then it reports its own numbers honestly: win rate,
 * average win against average loss, and expectancy.
 *
 * The honesty is in `MIN_TRADES_FOR_STATS`. Under that many closed trades the loop says
 * "not enough trades to tell" and does not quote a win rate at all, because a win rate
 * over six trades is noise dressed as a result.
 */

function journalFile(): string {
  return path.join(app.getPath('userData'), 'venue-trades.jsonl')
}

export function readTrades(limit = 5_000): TradeRecord[] {
  try {
    return fs.readFileSync(journalFile(), 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line) as TradeRecord } catch { return null } })
      .filter((t): t is TradeRecord => t !== null)
      .slice(-limit)
  } catch { return [] }
}

export function recordTrade(trade: TradeRecord): TradeRecord {
  const file = journalFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(trade)}\n`, { mode: 0o600 })
  return trade
}

/** A trade opened by a ticket, with the reason preserved exactly as it was given. */
export function openTrade(ticket: VenueTicket, venueOrderId: string | null, entryPrice: number): TradeRecord {
  return recordTrade({
    id: ticket.id,
    venue: ticket.venue,
    symbol: ticket.symbol,
    side: ticket.side,
    size: ticket.size,
    sizeUnit: ticket.sizeUnit,
    entryPrice,
    exitPrice: null,
    pnl: null,
    pnlPct: null,
    reason: ticket.reason,
    openedAt: new Date().toISOString(),
    closedAt: null,
    ticketId: ticket.id,
    venueOrderId,
  })
}

/**
 * Work out the numbers from closed trades only.
 *
 * Every figure is null until there is enough to compute it, and the verdict says
 * "too-few-trades" rather than "positive" when the sample is small — a losing streak of
 * two trades is not evidence of a bad system either.
 */
export function analyse(trades: TradeRecord[], venue: VenueId): LoopStats {
  const closed = trades.filter(t => t.venue === venue && t.closedAt !== null && t.pnl !== null)
  const wins = closed.filter(t => (t.pnl ?? 0) > 0)
  const losses = closed.filter(t => (t.pnl ?? 0) < 0)
  const totalPnl = closed.reduce((a, t) => a + (t.pnl ?? 0), 0)
  const enough = closed.length >= MIN_TRADES_FOR_STATS

  const avgWin = wins.length ? wins.reduce((a, t) => a + (t.pnl ?? 0), 0) / wins.length : null
  const sumLoss = losses.reduce((a, t) => a + (t.pnl ?? 0), 0)
  const avgLoss = losses.length ? sumLoss / losses.length : null
  const winRate = enough ? wins.length / closed.length : null
  const winLossRatio = avgWin !== null && avgLoss !== null && avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null
  const expectancy = enough ? totalPnl / closed.length : null

  const findings: string[] = []
  if (!closed.length) {
    findings.push('No closed trades yet. Open a trade and close it, and the numbers start here.')
    return {
      venue, closedTrades: 0, wins: 0, losses: 0,
      winRate: null, avgWin: null, avgLoss: null, winLossRatio: null,
      expectancy: null, totalPnl: 0, verdict: 'too-few-trades',
      headline: 'Not enough trades to tell — none have been closed yet.', findings,
    }
  }

  findings.push(`${closed.length} closed trade${closed.length === 1 ? '' : 's'} so far, ${MIN_TRADES_FOR_STATS} needed before these numbers mean anything.`)
  findings.push(`${wins.length} made a profit and ${losses.length} did not.`)
  if (avgWin !== null) findings.push(`The average winner made ${avgWin.toFixed(2)}.`)
  if (avgLoss !== null) findings.push(`The average loser lost ${Math.abs(avgLoss).toFixed(2)}.`)
  if (winLossRatio !== null) findings.push(`Winners are ${winLossRatio.toFixed(2)} times the size of losers. Below about 1.0 you need to win most of the time just to break even.`)
  else if (avgWin !== null && avgLoss === null) findings.push('Nothing has lost yet, so there is no average loss to compare against.')
  findings.push(`In total this venue is ${totalPnl >= 0 ? 'up' : 'down'} ${Math.abs(totalPnl).toFixed(2)} of simulated value. That is a score, not money.`)

  if (!enough) {
    findings.push(`There is no win rate or expectancy quoted yet, on purpose: ${closed.length} trades is too small a sample to tell luck from skill.`)
    return {
      venue, closedTrades: closed.length, wins: wins.length, losses: losses.length,
      winRate: null, avgWin, avgLoss, winLossRatio, expectancy: null, totalPnl,
      verdict: 'too-few-trades',
      headline: `Not enough trades to tell — ${closed.length} of the ${MIN_TRADES_FOR_STATS} closed trades needed.`,
      findings,
    }
  }

  const pct = ((winRate ?? 0) * 100).toFixed(1)
  let verdict: LoopStats['verdict']
  let headline: string
  if ((expectancy ?? 0) > 0) {
    verdict = 'positive'
    headline = `Average result per trade is +${(expectancy ?? 0).toFixed(2)} over ${closed.length} trades. A positive expectancy on a small sample still does not mean it will keep working.`
  } else if ((expectancy ?? 0) < 0) {
    verdict = 'negative'
    headline = `Average result per trade is ${(expectancy ?? 0).toFixed(2)} over ${closed.length} trades. Losing systems do not turn into winning ones by trading them longer.`
  } else {
    verdict = 'break-even'
    headline = `Average result per trade is about zero over ${closed.length} trades. Costs alone would put this below zero.`
  }
  findings.push(`Win rate ${pct}%. Expectancy ${(expectancy ?? 0) >= 0 ? '+' : ''}${(expectancy ?? 0).toFixed(2)} per trade.`)
  findings.push('None of this is a promise. It describes what already happened on a simulated account.')

  return {
    venue, closedTrades: closed.length, wins: wins.length, losses: losses.length,
    winRate, avgWin, avgLoss, winLossRatio, expectancy, totalPnl, verdict, headline, findings,
  }
}

/** Close the most recent open trade for a symbol, and record the result. */
export function closeTrade(
  venue: VenueId, symbol: string, exitPrice: number, contractSize = 1,
): { ok: boolean; message: string; trade: TradeRecord | null } {
  const trades = readTrades()
  const open = [...trades].reverse().find(t => t.venue === venue && t.symbol === symbol && t.closedAt === null)
  if (!open) return { ok: false, message: `There is no open ${symbol} trade on ${venue} in the journal to close.`, trade: null }

  const direction = open.side === 'buy' ? 1 : -1
  // For a notional-sized trade the size already is money, so the move is a fraction of it;
  // for shares and lots the move is multiplied by the size and the contract size.
  const pnl = open.sizeUnit === 'notional'
    ? open.size * ((exitPrice - open.entryPrice) / open.entryPrice) * direction
    : (exitPrice - open.entryPrice) * open.size * contractSize * direction
  const pnlPct = open.entryPrice > 0
    ? ((exitPrice - open.entryPrice) / open.entryPrice) * direction
    : 0

  const closed: TradeRecord = { ...open, exitPrice, pnl, pnlPct, closedAt: new Date().toISOString() }
  // Append the closed version; `readTrades` keeps the newest record per id on analysis.
  recordTrade(closed)
  return { ok: true, message: `Closed ${symbol} at ${exitPrice} for ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} of simulated value.`, trade: closed }
}

/** The newest record for each trade id, so a close supersedes its open. */
export function latestTrades(trades: TradeRecord[]): TradeRecord[] {
  const byId = new Map<string, TradeRecord>()
  for (const t of trades) {
    const existing = byId.get(t.id)
    // A closed record wins over an open one for the same id.
    if (!existing || (t.closedAt !== null && existing.closedAt === null)) byId.set(t.id, t)
  }
  return Array.from(byId.values())
}
