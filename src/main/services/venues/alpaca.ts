import type { VenueAccount, VenuePosition, VenueQuote, VenueTicket } from '../../../shared/venues'
import { VENUES } from '../../../shared/venues'
import { AlpacaClient, AlpacaError } from '../broker/client'
import { paperKeys } from '../broker/credentials'
import { approvalGate, riskPasses, riskRefusals, TICKET_TTL_MS, type RiskInput } from './guard'
import { openTrade } from './journal'
import { readHalt, recordVenueEvent } from './state'
import { LogService } from '../logs'
import crypto from 'crypto'

/**
 * Alpaca paper, as the second consumer.
 *
 * This one goes through Alpaca's real API rather than the screen, because Alpaca has one.
 * It reuses the client and the stored-key path the Trading page already uses, so there is
 * one credential and one place it is read — and it is hard-coded to the paper host. There
 * is no setting that could point it at a live account.
 *
 * The approval gate and the risk guard are the same objects Pivex uses. That is the point
 * of the shared layer: a second venue adds a way to read and a way to send, and inherits
 * every check.
 */

const log = () => LogService.getInstance()

/** Paper only, by construction. There is no parameter that changes this. */
const PAPER = 'paper' as const

function client(): AlpacaClient {
  return new AlpacaClient(() => paperKeys())
}

export interface AlpacaRead {
  account: VenueAccount | null
  /** Plain words about why there is no account, when there is none. */
  error: string | null
  /** True when a paper key is stored and decrypts. */
  keyStored: boolean
}

/** Read the paper account, positions and today's change. Read-only. */
export async function readAlpacaPaper(): Promise<AlpacaRead> {
  const keys = paperKeys()
  if (!keys) {
    return {
      account: null, keyStored: false,
      error: 'No Alpaca paper key is stored, or the stored one could not be decrypted. Add a free paper key in Goga → Trading (the key id starts with PK).',
    }
  }
  try {
    const c = client()
    const [account, positions] = await Promise.all([c.account(PAPER), c.positions(PAPER)])
    const equity = Number(account.equity ?? 0)
    const lastEquity = Number(account.last_equity ?? 0)
    const dayPnlPct = lastEquity > 0 ? (equity / lastEquity - 1) * 100 : 0
    const portfolio = Number(account.portfolio_value ?? equity)
    // Alpaca paper starts at 100k; the change since then is the honest "overall" figure.
    const overallPnlPct = portfolio > 0 ? (equity / 100_000 - 1) * 100 : 0

    const mapped: VenuePosition[] = positions.map(p => {
      const marketValue = Number(p.market_value) || 0
      return {
        symbol: p.symbol,
        side: p.side === 'short' ? 'short' : 'long',
        size: Math.abs(Number(p.qty)),
        avgEntryPrice: Number(p.avg_entry_price),
        currentPrice: Number(p.current_price),
        unrealizedPl: Number(p.unrealized_pl),
        unrealizedPlPct: Number(p.unrealized_plpc) * 100,
        exposurePct: equity > 0 ? (Math.abs(marketValue) / equity) * 100 : 0,
      }
    })

    return {
      keyStored: true,
      error: null,
      account: {
        venue: 'alpaca-paper',
        equity,
        cash: Number(account.cash ?? 0),
        dayPnlPct,
        overallPnlPct,
        currency: account.currency ?? 'USD',
        positions: mapped,
        notes: [
          'This is a simulated account at a real broker. The prices are real; the money is not.',
          `Status ${account.status ?? 'unknown'}.`,
        ],
        readAt: new Date().toISOString(),
      },
    }
  } catch (err) {
    const message = err instanceof AlpacaError
      ? err.message
      : err instanceof Error ? err.message : String(err)
    return { account: null, keyStored: true, error: `Alpaca refused the read: ${message}` }
  }
}

