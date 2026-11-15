import { describe, expect, it } from 'vitest'
import type { BacktestConfig, Bar, JournalEntry } from '../../../shared/strategy'
import { decide, resolveParams, runBacktest, signals, sizePosition, warmupBars } from '../strategy/engine'
import { summarise } from '../strategy/journal'
import { liveStats, reviewStrategy } from '../strategy/review'
import { probeUrl, publishSteps, summariseUptime, monitorRows } from '../business/monitor'
import type { HealthCheck, MonitoredApp } from '../../../shared/business'

/**
 * Hand-checked numbers.
 *
 * Every figure below was worked out on paper first and written into the assertion, so a test
 * that passes means the code still agrees with the arithmetic — not that it agrees with
 * itself. Nothing here asserts "the function exists".
 */

/** Bars whose open equals their close, so a fill price is exactly the close of that bar. */
function barsFromCloses(closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    t: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
    o: c, h: c, l: c, c, v: 1_000_000,
  }))
}

const BASE: BacktestConfig = {
  strategyId: 'sma-cross',
  params: { fast: 2, slow: 3 },
  startingCapital: 10_000,
  commissionPerShare: 0,
  slippageBps: 0,
  riskPct: 1,
  maxPositionPct: 100,
  stopAtrMultiple: 0,
  atrPeriod: 14,
}

describe('strategy parameters', () => {
  it('fills in defaults and clamps to each spec range', () => {
    expect(resolveParams('sma-cross', {})).toEqual({ fast: 20, slow: 50 })
    // 1 is below the fast minimum of 2; 999 is above the slow maximum of 300.
    expect(resolveParams('sma-cross', { fast: 1, slow: 999 })).toEqual({ fast: 2, slow: 300 })
    // 41 is already above 40, so it is left alone.
    expect(resolveParams('mean-reversion', { oversold: 40, exitLevel: 41 })).toEqual({ rsiPeriod: 14, oversold: 40, exitLevel: 41 })
    // 35 is not above 50, so it is pulled up to oversold + 5.
    expect(resolveParams('mean-reversion', { oversold: 50, exitLevel: 35 })).toEqual({ rsiPeriod: 14, oversold: 50, exitLevel: 55 })
  })

  it('keeps the fast average below the slow one, so the pair can still trade', () => {
    expect(resolveParams('sma-cross', { fast: 50, slow: 50 })).toEqual({ fast: 50, slow: 51 })
  })

  it('knows how many bars a strategy needs before it can say anything', () => {
    expect(warmupBars('sma-cross', { fast: 20, slow: 50 })).toBe(51)
    expect(warmupBars('breakout', { lookback: 20, exitLookback: 10 })).toBe(21)
    expect(warmupBars('mean-reversion', { rsiPeriod: 14, oversold: 30, exitLevel: 55 })).toBe(16)
  })
})

describe('decide — the look-ahead guard', () => {
  // closes: 10 9 8 9 10 11. With fast=2 and slow=3 the averages are:
  //   i=1 fast 9.5 (slow undefined)
  //   i=2 fast 8.5, slow 9
  //   i=3 fast 8.5, slow 8.667
  //   i=4 fast 9.5, slow 9      → 8.5 ≤ 8.667 and 9.5 > 9: a cross up
  const bars = barsFromCloses([10, 9, 8, 9, 10, 11])
  const params = { fast: 2, slow: 3 }

  it('does not fire before the slow average exists', () => {
    expect(decide('sma-cross', params, bars, 1, false).action).toBe('hold')
    expect(decide('sma-cross', params, bars, 2, false).action).toBe('hold')
    expect(decide('sma-cross', params, bars, 3, false).action).toBe('hold')
  })

  it('enters on the bar where the fast average crosses up through the slow one', () => {
    const d = decide('sma-cross', params, bars, 4, false)
    expect(d.action).toBe('enter')
    expect(d.reason).toBe('SMA2 9.50 crossed above SMA3 9.00')
  })

  it('gives a different answer when a position is already open, which is how the exit is found', () => {
    // Same bar, holding: there is no cross to act on, so nothing happens.
    expect(decide('sma-cross', params, bars, 4, true).action).toBe('hold')
    // closes 11, 10, 8 → i=7 fast 9.0, slow 9.667, crossed down.
    const longer = barsFromCloses([10, 9, 8, 9, 10, 11, 11, 10, 8])
    expect(decide('sma-cross', params, longer, 7, true).action).toBe('exit')
  })

  it('cannot see a bar after the one it is asked about', () => {
    // The series continues to 1000; the decision at index 4 must be identical.
    const truncated = barsFromCloses([10, 9, 8, 9, 10, 1000, 1000])
    expect(decide('sma-cross', params, truncated, 4, false)).toEqual(decide('sma-cross', params, bars, 4, false))
  })

  it('runs every signal over the series in order', () => {
    const s = signals('sma-cross', params, barsFromCloses([10, 9, 8, 9, 10, 11, 11, 10, 8]))
    expect(s.map(x => [x.index, x.action])).toEqual([[4, 'enter'], [7, 'exit']])
  })
})

