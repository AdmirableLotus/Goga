import { atr, sma, type Bar } from './indicators'

// A trade plan, the NOFX "Frontier" idea adapted for Goga's paper desk: lay out entry,
// stop, targets, size and reward-to-risk before anything is placed, so the user approves
// a concrete plan instead of a bare order. Nothing here touches a broker.

export interface TradePlan {
  symbol: string
  side: 'buy' | 'sell'
  entry: number
  stop: number
  riskPerUnit: number          // price distance to the stop
  atr: number
  targets: { r: number; price: number }[]   // 1R, 2R, 3R
  suggestedQty: number
  orderValue: number
  riskAmount: number           // dollars risked if the stop is hit
  riskPct: number              // percent of equity risked
  rewardToRisk: number         // at the 2R target
  trendNote: string
  warnings: string[]
  readable: string
}

const round = (n: number, dp = 4) => Number.isFinite(n) ? Number(n.toFixed(dp)) : NaN

/** Build a plan from real bars. `side` buy or sell; risk is a percent of equity (default 1%). */
export function tradePlan(symbol: string, bars: Bar[], side: 'buy' | 'sell', opts: { equity: number; riskPct?: number; atrMult?: number; maxPositionPct?: number }): TradePlan {
  if (bars.length < 20) throw new Error(`Only ${bars.length} bars for ${symbol} — not enough history to plan a trade.`)
  const closes = bars.map(b => b.c)
  const entry = closes[closes.length - 1]
  const a = atr(bars)[atr(bars).length - 1]
  if (!Number.isFinite(a) || a <= 0) throw new Error('Could not measure volatility (ATR) for a sensible stop.')
  const atrMult = opts.atrMult ?? 2
  const riskPct = Math.min(Math.max(opts.riskPct ?? 1, 0.1), 5)   // keep practice risk sane: 0.1–5%
  const riskPerUnit = atrMult * a
  const stop = side === 'buy' ? entry - riskPerUnit : entry + riskPerUnit
  const dir = side === 'buy' ? 1 : -1
  const targets = [1, 2, 3].map(r => ({ r, price: round(entry + dir * r * riskPerUnit, 6) }))

  const riskAmount = opts.equity * riskPct / 100
  let suggestedQty = riskAmount / riskPerUnit
  let orderValue = suggestedQty * entry
  const maxPositionPct = opts.maxPositionPct ?? 10
  const maxValue = opts.equity * maxPositionPct / 100
  const warnings: string[] = []
  if (orderValue > maxValue) {
    // Cap at the position-size limit, leaving a 2% margin so price drift between planning
    // and a market fill can't push the order over the limit and get it rejected.
    suggestedQty = maxValue * 0.98 / entry
    orderValue = suggestedQty * entry
    warnings.push(`Size capped at the ${maxPositionPct}% max position ($${maxValue.toFixed(0)}); actual risk is under ${riskPct}%.`)
  }
  // Floor the quantity to 4 decimals so rounding never nudges the order value back over a limit.
  suggestedQty = Math.floor(suggestedQty * 1e4) / 1e4
  orderValue = suggestedQty * entry

  const s50 = sma(closes, 50), s200 = sma(closes, 200)
  const t50 = s50[s50.length - 1], t200 = s200[s200.length - 1]
  const uptrend = Number.isFinite(t50) && Number.isFinite(t200) ? entry > t50 && t50 > t200 : entry > t50
  const downtrend = Number.isFinite(t50) && Number.isFinite(t200) ? entry < t50 && t50 < t200 : entry < t50
  const trendNote = uptrend ? 'price is in an uptrend' : downtrend ? 'price is in a downtrend' : 'trend is mixed/sideways'
  if (side === 'buy' && downtrend) warnings.push('Buying against a downtrend — the setup is fighting the trend.')
  if (side === 'sell' && uptrend) warnings.push('Selling/shorting against an uptrend — the setup is fighting the trend.')

  const readable = [
    `Trade plan — ${side.toUpperCase()} ${symbol}`,
    `Entry (now):   ${round(entry, 6)}`,
    `Stop (${atrMult}×ATR): ${round(stop, 6)}   (risk ${round(riskPerUnit, 6)} per unit)`,
    `Targets:       1R ${targets[0].price}, 2R ${targets[1].price}, 3R ${targets[2].price}`,
    `Size:          ${round(suggestedQty, 4)} units  ≈ $${orderValue.toFixed(0)}`,
    `Risk:          $${riskAmount.toFixed(0)} (${riskPct}% of $${opts.equity.toFixed(0)}) if the stop is hit`,
    `Reward:risk:   ${round((targets[1].price - entry) * dir / riskPerUnit, 2)} : 1 at the 2R target`,
    `Context:       ${trendNote}`,
    ...(warnings.length ? [`Warnings:      ${warnings.join(' ')}`] : []),
    `This is a PLAN only — no order placed. Approve it to place a practice trade with a stop at ${round(stop, 6)} and target ${targets[1].price}.`,
  ].join('\n')

  return {
    symbol, side, entry: round(entry, 6), stop: round(stop, 6), riskPerUnit: round(riskPerUnit, 6), atr: round(a, 6),
    targets, suggestedQty, orderValue: round(orderValue, 2), riskAmount: round(riskAmount, 2),
    riskPct, rewardToRisk: round((targets[1].price - entry) * dir / riskPerUnit, 2), trendNote, warnings, readable,
  }
}