/** The latest quote for a symbol, from Alpaca's data host. */
export async function readAlpacaQuote(symbol: string): Promise<VenueQuote | null> {
  const sym = String(symbol ?? '').trim().toUpperCase()
  if (!/^[A-Z][A-Z.]{0,9}$/.test(sym)) return null
  if (!paperKeys()) return null
  try {
    const c = client()
    const bars = await c.dailyBars(sym, 5)
    const last = bars[bars.length - 1]
    if (!last) return null
    // Daily bars carry no bid/ask, so the spread is reported as unknown rather than zero.
    return { symbol: sym, bid: null, ask: null, spread: null, spreadPct: null, asOf: last.t }
  } catch { return null }
}

export interface AlpacaPrepareInput {
  symbol: string
  side: 'buy' | 'sell'
  qty?: number | null
  notional?: number | null
  orderType?: 'market' | 'limit'
  limitPrice?: number | null
  /** Where the stop would go. Used to work out what the order risks. */
  stopPrice?: number | null
  reason: string
}

/**
 * Work out an Alpaca paper order and check it. Sends nothing.
 *
 * The risk figure is the distance to the stop times the size. Without a stop the order is
 * refused, for the same reason as on Pivex: an unbounded loss cannot be checked against a
 * loss budget.
 */
export async function prepareAlpacaOrder(input: AlpacaPrepareInput): Promise<VenueTicket> {
  const reason = String(input.reason ?? '').trim()
  if (reason.length < 10) throw new Error('say why in at least 10 characters — the journal keeps it with the trade')
  const symbol = String(input.symbol ?? '').trim().toUpperCase()
  if (!/^[A-Z][A-Z.]{0,9}$/.test(symbol)) throw new Error(`"${input.symbol}" does not look like a stock symbol (e.g. AAPL)`)
  if (!(Number(input.stopPrice) > 0)) throw new Error('an Alpaca order needs a stop price: without one there is no limit on what it can lose, and Goga will not prepare it')

  const read = await readAlpacaPaper()
  if (!read.account) throw new Error(read.error ?? 'the paper account could not be read')

  const orderType: 'market' | 'limit' = input.orderType === 'limit' ? 'limit' : 'market'
  if (orderType === 'limit' && !(Number(input.limitPrice) > 0)) throw new Error('a limit order needs a limit price above zero')

  const qty = input.qty === undefined || input.qty === null ? null : Number(input.qty)
  const notional = input.notional === undefined || input.notional === null ? null : Number(input.notional)
  if (qty === null && notional === null) throw new Error('give either a share quantity or a dollar amount')
  if (qty !== null && !(qty > 0)) throw new Error('the quantity must be above zero')

  let price = Number(input.limitPrice ?? 0)
  if (!(price > 0)) {
    const held = read.account.positions.find(p => p.symbol === symbol)
    if (held && held.currentPrice > 0) price = held.currentPrice
    else {
      const bars = await client().dailyBars(symbol, 10)
      const last = bars[bars.length - 1]
      if (!last) throw new Error(`no price came back for ${symbol} — check the symbol`)
      price = last.c
    }
  }

  const size = qty !== null ? qty : Number(notional)
  const orderNotional = qty !== null ? qty * price : Number(notional)
  const stopDistance = Math.abs(price - Number(input.stopPrice))
  const riskMoney = qty !== null ? stopDistance * qty : stopDistance / price * Number(notional)
  if (!(riskMoney > 0)) throw new Error('the stop price is the same as the entry price, so there is no risk figure to check')

  const riskPct = read.account.equity > 0 ? (riskMoney / read.account.equity) * 100 : 100
  const held = read.account.positions.find(p => p.symbol === symbol)
  if (input.side === 'sell' && !held) throw new Error(`there is no ${symbol} position to sell in the paper account`)

  const risk: RiskInput = {
    venue: 'alpaca-paper', budget: VENUES['alpaca-paper'].budget,
    equity: read.account.equity,
    dayPnlPct: read.account.dayPnlPct,
    overallPnlPct: read.account.overallPnlPct,
    orderNotional,
    riskPct,
    openPositions: read.account.positions.length,
    opensNewPosition: !held,
    halted: readHalt('alpaca-paper').halted,
    haltReason: readHalt('alpaca-paper').reason,
  }
  const refusals = riskRefusals(risk)
  if (refusals.length) {
    recordVenueEvent('alpaca-paper', 'refused', `${symbol} ${input.side}: ${refusals.join('; ')}`)
    throw new Error(`Order not prepared — ${refusals.join('; ')}`)
  }

  const id = crypto.randomUUID()
  const ticket: VenueTicket = {
    id,
    venue: 'alpaca-paper',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
    symbol,
    side: input.side,
    size,
    sizeUnit: qty !== null ? 'shares' : 'notional',
    orderType,
    limitPrice: orderType === 'limit' ? Number(input.limitPrice) : null,
    estimatedPrice: price,
    estimatedNotional: orderNotional,
    confirmation: `${input.side.toUpperCase()} ${qty !== null ? `${qty} ${symbol}` : `$${Number(notional).toFixed(2)} of ${symbol}`}`
      + ` — ${orderType.toUpperCase()}${orderType === 'limit' ? ` at ${input.limitPrice}` : ` (about $${price.toFixed(2)} now)`}`
      + `, about $${orderNotional.toFixed(2)} of the paper account, risking $${riskMoney.toFixed(2)} to the stop at ${Number(input.stopPrice).toFixed(2)}`,
    checks: riskPasses(risk),
    reason,
    spent: false,
  }
  approvalGate.offer(ticket)
  recordVenueEvent('alpaca-paper', 'prepared', ticket.confirmation)
  log().info(`Alpaca paper: ticket ${id} prepared (${ticket.confirmation}) — NOT sent`)
  return ticket
}

