import fs from 'fs'
import type { AlpacaKeys, MarketData } from './marketData'
import { instrument } from './marketData'

/**
 * Practice trading with fake money. Stocks and crypto go to the user's Alpaca *paper*
 * account (the address is fixed here; Goga has no way to reach a live account). Forex goes
 * to a ledger on this PC, priced with the daily ECB rates. Every order passes the user's
 * risk rules first, and every trade is written to a journal with the reason for it.
 */

// Paper only, on purpose: there is no setting that points this at real money.
export const ALPACA_PAPER = 'https://paper-api.alpaca.markets/v2'
const FX_START_CASH = 100_000

export interface RiskLimits {
  /** Largest new position, as a percent of account value. */
  maxPositionPct: number
  /** Opening trades must say where the stop is. */
  requireStop: boolean
  /** No new positions after the account is down this percent today. */
  dailyLossPct: number
}

export interface OrderRequest {
  symbol: string
  side: 'buy' | 'sell'
  qty?: number
  notional?: number
  type?: 'market' | 'limit'
  limitPrice?: number
  stopPrice?: number
  takeProfit?: number
  reason: string
}

export interface RiskInput { equity: number; dayPnlPct: number; orderValue: number; opening: boolean; price: number; side: 'buy' | 'sell'; stopPrice?: number; takeProfit?: number; reason: string }

/** Every rule an order breaks, in plain words. Empty means it may go ahead. */
export function riskProblems(o: RiskInput, limits: RiskLimits): string[] {
  const problems: string[] = []
  if (!o.reason || o.reason.trim().length < 10) problems.push('say why you are taking this trade (the journal keeps it)')
  if (!o.opening) return problems
  if (o.side === 'sell') problems.push('only buying to open is allowed in practice; sell only what is held')
  if (!(o.orderValue > 0)) problems.push('give a quantity or a dollar amount')
  const maxValue = o.equity * limits.maxPositionPct / 100
  if (o.orderValue > maxValue) problems.push(`this is $${o.orderValue.toFixed(0)}, over the ${limits.maxPositionPct}% limit per position ($${maxValue.toFixed(0)})`)
  if (o.dayPnlPct <= -limits.dailyLossPct) problems.push(`the account is down ${Math.abs(o.dayPnlPct).toFixed(1)}% today, past the ${limits.dailyLossPct}% daily loss limit: no new positions until tomorrow`)
  if (limits.requireStop && !o.stopPrice) problems.push('set a stop price (where you are proven wrong) — a stop 2×ATR below entry is a common start')
  if (o.stopPrice && o.stopPrice >= o.price) problems.push(`the stop (${o.stopPrice}) must be below the price (${o.price}) for a buy`)
  if (o.takeProfit && o.takeProfit <= o.price) problems.push(`the target (${o.takeProfit}) must be above the price (${o.price})`)
  return problems
}

/** Reward to risk, when both a stop and a target are set. */
export function rewardToRisk(price: number, stop?: number, target?: number): number | undefined {
  if (!stop || !target || stop >= price) return undefined
  return (target - price) / (price - stop)
}

export interface JournalEntry { time: string; symbol: string; side: string; qty: number; price: number; stop?: number; target?: number; reason: string; orderId?: string; status: string }
export interface Position { symbol: string; qty: number; avgPrice: number; price: number; pnl: number; pnlPct: number; stop?: number }
export interface AccountView { name: string; equity: number; cash: number; dayPnlPct: number; positions: Position[]; openOrders: string[] }

interface FxLedger { cash: number; startOfDay: { date: string; equity: number }; positions: Record<string, { units: number; avgPrice: number; stop?: number; target?: number }> }

const today = () => new Date().toISOString().slice(0, 10)

export class PaperTrading {
  constructor(
    private deps: {
      keys: () => AlpacaKeys | null
      data: MarketData
      limits: () => RiskLimits
      journalFile: string
      fxFile: string
      http?: typeof fetch
    },
  ) {}

