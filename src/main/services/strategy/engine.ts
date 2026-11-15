import type {
  BacktestConfig, BacktestResult, Bar, Signal, StrategyDefinition, StrategyId, StrategyParams, Trade,
} from '../../../shared/strategy'
import { atr, rsi, sma } from '../trading/indicators'

/**
 * The strategy engine.
 *
 * Every rule here is a pure function of the bars it is given. `decide()` looks at bars
 * 0..i and nothing else, so a decision at bar i can never see bar i+1 — that is the
 * look-ahead guard, and it is structural rather than a promise. The backtester and the
 * paper loop both call the same `decide()`, so what is tested is what runs.
 *
 * Fills happen at the NEXT bar's open, not at the close that produced the signal. A
 * signal you can only act on after the close cannot be filled at that close.
 */

export const STRATEGIES: StrategyDefinition[] = [
  {
    id: 'sma-cross',
    name: 'Moving-average crossover',
    summary: 'Follows a trend: hold while the fast average is above the slow one.',
    entryRule: 'Buy at the next open when the fast SMA crosses from at-or-below the slow SMA to above it (yesterday fast ≤ slow, today fast > slow).',
    exitRule: 'Sell at the next open when the fast SMA crosses back to at-or-below the slow SMA.',
    params: [
      { key: 'fast', label: 'Fast SMA (bars)', default: 20, min: 2, max: 200, step: 1, help: 'Short average. Smaller = more trades.' },
      { key: 'slow', label: 'Slow SMA (bars)', default: 50, min: 3, max: 300, step: 1, help: 'Long average. Must be larger than the fast one.' },
    ],
    sizing: 'Risk a fixed percent of equity between entry and the ATR stop, capped at a percent of equity per position.',
  },
  {
    id: 'breakout',
    name: 'Donchian breakout',
    summary: 'Buys a new high, sells a new low. Trend-following, no averaging down.',
    entryRule: 'Buy at the next open when the close is above the highest HIGH of the previous N bars (the current bar is not included in that high).',
    exitRule: 'Sell at the next open when the close is below the lowest LOW of the previous M bars.',
    params: [
      { key: 'lookback', label: 'Breakout lookback (bars)', default: 20, min: 5, max: 200, step: 1, help: 'How many prior bars make the high that must be beaten.' },
      { key: 'exitLookback', label: 'Exit lookback (bars)', default: 10, min: 2, max: 100, step: 1, help: 'How many prior bars make the low that must be broken to sell.' },
    ],
    sizing: 'Risk a fixed percent of equity between entry and the ATR stop, capped at a percent of equity per position.',
  },
  {
    id: 'mean-reversion',
    name: 'RSI mean reversion',
    summary: 'Buys a stretched-down market and sells when it recovers. Counter-trend.',
    entryRule: 'Buy at the next open when RSI(period) crosses from at-or-above the oversold level to below it.',
    exitRule: 'Sell at the next open when RSI(period) crosses from at-or-below the exit level to above it.',
    params: [
      { key: 'rsiPeriod', label: 'RSI period (bars)', default: 14, min: 2, max: 60, step: 1, help: 'Wilder RSI lookback.' },
      { key: 'oversold', label: 'Buy below RSI', default: 30, min: 5, max: 50, step: 1, help: 'Entry threshold.' },
      { key: 'exitLevel', label: 'Sell above RSI', default: 55, min: 35, max: 95, step: 1, help: 'Exit threshold. Must be above the buy level.' },
    ],
    sizing: 'Risk a fixed percent of equity between entry and the ATR stop, capped at a percent of equity per position.',
  },
]

export function strategyDefinition(id: StrategyId): StrategyDefinition {
  const found = STRATEGIES.find(s => s.id === id)
  if (!found) throw new Error(`unknown strategy "${id}"`)
  return found
}

