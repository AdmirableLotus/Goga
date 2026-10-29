import type { MarketsState } from '../../shared/markets'
import { backtest, parseMarketCsv, symbolValue } from './marketCalculations'
import Store from 'electron-store'
export class MarketsService {
  private static instance: MarketsService
  static getInstance() { return this.instance ??= new MarketsService() }
  private store = new Store({ name: 'markets', defaults: { state: { datasets: [], watchlist: [], latest: null } } })
  state(): MarketsState { return this.store.get('state') }
  importCsv(symbol: unknown, csv: unknown) {
    const data = parseMarketCsv(symbol, csv), state = this.state()
    if (!state.datasets.some(d => d.symbol === data.symbol) && state.datasets.length >= 50) throw new Error('Maximum 50 datasets.')
    state.datasets = [...state.datasets.filter(d => d.symbol !== data.symbol), data]
    if (!state.watchlist.includes(data.symbol)) state.watchlist.push(data.symbol)
    if (state.latest?.config.symbol === data.symbol) state.latest = null
    this.store.set('state', state)
    return state
  }
  watchlist(value: unknown) {
    if (!Array.isArray(value) || value.length > 50) throw new Error('Invalid watchlist.')
    const symbols = [...new Set(value.map(symbolValue))], state = this.state()
    if (symbols.some(s => !state.datasets.some(d => d.symbol === s))) throw new Error('Import a symbol before adding it.')
    state.watchlist = symbols
    this.store.set('state', state)
    return state
  }
  run(input: unknown) {
    const state = this.state()
    const symbol = symbolValue((input as any)?.symbol)
    const data = state.datasets.find(d => d.symbol === symbol)
    if (!data) throw new Error('Import historical data for this symbol first.')
    state.latest = backtest(data, input)
    this.store.set('state', state)
    return state
  }
  report(now = Date.now()): string {
    const s = this.state()
    const lines = ['Verified local market calculations. Historical simulation only; live prices, corporate-action adjustments and execution are unavailable.']
    for (const d of s.datasets) {
      const last = d.bars[d.bars.length - 1]
      lines.push(`${d.symbol}: ${d.bars.length} rows; source ${d.source}; imported ${d.importedAt}; through ${last.date}; last close ${last.close}; ${now - Date.parse(last.date) > 3 * 86400000 ? 'STALE (>3 calendar days)' : 'historical, not a live quote'}.`)
    }
    if (!s.datasets.length) lines.push('Missing data: import date,close CSV on Markets.')
    if (s.latest) {
      lines.push(`Latest run parameters: ${JSON.stringify(s.latest.config)}. Periods reset cash and positions, including independent warmup; open positions marked at last close, no forced liquidation.`)
      for (const key of ['development', 'evaluation'] as const) {
        const p = s.latest[key]
        lines.push(`${key} ${p.start} to ${p.end}: equity ${p.finalEquity.toFixed(2)}, return ${p.returnPct.toFixed(2)}%, max drawdown ${p.maxDrawdownPct.toFixed(2)}%, mean exposure ${p.exposurePct.toFixed(2)}%, journal events ${p.trades.length}.`)
      }
    } else lines.push('Missing calculation: run a simulation on Markets.')
    return lines.join('\n')
  }
}
