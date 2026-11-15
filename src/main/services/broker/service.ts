import crypto from 'crypto'
import type {
  BrokerAccount, BrokerMode, BrokerOrderResult, BrokerSnapshot, KillSwitchResult,
  OrderAuditEntry, OrderIntent,
} from '../../../shared/broker'
import { AlpacaClient, AlpacaError, toOrder, toPosition } from './client'
import { keysFor, credentialStatus } from './credentials'
import { readAudit, recordAudit } from './audit'
import { limits, lossLimitReached, readState, riskPasses, riskRefusals, tradingDay, writeState, type RiskState } from './risk'
import { LogService } from '../logs'

/**
 * The broker: read-only account data, order INTENTS, and the single place an order is
 * actually sent.
 *
 * The shape is deliberate. `prepareOrder` never sends anything — it prices the order,
 * runs every risk rule, writes an audit entry, and returns an intent that expires. Only
 * `sendOrder` sends, and it refuses unless the intent id it is given is one it issued,
 * has not expired, and the user's approval for that exact intent has been recorded.
 */

const INTENT_TTL_MS = 120_000
const MIN_REASON_CHARS = 10

interface LiveIntent {
  intent: OrderIntent
  approvedAt: string | null
}

const pending = new Map<string, LiveIntent>()

const log = () => LogService.getInstance()

function modeKeys(mode: BrokerMode) {
  return keysFor(mode)
}

export class BrokerService {
  constructor(private http: typeof fetch = fetch) {}

  private client(mode: BrokerMode): AlpacaClient {
    return new AlpacaClient(() => modeKeys(mode), this.http)
  }

  state(): RiskState { return readState() }

  /** Read-only: keys status, account, positions, open orders. Never sends an order. */
  async snapshot(mode: BrokerMode): Promise<BrokerSnapshot> {
    const state = readState()
    const l = limits()
    const credentials = credentialStatus(state.liveEnabled, state.halted, state.haltReason)
    const keys = modeKeys(mode)
    if (!keys) {
      return {
        credentials, account: null, positions: [], openOrders: [],
        error: mode === 'live'
          ? 'No live Alpaca key is stored. Add one in Goga → Trading if you want real-money trading (off by default).'
          : 'No Alpaca paper key is stored. Add the free paper keys in Goga → Settings → Trading, or below.',
        limits: l,
      }
    }
    try {
      const [account, positions, orders] = await Promise.all([
        this.client(mode).account(mode), this.client(mode).positions(mode), this.client(mode).orders(mode, 'open', 50),
      ])
      const equity = Number(account.equity ?? 0)
      const lastEquity = Number(account.last_equity ?? 0)
      const dayPnl = lastEquity > 0 ? equity - lastEquity : 0
      const dayPnlPct = lastEquity > 0 ? (equity / lastEquity - 1) * 100 : 0
      const breached = lossLimitReached(dayPnlPct, l, state)
      const view: BrokerAccount = {
        mode,
        status: account.status ?? 'unknown',
        currency: account.currency ?? 'USD',
        equity,
        cash: Number(account.cash ?? 0),
        buyingPower: Number(account.buying_power ?? 0),
        dayPnl,
        dayPnlPct,
        dailyLossBreached: breached,
        tradingBlocked: state.halted || (mode === 'live' && !state.liveEnabled) || breached,
        blockedReason: state.halted
          ? `kill switch on${state.haltReason ? `: ${state.haltReason}` : ''}`
          : mode === 'live' && !state.liveEnabled
            ? 'live trading is switched off'
            : breached ? `daily loss limit reached (${dayPnlPct.toFixed(2)}%)` : null,
        asOf: new Date().toISOString(),
      }
      return {
        credentials,
        account: view,
        positions: positions.map(p => toPosition(p, equity)),
        openOrders: orders.map(toOrder),
        error: null,
        limits: l,
      }
    } catch (err) {
      return { credentials, account: null, positions: [], openOrders: [], error: err instanceof Error ? err.message : String(err), limits: l }
    }
  }

  /** Historical daily bars for a symbol. Read-only market data. */
  async bars(symbol: string, mode: BrokerMode = 'paper', days = 120) {
    const sym = String(symbol ?? '').trim().toUpperCase()
    if (!/^[A-Z][A-Z.]{0,9}$/.test(sym)) throw new Error(`"${symbol}" does not look like a stock symbol`)
    return this.client(mode).dailyBars(sym, Math.min(Math.max(days, 5), 1000))
  }

