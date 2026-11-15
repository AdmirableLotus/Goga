import type { BrokerBar, BrokerMode, BrokerOrder, BrokerPosition } from '../../../shared/broker'
import type { BrokerKeys } from './credentials'

/**
 * A small Alpaca client. Two fixed hosts and nothing else, so there is exactly one place
 * that could reach real money and it is the one `placeOrder` uses.
 *
 * Reads (account, positions, orders, bars, clock) are plain GETs. `placeOrder` is the only
 * method that sends an order and is called from one place: BrokerService, after the
 * risk checks, the user's approval and the audit entry.
 */

export const ALPACA_PAPER_HOST = 'https://paper-api.alpaca.markets/v2'
export const ALPACA_LIVE_HOST = 'https://api.alpaca.markets/v2'
export const ALPACA_DATA_HOST = 'https://data.alpaca.markets'

export function hostFor(mode: BrokerMode): string {
  return mode === 'live' ? ALPACA_LIVE_HOST : ALPACA_PAPER_HOST
}

export interface RawAccount {
  status?: string
  currency?: string
  equity?: string
  cash?: string
  buying_power?: string
  last_equity?: string
  portfolio_value?: string
}

export interface RawPosition {
  symbol: string
  qty: string
  side: string
  avg_entry_price: string
  current_price: string
  market_value: string
  unrealized_pl: string
  unrealized_plpc: string
}

export interface RawOrder {
  id: string
  symbol: string
  side: string
  qty: string | null
  notional: string | null
  type: string
  limit_price: string | null
  stop_price: string | null
  status: string
  submitted_at: string
  filled_qty: string
  filled_avg_price: string | null
}

export interface OrderBody {
  symbol: string
  side: 'buy' | 'sell'
  qty?: string
  notional?: string
  type: 'market' | 'limit'
  time_in_force: 'day' | 'gtc'
  limit_price?: string
}

export class AlpacaError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export class AlpacaClient {
  constructor(private keys: () => BrokerKeys | null, private http: typeof fetch = fetch) {}

  private headers(): Record<string, string> {
    const k = this.keys()
    if (!k) throw new AlpacaError('no Alpaca key is stored for this account — add one in Goga → Trading', 0)
    return {
      'APCA-API-KEY-ID': k.keyId,
      'APCA-API-SECRET-KEY': k.secret,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }
  }

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.http(url, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) })
    const text = await res.text()
    if (res.status === 401 || res.status === 403) throw new AlpacaError('Alpaca refused the key (401/403) — check it, and that it is the right mode (paper vs live)', res.status)
    if (!res.ok) {
      let detail = text.slice(0, 240)
      try { detail = (JSON.parse(text) as { message?: string }).message ?? detail } catch { /* not JSON */ }
      throw new AlpacaError(`Alpaca said ${res.status}: ${detail}`, res.status)
    }
    return (text ? JSON.parse(text) : {}) as T
  }

  async account(mode: BrokerMode): Promise<RawAccount> {
    return this.call<RawAccount>(`${hostFor(mode)}/account`)
  }

  async positions(mode: BrokerMode): Promise<RawPosition[]> {
    return this.call<RawPosition[]>(`${hostFor(mode)}/positions`)
  }

  async orders(mode: BrokerMode, status: 'open' | 'all' = 'open', limit = 50): Promise<RawOrder[]> {
    return this.call<RawOrder[]>(`${hostFor(mode)}/orders?status=${status}&limit=${Math.min(Math.max(limit, 1), 500)}&direction=desc`)
  }

  async clock(mode: BrokerMode): Promise<{ is_open?: boolean; next_open?: string; next_close?: string; timestamp?: string }> {
    return this.call(`${hostFor(mode)}/clock`)
  }

  async cancelOrder(mode: BrokerMode, orderId: string): Promise<void> {
    if (!/^[\w-]{8,64}$/.test(orderId)) throw new AlpacaError('that is not an order id', 0)
    const res = await this.http(`${hostFor(mode)}/orders/${orderId}`, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(20_000) })
    if (!res.ok && res.status !== 404) throw new AlpacaError(`Alpaca could not cancel ${orderId}: ${res.status}`, res.status)
  }

  /** Historical daily bars. Read-only market data; needs market-data keys but no account. */
  async dailyBars(symbol: string, days = 120): Promise<BrokerBar[]> {
    const start = new Date(Date.now() - days * 86_400_000).toISOString()
    const url = `${ALPACA_DATA_HOST}/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${start}&limit=1000&adjustment=split&feed=iex`
    const body = await this.call<{ bars?: BrokerBar[] }>(url)
    return (body.bars ?? []).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
  }

  /** The one call that can move money. Called only by BrokerService.sendOrder. */
  async placeOrder(mode: BrokerMode, body: OrderBody): Promise<RawOrder> {
    return this.call<RawOrder>(`${hostFor(mode)}/orders`, { method: 'POST', body: JSON.stringify(body) })
  }
}

export function toPosition(p: RawPosition, equity: number): BrokerPosition {
  const marketValue = Number(p.market_value) || 0
  return {
    symbol: p.symbol,
    qty: Number(p.qty),
    side: p.side,
    avgEntryPrice: Number(p.avg_entry_price),
    currentPrice: Number(p.current_price),
    marketValue,
    unrealizedPl: Number(p.unrealized_pl),
    unrealizedPlPct: Number(p.unrealized_plpc) * 100,
    exposurePct: equity > 0 ? (Math.abs(marketValue) / equity) * 100 : 0,
  }
}

export function toOrder(o: RawOrder): BrokerOrder {
  return {
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    qty: o.qty === null ? null : Number(o.qty),
    notional: o.notional === null ? null : Number(o.notional),
    type: o.type,
    limitPrice: o.limit_price === null ? null : Number(o.limit_price),
    stopPrice: o.stop_price === null ? null : Number(o.stop_price),
    status: o.status,
    submittedAt: o.submitted_at,
    filledQty: Number(o.filled_qty) || 0,
    filledAvgPrice: o.filled_avg_price === null ? null : Number(o.filled_avg_price),
  }
}