  /** The stock/crypto paper account and the forex ledger, with what is held. */
  async accounts(): Promise<AccountView[]> {
    const views: AccountView[] = []
    if (this.deps.keys()) views.push(await this.alpacaAccount())
    views.push(await this.fxAccount())
    return views
  }

  async order(req: OrderRequest): Promise<string> {
    const inst = instrument(req.symbol)
    return inst.market === 'forex' ? this.fxOrder(inst.symbol, req) : this.alpacaOrder(inst.symbol, inst.market === 'crypto', req)
  }

  async cancel(orderId: string): Promise<string> {
    if (!/^[\w-]{8,64}$/.test(orderId)) throw new Error('not an order id')
    await this.alpaca(`/orders/${orderId}`, 'DELETE')
    return `Cancelled order ${orderId}`
  }

  journal(limit = 20): JournalEntry[] {
    return this.readJournal().slice(-limit)
  }

  // ── Alpaca paper (stocks, ETFs, crypto) ──────────────────────────────────────

  private async alpacaAccount(): Promise<AccountView> {
    const [account, positions, orders] = await Promise.all([this.alpaca('/account'), this.alpaca('/positions'), this.alpaca('/orders?status=open&limit=20')])
    const equity = Number(account.equity)
    return {
      name: 'Alpaca paper account (stocks, ETFs, crypto — fake money)',
      equity,
      cash: Number(account.cash),
      dayPnlPct: Number(account.last_equity) ? (equity / Number(account.last_equity) - 1) * 100 : 0,
      positions: (positions as Record<string, string>[]).map(p => ({
        symbol: p.symbol, qty: Number(p.qty), avgPrice: Number(p.avg_entry_price), price: Number(p.current_price),
        pnl: Number(p.unrealized_pl), pnlPct: Number(p.unrealized_plpc) * 100,
      })),
      openOrders: (orders as Record<string, string>[]).map(o => `${o.id}: ${o.side} ${o.qty ?? `$${o.notional}`} ${o.symbol} ${o.type}${o.limit_price ? ` @ ${o.limit_price}` : ''}${o.stop_price ? ` stop ${o.stop_price}` : ''} (${o.status})`),
    }
  }

  private async alpacaOrder(symbol: string, crypto: boolean, req: OrderRequest): Promise<string> {
    const account = await this.alpaca('/account')
    const equity = Number(account.equity)
    const dayPnlPct = Number(account.last_equity) ? (equity / Number(account.last_equity) - 1) * 100 : 0
    const held = (await this.alpaca('/positions') as { symbol: string; qty: string }[])
      .find(p => p.symbol.replace('/', '') === symbol.replace('/', ''))
    const price = req.limitPrice ?? (await this.deps.data.quote(symbol)).price
    const opening = req.side === 'buy' || !held
    const orderValue = req.notional ?? (req.qty ?? 0) * price
    const problems = riskProblems({ equity, dayPnlPct, orderValue, opening, price, side: req.side, stopPrice: req.stopPrice, takeProfit: req.takeProfit, reason: req.reason }, this.deps.limits())
    if (req.side === 'sell' && held && (req.qty ?? 0) > Number(held.qty)) problems.push(`only ${held.qty} ${symbol} are held`)
    if (problems.length) throw new Error(`Order not placed — ${problems.join('; ')}`)

    const type = req.type === 'limit' ? 'limit' : 'market'
    const body: Record<string, unknown> = {
      symbol, side: req.side, type,
      time_in_force: crypto ? 'gtc' : (req.stopPrice || req.takeProfit) && req.side === 'buy' ? 'gtc' : 'day',
      ...(req.qty ? { qty: String(req.qty) } : { notional: String(req.notional) }),
      ...(type === 'limit' ? { limit_price: String(req.limitPrice) } : {}),
    }
    // Stocks carry the stop and target with the order; crypto gets a separate stop order.
    if (!crypto && req.side === 'buy' && req.stopPrice) {
      if (!req.qty) throw new Error('Order not placed — for a stock with a stop, give a whole-share quantity (qty), not a dollar amount')
      body.order_class = req.takeProfit ? 'bracket' : 'oto'
      body.stop_loss = { stop_price: String(req.stopPrice) }
      if (req.takeProfit) body.take_profit = { limit_price: String(req.takeProfit) }
    }
    const placed = await this.alpaca('/orders', 'POST', body)
    let note = ''
    if (crypto && req.side === 'buy' && req.stopPrice) {
      try {
        const qty = req.qty ?? await this.filledQty(placed.id)
        await this.alpaca('/orders', 'POST', { symbol, side: 'sell', type: 'stop_limit', time_in_force: 'gtc', qty: String(qty), stop_price: String(req.stopPrice), limit_price: String((req.stopPrice * 0.995).toFixed(2)) })
        note = ` A stop order at ${req.stopPrice} protects it.`
      } catch (err) { note = ` The stop order could not be placed (${(err as Error).message}) — watch it by hand.` }
    }
    const qty = Number(placed.qty ?? 0) || req.qty || 0
    this.writeJournal({ time: new Date().toISOString(), symbol, side: req.side, qty, price, stop: req.stopPrice, target: req.takeProfit, reason: req.reason, orderId: placed.id, status: placed.status })
    const rr = rewardToRisk(price, req.stopPrice, req.takeProfit)
    return `Paper order placed: ${req.side} ${req.qty ?? `$${req.notional} of`} ${symbol} (${type}, about ${price}), status ${placed.status}, id ${placed.id}.${note}${rr ? ` Reward to risk ${rr.toFixed(1)} : 1.` : ''}`
  }