/**
 * Send an approved Alpaca paper ticket.
 *
 * The gate is claimed before the request goes out, so a network failure cannot leave a
 * ticket that could be sent twice. The host is the paper host, hard-coded in the client.
 */
export async function sendAlpacaOrder(ticketId: string): Promise<{ ok: boolean; message: string; venueOrderId: string | null; refusedByGate: boolean }> {
  const halt = readHalt('alpaca-paper')
  const claim = approvalGate.claim(ticketId, 'alpaca-paper', halt.halted, halt.reason ?? undefined)
  if (!claim.ok || !claim.ticket) {
    recordVenueEvent('alpaca-paper', 'refused', claim.message)
    return { ok: false, message: claim.message, venueOrderId: null, refusedByGate: true }
  }
  const ticket = claim.ticket

  if (!paperKeys()) {
    return { ok: false, message: 'No Alpaca paper key is stored, so nothing was sent.', venueOrderId: null, refusedByGate: false }
  }

  try {
    const placed = await client().placeOrder(PAPER, {
      symbol: ticket.symbol,
      side: ticket.side,
      type: ticket.orderType,
      time_in_force: 'day',
      ...(ticket.sizeUnit === 'notional' ? { notional: String(ticket.size) } : { qty: String(ticket.size) }),
      ...(ticket.orderType === 'limit' && ticket.limitPrice !== null ? { limit_price: String(ticket.limitPrice) } : {}),
    })
    openTrade(ticket, placed.id, ticket.estimatedPrice)
    recordVenueEvent('alpaca-paper', 'sent', `${ticket.confirmation} → order ${placed.id} ${placed.status}`)
    log().info(`Alpaca paper: order SENT ${placed.id} ${ticket.side} ${ticket.size} ${ticket.symbol}`)
    return {
      ok: true,
      message: `Sent to the paper account: ${placed.side} ${placed.qty ?? `$${placed.notional}`} ${placed.symbol}, status ${placed.status} (order ${placed.id}). Simulated money.`,
      venueOrderId: placed.id, refusedByGate: false,
    }
  } catch (err) {
    const message = err instanceof AlpacaError ? err.message : err instanceof Error ? err.message : String(err)
    recordVenueEvent('alpaca-paper', 'error', message)
    log().warn(`Alpaca paper: send failed — ${message}`)
    return { ok: false, message, venueOrderId: null, refusedByGate: false }
  }
}