/** Defaults merged with whatever the user set, with every value clamped to its range. */
export function resolveParams(id: StrategyId, given: StrategyParams = {}): StrategyParams {
  const def = strategyDefinition(id)
  const out: StrategyParams = {}
  for (const spec of def.params) {
    const raw = Number(given[spec.key])
    const value = Number.isFinite(raw) ? raw : spec.default
    out[spec.key] = Math.min(spec.max, Math.max(spec.min, Math.round(value)))
  }
  if (id === 'sma-cross' && out.fast >= out.slow) {
    // Keep the pair legal rather than silently producing a strategy that never trades.
    out.slow = Math.min(300, out.fast + 1)
  }
  if (id === 'mean-reversion' && out.exitLevel <= out.oversold) out.exitLevel = Math.min(95, out.oversold + 5)
  return out
}

/** How many bars must pass before the strategy can say anything at all. */
export function warmupBars(id: StrategyId, params: StrategyParams): number {
  const p = resolveParams(id, params)
  switch (id) {
    case 'sma-cross': return p.slow + 1
    case 'breakout': return Math.max(p.lookback, p.exitLookback) + 1
    case 'mean-reversion': return p.rsiPeriod + 2
  }
}

export interface Decision {
  action: 'enter' | 'exit' | 'hold'
  reason: string
}

const HOLD: Decision = { action: 'hold', reason: '' }

/**
 * The one place a strategy decides anything.
 *
 * `bars` may be the whole history; only `bars[0..index]` is read. `holding` is whether a
 * position is open at the close of that bar.
 */
export function decide(id: StrategyId, params: StrategyParams, bars: Bar[], index: number, holding: boolean): Decision {
  const p = resolveParams(id, params)
  if (index < 1 || index >= bars.length) return HOLD
  const closes = bars.slice(0, index + 1).map(b => b.c)

  if (id === 'sma-cross') {
    const fast = sma(closes, p.fast)
    const slow = sma(closes, p.slow)
    const f = fast[index], s = slow[index], pf = fast[index - 1], ps = slow[index - 1]
    if (![f, s, pf, ps].every(Number.isFinite)) return HOLD
    if (!holding && pf <= ps && f > s) return { action: 'enter', reason: `SMA${p.fast} ${f.toFixed(2)} crossed above SMA${p.slow} ${s.toFixed(2)}` }
    if (holding && pf >= ps && f < s) return { action: 'exit', reason: `SMA${p.fast} ${f.toFixed(2)} crossed below SMA${p.slow} ${s.toFixed(2)}` }
    return HOLD
  }

  if (id === 'breakout') {
    const n = p.lookback, m = p.exitLookback
    if (index < n) return HOLD
    const priorHigh = Math.max(...bars.slice(index - n, index).map(b => b.h))
    const priorLow = Math.min(...bars.slice(index - m, index).map(b => b.l))
    const close = bars[index].c
    if (!holding && close > priorHigh) return { action: 'enter', reason: `close ${close.toFixed(2)} above the ${n}-bar high ${priorHigh.toFixed(2)}` }
    if (holding && close < priorLow) return { action: 'exit', reason: `close ${close.toFixed(2)} below the ${m}-bar low ${priorLow.toFixed(2)}` }
    return HOLD
  }

  // mean-reversion
  const r = rsi(closes, p.rsiPeriod)
  const now = r[index], before = r[index - 1]
  if (![now, before].every(Number.isFinite)) return HOLD
  if (!holding && before >= p.oversold && now < p.oversold) return { action: 'enter', reason: `RSI${p.rsiPeriod} fell to ${now.toFixed(1)}, below ${p.oversold}` }
  if (holding && before <= p.exitLevel && now > p.exitLevel) return { action: 'exit', reason: `RSI${p.rsiPeriod} recovered to ${now.toFixed(1)}, above ${p.exitLevel}` }
  return HOLD
}

