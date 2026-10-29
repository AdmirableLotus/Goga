import { describe, it, expect } from 'vitest'
import { backtest, parseMarketCsv, validateBacktest } from '../marketCalculations'
const closes = [10, 12, 14, 8, 7, 9, 10, 12, 14, 8, 7, 9]
const csv = 'date,close\n' + closes.map((v, i) => `2020-01-${String(i + 1).padStart(2, '0')},${v}`).join('\n')
const data = parseMarketCsv('TEST', csv, new Date('2020-02-01'))
const config = { symbol: 'TEST', initialCash: 100, quantity: 2, lookback: 2, feeBps: 0, slippageBps: 0, evaluationStart: '2020-01-07' }
describe('historical simulations', () => {
  it('executes previous signals at next close and accounts for cash, positions and drawdown', () => {
    const result = backtest(data, config)
    const p = result.development
    expect(p.trades.map(t => [t.side, t.date, t.price, t.cash])).toEqual([['buy', '2020-01-03', 14, 72], ['sell', '2020-01-05', 7, 86]])
    expect(p.finalEquity).toBe(86)
    expect(p.returnPct).toBeCloseTo(-14)
    expect(p.maxDrawdownPct).toBeCloseTo(14)
    expect(p.curve[2].exposure).toBeCloseTo(0.28)
    for (const point of p.curve) expect(point.equity).toBeCloseTo(point.cash + point.quantity * data.bars.find(b => b.date === point.date)!.close)
    expect(result.evaluation.finalEquity).toBe(86)
    expect(result.evaluation.curve[0].cash).toBe(100)
    expect(backtest(data, config)).toEqual(result)
  })
  it('charges fees and adverse slippage on both fills', () => {
    const p = backtest(data, { ...config, feeBps: 100, slippageBps: 100 }).development
    const cost = 2 * 14 * 1.01 * 1.01
    const proceeds = 2 * 7 * 0.99 * 0.99
    expect(p.finalEquity).toBeCloseTo(100 - cost + proceeds)
    expect(p.trades[0].fee).toBeCloseTo(2 * 14 * 1.01 * .01)
  })
  it('rejects buys with insufficient cash without changing balances', () => {
    const p = backtest(data, { ...config, initialCash: 1 }).development
    expect(p.trades.every(t => t.side === 'rejected' && t.fee === 0)).toBe(true)
    expect(p.finalEquity).toBe(1)
    expect(p.curve.every(v => v.quantity === 0 && v.cash === 1)).toBe(true)
  })
  it('does not use future evaluation data for development', () => {
    const modified = { ...data, bars: data.bars.map((b, i) => i < 6 ? b : { ...b, close: 999 }) }
    expect(backtest(modified, config).development).toEqual(backtest(data, config).development)
  })
  it('rejects invalid CSV and requests', () => {
    for (const value of [null, '', 'date,close\n2020-02-30,1\n2020-03-01,2\n2020-03-02,3', 'date,close\n2020-01-01,1\n2020-01-01,2\n2020-01-03,3', csv.replace(',10', ',NaN'), csv.replace(',10', ',-1')]) expect(() => parseMarketCsv('TEST', value)).toThrow()
    expect(() => parseMarketCsv('../TEST', csv)).toThrow()
    for (const value of [null, {}, { ...config, quantity: 1.5 }, { ...config, initialCash: Infinity }, { ...config, feeBps: -1 }, { ...config, lookback: '2' }, { ...config, evaluationStart: '2020-02-30' }]) expect(() => validateBacktest(value)).toThrow()
    expect(() => backtest(data, { ...config, evaluationStart: '2020-01-03' })).toThrow()
  })
})
