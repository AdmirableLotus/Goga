/**
 * Market math done in code, never by the brain: indicators, a plain-words read of a chart,
 * and a backtest that shows how a rule-based strategy would have done, fees included.
 */

export interface Bar { t: string; o: number; h: number; l: number; c: number; v: number }

const round = (n: number, places = 2) => Number.isFinite(n) ? Number(n.toFixed(places)) : NaN

export function sma(values: number[], period: number): number[] {
  return values.map((_, i) => i + 1 < period ? NaN : values.slice(i + 1 - period, i + 1).reduce((a, b) => a + b, 0) / period)
}

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  values.forEach((v, i) => {
    if (i + 1 < period) out.push(NaN)
    else if (i + 1 === period) out.push(values.slice(0, period).reduce((a, b) => a + b, 0) / period)
    else out.push(v * k + out[i - 1] * (1 - k))
  })
  return out
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): number[] {
  const out: number[] = values.map(() => NaN)
  if (values.length <= period) return out
  let gain = 0, loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    gain += Math.max(d, 0); loss += Math.max(-d, 0)
  }
  gain /= period; loss /= period
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  }
  return out
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9): { macd: number[]; signal: number[]; histogram: number[] } {
  const f = ema(values, fast), s = ema(values, slow)
  const line = values.map((_, i) => f[i] - s[i])
  const firstValid = line.findIndex(Number.isFinite)
  const sig = firstValid < 0 ? line.map(() => NaN) : [...line.slice(0, firstValid).map(() => NaN), ...ema(line.slice(firstValid), signal)]
  return { macd: line, signal: sig, histogram: line.map((m, i) => m - sig[i]) }
}

/** Average true range: how far the price typically moves in one bar. */
export function atr(bars: Bar[], period = 14): number[] {
  const tr = bars.map((b, i) => i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)))
  const out: number[] = bars.map(() => NaN)
  if (bars.length < period) return out
  out[period - 1] = tr.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < bars.length; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
  return out
}

export function bollinger(values: number[], period = 20, width = 2): { middle: number[]; upper: number[]; lower: number[] } {
  const middle = sma(values, period)
  const sd = values.map((_, i) => {
    if (i + 1 < period) return NaN
    const slice = values.slice(i + 1 - period, i + 1)
    const mean = middle[i]
    return Math.sqrt(slice.reduce((a, v) => a + (v - mean) ** 2, 0) / period)
  })
  return { middle, upper: middle.map((m, i) => m + width * sd[i]), lower: middle.map((m, i) => m - width * sd[i]) }
}

/** The worst fall from a peak, as a fraction (0.25 = 25%). */
export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity, worst = 0
  for (const e of equity) { peak = Math.max(peak, e); worst = Math.max(worst, (peak - e) / peak) }
  return worst
}

const last = (a: number[]) => a[a.length - 1]
const pct = (n: number) => `${n >= 0 ? '+' : ''}${round(n * 100, 1)}%`

/** A chart read in plain words, with the numbers behind it. */
export function chartSummary(symbol: string, bars: Bar[], timeframe: string): string {
  if (bars.length < 30) return `Only ${bars.length} ${timeframe} bars for ${symbol} — not enough history for indicators.`
  const closes = bars.map(b => b.c)
  const price = last(closes)
  const s20 = last(sma(closes, 20)), s50 = last(sma(closes, 50)), s200 = last(sma(closes, 200))
  const r = last(rsi(closes))
  const m = macd(closes)
  const a = last(atr(bars))
  const bb = bollinger(closes)
  const change = (n: number) => closes.length > n ? price / closes[closes.length - 1 - n] - 1 : NaN
  const window = closes.slice(-Math.min(closes.length, 252))
  const returns = closes.slice(1).map((c, i) => c / closes[i] - 1).slice(-60)
  const vol = Math.sqrt(returns.reduce((s, x) => s + x * x, 0) / returns.length)

  const trend = Number.isFinite(s50) && Number.isFinite(s200)
    ? (price > s50 && s50 > s200 ? 'uptrend (price above the 50 and 200 averages)' : price < s50 && s50 < s200 ? 'downtrend (price below the 50 and 200 averages)' : 'mixed trend')
    : price > s20 && (!Number.isFinite(s50) || s20 > s50) ? 'short-term uptrend' : price < s20 ? 'short-term downtrend' : 'sideways'
  const momentum = r >= 70 ? 'overbought (RSI 70+), stretched after a run up' : r <= 30 ? 'oversold (RSI 30 or less), stretched after a drop' : 'neutral momentum'
  const macdNote = last(m.histogram) > 0 ? (m.histogram[m.histogram.length - 2] <= 0 ? 'MACD just crossed up' : 'MACD positive') : (m.histogram[m.histogram.length - 2] >= 0 ? 'MACD just crossed down' : 'MACD negative')

  return [
    `${symbol} (${timeframe} bars, ${bars.length} of them, last ${bars[bars.length - 1].t.slice(0, 16).replace('T', ' ')} UTC)`,
    `Price ${round(price, 4)} | change: ${pct(change(1))} last bar, ${pct(change(5))} 5 bars, ${pct(change(20))} 20 bars`,
    `Range of the last ${window.length} bars: low ${round(Math.min(...window), 4)}, high ${round(Math.max(...window), 4)}`,
    `Averages: 20=${round(s20, 4)} 50=${round(s50, 4)} 200=${round(s200, 4)} → ${trend}`,
    `RSI(14) ${round(r, 1)} → ${momentum}; ${macdNote}`,
    `Bollinger(20,2): ${round(last(bb.lower), 4)} – ${round(last(bb.upper), 4)}`,
    `Typical move per bar (ATR 14): ${round(a, 4)} (${round(a / price * 100, 2)}% of price); volatility per bar ${round(vol * 100, 2)}%`,
    `A stop 2×ATR away would sit near ${round(price - 2 * a, 4)} for a buy or ${round(price + 2 * a, 4)} for a sell.`,
  ].join('\n')
}

