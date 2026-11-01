import { describe, expect, it } from 'vitest'
import { watchAccount, lesson, DEFAULT_WATCH_RULES, type WatchState } from '../trading/tradeWatcher'
import type { AccountView, Position } from '../trading/paperTrading'

const morning = new Date(2026, 10, 2, 10, 0)    // 10:00 local
const evening = new Date(2026, 10, 2, 17, 30)   // after the US close

const pos = (symbol: string, pnlPct: number, extra: Partial<Position> = {}): Position =>
  ({ symbol, qty: 1, avgPrice: 100, price: 100 * (1 + pnlPct / 100), pnl: pnlPct * 10, pnlPct, ...extra })
const view = (positions: Position[], openOrders: string[] = [], over: Partial<AccountView> = {}): AccountView =>
  ({ name: 'Alpaca paper account', equity: 100_000, cash: 50_000, dayPnlPct: 0, positions, openOrders, ...over })

/** Baseline look, then the look under test. */
function run(first: AccountView, second: AccountView, at = morning, prev?: WatchState) {
  const base = prev ?? watchAccount(undefined, first, DEFAULT_WATCH_RULES, at).state
  return watchAccount(base, second, DEFAULT_WATCH_RULES, at)
}

describe('trade watcher', () => {
  it('says nothing on the first look', () => {
    expect(watchAccount(undefined, view([pos('AAPL', -20)]), DEFAULT_WATCH_RULES, morning).alerts).toEqual([])
  })

  it('reports a new position and a closed one (and keeps score)', () => {
    const stop = ['id1: sell 1 BTC/USD stop_limit stop 60000 (new)']
    const opened = run(view([]), view([pos('BTC/USD', 0)], stop))
    expect(opened.alerts.map(a => a.title)).toEqual(['New position: BTC/USD'])
    const closed = watchAccount(opened.state, view([]), DEFAULT_WATCH_RULES, morning)
    expect(closed.alerts[0].title).toBe('Position closed: BTCUSD')
    expect(closed.state.closed).toHaveLength(1)
  })

  it('warns once when a position has no stop, and again only after it is fixed and lost', () => {
    const r1 = run(view([]), view([pos('AAPL', 1)]))
    expect(r1.alerts.map(a => a.title)).toContain('AAPL has no stop')
    const r2 = watchAccount(r1.state, view([pos('AAPL', 1)]), DEFAULT_WATCH_RULES, morning)
    expect(r2.alerts.map(a => a.title)).not.toContain('AAPL has no stop')       // said once
    const protectedView = view([pos('AAPL', 1)], ['id2: sell 1 AAPL stop stop 95 (held)'])
    expect(watchAccount(r2.state, protectedView, DEFAULT_WATCH_RULES, morning).alerts).toEqual([])
  })

  it('warns on a losing position and suggests protecting a winner', () => {
    const stops = ['a: sell 1 AAPL stop stop 90', 'b: sell 1 NVDA stop stop 90']
    const r = run(view([pos('AAPL', 0), pos('NVDA', 0)], stops), view([pos('AAPL', -6), pos('NVDA', 12)], stops))
    const titles = r.alerts.map(a => a.title)
    expect(titles).toContain('AAPL is down 6.0%')
    expect(titles).toContain('NVDA is up 12.0%')
    expect(r.alerts.find(a => a.title.startsWith('AAPL'))?.severity).toBe('warning')
  })

  it('raises danger past the daily loss limit, once per day', () => {
    const r = run(view([]), view([], [], { dayPnlPct: -3.4, equity: 96_600 }))
    expect(r.alerts).toEqual([expect.objectContaining({ severity: 'danger', title: 'Down 3.4% today' })])
    expect(watchAccount(r.state, view([], [], { dayPnlPct: -3.6, equity: 96_400 }), DEFAULT_WATCH_RULES, morning).alerts).toEqual([])
  })

  it('warns when the account falls 10% below its best', () => {
    const r = run(view([], [], { equity: 100_000 }), view([], [], { equity: 89_000 }))
    expect(r.alerts.map(a => a.title)).toContain('Account 11.0% below its best')
  })

  it('posts one end-of-day summary after the close', () => {
    const base = watchAccount(undefined, view([]), DEFAULT_WATCH_RULES, morning).state
    const r = watchAccount(base, view([], [], { dayPnlPct: 0.4 }), DEFAULT_WATCH_RULES, evening)
    expect(r.alerts).toEqual([expect.objectContaining({ severity: 'summary' })])
    expect(r.alerts[0].detail).toContain('+0.4% today')
    expect(watchAccount(r.state, view([]), DEFAULT_WATCH_RULES, evening).alerts).toEqual([])
  })
})

describe('coaching lesson from the record', () => {
  const t = (pnl: number) => ({ symbol: 'X', pnl, pnlPct: pnl / 10, closedAt: '' })
  it('is honest when there are too few trades', () => {
    expect(lesson([t(10), t(-5)])).toMatch(/too few/)
  })
  it('flags losers bigger than winners', () => {
    expect(lesson([t(50), t(50), t(-150), t(-150), t(40)])).toMatch(/average loss/)
  })
  it('recognizes a working process', () => {
    expect(lesson([t(100), t(120), t(-40), t(90), t(-50)])).toMatch(/working process/)
  })
})