describe('position sizing', () => {
  it('takes whichever cap is smaller: risk to the stop, or the exposure cap', () => {
    // Exposure: 10000 × 25% ÷ 100 = 25 shares. Risk: 10000 × 1% ÷ 5 = 20 shares. The risk
    // cap is smaller, so 20.
    expect(sizePosition({ equity: 10_000, price: 100, stopDistance: 5, riskPct: 1, maxPositionPct: 25 })).toBe(20)
    // With the stop wide (100 dollars), the risk cap is 1 share and still binds.
    expect(sizePosition({ equity: 10_000, price: 100, stopDistance: 100, riskPct: 1, maxPositionPct: 25 })).toBe(1)
  })

  it('uses only the exposure cap when the stop is off', () => {
    // 10000 × 25% ÷ 100 = 25
    expect(sizePosition({ equity: 10_000, price: 100, stopDistance: 0, riskPct: 1, maxPositionPct: 25 })).toBe(25)
  })

  it('returns zero rather than a nonsense size', () => {
    expect(sizePosition({ equity: 0, price: 100, stopDistance: 5, riskPct: 1, maxPositionPct: 25 })).toBe(0)
    expect(sizePosition({ equity: 10_000, price: 0, stopDistance: 5, riskPct: 1, maxPositionPct: 25 })).toBe(0)
    // 100 dollars of equity cannot buy a 1000-dollar share.
    expect(sizePosition({ equity: 100, price: 1000, stopDistance: 5, riskPct: 1, maxPositionPct: 25 })).toBe(0)
  })
})

describe('runBacktest — one trade, worked out by hand', () => {
  // closes: 10 9 8 9 10 11 11 10 8 ; open = close on every bar.
  //   signal at i=4 (the cross), filled at i=5's open of 11.
  //   size: cash 10000, exposure cap 100% → 10000 ÷ 11 = 909.09 → 909 shares; cost 9999; cash 1.
  //   exit signal at i=7, filled at i=8's open of 8 → 909 × 8 = 7272; cash 7273.
  //   P/L = 7272 − 9999 = −2727. Ending equity 7273. Buy and hold 8/10 − 1 = −20%.
  const result = runBacktest(barsFromCloses([10, 9, 8, 9, 10, 11, 11, 10, 8]), BASE, 'TEST')

  it('opens at the next bar’s open, not at the signal bar’s close', () => {
    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].entryIndex).toBe(5)
    expect(result.trades[0].entryPrice).toBe(11)
    expect(result.trades[0].exitIndex).toBe(8)
    expect(result.trades[0].exitPrice).toBe(8)
    expect(result.trades[0].exitReason).toBe('signal')
  })

  it('sizes the position and books the loss exactly', () => {
    expect(result.trades[0].qty).toBe(909)
    expect(result.trades[0].pnl).toBeCloseTo(-2727, 6)
    expect(result.trades[0].pnlPct).toBeCloseTo(-2727 / 9999, 6)
    expect(result.trades[0].barsHeld).toBe(3)
  })

  it('reports the totals from the equity curve', () => {
    expect(result.endingEquity).toBeCloseTo(7273, 6)
    expect(result.totalReturn).toBeCloseTo(7273 / 10_000 - 1, 6)
    expect(result.buyHoldReturn).toBeCloseTo(-0.2, 6)
    expect(result.maxDrawdown).toBeCloseTo((10_000 - 7273) / 10_000, 6)
    expect(result.tradeCount).toBe(1)
    expect(result.winRate).toBe(0)
    expect(result.avgWin).toBe(0)
    expect(result.avgLoss).toBeCloseTo(-2727, 6)
    // No winning trades, so the profit factor is 0 rather than a division by zero.
    expect(result.profitFactor).toBe(0)
    // In the market on bars 5, 6 and 7 only: the exit fills at bar 8's open, before that
    // bar's exposure is counted. 3 of 9 bars.
    expect(result.exposure).toBeCloseTo(3 / 9, 6)
  })

  it('charges slippage and commission on both sides', () => {
    const withCosts = runBacktest(barsFromCloses([10, 9, 8, 9, 10, 11, 11, 10, 8]),
      { ...BASE, commissionPerShare: 0.001, slippageBps: 10 }, 'TEST')
    const t = withCosts.trades[0]
    // Entry fill: 11 × (1 + 0.001) = 11.011. Exit fill: 8 × (1 − 0.001) = 7.992.
    expect(t.entryPrice).toBeCloseTo(11.011, 6)
    expect(t.exitPrice).toBeCloseTo(7.992, 6)
    // Fewer shares once the commission is in the cost, and a worse P/L than the free run.
    expect(t.qty).toBeLessThan(909)
    expect(t.pnl).toBeLessThan(result.trades[0].pnl)
  })

  it('closes an open position at the last close and says so', () => {
    // Closes rise all the way, so the strategy is still long at the end.
    const rising = runBacktest(barsFromCloses([10, 9, 8, 9, 10, 11, 12, 13]), BASE, 'UP')
    const last = rising.trades[rising.trades.length - 1]
    expect(last.exitReason).toBe('end-of-test')
    expect(last.exitIndex).toBe(7)
  })

  it('says plainly when there are too few trades to read anything into', () => {
    expect(result.warnings.join(' ')).toContain('Only 1 trade')
    expect(result.warnings.join(' ')).toContain('9 bars is a short test')
  })

  it('holds nothing and reports zero when the series is too short for the strategy', () => {
    const tiny = runBacktest(barsFromCloses([10, 11, 12]), BASE, 'TINY')
    expect(tiny.tradeCount).toBe(0)
    expect(tiny.endingEquity).toBe(10_000)
    expect(tiny.totalReturn).toBe(0)
  })
})

