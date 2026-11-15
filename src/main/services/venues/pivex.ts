import type { VenueAccount, VenuePosition, VenueQuote, VenueTicket } from '../../../shared/venues'
import { VENUES } from '../../../shared/venues'
import type { PageRead } from '../../../shared/browser'
import { browserLayer } from '../browser/layer'
import { recipeFor } from '../browser/recipes'
import { ApprovalGate, approvalGate, riskPasses, riskRefusals, TICKET_TTL_MS, type RiskInput } from './guard'
import { openTrade } from './journal'
import { readHalt, recordVenueEvent } from './state'
import { LogService } from '../logs'
import crypto from 'crypto'

/**
 * Pivex, as the first consumer of the general browser layer.
 *
 * Nothing here talks to Pivex over an API, because Pivex has none: everything goes
 * through the Firefox tab the user is signed in to, using the same primitives any other
 * site would use — read the page, find an element by its label, click it, read a value,
 * wait for something to appear.
 *
 * The hard limits Pivex sets are the ones this file enforces: 4% daily, 6% overall. An
 * order is prepared, checked, approved by the user for that exact order, and only then
 * sent — and a confirm modal never gets clicked without that approval.
 *
 * The account is a simulation. This file never calls the balance money.
 */

const log = () => LogService.getInstance()

const PIVEX_HOST = 'app.pivex.com'

/** Symbols Pivex lists, with the contract size one lot represents. */
export const PIVEX_INSTRUMENTS: Record<string, { contract: number; kind: 'forex' | 'index' | 'commodity' | 'crypto' | 'stock' }> = {
  EURUSD: { contract: 100_000, kind: 'forex' },
  GBPUSD: { contract: 100_000, kind: 'forex' },
  GBPJPY: { contract: 100_000, kind: 'forex' },
  EURGBP: { contract: 100_000, kind: 'forex' },
  XAUUSD: { contract: 100, kind: 'commodity' },
  XAGUSD: { contract: 5_000, kind: 'commodity' },
  WTI: { contract: 1_000, kind: 'commodity' },
  NGAS: { contract: 10_000, kind: 'commodity' },
  GER40: { contract: 1, kind: 'index' },
  US500: { contract: 1, kind: 'index' },
  BTCUSD: { contract: 1, kind: 'crypto' },
}

/** Pivex's own leverage, from its help pages. Used to work out the margin one order needs. */
export const PIVEX_LEVERAGE: Record<string, number> = {
  forex: 30, index: 5, commodity: 10, crypto: 1, stock: 1,
}

export const PIVEX_URL = 'https://app.pivex.com/trading-platform'

export interface PivexRead {
  account: VenueAccount | null
  /** True when the page looks like the Pivex sign-in wall rather than the terminal. */
  needsSignIn: boolean
  /** What Goga could not read, in plain words. */
  gaps: string[]
  /** The page it read, for the record. */
  page: { url: string; title: string } | null
}

