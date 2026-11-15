import { ToolRegistry } from './registry'
import { broker } from '../services/broker/service'
import { AlpacaClient } from '../services/broker/client'
import { keysFor } from '../services/broker/credentials'

/**
 * Alpaca broker tools.
 *
 * Read-only tools are safe for the model to call at will. Anything that could place an
 * order is `critical`, so the approval gate always stops it, and on top of that the order
 * path itself requires a per-order confirmation in the Trading page: a prepared intent
 * expires in two minutes and cannot be sent without the user approving THAT intent.
 */

const reg = ToolRegistry.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })
const modeParam = { type: 'string' as const, enum: ['paper', 'live'], description: 'paper (fake money, default) or live (real money, needs live trading switched on).' }

reg.register({
  name: 'broker.account',
  description: 'The Alpaca account Goga trades through: equity, cash, buying power, today\'s profit or loss, every open position with its share of the account, open orders, and whether trading is currently blocked. Paper by default. Read-only.',
  parameters: { type: 'object', properties: { mode: modeParam } },
  riskLevel: 'low', reversible: true, category: 'web',
}, async p => {
  try {
    const snap = await broker().snapshot(p.mode === 'live' ? 'live' : 'paper')
    if (!snap.account) return { success: false, error: snap.error ?? 'the account could not be read' }
    const a = snap.account
    return { success: true, data: [
      `${a.mode === 'live' ? 'LIVE (real money)' : 'Paper'} Alpaca account, status ${a.status}: equity $${a.equity.toFixed(2)}, cash $${a.cash.toFixed(2)}, buying power $${a.buyingPower.toFixed(2)}`,
      `Today: ${a.dayPnl >= 0 ? '+' : ''}$${a.dayPnl.toFixed(2)} (${a.dayPnlPct >= 0 ? '+' : ''}${a.dayPnlPct.toFixed(2)}%)${a.dailyLossBreached ? ' — DAILY LOSS LIMIT REACHED, new positions are blocked' : ''}`,
      a.tradingBlocked ? `Trading is blocked: ${a.blockedReason}` : 'Trading is not blocked.',
      ...(snap.positions.length ? snap.positions.map(p2 => `  ${p2.symbol}: ${p2.qty} @ ${p2.avgEntryPrice.toFixed(2)} → ${p2.currentPrice.toFixed(2)}, ${p2.unrealizedPl >= 0 ? '+' : ''}$${p2.unrealizedPl.toFixed(2)} (${p2.unrealizedPlPct.toFixed(1)}%), ${p2.exposurePct.toFixed(1)}% of the account`) : ['  no open positions']),
      ...(snap.openOrders.length ? snap.openOrders.map(o => `  open order ${o.id}: ${o.side} ${o.qty ?? `$${o.notional}`} ${o.symbol} ${o.type} (${o.status})`) : ['  no open orders']),
      `Limits: ${snap.limits.maxPositionPct}% per position, ${snap.limits.maxOpenPositions} positions, $${snap.limits.maxOrderNotional} per order, halt at ${snap.limits.dailyLossPct}% daily loss.`,
      `Keys: paper ${snap.credentials.paper ? 'stored' : 'MISSING'}, live ${snap.credentials.live ? 'stored' : 'not stored'}, live trading ${snap.credentials.liveEnabled ? 'ON' : 'off'}, kill switch ${snap.credentials.halted ? `ON (${snap.credentials.haltReason})` : 'off'}.`,
    ].join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'broker.bars',
  description: 'Historical daily price bars from Alpaca for one stock symbol (date, open, high, low, close, volume). Read-only market data; use it for any analysis, never invent prices.',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Stock symbol, e.g. AAPL.' },
      days: { type: 'number', description: 'How many calendar days back (default 120, max 1000).' },
    },
    required: ['symbol'],
  },
  riskLevel: 'low', reversible: true, category: 'web',
}, async p => {
  try {
    const bars = await broker().bars(String(p.symbol), 'paper', Number(p.days) || 120)
    if (!bars.length) return { success: true, data: `No bars came back for ${p.symbol}. Check the symbol.` }
    const rows = bars.slice(-60).map(b => `${b.t.slice(0, 10)} O ${b.o} H ${b.h} L ${b.l} C ${b.c} V ${b.v}`)
    return { success: true, data: `${p.symbol}: ${bars.length} daily bars (showing the last ${rows.length}).\n${rows.join('\n')}` }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'broker.prepareOrder',
  description: 'Work out a specific Alpaca order and check it against the limits WITHOUT sending anything. Returns a confirmation line with symbol, side, quantity, order type, estimated price and notional. Show it to the user and ask whether to place it — a separate step then sends it, and only with the user\'s approval of that exact order.',
  parameters: {
    type: 'object',
    properties: {
      mode: modeParam,
      symbol: { type: 'string', description: 'Stock symbol, e.g. AAPL.' },
      side: { type: 'string', enum: ['buy', 'sell'], description: 'buy or sell.' },
      qty: { type: 'number', description: 'Share quantity. Give qty or notional.' },
      notional: { type: 'number', description: 'Dollar amount instead of a share quantity.' },
      orderType: { type: 'string', enum: ['market', 'limit'], description: 'market (default) or limit.' },
      limitPrice: { type: 'number', description: 'Required for a limit order.' },
      reason: { type: 'string', description: 'Why this trade — kept in the audit log (at least 10 characters).' },
    },
    required: ['symbol', 'side', 'reason'],
  },
  riskLevel: 'medium', reversible: true, category: 'web',
}, async p => {
  try {
    const intent = await broker().prepareOrder({
      mode: p.mode === 'live' ? 'live' : 'paper',
      symbol: String(p.symbol),
      side: p.side === 'sell' ? 'sell' : 'buy',
      qty: p.qty === undefined || p.qty === null ? null : Number(p.qty),
      notional: p.notional === undefined || p.notional === null ? null : Number(p.notional),
      orderType: p.orderType === 'limit' ? 'limit' : 'market',
      limitPrice: p.limitPrice === undefined || p.limitPrice === null ? null : Number(p.limitPrice),
      reason: String(p.reason ?? ''),
    })
    return { success: true, data: `Order prepared but NOT sent (id ${intent.id}, expires ${intent.expiresAt}):\n${intent.confirmation}\nChecks passed:\n${intent.checks.map(c => `  • ${c}`).join('\n')}\n\nIf the user approves this exact order, call broker.sendOrder with intentId "${intent.id}". If they do not, nothing happens and the intent expires.` }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'broker.sendOrder',
  description: 'Send ONE previously prepared and user-approved order to Alpaca. Needs the intentId from broker.prepareOrder. Gated on the approval prompt, and the broker itself refuses unless the user approved that exact intent.',
  parameters: { type: 'object', properties: { intentId: { type: 'string', description: 'The intentId returned by broker.prepareOrder.' } }, required: ['intentId'] },
  riskLevel: 'critical', reversible: false, category: 'web',
}, async p => {
  try {
    const r = await broker().sendOrder(String(p.intentId))
    return { success: r.ok, data: r.message, error: r.ok ? undefined : r.message }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'broker.cancelOrder',
  description: 'Cancel one open Alpaca order by id (from broker.account).',
  parameters: { type: 'object', properties: { orderId: { type: 'string', description: 'The order id.' }, mode: modeParam }, required: ['orderId'] },
  riskLevel: 'medium', reversible: false, category: 'web',
}, async p => {
  try {
    const mode = p.mode === 'live' ? 'live' : 'paper'
    if (!keysFor(mode)) return { success: false, error: `no Alpaca ${mode} key is stored, so there is nothing to cancel there` }
    const client = new AlpacaClient(() => keysFor(mode))
    await client.cancelOrder(mode, String(p.orderId))
    return { success: true, data: `Cancelled ${p.orderId} in the ${mode} account.` }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'broker.killSwitch',
  description: 'THE KILL SWITCH: cancel every open order and stop Goga from preparing or sending any new order until the user clears it. Use immediately when the user says stop trading, something is going wrong, or losses are running.',
  parameters: { type: 'object', properties: { mode: modeParam, reason: { type: 'string', description: 'Why — recorded in the audit log.' } } },
  riskLevel: 'high', reversible: true, category: 'web',
}, async p => {
  try {
    const r = await broker().killSwitch(p.mode === 'live' ? 'live' : 'paper', String(p.reason ?? ''))
    return { success: true, data: r.message }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'broker.audit',
  description: 'The broker audit log: every order intent, refusal, approval, denial and send result, newest last. Use it to answer "what did you do and why".',
  parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many recent entries (default 40).' } } },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const entries = broker().audit(Number(p.limit) || 40)
  if (!entries.length) return { success: true, data: 'The broker audit log is empty — no order has been prepared yet.' }
  return { success: true, data: entries.map(e => `${e.time.slice(0, 19).replace('T', ' ')} [${e.stage}] ${e.mode} ${e.symbol ?? ''} ${e.side ?? ''} ${e.qty ?? (e.notional ? `$${e.notional}` : '')} — ${e.detail}`).join('\n') }
})