describe('runBacktest — the ATR stop', () => {
  it('exits on the stop and records the reason', () => {
    // A cross up at i=4, filled at 11, then a bar that trades through any stop below entry.
    const bars = barsFromCloses([10, 9, 8, 9, 10, 11, 11, 10, 8])
    bars[6] = { ...bars[6], o: 11, h: 11, l: 5, c: 6 }
    const stopped = runBacktest(bars, { ...BASE, stopAtrMultiple: 1, atrPeriod: 2 }, 'STOP')
    expect(stopped.trades.length).toBeGreaterThan(0)
    expect(stopped.trades[0].exitReason).toBe('stop')
    // The stop price is entry minus one ATR, so the exit is above the bar's low of 5.
    expect(stopped.trades[0].exitPrice).toBeGreaterThan(5)
    expect(stopped.trades[0].exitPrice).toBeLessThan(11)
  })
})

describe('journal summaries', () => {
  const entry = (over: Partial<JournalEntry>): JournalEntry => ({
    id: Math.random().toString(36).slice(2), time: '2026-11-10T00:00:00.000Z',
    strategyId: 'sma-cross', symbol: 'SPY', mode: 'paper', kind: 'exit',
    side: 'sell', qty: 10, price: 100, pnl: 0, pnlPct: 0, reason: '', intentId: null, orderId: null,
    ...over,
  })

  it('counts only closed trades, and groups them by strategy and symbol', () => {
    const s = summarise([
      entry({ kind: 'signal', pnl: null, pnlPct: null }),
      entry({ kind: 'exit', pnl: 100, pnlPct: 0.1 }),
      entry({ kind: 'exit', pnl: -40, pnlPct: -0.04 }),
      entry({ kind: 'exit', pnl: 60, pnlPct: 0.06 }),
      entry({ kind: 'exit', symbol: 'QQQ', pnl: -10, pnlPct: -0.01 }),
    ])
    expect(s).toHaveLength(2)
    const spy = s.find(x => x.symbol === 'SPY')!
    expect(spy.closedTrades).toBe(3)
    expect(spy.wins).toBe(2)
    expect(spy.losses).toBe(1)
    expect(spy.winRate).toBeCloseTo(2 / 3, 6)
    expect(spy.totalPnl).toBe(120)
    expect(spy.avgWin).toBe(80)
    expect(spy.avgLoss).toBe(-40)
    expect(spy.avgPnlPct).toBeCloseTo((0.1 - 0.04 + 0.06) / 3, 6)
  })

  it('reports zeroes rather than inventing a record when nothing has closed', () => {
    expect(summarise([entry({ kind: 'signal', pnl: null, pnlPct: null })])).toEqual([])
  })
})

