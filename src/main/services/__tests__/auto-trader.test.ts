import { describe, expect, it } from 'vitest'
import { decide, chooseStrategy, learningReport, emptyAutoState, recordClose, DEFAULT_AUTO_RULES, type AutoInput, type AutoPosition, type AutoState } from '../trading/autoTrader'
import type { Bar } from '../trading/indicators'
import type { AccountView, Position } from '../trading/paperTrading'

const now = new Date(2026, 10, 2, 11, 0)

/** A rising market with regular pullbacks — strategies that buy strength make money on it. */
function uptrend(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + i * 0.6 + 6 * Math.sin(i / 3)
    return { t: new Date(2026, 0, 1 + i).toISOString(), o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 }
  })
}
const falling = (n: number): Bar[] => uptrend(n).map((b, i) => ({ ...b, c: 300 - i * 0.8, h: 301 - i * 0.8, l: 299 - i * 0.8, o: 300 - i * 0.8 }))

const account = (positions: Position[] = [], over: Partial<AccountView> = {}): AccountView =>
  ({ name: 'Alpaca paper account', equity: 100_000, cash: 80_000, dayPnlPct: 0, positions, openOrders: [], ...over })

const input = (over: Partial<AutoInput>): AutoInput =>
  ({ account: account(), looks: [], state: emptyAutoState(), rules: DEFAULT_AUTO_RULES, stockOpen: true, now, ...over })

/** The first length of the uptrend at which a fresh buy signal appears. */
function signalBars(): Bar[] {
  for (let n = 120; n <= 300; n++) {
    const bars = uptrend(n)
    if (decide(input({ looks: [{ symbol: 'SPY', market: 'stock', bars }] })).actions.length) return bars
  }
  throw new Error('no signal in the test market')
}

const pos = (over: Partial<AutoPosition> = {}): AutoPosition =>
  ({ symbol: 'SPY', market: 'stock', strategy: 'breakout', entry: 100, stop: 95, target: 110, qty: 10, openedAt: '', lastPnl: 0, lastPnlPct: 0, ...over })
const held = (symbol: string, price: number, pnl = 0): Position => ({ symbol, qty: 10, avgPrice: 100, price, pnl, pnlPct: pnl / 10 })

describe('auto-trader', () => {
  it('trades nothing in a falling market', () => {
    expect(chooseStrategy(falling(250), [])).toBeNull()
    expect(decide(input({ looks: [{ symbol: 'SPY', market: 'stock', bars: falling(250) }] })).actions).toEqual([])
  })

  it('buys on a fresh signal with a stop, a target, whole shares and small risk', () => {
    const bars = signalBars()
    const [buy] = decide(input({ looks: [{ symbol: 'SPY', market: 'stock', bars }] })).actions
    if (buy.kind !== 'buy') throw new Error('expected a buy')
    expect(Number.isInteger(buy.order.qty)).toBe(true)
    expect(buy.order.stopPrice).toBeLessThan(buy.position.entry)
    expect(buy.order.takeProfit).toBeGreaterThan(buy.position.entry)
    const risk = (buy.position.entry - buy.position.stop) * buy.position.qty
    expect(risk).toBeLessThanOrEqual(100_000 * DEFAULT_AUTO_RULES.riskPct / 100 + 1)
    expect(buy.order.reason).toMatch(/auto-trade/)
  })

  it('leaves alone what is already held, closed markets, and days past the loss limit', () => {
    const looks = [{ symbol: 'SPY', market: 'stock' as const, bars: signalBars() }]
    expect(decide(input({ looks, account: account([held('SPY', 100)]) })).actions).toEqual([])
    expect(decide(input({ looks, stockOpen: false })).actions).toEqual([])
    expect(decide(input({ looks, account: account([], { dayPnlPct: -3.5 }) })).actions).toEqual([])
  })

  it('holds no more than the maximum number of positions', () => {
    const bars = signalBars()
    const state: AutoState = { ...emptyAutoState(), open: { A: pos({ symbol: 'A' }), B: pos({ symbol: 'B' }), C: pos({ symbol: 'C' }) } }
    const acct = account([held('A', 101), held('B', 101), held('C', 101)])
    expect(decide(input({ looks: [{ symbol: 'SPY', market: 'stock', bars }], state, account: acct })).actions).toEqual([])
  })

  it('sells its own position at the target', () => {
    const state: AutoState = { ...emptyAutoState(), open: { SPY: pos() } }
    const r = decide(input({ looks: [{ symbol: 'SPY', market: 'stock', bars: uptrend(200) }], state, account: account([held('SPY', 111, 110)]) }))
    expect(r.actions[0]).toEqual(expect.objectContaining({ kind: 'sell', symbol: 'SPY' }))
  })

  it('records a stop that filled at the broker and benches a symbol after two losses', () => {
    const state: AutoState = { ...emptyAutoState(), open: { SPY: pos({ lastPnl: -50, lastPnlPct: -5 }) } }
    recordClose(state, pos({ symbol: 'SPY' }), -40, -4, now, 'stop filled', DEFAULT_AUTO_RULES)
    state.open.SPY = pos({ lastPnl: -50, lastPnlPct: -5 })
    const r = decide(input({ state }))
    expect(r.state.closed).toHaveLength(2)
    expect(r.state.open.SPY).toBeUndefined()
    expect(r.state.benched.SPY).toBeDefined()
  })

  it('drops a strategy that loses money live', () => {
    const closed = Array.from({ length: 5 }, () => ({ symbol: 'X', strategy: 'breakout' as const, pnl: -20, pnlPct: -2, closedAt: '', why: '' }))
    const pick = chooseStrategy(signalBars(), closed)
    expect(pick?.strategy).not.toBe('breakout')
    expect(learningReport({ ...emptyAutoState(), closed })).toMatch(/dropped/)
  })
})