  /**
   * Price an order and check it. Sends nothing. Returns a confirmation the user must
   * approve before `sendOrder` will accept the intent.
   */
  async prepareOrder(input: {
    mode: BrokerMode
    symbol: string
    side: 'buy' | 'sell'
    qty?: number | null
    notional?: number | null
    orderType?: 'market' | 'limit'
    limitPrice?: number | null
    reason: string
  }): Promise<OrderIntent> {
    const state = readState()
    const l = limits()
    const mode: BrokerMode = input.mode === 'live' ? 'live' : 'paper'
    const symbol = String(input.symbol ?? '').trim().toUpperCase()
    const side: 'buy' | 'sell' = input.side === 'sell' ? 'sell' : 'buy'
    const reason = String(input.reason ?? '').trim()

    if (!/^[A-Z][A-Z.]{0,9}$/.test(symbol)) throw new Error(`"${input.symbol}" does not look like a stock symbol (e.g. AAPL)`)
    if (reason.length < MIN_REASON_CHARS) throw new Error(`say why in at least ${MIN_REASON_CHARS} characters — the audit log keeps it`)
    if (mode === 'live' && !state.liveEnabled) throw new Error('live trading is switched off in Goga → Trading. Switch it on there first; paper orders work now.')
    const keys = modeKeys(mode)
    if (!keys) {
      throw new Error(mode === 'live'
        ? 'no live Alpaca key is stored — Goga will not guess one. Add your own live key in Goga → Trading.'
        : 'no Alpaca paper key is stored — add your own free paper key in Goga → Settings → Trading.')
    }

    const orderType: 'market' | 'limit' = input.orderType === 'limit' ? 'limit' : 'market'
    if (orderType === 'limit' && !(Number(input.limitPrice) > 0)) throw new Error('a limit order needs a limit price above zero')

    const [account, positions, openOrders] = await Promise.all([
      this.client(mode).account(mode), this.client(mode).positions(mode), this.client(mode).orders(mode, 'open', 50),
    ])
    const equity = Number(account.equity ?? 0)
    const lastEquity = Number(account.last_equity ?? 0)
    const dayPnlPct = lastEquity > 0 ? (equity / lastEquity - 1) * 100 : 0

    // Price: the limit price when given, otherwise the position's mark or the last daily close.
    let estimatedPrice = Number(input.limitPrice ?? 0)
    if (!(estimatedPrice > 0)) {
      const held = positions.find(p => p.symbol === symbol)
      if (held && Number(held.current_price) > 0) estimatedPrice = Number(held.current_price)
      else {
        const bars = await this.client(mode).dailyBars(symbol, 10)
        const last = bars[bars.length - 1]
        if (!last) throw new Error(`no price available for ${symbol} — check the symbol`)
        estimatedPrice = last.c
      }
    }

    const qty = input.qty === undefined || input.qty === null ? null : Number(input.qty)
    if (qty !== null && !(qty > 0)) throw new Error('the quantity must be above zero, or leave it empty and give a dollar amount')
    const requestedNotional = input.notional === undefined || input.notional === null ? null : Number(input.notional)
    if (qty === null && requestedNotional === null) throw new Error('give either a share quantity or a dollar amount')
    const estimatedNotional = qty !== null ? qty * estimatedPrice : Number(requestedNotional)

    const held = positions.find(p => p.symbol === symbol)
    const existingPositionValue = held ? Math.abs(Number(held.market_value) || 0) : 0
    if (side === 'sell' && !held) throw new Error(`there is no ${symbol} position to sell in the ${mode} account`)
    if (side === 'sell' && qty !== null && held && qty > Math.abs(Number(held.qty))) throw new Error(`only ${held.qty} ${symbol} are held`)

    const underReview = { mode, symbol, side, estimatedNotional, equity, dayPnlPct, existingPositionValue, openPositionCount: positions.length }
    const refusals = riskRefusals(underReview, l, state)
    if (refusals.length) {
      recordAudit({ stage: 'refused', mode, symbol, side, qty, notional: estimatedNotional, orderType, price: estimatedPrice, detail: refusals.join('; ') })
      throw new Error(`Order not prepared — ${refusals.join('; ')}`)
    }

    const expiresAt = new Date(Date.now() + INTENT_TTL_MS).toISOString()
    const id = crypto.randomUUID()
    const intent: OrderIntent = {
      id,
      createdAt: new Date().toISOString(),
      expiresAt,
      mode,
      symbol,
      side,
      qty,
      notional: requestedNotional ?? estimatedNotional,
      orderType,
      limitPrice: orderType === 'limit' ? Number(input.limitPrice) : null,
      estimatedPrice,
      estimatedNotional,
      confirmation: `${side.toUpperCase()} ${qty !== null ? `${qty} ${symbol}` : `$${requestedNotional?.toFixed(2)} of ${symbol}`}`
        + ` — ${orderType.toUpperCase()}${orderType === 'limit' ? ` at ${input.limitPrice}` : ` (about $${estimatedPrice.toFixed(2)} now)`}`
        + ` ≈ $${estimatedNotional.toFixed(2)} in your ${mode === 'live' ? 'REAL-MONEY' : 'paper'} Alpaca account`,
      checks: riskPasses(underReview, l, state),
      reason,
    }
    pending.set(id, { intent, approvedAt: null })
    // Expire old intents so the map cannot grow without bound.
    for (const [key, value] of pending) if (Date.parse(value.intent.expiresAt) < Date.now()) pending.delete(key)
    recordAudit({ stage: 'intent', mode, symbol, side, qty, notional: estimatedNotional, orderType, price: estimatedPrice, detail: intent.confirmation })
    log().info(`Broker: order intent ${id} prepared (${intent.confirmation}) — NOT sent, waiting for approval`)
    return intent
  }