describe('review — backtest vs paper', () => {
  const baseline = {
    strategyId: 'sma-cross', symbol: 'SPY', at: '2026-11-01T00:00:00.000Z',
    tradeCount: 40, winRate: 0.5, avgTradePct: 0.02, totalReturn: 0.8,
  }
  const closed = (pcts: number[]): JournalEntry[] => pcts.map((p, i) => ({
    id: String(i), time: '2026-11-05T00:00:00.000Z', strategyId: 'sma-cross', symbol: 'SPY',
    mode: 'paper', kind: 'exit', side: 'sell', qty: 1, price: 1,
    pnl: p * 1000, pnlPct: p, reason: '', intentId: null, orderId: null,
  }))

  it('compounds the paper return rather than adding the percentages', () => {
    // +10% then −10% compounds to −1%, not 0.
    const s = liveStats(closed([0.1, -0.1]), 'sma-cross', 'SPY')
    expect(s.tradeCount).toBe(2)
    expect(s.totalReturn).toBeCloseTo(1.1 * 0.9 - 1, 6)
    expect(s.avgTradePct).toBeCloseTo(0, 6)
    expect(s.winRate).toBe(0.5)
  })

  it('refuses to judge on fewer than ten trades', () => {
    const r = reviewStrategy(closed([0.05, 0.05]), baseline)
    expect(r.verdict).toBe('too-few-trades')
    expect(r.headline).toContain('2 of the 10')
  })

  it('calls it in line when the gaps are inside the stated tolerance', () => {
    // Ten trades of +2%: average trade 2% (gap 0), win rate 100% (gap 50 points → diverging).
    const r = reviewStrategy(closed(Array(10).fill(0.02)), { ...baseline, winRate: 1 })
    expect(r.verdict).not.toBe('too-few-trades')
    expect(['in-line', 'better', 'weaker']).toContain(r.verdict)
  })

  it('names material divergence instead of quietly carrying on', () => {
    const r = reviewStrategy(closed(Array(10).fill(-0.05)), baseline)
    expect(r.verdict).toBe('diverging')
    expect(r.headline).toContain('materially worse')
    expect(r.findings.join(' ')).toContain('tolerance 1.5')
  })

  it('says there is nothing to compare when no backtest was saved', () => {
    const r = reviewStrategy(closed([0.01]), null)
    expect(r.verdict).toBe('too-few-trades')
    expect(r.backtest).toBeNull()
    expect(r.headline).toContain('No backtest saved')
  })
})

describe('uptime arithmetic', () => {
  const check = (ok: boolean, ms = 100, at = '2026-11-10T00:00:00.000Z'): HealthCheck => ({
    at, ok, status: ok ? 200 : 500, ms, error: ok ? null : 'boom',
  })

  it('reports null rather than 100% when nothing has been checked', () => {
    expect(summariseUptime('a', [])).toEqual({ appId: 'a', checks: 0, up: 0, uptimePct: null, avgMs: null, lastCheck: null })
  })

  it('divides the checks that answered OK by the checks taken', () => {
    const u = summariseUptime('a', [check(true, 100), check(false, 300), check(true, 200)])
    expect(u.checks).toBe(3)
    expect(u.up).toBe(2)
    expect(u.uptimePct).toBeCloseTo(66.6666, 3)
    // (100 + 300 + 200) / 3 = 200
    expect(u.avgMs).toBe(200)
    expect(u.lastCheck?.ok).toBe(true)
  })

  it('calls an app down only when the last three checks all failed', () => {
    const app = (checks: HealthCheck[]): MonitoredApp => ({
      id: 'a', name: 'A', url: 'https://example.com', packageName: '', liveVersion: '',
      lastPublishedAt: null, publishedWhere: '', checks, createdAt: '',
    })
    expect(monitorRows([app([check(true), check(false), check(false)])])[0].down).toBe(false)
    expect(monitorRows([app([check(false), check(false), check(false)])])[0].down).toBe(true)
    expect(monitorRows([app([])])[0].down).toBe(false)
  })

  it('counts a redirect as healthy and a 500 as down', async () => {
    const fake = (status: number) => (async () => ({ status } as Response)) as typeof fetch
    expect((await probeUrl('https://x.test', fake(301))).ok).toBe(true)
    expect((await probeUrl('https://x.test', fake(500))).ok).toBe(false)
    expect((await probeUrl('https://x.test', fake(204))).ok).toBe(true)
  })

  it('records a thrown fetch as a failed check with the reason, not as a success', async () => {
    const failing = (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as unknown as typeof fetch
    const c = await probeUrl('https://nope.invalid', failing)
    expect(c.ok).toBe(false)
    expect(c.status).toBeNull()
    expect(c.error).toContain('ENOTFOUND')
  })
})

describe('publishing steps', () => {
  it('never offers to publish on the user’s behalf', () => {
    for (const where of ['Google Play Console', 'Base44', 'Netlify', '']) {
      expect(publishSteps(where).join(' ')).toMatch(/your (own )?(click|account)|does not publish|Nothing is deployed|you publish/i)
    }
  })
})