  private async filledQty(orderId: string): Promise<number> {
    for (let i = 0; i < 6; i++) {
      const o = await this.alpaca(`/orders/${orderId}`)
      if (Number(o.filled_qty) > 0) return Number(o.filled_qty)
      await new Promise(r => setTimeout(r, 1000))
    }
    throw new Error('the buy has not filled yet')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async alpaca(pathAndQuery: string, method = 'GET', body?: unknown): Promise<any> {
    const keys = this.deps.keys()
    if (!keys) throw new Error('the paper account needs Alpaca keys — add them in Settings → Trading (free at alpaca.markets)')
    const res = await (this.deps.http ?? fetch)(`${ALPACA_PAPER}${pathAndQuery}`, {
      method,
      headers: { 'APCA-API-KEY-ID': keys.keyId, 'APCA-API-SECRET-KEY': keys.secret, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    if (res.status === 401 || res.status === 403) throw new Error('Alpaca refused the keys — check they are the PAPER keys in Settings → Trading')
    const text = await res.text()
    if (!res.ok) throw new Error(`Alpaca: ${(() => { try { return JSON.parse(text).message } catch { return text.slice(0, 200) } })()}`)
    return text ? JSON.parse(text) : {}
  }

  // ── Forex ledger on this PC ──────────────────────────────────────────────────

  private async fxAccount(): Promise<AccountView> {
    const ledger = this.readFx()
    const positions: Position[] = []
    let value = ledger.cash
    for (const [symbol, p] of Object.entries(ledger.positions)) {
      const price = (await this.deps.data.quote(symbol)).price
      // A stop or target the daily rate has crossed closes the position at that level.
      const exit = p.stop && price <= p.stop ? p.stop : p.target && price >= p.target ? p.target : undefined
      if (exit) {
        ledger.cash += this.value(symbol, p.units, p.avgPrice, exit)
        this.writeJournal({ time: new Date().toISOString(), symbol, side: 'sell', qty: p.units, price: exit, reason: exit === p.stop ? 'stop reached' : 'target reached', status: 'filled' })
        delete ledger.positions[symbol]
        value += this.value(symbol, p.units, p.avgPrice, exit)
        continue
      }
      const pnl = this.value(symbol, p.units, p.avgPrice, price) - this.value(symbol, p.units, p.avgPrice, p.avgPrice)
      positions.push({ symbol, qty: p.units, avgPrice: p.avgPrice, price, pnl, pnlPct: (price / p.avgPrice - 1) * 100, stop: p.stop })
      value += this.value(symbol, p.units, p.avgPrice, price)
    }
    if (ledger.startOfDay.date !== today()) ledger.startOfDay = { date: today(), equity: value }
    this.saveFx(ledger)
    return { name: 'Forex practice ledger on this PC (fake money, daily ECB rates)', equity: value, cash: ledger.cash, dayPnlPct: (value / ledger.startOfDay.equity - 1) * 100, positions, openOrders: [] }
  }

  private async fxOrder(symbol: string, req: OrderRequest): Promise<string> {
    if (!/\/USD$|^USD\//.test(symbol)) throw new Error('practice forex is for pairs with USD in them, like EUR/USD or USD/JPY')
    if (req.type === 'limit') throw new Error('practice forex fills at the daily rate; use a market order')
    const view = await this.fxAccount()
    const ledger = this.readFx()
    const price = (await this.deps.data.quote(symbol)).price
    const units = req.qty ?? (req.notional ? this.unitsFor(symbol, req.notional, price) : 0)
    const held = ledger.positions[symbol]
    const opening = req.side === 'buy' || !held
    const problems = riskProblems({ equity: view.equity, dayPnlPct: view.dayPnlPct, orderValue: this.value(symbol, units, price, price), opening, price, side: req.side, stopPrice: req.stopPrice, takeProfit: req.takeProfit, reason: req.reason }, this.deps.limits())
    if (req.side === 'sell' && held && units > held.units) problems.push(`only ${held.units} units of ${symbol} are held`)
    if (problems.length) throw new Error(`Order not placed — ${problems.join('; ')}`)
    const cost = req.side === 'buy' ? this.value(symbol, units, price, price) : this.value(symbol, units, held!.avgPrice, price)
    if (req.side === 'buy') {
      if (cost > ledger.cash) throw new Error(`Order not placed — it costs $${cost.toFixed(0)} and the ledger has $${ledger.cash.toFixed(0)}`)
      const prev = held ?? { units: 0, avgPrice: price }
      ledger.positions[symbol] = { units: prev.units + units, avgPrice: (prev.units * prev.avgPrice + units * price) / (prev.units + units), stop: req.stopPrice ?? held?.stop, target: req.takeProfit ?? held?.target }
      ledger.cash -= cost
    } else {
      ledger.cash += cost
      held!.units -= units
      if (held!.units <= 1e-9) delete ledger.positions[symbol]
    }
    this.saveFx(ledger)
    this.writeJournal({ time: new Date().toISOString(), symbol, side: req.side, qty: units, price, stop: req.stopPrice, target: req.takeProfit, reason: req.reason, status: 'filled' })
    return `Practice forex ${req.side} of ${units.toFixed(0)} ${symbol.split('/')[0]} at ${price} filled ($${cost.toFixed(0)}). The ledger checks stops and targets against each day's rate.`
  }

  /**
   * Dollar value of a position of `units` of the pair's first currency bought at `avg`, now at
   * `price`. For USD/XXX the units are dollars and the gain is earned in XXX, so it is converted back.
   */
  private value(symbol: string, units: number, avg: number, price: number): number {
    return symbol.endsWith('/USD') ? units * price : units * (2 - avg / price)
  }

  private unitsFor(symbol: string, usd: number, price: number): number {
    return symbol.endsWith('/USD') ? usd / price : usd
  }

  private readFx(): FxLedger {
    try { return JSON.parse(fs.readFileSync(this.deps.fxFile, 'utf8')) } catch { return { cash: FX_START_CASH, startOfDay: { date: today(), equity: FX_START_CASH }, positions: {} } }
  }

  private saveFx(ledger: FxLedger): void {
    fs.writeFileSync(this.deps.fxFile, JSON.stringify(ledger, null, 2), { mode: 0o600 })
  }

  private readJournal(): JournalEntry[] {
    try { return JSON.parse(fs.readFileSync(this.deps.journalFile, 'utf8')) } catch { return [] }
  }

  private writeJournal(entry: JournalEntry): void {
    const all = [...this.readJournal(), entry].slice(-1000)
    fs.writeFileSync(this.deps.journalFile, JSON.stringify(all, null, 2), { mode: 0o600 })
  }
}
