import { describe, expect, it } from 'vitest'
import type { BacktestConfig, Bar } from '../../../shared/strategy'
import { runBacktest, cryptoFeeWarning } from '../strategy/engine'

/**
 * The crypto fee fix, checked by arithmetic.
 *
 * Per-share fees are near-zero on crypto (fractional coins × a few tenths of a cent). The fix
 * adds a 'percent' fee mode that charges a percent of the notional traded, which is how real
 * crypto exchanges bill. These tests prove: the default is unchanged (per-share), percent mode
 * charges exactly rate × notional on each side, and a crypto symbol left on per-share is flagged.
 */

/** Open = close, so every fill lands exactly on that bar's close and the math is exact. */
function barsFromCloses(closes: number[]): Bar[] {
  return closes.map((c, i) => ({ t: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(), o: c, h: c, l: c, c, v: 1_000_000 }))
}

// One clean round trip: flat, then a rise (enter), then a fall (exit), then flat (no re-entry).
const CLOSES = [10, 10, 10, 10, 11, 12, 13, 12, 11, 10, 10, 10]

const BASE: Omit<BacktestConfig, 'feeMode' | 'feeBps' | 'commissionPerShare'> = {
  strategyId: 'sma-cross',
  params: { fast: 2, slow: 3 },
  startingCapital: 10_000,
  slippageBps: 0,
  riskPct: 1,
  maxPositionPct: 50,   // well under 100 so fees never push cost past cash and qty is identical across runs
  stopAtrMultiple: 0,
  atrPeriod: 14,
}

describe('fee modes in the backtester', () => {
  const bars = barsFromCloses(CLOSES)

  it('produces exactly one round-trip trade on this fixture', () => {
    const r = runBacktest(bars, { ...BASE, commissionPerShare: 0, feeMode: 'per-share', feeBps: 0 }, 'TEST')
    expect(r.tradeCount).toBe(1)
    expect(r.trades[0].qty).toBeGreaterThan(0)
  })

  it('charges percent-of-notional on BOTH sides, and nothing else changes vs a zero-fee run', () => {
    const zero = runBacktest(bars, { ...BASE, commissionPerShare: 0, feeMode: 'per-share', feeBps: 0 }, 'TEST')
    const pct = runBacktest(bars, { ...BASE, commissionPerShare: 0, feeMode: 'percent', feeBps: 100 }, 'TEST') // 1.00%

    // Sizing does not depend on fees, so the quantity and fills are identical between the runs.
    expect(pct.trades[0].qty).toBe(zero.trades[0].qty)
    const { qty, entryPrice, exitPrice } = zero.trades[0]
    const expectedFees = 0.01 * (qty * entryPrice + qty * exitPrice) // 1% of entry notional + 1% of exit notional

    const feeDrag = zero.endingEquity - pct.endingEquity
    expect(feeDrag).toBeCloseTo(expectedFees, 6)
    expect(expectedFees).toBeGreaterThan(0)
  })

  it('leaves existing behaviour unchanged: omitting feeMode equals explicit per-share', () => {
    const implicit = runBacktest(bars, { ...BASE, commissionPerShare: 0.01 } as BacktestConfig, 'TEST')
    const explicit = runBacktest(bars, { ...BASE, commissionPerShare: 0.01, feeMode: 'per-share', feeBps: 0 }, 'TEST')
    expect(implicit.endingEquity).toBe(explicit.endingEquity)
    // And per-share is genuinely different from percent on the same inputs.
    const percent = runBacktest(bars, { ...BASE, commissionPerShare: 0.01, feeMode: 'percent', feeBps: 100 }, 'TEST')
    expect(percent.endingEquity).not.toBe(explicit.endingEquity)
  })

  it('states the fee mode in the assumptions', () => {
    const perShare = runBacktest(bars, { ...BASE, commissionPerShare: 0.005, feeMode: 'per-share', feeBps: 0 }, 'TEST')
    const percent = runBacktest(bars, { ...BASE, commissionPerShare: 0, feeMode: 'percent', feeBps: 25 }, 'TEST')
    expect(perShare.assumptions.join(' ')).toMatch(/per share/i)
    expect(percent.assumptions.join(' ')).toMatch(/basis points of notional/i)
  })
})

describe('cryptoFeeWarning — honest disclosure, never a silent switch', () => {
  it('warns when a crypto symbol is modelled per-share', () => {
    expect(cryptoFeeWarning('BTC/USD', 'per-share')).toMatch(/percent of notional/i)
    expect(cryptoFeeWarning('ETHUSD', undefined)).toMatch(/percent of notional/i)
  })

  it('stays silent for stocks, and for crypto already on percent mode', () => {
    expect(cryptoFeeWarning('SPY', 'per-share')).toBeNull()
    expect(cryptoFeeWarning('BTC/USD', 'percent')).toBeNull()
  })

  it('is surfaced in a real crypto backtest left on the default mode', () => {
    const r = runBacktest(barsFromCloses(CLOSES), { ...BASE, commissionPerShare: 0.005, feeMode: 'per-share', feeBps: 0 }, 'BTC/USD')
    expect(r.warnings.some(w => /percent of notional/i.test(w))).toBe(true)
  })
})
