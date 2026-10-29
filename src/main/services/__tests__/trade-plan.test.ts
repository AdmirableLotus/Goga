import { describe, expect, it } from 'vitest'
import { tradePlan } from '../trading/tradePlan'
import type { Bar } from '../trading/indicators'

function bars(count: number, start = 100, step = 1): Bar[] {
  const out: Bar[] = []
  let p = start
  for (let i = 0; i < count; i++) { p += step; out.push({ t: `2026-01-${(i % 28) + 1}`, o: p, h: p + 2, l: p - 2, c: p, v: 1000 }) }
  return out
}

describe('trade plan', () => {
  it('places the stop an ATR multiple away and targets at R multiples', () => {
    const plan = tradePlan('AAA', bars(60), 'buy', { equity: 100000, riskPct: 1 })
    expect(plan.side).toBe('buy')
    expect(plan.stop).toBeLessThan(plan.entry)                 // buy stop below entry
    expect(plan.riskPerUnit).toBeCloseTo(plan.entry - plan.stop, 4)
    expect(plan.targets.map(t => t.r)).toEqual([1, 2, 3])
    expect(plan.targets[1].price).toBeCloseTo(plan.entry + 2 * plan.riskPerUnit, 3)  // 2R above entry
    expect(plan.rewardToRisk).toBeCloseTo(2, 1)
  })

  it('mirrors the stop and targets for a sell', () => {
    const plan = tradePlan('AAA', bars(60), 'sell', { equity: 100000, riskPct: 1 })
    expect(plan.stop).toBeGreaterThan(plan.entry)              // sell stop above entry
    expect(plan.targets[0].price).toBeLessThan(plan.entry)     // targets below for a short
  })

  it('sizes the position so the stop loss is about the risk percent of equity', () => {
    // Small per-unit risk so the position-size cap does not bind.
    const plan = tradePlan('AAA', bars(60, 100, 0.2), 'buy', { equity: 100000, riskPct: 1, maxPositionPct: 90 })
    const lossIfStopped = plan.suggestedQty * plan.riskPerUnit
    expect(lossIfStopped).toBeGreaterThan(900)
    expect(lossIfStopped).toBeLessThan(1100)                   // ~$1000 = 1% of $100k
  })

  it('caps the position at the max-position limit and warns', () => {
    const plan = tradePlan('AAA', bars(60), 'buy', { equity: 100000, riskPct: 5, maxPositionPct: 10 })
    expect(plan.orderValue).toBeLessThanOrEqual(10000.01)      // 10% of 100k
    expect(plan.warnings.join(' ')).toMatch(/capped/i)
  })

  it('needs enough history', () => {
    expect(() => tradePlan('AAA', bars(10), 'buy', { equity: 100000 })).toThrow('not enough history')
  })
})
