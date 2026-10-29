import { describe, it, expect, vi } from 'vitest'
vi.mock('electron-store', () => ({ default: class {
  private value: unknown = { datasets: [], watchlist: [], latest: null }
  get() { return structuredClone(this.value) }
  set(_key: string, value: unknown) { this.value = structuredClone(value) }
} }))
import { registerMarketsHandlers } from './markets'
describe('market IPC input boundary', () => {
  it('rejects malformed import, watchlist and simulation payloads without mutation', () => {
    const handlers: Record<string, (...args: any[]) => any> = {}
    registerMarketsHandlers({ handle: (name: string, fn: any) => { handlers[name] = fn } } as any)
    const before = handlers['markets:state']()
    expect(() => handlers['markets:import']({}, '../BAD', 'bad')).toThrow()
    expect(() => handlers['markets:watchlist']({}, 'TEST')).toThrow()
    expect(() => handlers['markets:watchlist']({}, ['UNKNOWN'])).toThrow()
    expect(() => handlers['markets:backtest']({}, null)).toThrow()
    expect(handlers['markets:state']()).toEqual(before)
  })
})

import { MarketsService } from '../services/markets'
it('stores imports, validates watchlists, reports stale data and invalidates superseded results', () => {
  const service = new MarketsService()
  expect(service.report()).toContain('Missing data')
  const csv = 'date,close\n' + [10, 12, 14, 8, 7, 9, 10, 12, 14, 8, 7, 9].map((v, i) => `2020-01-${String(i + 1).padStart(2, '0')},${v}`).join('\n')
  service.importCsv('TEST', csv)
  expect(service.watchlist([]).watchlist).toEqual([])
  expect(service.watchlist(['TEST', 'TEST']).watchlist).toEqual(['TEST'])
  const config = { symbol: 'TEST', initialCash: 100, quantity: 2, lookback: 2, feeBps: 0, slippageBps: 0, evaluationStart: '2020-01-07' }
  expect(service.run(config).latest?.evaluation.finalEquity).toBe(86)
  expect(service.report(Date.parse('2020-02-01'))).toContain('STALE')
  expect(service.report()).toContain('return -14.00%')
  expect(service.importCsv('TEST', csv).latest).toBeNull()
  expect(service.state().datasets).toHaveLength(1)
})