// ── Backtest ─────────────────────────────────────────────────────────────────

export type Strategy = 'sma-cross' | 'rsi-reversion' | 'breakout' | 'buy-and-hold'
export const STRATEGIES: Record<Strategy, string> = {
  'sma-cross': 'buy when the fast average crosses above the slow one, sell when it crosses back (fast/slow default 20/50)',
  'rsi-reversion': 'buy when RSI(14) falls below 30, sell when it rises above 55',
  'breakout': 'buy when price closes above the highest close of the last 20 bars, sell below the lowest of the last 10',
  'buy-and-hold': 'buy on the first bar and hold — the yardstick every strategy should beat',
}

export interface BacktestResult {
  strategy: Strategy
  bars: number
  trades: number
  winRate: number
  totalReturn: number
  buyHoldReturn: number
  maxDrawdown: number
  avgTrade: number
  exposure: number
}

/** For each bar, whether the strategy wants to be holding (long-only). Shared by the backtest and the auto-trader. */
export function inMarketSeries(bars: Bar[], strategy: Strategy, opts: { fast?: number; slow?: number } = {}): boolean[] {
  const closes = bars.map(b => b.c)
  const fast = sma(closes, opts.fast ?? 20), slow = sma(closes, opts.slow ?? 50)
  const r = rsi(closes)
  const wantIn = (i: number, inMarket: boolean): boolean => {
    switch (strategy) {
      case 'buy-and-hold': return true
      case 'sma-cross': return Number.isFinite(slow[i]) ? fast[i] > slow[i] : false
      case 'rsi-reversion': return inMarket ? !(r[i] > 55) : r[i] < 30
      case 'breakout': {
        if (i < 20) return false
        if (!inMarket) return closes[i] > Math.max(...closes.slice(i - 20, i))
        return !(closes[i] < Math.min(...closes.slice(i - 10, i)))
      }
    }
  }
  const series: boolean[] = []
  for (let i = 0; i < bars.length; i++) series.push(wantIn(i, series[i - 1] ?? false))
  return series
}

/** Long-only, all in or out, filled at the close of the signal bar, with fees per side. */
export function backtest(bars: Bar[], strategy: Strategy, opts: { fast?: number; slow?: number; feePct?: number } = {}): BacktestResult {
  const closes = bars.map(b => b.c)
  const fee = (opts.feePct ?? 0.1) / 100
  const series = inMarketSeries(bars, strategy, opts)
  let cash = 1, units = 0, entry = 0, barsIn = 0
  const tradeReturns: number[] = []
  const equity: number[] = []
  for (let i = 0; i < bars.length; i++) {
    const inMarket = units > 0
    const want = series[i]
    if (want && !inMarket) { units = cash * (1 - fee) / closes[i]; entry = cash; cash = 0 }
    else if (!want && inMarket) { cash = units * closes[i] * (1 - fee); tradeReturns.push(cash / entry - 1); units = 0 }
    if (units > 0) barsIn++
    equity.push(cash + units * closes[i])
  }
  if (units > 0) tradeReturns.push(units * last(closes) * (1 - fee) / entry - 1)
  const final = last(equity)
  return {
    strategy,
    bars: bars.length,
    trades: tradeReturns.length,
    winRate: tradeReturns.length ? tradeReturns.filter(x => x > 0).length / tradeReturns.length : 0,
    totalReturn: final - 1,
    buyHoldReturn: last(closes) / closes[0] - 1,
    maxDrawdown: maxDrawdown(equity),
    avgTrade: tradeReturns.length ? tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length : 0,
    exposure: barsIn / bars.length,
  }
}

export function backtestReport(symbol: string, timeframe: string, b: BacktestResult): string {
  const lines = [
    `Backtest of ${b.strategy} on ${symbol}, ${b.bars} ${timeframe} bars: ${STRATEGIES[b.strategy]}.`,
    `Result: ${pct(b.totalReturn)} vs buy-and-hold ${pct(b.buyHoldReturn)}; worst drop from a peak ${round(b.maxDrawdown * 100, 1)}%.`,
    `${b.trades} trades, ${round(b.winRate * 100, 0)}% winners, average trade ${pct(b.avgTrade)}, in the market ${round(b.exposure * 100, 0)}% of the time.`,
  ]
  if (b.trades < 10 && b.strategy !== 'buy-and-hold') lines.push('Too few trades to trust — test on more history or another symbol.')
  lines.push('Past results do not promise future ones; fees are counted, slippage and taxes are not.')
  return lines.join('\n')
}
