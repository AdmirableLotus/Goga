import { ToolRegistry } from './registry'
import { marketData, paperTrading } from '../services/trading/desk'
import { STRATEGIES, backtest, backtestReport, chartSummary, type Strategy } from '../services/trading/indicators'
import { TIMEFRAMES, timeframe } from '../services/trading/marketData'
import { tradePlan } from '../services/trading/tradePlan'
import { tradingLimits } from '../services/trading/desk'
import type { OrderRequest } from '../services/trading/paperTrading'

const reg = ToolRegistry.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })
const symbolParam = { type: 'string' as const, description: 'Stock/ETF like "AAPL", crypto like "BTC/USD", forex like "EUR/USD".' }
const timeframeParam = { type: 'string' as const, enum: [...TIMEFRAMES], description: 'Bar size (default 1Day). Forex is daily only.' }

reg.register({
  name: 'trading.quote',
  description: 'The current real price of a stock, ETF, crypto or forex pair, with the day\'s change.',
  parameters: { type: 'object', properties: { symbol: symbolParam }, required: ['symbol'] },
  riskLevel: 'low', reversible: true, category: 'web',
}, async p => {
  try {
    const q = await marketData().quote(String(p.symbol))
    return { success: true, data: `${q.symbol}: ${q.price}${q.bid && q.ask ? ` (bid ${q.bid} / ask ${q.ask})` : ''}${q.dayChangePct !== undefined ? `, ${q.dayChangePct >= 0 ? '+' : ''}${q.dayChangePct.toFixed(2)}% today` : ''} — ${q.source}, ${q.time}` }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'trading.analyze',
  description: 'Read a chart from real price history: trend, moving averages, RSI, MACD, Bollinger bands, typical move (ATR) and where a sensible stop would sit. Use this for any question about a symbol\'s chart.',
  parameters: { type: 'object', properties: { symbol: symbolParam, timeframe: timeframeParam }, required: ['symbol'] },
  riskLevel: 'low', reversible: true, category: 'web',
}, async p => {
  try {
    const { inst, tf, bars } = await marketData().bars(String(p.symbol), timeframe(p.timeframe))
    return { success: true, data: chartSummary(inst.symbol, bars, tf) }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'trading.plan',
  description: 'Build a trade PLAN for a practice trade — no order is placed. Returns entry (current price), an ATR-based stop, 1R/2R/3R targets, a position size for the chosen risk, and reward-to-risk. Show it to the user to approve before calling trading.order. Use this whenever considering a buy or sell.',
  parameters: {
    type: 'object',
    properties: {
      symbol: symbolParam,
      side: { type: 'string', enum: ['buy', 'sell'], description: 'buy (long) or sell (short).' },
      riskPct: { type: 'number', description: 'Percent of account to risk if the stop is hit (default 1, max 5).' },
      timeframe: timeframeParam,
    },
    required: ['symbol', 'side'],
  },
  riskLevel: 'low', reversible: true, category: 'web',
}, async p => {
  try {
    const { inst, tf, bars } = await marketData().bars(String(p.symbol), timeframe(p.timeframe))
    let equity = 100000
    try { const accts = await paperTrading().accounts(); if (accts[0]?.equity) equity = accts[0].equity } catch { /* keys may be missing; use the default practice equity */ }
    const limits = tradingLimits()
    const plan = tradePlan(inst.symbol, bars, p.side === 'sell' ? 'sell' : 'buy', { equity, riskPct: Number(p.riskPct) || undefined, maxPositionPct: limits.maxPositionPct })
    return { success: true, data: plan }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'trading.news',
  description: 'Latest market news headlines, for a symbol or the whole market.',
  parameters: { type: 'object', properties: { symbol: { type: 'string', description: 'Optional symbol, e.g. "NVDA" or "BTC/USD".' } } },
  riskLevel: 'low', reversible: true, category: 'web',
}, async p => {
  try {
    const news = await marketData().news(p.symbol ? String(p.symbol) : undefined)
    return { success: true, data: news.length ? news.map(n => `${n.time.slice(0, 16).replace('T', ' ')} ${n.source}: ${n.headline}${n.summary ? ` — ${n.summary}` : ''}`).join('\n') : 'No recent news.' }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'trading.backtest',
  description: `Test how a strategy would have done on real history, fees included, compared with buy-and-hold. Strategies: ${Object.keys(STRATEGIES).join(', ')}.`,
  parameters: {
    type: 'object',
    properties: {
      symbol: symbolParam,
      strategy: { type: 'string', enum: Object.keys(STRATEGIES), description: 'The strategy.' },
      timeframe: timeframeParam,
      fast: { type: 'number', description: 'sma-cross fast average (default 20).' },
      slow: { type: 'number', description: 'sma-cross slow average (default 50).' },
    },
    required: ['symbol', 'strategy'],
  },
  riskLevel: 'low', reversible: true, category: 'web',
}, async p => {
  try {
    const strategy = String(p.strategy) as Strategy
    if (!(strategy in STRATEGIES)) throw new Error(`unknown strategy — use one of ${Object.keys(STRATEGIES).join(', ')}`)
    const { inst, tf, bars } = await marketData().bars(String(p.symbol), timeframe(p.timeframe))
    if (bars.length < 60) throw new Error(`only ${bars.length} bars of history — too few to test`)
    const fee = inst.market === 'crypto' ? 0.25 : inst.market === 'forex' ? 0.02 : 0.05
    const result = backtest(bars, strategy, { fast: Number(p.fast) || undefined, slow: Number(p.slow) || undefined, feePct: fee })
    return { success: true, data: backtestReport(inst.symbol, tf, result) }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'trading.account',
  description: 'The practice accounts (fake money): value, cash, today\'s change, what is held with profit/loss, and open orders.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'web',
}, async () => {
  try {
    const views = await paperTrading().accounts()
    return { success: true, data: views.map(v => [
      `${v.name}: value $${v.equity.toFixed(2)}, cash $${v.cash.toFixed(2)}, today ${v.dayPnlPct >= 0 ? '+' : ''}${v.dayPnlPct.toFixed(2)}%`,
      ...v.positions.map(p => `  ${p.symbol}: ${p.qty} @ ${p.avgPrice.toFixed(4)} → ${p.price.toFixed(4)}, ${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(2)} (${p.pnlPct.toFixed(1)}%)${p.stop ? `, stop ${p.stop}` : ''}`),
      ...v.openOrders.map(o => `  open order ${o}`),
      v.positions.length ? '' : '  nothing held',
    ].filter(Boolean).join('\n')).join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'trading.order',
  description: 'Place a PRACTICE trade (fake money). Buying to open needs a stop price and stays within the user\'s risk limits; sell only what is held. Always give the reason, for the journal.',
  parameters: {
    type: 'object',
    properties: {
      symbol: symbolParam,
      side: { type: 'string', enum: ['buy', 'sell'], description: 'buy or sell.' },
      qty: { type: 'number', description: 'Shares, coins or currency units.' },
      notional: { type: 'number', description: 'Or a dollar amount instead of qty.' },
      type: { type: 'string', enum: ['market', 'limit'], description: 'market (default) or limit.' },
      limitPrice: { type: 'number', description: 'For a limit order.' },
      stopPrice: { type: 'number', description: 'Where to get out if wrong (needed to buy).' },
      takeProfit: { type: 'number', description: 'Optional target to sell at.' },
      reason: { type: 'string', description: 'Why this trade: the setup, and what would prove it wrong.' },
    },
    required: ['symbol', 'side', 'reason'],
  },
  riskLevel: 'medium', reversible: false, category: 'web',
}, async p => {
  try {
    const num = (v: unknown) => v === undefined || v === null || v === '' ? undefined : Number(v)
    const req: OrderRequest = {
      symbol: String(p.symbol), side: p.side === 'sell' ? 'sell' : 'buy', reason: String(p.reason ?? ''),
      qty: num(p.qty), notional: num(p.notional), type: p.type === 'limit' ? 'limit' : 'market',
      limitPrice: num(p.limitPrice), stopPrice: num(p.stopPrice), takeProfit: num(p.takeProfit),
    }
    return { success: true, data: await paperTrading().order(req) }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'trading.cancel',
  description: 'Cancel an open practice order by its id (from trading.account).',
  parameters: { type: 'object', properties: { orderId: { type: 'string', description: 'The order id.' } }, required: ['orderId'] },
  riskLevel: 'medium', reversible: false, category: 'web',
}, async p => {
  try { return { success: true, data: await paperTrading().cancel(String(p.orderId)) } } catch (err) { return failure(err) }
})

reg.register({
  name: 'trading.journal',
  description: 'The trading journal: recent practice trades with their reasons, stops and targets — for reviewing what worked and what to learn.',
  parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many recent trades (default 20).' } } },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const entries = paperTrading().journal(Number(p.limit) || 20)
  return { success: true, data: entries.length ? entries.map(e => `${e.time.slice(0, 16).replace('T', ' ')} ${e.side} ${e.qty} ${e.symbol} @ ${e.price}${e.stop ? ` stop ${e.stop}` : ''}${e.target ? ` target ${e.target}` : ''} (${e.status}) — ${e.reason}`).join('\n') : 'No trades in the journal yet.' }
})