/** Every decision the strategy would make over the whole series, for display and testing. */
export function signals(id: StrategyId, params: StrategyParams, bars: Bar[]): Signal[] {
  const out: Signal[] = []
  let holding = false
  for (let i = 0; i < bars.length; i++) {
    const d = decide(id, params, bars, i, holding)
    if (d.action === 'enter') { holding = true; out.push({ index: i, action: 'enter', reason: d.reason }) }
    else if (d.action === 'exit') { holding = false; out.push({ index: i, action: 'exit', reason: d.reason }) }
  }
  return out
}

export const DEFAULT_BACKTEST: Omit<BacktestConfig, 'strategyId' | 'params'> = {
  startingCapital: 10_000,
  commissionPerShare: 0.005,
  slippageBps: 5,
  riskPct: 1,
  maxPositionPct: 25,
  stopAtrMultiple: 2,
  atrPeriod: 14,
}

/**
 * Shares to buy. Two caps, whichever is smaller:
 *   - risk: (equity × riskPct%) ÷ (stop distance in dollars)
 *   - exposure: (equity × maxPositionPct%) ÷ price
 * With the stop switched off there is no risk figure, so only the exposure cap applies.
 */
export function sizePosition(input: {
  equity: number
  price: number
  stopDistance: number
  riskPct: number
  maxPositionPct: number
}): number {
  const { equity, price, stopDistance, riskPct, maxPositionPct } = input
  if (!(equity > 0) || !(price > 0)) return 0
  const exposureCap = equity * (maxPositionPct / 100) / price
  const riskCap = stopDistance > 0 ? equity * (riskPct / 100) / stopDistance : Infinity
  const qty = Math.floor(Math.min(exposureCap, riskCap))
  return Number.isFinite(qty) && qty > 0 ? qty : 0
}

function maxDrawdownOf(equity: number[]): number {
  let peak = -Infinity, worst = 0
  for (const e of equity) {
    peak = Math.max(peak, e)
    if (peak > 0) worst = Math.max(worst, (peak - e) / peak)
  }
  return worst
}

/**
 * Run a strategy over bars.
 *
 * Assumptions, all of them stated in the result so the UI can show them:
 *   - a signal is decided on a bar's CLOSE and filled at the NEXT bar's OPEN;
 *   - slippage moves every fill against you by `slippageBps`;
 *   - commission is charged per share on entry and on exit;
 *   - the ATR stop is checked against each bar's low and fills at the stop (or the open
 *     if the bar gapped through it);
 *   - long only, one position at a time, no shorting, no leverage, no dividends, no tax.
 */