  /** Record the user's decision about one exact intent. */
  approveIntent(intentId: string, approved: boolean): OrderIntent {
    const entry = pending.get(intentId)
    if (!entry) throw new Error('that order intent is unknown or has expired — prepare it again')
    if (Date.parse(entry.intent.expiresAt) < Date.now()) { pending.delete(intentId); throw new Error('that order intent expired — prepare it again') }
    if (approved) entry.approvedAt = new Date().toISOString()
    else pending.delete(intentId)
    recordAudit({
      stage: approved ? 'approved' : 'denied', mode: entry.intent.mode, symbol: entry.intent.symbol, side: entry.intent.side,
      qty: entry.intent.qty, notional: entry.intent.estimatedNotional, orderType: entry.intent.orderType,
      price: entry.intent.estimatedPrice, detail: approved ? 'user approved this exact order' : 'user denied this order',
    })
    log().info(`Broker: intent ${intentId} ${approved ? 'APPROVED' : 'DENIED'} by the user`)
    return entry.intent
  }

  /**
   * Send an approved intent. This is the only method that reaches the order endpoint.
   * It re-checks everything: the intent must be one Goga issued, unexpired, and approved.
   */
  async sendOrder(intentId: string): Promise<BrokerOrderResult> {
    const entry = pending.get(intentId)
    const refuse = (detail: string): BrokerOrderResult => {
      const audit = recordAudit({ stage: 'error', mode: entry?.intent.mode ?? 'paper', symbol: entry?.intent.symbol, detail })
      log().warn(`Broker: refused to send ${intentId}: ${detail}`)
      return { ok: false, orderId: null, status: null, message: detail, audit }
    }
    if (!entry) return refuse('that order intent is unknown or has expired')
    if (!entry.approvedAt) return refuse('this order has not been approved by the user')
    if (Date.parse(entry.intent.expiresAt) < Date.now()) { pending.delete(intentId); return refuse('this order intent expired before it was sent') }

    const i = entry.intent
    const state = readState()
    if (state.halted) { pending.delete(intentId); return refuse(`the kill switch is on${state.haltReason ? ` (${state.haltReason})` : ''}`) }
    if (i.mode === 'live' && !state.liveEnabled) { pending.delete(intentId); return refuse('live trading was switched off after this intent was prepared') }

    const body = {
      symbol: i.symbol,
      side: i.side,
      type: i.orderType,
      time_in_force: 'day' as const,
      ...(i.qty !== null ? { qty: String(i.qty) } : { notional: String(i.notional) }),
      ...(i.orderType === 'limit' && i.limitPrice !== null ? { limit_price: String(i.limitPrice) } : {}),
    }
    try {
      const placed = await this.client(i.mode).placeOrder(i.mode, body)
      pending.delete(intentId)
      const audit = recordAudit({
        stage: 'sent', mode: i.mode, symbol: i.symbol, side: i.side, qty: i.qty, notional: i.estimatedNotional,
        orderType: i.orderType, price: i.estimatedPrice,
        orderId: placed.id, detail: `${placed.status} ${placed.side} ${placed.qty ?? `$${placed.notional}`} ${placed.symbol}`,
      })
      log().info(`Broker: order SENT ${placed.id} (${i.mode}) ${placed.side} ${placed.qty ?? placed.notional} ${placed.symbol}`)
      return {
        ok: true, orderId: placed.id, status: placed.status ?? null,
        message: `Order ${placed.id} ${placed.status}: ${placed.side} ${placed.qty ?? `$${placed.notional}`} ${placed.symbol} (${i.mode === 'live' ? 'REAL MONEY' : 'paper'}).`,
        audit,
      }
    } catch (err) {
      const detail = err instanceof AlpacaError ? err.message : err instanceof Error ? err.message : String(err)
      const audit = recordAudit({ stage: 'error', mode: i.mode, symbol: i.symbol, side: i.side, qty: i.qty, notional: i.estimatedNotional, orderType: i.orderType, price: i.estimatedPrice, detail })
      log().warn(`Broker: order failed: ${detail}`)
      return { ok: false, orderId: null, status: null, message: detail, audit }
    }
  }

