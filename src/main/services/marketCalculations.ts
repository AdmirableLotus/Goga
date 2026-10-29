import type { BacktestRequest, BacktestResult, MarketDataset, SimulationPeriod } from '../../shared/markets'

export function symbolValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(value)) throw new Error('Symbol must be 1–20 uppercase letters, digits, dot, dash or underscore.')
  return value
}
export function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}
export function parseMarketCsv(symbol: unknown, csv: unknown, now = new Date()): MarketDataset {
  const name = symbolValue(symbol)
  if (typeof csv !== 'string' || csv.length > 2_000_000) throw new Error('CSV must be text, at most 2 MB.')
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  if (lines.shift()?.trim().toLowerCase() !== 'date,close') throw new Error('CSV header must be date,close (daily ISO dates and positive closes).')
  if (lines.length < 3 || lines.length > 20_000) throw new Error('Import 3–20,000 daily rows.')
  let previous = ''
  const bars = lines.map((line, index) => {
    const fields = line.split(',').map(s => s.trim())
    const [date, raw] = fields
    const close = Number(raw)
    if (fields.length !== 2 || !validDate(date) || date <= previous || date > now.toISOString().slice(0, 10) || !raw || !Number.isFinite(close) || close <= 0 || close > 1e12) throw new Error(`Invalid, duplicate, future or unordered row ${index + 2}.`)
    previous = date
    return { date, close }
  })
  return { symbol: name, source: 'Imported CSV', importedAt: now.toISOString(), bars }
}
export function validateBacktest(value: unknown): BacktestRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid simulation request.')
  const c = value as BacktestRequest
  symbolValue(c.symbol)
  for (const key of ['initialCash', 'quantity', 'lookback', 'feeBps', 'slippageBps'] as const) {
    if (typeof c[key] !== 'number' || !Number.isFinite(c[key])) throw new Error(`Invalid ${key}.`)
  }
  if (c.initialCash <= 0 || c.initialCash > 1e12 || !Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > 1e9 || !Number.isInteger(c.lookback) || c.lookback < 2 || c.lookback > 252 || c.feeBps < 0 || c.feeBps > 1000 || c.slippageBps < 0 || c.slippageBps > 1000 || !validDate(c.evaluationStart)) throw new Error('Simulation parameters out of range.')
  return { symbol: c.symbol, initialCash: c.initialCash, quantity: c.quantity, lookback: c.lookback, feeBps: c.feeBps, slippageBps: c.slippageBps, evaluationStart: c.evaluationStart }
}
export function backtest(data: MarketDataset, input: unknown): BacktestResult {
  const c = validateBacktest(input)
  if (c.symbol !== data.symbol) throw new Error('Dataset does not match symbol.')
  const split = data.bars.findIndex(b => b.date >= c.evaluationStart)
  if (split < c.lookback + 2 || data.bars.length - split < c.lookback + 2) throw new Error('Each period needs at least lookback + 2 rows.')
  const simulate = (bars: MarketDataset['bars']): SimulationPeriod => {
    let cash = c.initialCash, quantity = 0, peak = cash, maxDrawdown = 0
    const trades: SimulationPeriod['trades'] = [], curve: SimulationPeriod['curve'] = []
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]
      if (i >= c.lookback) {
        const history = bars.slice(i - c.lookback, i)
        const average = history.reduce((sum, b) => sum + b.close, 0) / c.lookback
        const buy = bars[i - 1].close > average
        if ((buy && quantity === 0) || (!buy && quantity > 0)) {
          const side = buy ? 'buy' : 'sell'
          const units = buy ? c.quantity : quantity
          const price = bar.close * (1 + (buy ? 1 : -1) * c.slippageBps / 10000)
          const fee = units * price * c.feeBps / 10000
          const reason = `Previous close ${bars[i - 1].close} ${buy ? 'above' : 'at/below'} prior ${c.lookback}-bar mean ${average}; executed at next close.`
          if (buy && units * price + fee > cash) trades.push({ date: bar.date, side: 'rejected', quantity: units, price, fee: 0, cash, reason: `Insufficient cash. ${reason}` })
          else {
            cash += buy ? -(units * price + fee) : units * price - fee
            quantity = buy ? units : 0
            trades.push({ date: bar.date, side, quantity: units, price, fee, cash, reason })
          }
        }
      }
      const equity = cash + quantity * bar.close
      peak = Math.max(peak, equity)
      const drawdown = (peak - equity) / peak
      maxDrawdown = Math.max(maxDrawdown, drawdown)
      curve.push({ date: bar.date, equity, cash, quantity, exposure: quantity * bar.close / equity, drawdown })
    }
    const finalEquity = curve[curve.length - 1].equity
    return { start: bars[0].date, end: bars[bars.length - 1].date, initialCash: c.initialCash, finalEquity, returnPct: (finalEquity / c.initialCash - 1) * 100, maxDrawdownPct: maxDrawdown * 100, exposurePct: curve.reduce((sum, p) => sum + p.exposure, 0) / curve.length * 100, trades, curve }
  }
  return { config: c, dataImportedAt: data.importedAt, dataThrough: data.bars[data.bars.length - 1].date, development: simulate(data.bars.slice(0, split)), evaluation: simulate(data.bars.slice(split)) }
}
