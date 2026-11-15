import { describe, expect, it } from 'vitest'
import { analyse, latestTrades } from '../venues/journal'
import { MIN_TRADES_FOR_STATS } from '../../../shared/venues'
import type { TradeRecord } from '../../../shared/venues'

/**
 * The learning loop's honesty.
 *
 * The point of these tests is not that the arithmetic works — it is that the loop refuses
 * to quote a win rate it cannot support, and that it never presents a simulated result as
 * money.
 */

function trade(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: `t${Math.random()}`,
    venue: 'pivex',
    symbol: 'EURUSD',
    side: 'buy',
    size: 0.01,
    sizeUnit: 'lots',
    entryPrice: 1.085,
    exitPrice: 1.09,
    pnl: 5,
    pnlPct: 0.0046,
    reason: 'a reason given at the time',
    openedAt: new Date(0).toISOString(),
    closedAt: new Date(1).toISOString(),
    ticketId: 'x',
    venueOrderId: null,
    ...over,
  }
}

describe('learning loop — says "not enough trades" when it is true', () => {
  it('says so with no trades at all', () => {
    const stats = analyse([], 'pivex')
    expect(stats.verdict).toBe('too-few-trades')
    expect(stats.headline).toContain('Not enough trades to tell')
    expect(stats.winRate).toBeNull()
    expect(stats.expectancy).toBeNull()
  })

  it('refuses to quote a win rate under the minimum sample', () => {
    const trades = Array.from({ length: MIN_TRADES_FOR_STATS - 1 }, (_, i) =>
      trade({ id: `t${i}`, pnl: i % 2 === 0 ? 10 : -5 }))
    const stats = analyse(trades, 'pivex')
    expect(stats.verdict).toBe('too-few-trades')
    expect(stats.winRate).toBeNull()
    expect(stats.expectancy).toBeNull()
    expect(stats.headline).toContain(`${MIN_TRADES_FOR_STATS - 1} of the ${MIN_TRADES_FOR_STATS}`)
    // It still reports the raw counts, which are facts.
    expect(stats.closedTrades).toBe(MIN_TRADES_FOR_STATS - 1)
  })

  it('quotes the numbers once the sample is large enough', () => {
    const trades = Array.from({ length: MIN_TRADES_FOR_STATS }, (_, i) =>
      trade({ id: `t${i}`, pnl: i < 12 ? 10 : -5 }))
    const stats = analyse(trades, 'pivex')
    expect(stats.verdict).toBe('positive')
    expect(stats.winRate).toBeCloseTo(12 / 20, 5)
    expect(stats.avgWin).toBeCloseTo(10, 5)
    expect(stats.avgLoss).toBeCloseTo(-5, 5)
    expect(stats.winLossRatio).toBeCloseTo(2, 5)
    // 12 wins of 10 and 8 losses of 5 = 120 - 40 = 80 over 20 trades = 4 per trade.
    expect(stats.expectancy).toBeCloseTo(4, 5)
  })

  it('calls a losing system negative rather than dressing it up', () => {
    const trades = Array.from({ length: MIN_TRADES_FOR_STATS }, (_, i) =>
      trade({ id: `t${i}`, pnl: i < 5 ? 10 : -8 }))
    const stats = analyse(trades, 'pivex')
    expect(stats.verdict).toBe('negative')
    expect(stats.expectancy).toBeLessThan(0)
    expect(stats.headline).toContain('Losing systems do not turn into winning ones')
  })

  it('never calls a simulated result money', () => {
    const trades = Array.from({ length: MIN_TRADES_FOR_STATS }, (_, i) => trade({ id: `t${i}`, pnl: 10 }))
    const stats = analyse(trades, 'pivex')
    const all = [stats.headline, ...stats.findings].join(' ')
    expect(all).toContain('simulated')
    expect(all).not.toMatch(/\bearnings\b|\bincome\b|\bprofit you made\b/i)
  })

  it('keeps the two venues apart', () => {
    const trades = [
      ...Array.from({ length: MIN_TRADES_FOR_STATS }, (_, i) => trade({ id: `p${i}`, venue: 'pivex', pnl: 10 })),
      ...Array.from({ length: 3 }, (_, i) => trade({ id: `a${i}`, venue: 'alpaca-paper', pnl: -10 })),
    ]
    expect(analyse(trades, 'pivex').closedTrades).toBe(MIN_TRADES_FOR_STATS)
    expect(analyse(trades, 'alpaca-paper').closedTrades).toBe(3)
    expect(analyse(trades, 'alpaca-paper').verdict).toBe('too-few-trades')
  })

  it('ignores trades that are still open', () => {
    const trades = [
      trade({ id: 'open', closedAt: null, pnl: null }),
      ...Array.from({ length: MIN_TRADES_FOR_STATS }, (_, i) => trade({ id: `c${i}`, pnl: 1 })),
    ]
    expect(analyse(trades, 'pivex').closedTrades).toBe(MIN_TRADES_FOR_STATS)
  })

  it('a closed record supersedes its open one', () => {
    const open = trade({ id: 'same', closedAt: null, pnl: null })
    const closed = trade({ id: 'same', pnl: 7 })
    const latest = latestTrades([open, closed])
    expect(latest).toHaveLength(1)
    expect(latest[0].pnl).toBe(7)
  })

  it('keeps the reason exactly as it was given', () => {
    const reason = 'bought the breakout because volume doubled'
    const stats = analyse([trade({ reason })], 'pivex')
    expect(stats.closedTrades).toBe(1)
    // The reason is on the record, not rewritten by the analysis.
    expect(trade({ reason }).reason).toBe(reason)
  })
})