  /** Cancel every open order in the mode, then stop the strategy loop. */
  async killSwitch(mode: BrokerMode, reason: string): Promise<KillSwitchResult> {
    const why = String(reason ?? '').trim() || 'kill switch engaged by the user'
    writeState({ halted: true, haltReason: why, haltedOn: new Date().toISOString() })
    let cancelled = 0
    let message = `Kill switch ON: ${why}. No new order can be prepared or sent until you clear it.`
    if (modeKeys(mode)) {
      try {
        const open = await this.client(mode).orders(mode, 'open', 500)
        for (const o of open) {
          try { await this.client(mode).cancelOrder(mode, o.id); cancelled++ } catch { /* record per-order failure below */ }
        }
        message += ` Cancelled ${cancelled} of ${open.length} open ${mode} order(s).`
      } catch (err) {
        message += ` Could not list open ${mode} orders: ${err instanceof Error ? err.message : String(err)}. Check the account manually.`
      }
    } else {
      message += ` No ${mode} key is stored, so there were no open orders to cancel.`
    }
    recordAudit({ stage: 'refused', mode, detail: `KILL SWITCH: ${why}; cancelled ${cancelled} open order(s)` })
    log().warn(`Broker: KILL SWITCH — ${message}`)
    return { ok: true, cancelled, halted: true, message }
  }

  clearKillSwitch(): KillSwitchResult {
    writeState({ halted: false, haltReason: null, haltedOn: null, lossHaltDay: null })
    log().info('Broker: kill switch cleared by the user')
    return { ok: true, cancelled: 0, halted: false, message: 'Kill switch off and the daily loss halt cleared. New orders may be prepared again.' }
  }

  setLiveEnabled(enabled: boolean, confirmPhrase: string): { liveEnabled: boolean; message: string } {
    if (enabled && String(confirmPhrase ?? '').trim().toUpperCase() !== 'REAL MONEY') {
      throw new Error('to switch on real-money trading, type REAL MONEY in the confirmation box')
    }
    if (enabled && !keysFor('live')) throw new Error('add your live Alpaca key first — live trading cannot be switched on without one')
    writeState({ liveEnabled: !!enabled })
    log().warn(`Broker: live trading ${enabled ? 'ENABLED by the user' : 'disabled'}`)
    return {
      liveEnabled: !!enabled,
      message: enabled
        ? 'Live trading is ON. Every real order still needs your approval of that exact order, and the kill switch and limits still apply.'
        : 'Live trading is OFF. Paper orders keep working.',
    }
  }

  audit(limit = 100): OrderAuditEntry[] { return readAudit(limit) }

  /** Today's realized day P/L check, used by the strategy loop before it proposes anything. */
  today(): string { return tradingDay() }
}

let instance: BrokerService | null = null
export function broker(): BrokerService {
  return instance ??= new BrokerService()
}