function num(s: string): number | null {
  const cleaned = s.replace(/[^0-9.\-]/g, '')
  if (!cleaned || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * Read the account from the page's own text.
 *
 * Pivex renders its numbers into the page, so the honest thing to do is read what is
 * printed and say which figures were found and which were not — never invent a balance.
 */
export function parsePivexAccount(page: PageRead, tables: string[][][] = []): { account: VenueAccount | null; needsSignIn: boolean; gaps: string[] } {
  const gaps: string[] = []
  const text = page.text
  const url = page.url

  if (/\/login|\/signin|\/sign-in/i.test(url) || (/sign in/i.test(text) && /password/i.test(text) && !/balance|equity|positions/i.test(text))) {
    return { account: null, needsSignIn: true, gaps: ['The Pivex tab is showing a sign-in page, so there is no account to read.'] }
  }

  const balance = num(text.match(/balance[^0-9\-]{0,20}([\d,]+\.?\d*)/i)?.[1] ?? '')
  const equity = num(text.match(/equity[^0-9\-]{0,20}([\d,]+\.?\d*)/i)?.[1] ?? '')
  // The header line reads "Profit 155.98 USD". A table header cell ("Profit") has no
  // number after it, so requiring a digit within a few characters keeps the two apart.
  const profit = num(text.match(/\bprofit\b[^0-9\-]{0,6}(-?[\d,]+\.?\d*)/i)?.[1] ?? '')
  const progress = num(text.match(/progress[^0-9\-]{0,20}([\d.]+)\s*%/i)?.[1] ?? '')
  const accountNo = text.match(/#(\d{5,})/)?.[1] ?? null
  const plan = text.match(/(\d+k)\s*[–-]\s*(challenge|evaluation|verification)/i)

  const base = equilibrium(balance, equity, profit)

  if (base === null) {
    gaps.push('I could not find a balance or equity figure in the page text. It may still be loading, or the layout may have changed.')
    return { account: null, needsSignIn: false, gaps }
  }

  const notes: string[] = []
  notes.push('This balance is simulated. It is not money and cannot be withdrawn.')
  if (plan) notes.push(`Account type: ${plan[1]} ${plan[2].toLowerCase()}${accountNo ? ` #${accountNo}` : ''}.`)
  if (progress !== null) notes.push(`Progress toward the 10% target: ${progress}%.`)
  if (profit !== null) notes.push(`The platform's "profit" figure is a score: ${profit}.`)

  const positions = parsePivexPositions(page, tables)
  gaps.push(...positions.gaps)

  return {
    account: {
      venue: 'pivex',
      equity: base,
      cash: balance,
      dayPnlPct: 0,
      overallPnlPct: progress ?? 0,
      currency: 'USD',
      positions: positions.positions,
      notes,
      readAt: new Date().toISOString(),
    },
    needsSignIn: false,
    gaps,
  }
}

function equilibrium(balance: number | null, equity: number | null, _profit: number | null): number | null {
  if (equity !== null && equity > 0) return equity
  if (balance !== null && balance > 0) return balance
  return null
}

/**
 * Read every table on the page as rows of cells.
 *
 * A trading terminal's positions table is a real `<table>` or a grid of rows; reading it
 * as cells keeps the columns aligned, which reading the page's flat text does not. This
 * is a general primitive, not a Pivex one.
 */
export function readTablesScript(): string {
  return `(() => {
    const tables = []
    for (const table of Array.from(document.querySelectorAll('table'))) {
      const rows = []
      for (const tr of Array.from(table.querySelectorAll('tr'))) {
        const cells = Array.from(tr.querySelectorAll('th,td')).map(td => (td.innerText || '').replace(/\\s+/g, ' ').trim())
        if (cells.length) rows.push(cells)
      }
      if (rows.length) tables.push(rows)
    }
    // Grid layouts that are not <table>: rows carrying role="row" with role="cell" children.
    if (!tables.length) {
      const rows = []
      for (const tr of Array.from(document.querySelectorAll('[role="row"]'))) {
        const cells = Array.from(tr.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"]'))
          .map(td => (td.innerText || '').replace(/\\s+/g, ' ').trim())
        if (cells.length) rows.push(cells)
      }
      if (rows.length) tables.push(rows)
    }
    return JSON.stringify(tables)
  })()`
}

/**
 * Positions from the page's table.
 *
 * The table is read as cells, so a column cannot drift out of line with its header. The
 * header row is found by name, and a row is only turned into a position when the symbol
 * and the size are both readable — anything else is reported as a gap rather than guessed.
 */
export function parsePivexPositions(page: PageRead, tables: string[][][] = []): { positions: VenuePosition[]; gaps: string[] } {
  const gaps: string[] = []
  const equity = 0

  for (const rows of tables) {
    const headerIndex = rows.findIndex(r =>
      r.some(c => /^symbol$/i.test(c)) && r.some(c => /^(volume|qty|size|quantity)$/i.test(c)))
    if (headerIndex === -1) continue
    const header = rows[headerIndex].map(c => c.toLowerCase())
    const col = {
      symbol: header.findIndex(c => /^symbol$/.test(c)),
      side: header.findIndex(c => /^(side|type|direction)$/.test(c)),
      volume: header.findIndex(c => /^(volume|qty|size|quantity)$/.test(c)),
      entry: header.findIndex(c => /^(open|entry|open price|entry price)$/.test(c)),
      price: header.findIndex(c => /^(price|current|current price|market price)$/.test(c)),
      profit: header.findIndex(c => /^(profit|p\/l|pnl|profit\/loss)$/.test(c)),
    }
    if (col.symbol === -1 || col.volume === -1) {
      gaps.push('A positions table was found but its Symbol and Volume columns could not be identified, so no position was read from it.')
      continue
    }

    const positions: VenuePosition[] = []
    for (const row of rows.slice(headerIndex + 1)) {
      const symbol = (row[col.symbol] ?? '').trim().toUpperCase()
      if (!symbol || !/^[A-Z0-9.]{2,12}$/.test(symbol)) continue
      const size = num(row[col.volume] ?? '')
      if (size === null) continue
      const entry = col.entry >= 0 ? num(row[col.entry] ?? '') : null
      const price = col.price >= 0 ? num(row[col.price] ?? '') : null
      const profit = col.profit >= 0 ? num(row[col.profit] ?? '') : null
      const sideText = col.side >= 0 ? (row[col.side] ?? '').toLowerCase() : ''
      const side: VenuePosition['side'] = /sell|short/.test(sideText) ? 'short' : /buy|long/.test(sideText) ? 'long' : 'flat'
      positions.push({
        symbol,
        side,
        size: Math.abs(size),
        avgEntryPrice: entry ?? 0,
        currentPrice: price ?? 0,
        unrealizedPl: profit ?? 0,
        unrealizedPlPct: entry && entry > 0 && price ? ((price - entry) / entry) * 100 * (side === 'short' ? -1 : 1) : 0,
        exposurePct: equity > 0 ? 0 : 0,
      })
    }
    if (positions.length) {
      gaps.push(`Read ${positions.length} open position${positions.length === 1 ? '' : 's'} from the page's table.`)
      return { positions, gaps }
    }
    gaps.push('The positions table has a header but no readable rows, so either nothing is open or the rows did not render.')
    return { positions: [], gaps }
  }

  gaps.push('No positions table was found on the page, so either nothing is open or the table was not read.')
  return { positions: [], gaps }
}

/** The current Pivex tab, read through the general layer. */
export async function readPivex(): Promise<PivexRead> {
  const layer = browserLayer()
  if (!layer.isAttached) {
    return { account: null, needsSignIn: false, gaps: ['Goga is not attached to Firefox. Attach on the Browser page first.'], page: null }
  }
  const tabs = await layer.listTabs()
  const tab = tabs.find(t => t.url.includes(PIVEX_HOST))
  if (!tab) {
    return {
      account: null, needsSignIn: false,
      gaps: [`No Pivex tab is open. Goga looked at ${tabs.length} tab${tabs.length === 1 ? '' : 's'} and none of them is ${PIVEX_HOST}. Start Firefox from the Browser page and open Pivex there.`],
      page: null,
    }
  }
  await layer.selectTab(tab.id)
  const page = await layer.readPage()
  // Read the tables as cells too, so positions keep their columns.
  let tables: string[][][] = []
  try {
    const raw = await layer.evaluateScript(readTablesScript())
    const parsedTables = JSON.parse(raw)
    if (Array.isArray(parsedTables)) tables = parsedTables as string[][][]
  } catch { /* no tables is a normal page */ }
  const parsed = parsePivexAccount(page, tables)
  const recipe = recipeFor(PIVEX_HOST)
  if (!recipe) parsed.gaps.push('Goga has no saved description of Pivex yet. Press "Learn this page" so it does not have to start from zero next time.')
  return { account: parsed.account, needsSignIn: parsed.needsSignIn, gaps: parsed.gaps, page: { url: page.url, title: page.title } }
}

/** Best-effort bid/ask for a symbol, from the ticket under the chart. */
export async function readPivexQuote(symbol: string): Promise<VenueQuote | null> {
  const layer = browserLayer()
  if (!layer.isAttached) return null
  const page = await layer.readPage()
  const sym = symbol.toUpperCase()
  if (!page.text.toUpperCase().includes(sym)) return null
  // Pivex prints the live bid and ask on the SELL and BUY buttons.
  const sell = num(page.text.match(/sell[^0-9]{0,12}([\d.,]+)/i)?.[1] ?? '')
  const buy = num(page.text.match(/buy[^0-9]{0,12}([\d.,]+)/i)?.[1] ?? '')
  if (sell === null && buy === null) return null
  const bid = sell, ask = buy
  const spread = bid !== null && ask !== null ? ask - bid : null
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null
  return {
    symbol: sym, bid, ask, spread,
    spreadPct: spread !== null && mid ? (spread / mid) * 100 : null,
    asOf: new Date().toISOString(),
  }
}

export interface PivexPrepareInput {
  symbol: string
  side: 'buy' | 'sell'
  /** Lots. Pivex's box defaults to 0.01. */
  lots: number
  /** Where the stop would go, in price. Used to size the risk honestly. */
  stopPrice?: number | null
  reason: string
}

/**
 * Work out a Pivex order and check it. Places nothing.
 *
 * The risk figure is the distance from the entry to the stop, times the contract, times
 * the lots — the money actually at stake — not the face value of the position. If no
 * stop is given, the order is refused, because without a stop there is no risk figure and
 * an unbounded trade is exactly what the guard exists to stop.
 */
export async function preparePivexOrder(input: PivexPrepareInput): Promise<VenueTicket> {
  const reason = String(input.reason ?? '').trim()
  if (reason.length < 10) throw new Error('say why in at least 10 characters — the journal keeps it with the trade')
  const symbol = String(input.symbol ?? '').trim().toUpperCase()
  const inst = PIVEX_INSTRUMENTS[symbol]
  if (!inst) throw new Error(`"${symbol}" is not an instrument Goga knows on Pivex. Known ones: ${Object.keys(PIVEX_INSTRUMENTS).join(', ')}.`)
  const lots = Number(input.lots)
  if (!(lots > 0)) throw new Error('the volume must be above zero lots')
  if (!(Number(input.stopPrice) > 0)) throw new Error('a Pivex order needs a stop price: without one there is no limit on what it can lose, and Goga will not prepare it')

  const read = await readPivex()
  if (read.needsSignIn) throw new Error('The Pivex tab is showing a sign-in page. Sign in to Pivex in Firefox once, then prepare the order again.')
  if (!read.account) throw new Error(`Goga could not read the Pivex account: ${read.gaps.join(' ')}`)

  const quote = await readPivexQuote(symbol)
  const price = quote ? (input.side === 'buy' ? quote.ask : quote.bid) : null
  if (!price) throw new Error(`Goga could not read a live ${symbol} price from the Pivex ticket. Open ${symbol} in the Pivex tab and try again.`)

  const notional = price * inst.contract * lots
  const stopDistance = Math.abs(price - Number(input.stopPrice))
  const riskMoney = stopDistance * inst.contract * lots
  if (!(riskMoney > 0)) throw new Error('the stop price is the same as the entry price, so there is no risk figure to check')

  const venue = VENUES.pivex
  const riskPct = read.account.equity > 0 ? (riskMoney / read.account.equity) * 100 : 100
  const risk: RiskInput = {
    venue: 'pivex', budget: venue.budget,
    equity: read.account.equity,
    dayPnlPct: read.account.dayPnlPct,
    overallPnlPct: read.account.overallPnlPct,
    orderNotional: notional,
    riskPct,
    openPositions: read.account.positions.length,
    opensNewPosition: !read.account.positions.some(p => p.symbol === symbol),
    halted: readHalt('pivex').halted,
    haltReason: readHalt('pivex').reason,
  }
  const refusals = riskRefusals(risk)
  if (refusals.length) {
    recordVenueEvent('pivex', 'refused', `${symbol} ${input.side} ${lots} lots: ${refusals.join('; ')}`)
    throw new Error(`Order not prepared — ${refusals.join('; ')}`)
  }

  const id = crypto.randomUUID()
  const ticket: VenueTicket = {
    id,
    venue: 'pivex',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
    symbol,
    side: input.side,
    size: lots,
    sizeUnit: 'lots',
    orderType: 'market',
    limitPrice: null,
    estimatedPrice: price,
    estimatedNotional: notional,
    confirmation: `${input.side.toUpperCase()} ${lots} lot${lots === 1 ? '' : 's'} ${symbol} at about ${price.toFixed(5)}`
      + ` — face value ${notional.toFixed(2)}, risking ${riskMoney.toFixed(2)} to the stop at ${Number(input.stopPrice).toFixed(5)}`
      + ` (${riskPct.toFixed(2)}% of the ${read.account.equity.toFixed(2)} simulated balance)`,
    checks: riskPasses(risk),
    reason,
    spent: false,
  }
  approvalGate.offer(ticket)
  recordVenueEvent('pivex', 'prepared', ticket.confirmation)
  log().info(`Pivex: ticket ${id} prepared (${ticket.confirmation}) — NOT sent`)
  return ticket
}

/**
 * Send an approved Pivex ticket by clicking the platform's own buttons.
 *
 * This is the only path that can place a Pivex order, and it goes through the shared
 * gate first. The gate is claimed BEFORE any click, so a failure part-way cannot leave a
 * ticket that could be replayed.
 */
export async function sendPivexOrder(ticketId: string): Promise<{ ok: boolean; message: string; venueOrderId: string | null; refusedByGate: boolean }> {
  const halt = readHalt('pivex')
  const claim = approvalGate.claim(ticketId, 'pivex', halt.halted, halt.reason ?? undefined)
  if (!claim.ok || !claim.ticket) {
    recordVenueEvent('pivex', 'refused', claim.message)
    return { ok: false, message: claim.message, venueOrderId: null, refusedByGate: true }
  }
  const ticket = claim.ticket

  const layer = browserLayer()
  if (!layer.isAttached) {
    return { ok: false, message: 'Goga is not attached to Firefox, so nothing was sent. The ticket is now spent — prepare it again after attaching.', venueOrderId: null, refusedByGate: false }
  }

  try {
    // Select the instrument from the sidebar list first.
    const symbol = await layer.findElement({ by: 'text', text: ticket.symbol })
    if (!symbol.found) {
      return { ok: false, message: `Could not find ${ticket.symbol} in the Pivex pair list, so nothing was sent.`, venueOrderId: null, refusedByGate: false }
    }
    await layer.click({ by: 'text', text: ticket.symbol })
    await layer.waitForText('BUY')

    // Set the volume in its box.
    const volume = await layer.findElement({ by: 'role', role: 'textbox' })
    if (!volume.found || !volume.match) {
      return { ok: false, message: 'Could not find the volume box on the Pivex ticket, so nothing was sent.', venueOrderId: null, refusedByGate: false }
    }
    const volumeQuery = { by: 'role' as const, role: volume.match.role, name: volume.match.name }
    await layer.type(volumeQuery, String(ticket.size))
    const typed = await layer.readValue(volumeQuery)
    if (typed.value === null || Math.abs(Number(typed.value) - ticket.size) > 1e-9) {
      return { ok: false, message: `The volume box reads "${typed.value ?? ''}" instead of ${ticket.size}, so nothing was sent.`, venueOrderId: null, refusedByGate: false }
    }

    // Press the side button.
    const sideLabel = ticket.side === 'buy' ? 'BUY' : 'SELL'
    const button = await layer.findElement({ by: 'role', role: 'button', name: sideLabel })
    if (!button.found) {
      return { ok: false, message: `Could not find the ${sideLabel} button on the Pivex ticket, so nothing was sent.`, venueOrderId: null, refusedByGate: false }
    }
    await layer.click({ by: 'role', role: 'button', name: sideLabel })

    // The confirm modal names the exact order. Check it says what was approved.
    const modal = await layer.waitForText('Do you want to open', false, 8_000)
    if (!modal.found) {
      return {
        ok: false,
        message: `Pressing ${sideLabel} did not produce the confirmation the ticket expected. Nothing was confirmed — look at the Pivex tab before doing anything else.`,
        venueOrderId: null, refusedByGate: false,
      }
    }
    const expected = `${sideLabel} ${ticket.size} ${ticket.symbol}`
    if (!new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(modal.firstText)) {
      return {
        ok: false,
        message: `The confirmation on screen says "${modal.firstText.slice(0, 160)}", which is not the order that was approved (${expected}). Goga did not confirm it.`,
        venueOrderId: null, refusedByGate: false,
      }
    }

    const confirm = await layer.findElement({ by: 'role', role: 'button', name: 'Confirm' })
    if (!confirm.found) {
      return { ok: false, message: 'The Pivex confirmation is open but its Confirm button could not be found. Goga did not click anything else.', venueOrderId: null, refusedByGate: false }
    }
    await layer.click({ by: 'role', role: 'button', name: 'Confirm' })

    openTrade(ticket, null, ticket.estimatedPrice)
    recordVenueEvent('pivex', 'sent', ticket.confirmation)
    log().info(`Pivex: order SENT ${ticket.confirmation}`)
    return {
      ok: true,
      message: `Sent: ${ticket.confirmation}. This is a simulation — the position is a practice position, not a real one.`,
      venueOrderId: null, refusedByGate: false,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordVenueEvent('pivex', 'error', message)
    log().warn(`Pivex: send failed — ${message}`)
    return { ok: false, message, venueOrderId: null, refusedByGate: false }
  }
}

/** Refuse everything and record why. The venue's own kill switch. */
export function haltPivex(reason: string): void {
  recordVenueEvent('pivex', 'halt', reason)
}