export function runBacktest(bars: Bar[], config: BacktestConfig, symbol = ''): BacktestResult {
  const cfg: BacktestConfig = { ...DEFAULT_BACKTEST, ...config }
  const id = cfg.strategyId
  const params = resolveParams(id, cfg.params)
  const slip = Math.max(0, cfg.slippageBps) / 10_000
  const commission = Math.max(0, cfg.commissionPerShare)
  const warmup = warmupBars(id, params)

  let cash = cfg.startingCapital
  let qty = 0
  let entryPrice = 0
  let entryIndex = -1
  let entryCost = 0
  let stopPrice = 0
  let pending: Decision | null = null
  const trades: Trade[] = []
  const equityCurve: { t: string; equity: number }[] = []
  let barsInMarket = 0

  const closePosition = (i: number, price: number, reason: Trade['exitReason']) => {
    const fill = price * (1 - slip)
    const proceeds = qty * fill - qty * commission
    cash += proceeds
    const pnl = proceeds - entryCost
    trades.push({
      entryIndex, entryTime: bars[entryIndex].t, entryPrice,
      exitIndex: i, exitTime: bars[i].t, exitPrice: fill,
      qty, pnl, pnlPct: entryCost > 0 ? pnl / entryCost : 0,
      barsHeld: i - entryIndex, exitReason: reason,
    })
    qty = 0; entryPrice = 0; entryIndex = -1; entryCost = 0; stopPrice = 0
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]

    // 1. Act on yesterday's close decision at today's open.
    if (pending?.action === 'enter' && qty === 0) {
      const fill = bar.o * (1 + slip)
      const a = atr(bars.slice(0, i), cfg.atrPeriod)
      const lastAtr = a[a.length - 1]
      const stopDistance = cfg.stopAtrMultiple > 0 && Number.isFinite(lastAtr) ? lastAtr * cfg.stopAtrMultiple : 0
      const equityNow = cash
      const size = sizePosition({ equity: equityNow, price: fill, stopDistance, riskPct: cfg.riskPct, maxPositionPct: cfg.maxPositionPct })
      if (size > 0) {
        const cost = size * fill + size * commission
        if (cost <= cash) {
          cash -= cost
          qty = size
          entryPrice = fill
          entryIndex = i
          entryCost = cost
          stopPrice = stopDistance > 0 ? fill - stopDistance : 0
        }
      }
    } else if (pending?.action === 'exit' && qty > 0) {
      closePosition(i, bar.o, 'signal')
    }
    pending = null

    // 2. The stop, checked inside the bar.
    if (qty > 0 && stopPrice > 0 && bar.l <= stopPrice) {
      closePosition(i, Math.min(bar.o, stopPrice), 'stop')
    }

    if (qty > 0) barsInMarket++
    equityCurve.push({ t: bar.t, equity: cash + qty * bar.c })

    // 3. Decide on this bar's close, for the next bar's open.
    if (i >= warmup) pending = decide(id, params, bars, i, qty > 0)
  }

  // Close anything still open at the last close, so the trade list is complete.
  if (qty > 0) closePosition(bars.length - 1, bars[bars.length - 1].c, 'end-of-test')

  const endingEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : cfg.startingCapital
  const wins = trades.filter(t => t.pnl > 0)
  const losses = trades.filter(t => t.pnl <= 0)
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0))
  const first = bars[0], lastBar = bars[bars.length - 1]

  const warnings: string[] = []
  if (trades.length < 10) warnings.push(`Only ${trades.length} trade${trades.length === 1 ? '' : 's'} — far too few to tell skill from luck. Test more history or more symbols.`)
  if (bars.length < 200) warnings.push(`${bars.length} bars is a short test. A year of daily bars is about 250.`)
  if (trades.length > 0 && grossLoss === 0) warnings.push('No losing trades at all, which usually means the test is too short or too kind.')

  return {
    strategyId: id,
    symbol,
    barCount: bars.length,
    from: first?.t ?? '',
    to: lastBar?.t ?? '',
    startingCapital: cfg.startingCapital,
    endingEquity,
    totalReturn: cfg.startingCapital > 0 ? endingEquity / cfg.startingCapital - 1 : 0,
    buyHoldReturn: first && first.c > 0 ? lastBar.c / first.c - 1 : 0,
    maxDrawdown: maxDrawdownOf(equityCurve.map(p => p.equity)),
    winRate: trades.length ? wins.length / trades.length : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    tradeCount: trades.length,
    exposure: bars.length ? barsInMarket / bars.length : 0,
    trades,
    equityCurve,
    assumptions: [
      `Signals are decided on a bar's close and filled at the next bar's open — a decision never uses a bar it could not have seen.`,
      `Slippage ${cfg.slippageBps} basis points against you on every fill (${(cfg.slippageBps / 100).toFixed(2)}%).`,
      `Commission $${commission.toFixed(4)} per share on entry and on exit.`,
      cfg.stopAtrMultiple > 0
        ? `Stop ${cfg.stopAtrMultiple}× ATR(${cfg.atrPeriod}) below entry, filled at the stop or at the open if the bar gapped through it.`
        : 'No stop loss — a losing position is held until the exit rule fires.',
      `Position size: risk ${cfg.riskPct}% of equity to the stop, capped at ${cfg.maxPositionPct}% of equity per position.`,
      'Long only, one position at a time, no shorting, no leverage, no dividends, no tax, no borrow cost.',
      'A backtest is not a prediction. It says what these rules would have done on this history, nothing about tomorrow.',
    ],
    warnings,
    dataSource: 'synthetic',
    dataNote: '',
  }
}
