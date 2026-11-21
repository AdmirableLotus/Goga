import { describe, expect, it } from 'vitest'
import type { BacktestConfig, Bar } from '../../../shared/strategy'
import { runBacktest } from '../strategy/engine'

/**
 * Explicit bid/ask spread, checked by arithmetic.
 *
 * Spread is a cost separate from slippage and fees: a buy fills half the spread above the mid,
 * a sell half below, so one round trip pays the full spread. These tests prove the direction,
 * the exact dollar cost, that it is reported apart from fees, the documented zero default, and
 * that missing/invalid settings fall back explicitly rather than becoming NaN.
 */
function barsFromCloses(closes: number[]): Bar[] {
  return closes.map((c, i) => ({ t: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(), o: c, h: c, l: c, c, v: 1_000_000 }))
}

const CLOSES = [10, 10, 10, 10, 11, 12, 13, 12, 11, 10, 10, 10]   // exactly one round trip
const bars = barsFromCloses(CLOSES)

// No fees here, so spread is the only cost in play unless a test adds fees.
const BASE: BacktestConfig = {
  strategyId: 'sma-cross',
  params: { fast: 2, slow: 3 },
  startingCapital: 10_000,
  commissionPerShare: 0,
  feeMode: 'per-share',
  feeBps: 0,
  slippageBps: 0,
  spreadBps: 0,
  riskPct: 1,
  maxPositionPct: 50,
  stopAtrMultiple: 0,
  atrPeriod: 14,
}

describe('spread direction and accounting', () => {
  it('defaults to zero: no spread field means no spread cost, and it is reported', () => {
    const { spreadBps, ...noSpreadField } = BASE
    const r = runBacktest(bars, noSpreadField as BacktestConfig, 'SPY')
    expect(r.spreadBps).toBe(0)
    expect(r.totalSpreadCost).toBe(0)
  })

  it('a buy fills ABOVE the mid and a sell BELOW it (vs a zero-spread run)', () => {
    const zero = runBacktest(bars, { ...BASE, spreadBps: 0 }, 'SPY')
    const spread = runBacktest(bars, { ...BASE, spreadBps: 100 }, 'SPY')   // 1.00% full spread
    expect(spread.trades[0].entryPrice).toBeGreaterThan(zero.trades[0].entryPrice)
    expect(spread.trades[0].exitPrice).toBeLessThan(zero.trades[0].exitPrice)
    expect(spread.totalSpreadCost).toBeGreaterThan(0)
    expect(spread.endingEquity).toBeLessThan(zero.endingEquity)   // spread is a real drag
  })

  it('charges exactly half the spread per side on the notional traded', () => {
    const spreadBps = 100
    const half = spreadBps / 10_000 / 2
    const r = runBacktest(bars, { ...BASE, spreadBps }, 'SPY')
    const t = r.trades[0]
    const entryMid = t.entryPrice / (1 + half)     // buy fill = mid × (1 + half)
    const exitMid = t.exitPrice / (1 - half)        // sell fill = mid × (1 − half)
    const expected = t.qty * half * (entryMid + exitMid)
    expect(r.totalSpreadCost).toBeCloseTo(expected, 6)
    expect(r.spreadBps).toBe(spreadBps)
  })

  it('applies the same way for a crypto symbol and a stock symbol', () => {
    const stock = runBacktest(bars, { ...BASE, spreadBps: 50 }, 'SPY')
    const crypto = runBacktest(bars, { ...BASE, spreadBps: 50 }, 'BTC/USD')
    expect(stock.totalSpreadCost).toBeGreaterThan(0)
    expect(crypto.totalSpreadCost).toBeGreaterThan(0)
  })
})

describe('spread is reported separately from fees', () => {
  it('a run with both fees and spread reports each cost on its own', () => {
    const r = runBacktest(bars, { ...BASE, feeMode: 'percent', feeBps: 20, spreadBps: 100 }, 'BTC/USD')
    expect(r.totalFees).toBeGreaterThan(0)
    expect(r.totalSpreadCost).toBeGreaterThan(0)
    expect(r.totalFees).not.toBe(r.totalSpreadCost)   // not conflated
  })

  it('fees without spread leave spread cost at zero', () => {
    const r = runBacktest(bars, { ...BASE, feeMode: 'percent', feeBps: 20, spreadBps: 0 }, 'BTC/USD')
    expect(r.totalFees).toBeGreaterThan(0)
    expect(r.totalSpreadCost).toBe(0)
  })

  it('names the spread in the assumptions when set, and its default when not', () => {
    const withSpread = runBacktest(bars, { ...BASE, spreadBps: 100 }, 'SPY')
    const without = runBacktest(bars, { ...BASE, spreadBps: 0 }, 'SPY')
    expect(withSpread.assumptions.join(' ')).toMatch(/bid\/ask spread 100 basis points/i)
    expect(without.assumptions.join(' ')).toMatch(/no bid\/ask spread assumed/i)
  })
})

describe('missing or invalid spread is handled explicitly, never NaN', () => {
  it('clamps a negative spread to 0', () => {
    const r = runBacktest(bars, { ...BASE, spreadBps: -50 }, 'SPY')
    expect(r.spreadBps).toBe(0)
    expect(r.totalSpreadCost).toBe(0)
  })

  it('falls back to 0 for a non-finite spread (NaN)', () => {
    const r = runBacktest(bars, { ...BASE, spreadBps: Number.NaN }, 'SPY')
    expect(r.spreadBps).toBe(0)
    expect(Number.isFinite(r.endingEquity)).toBe(true)
  })

  it('caps an absurd spread at 500 bps', () => {
    const r = runBacktest(bars, { ...BASE, spreadBps: 100_000 }, 'SPY')
    expect(r.spreadBps).toBe(500)
  })
})
