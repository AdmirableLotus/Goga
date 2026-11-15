import { ToolRegistry } from './registry'
import { VENUES, type VenueId } from '../../shared/venues'
import { readPivex } from '../services/venues/pivex'
import { readAlpacaPaper } from '../services/venues/alpaca'
import { analyse, latestTrades, readTrades } from '../services/venues/journal'
import { readHalt, readVenueEvents, setHalt } from '../services/venues/state'
import { readStudyBase } from '../services/venues/study'

/**
 * Venue tools: the two practice venues, for chat.
 *
 * The Practice page could read an account, read its stats and halt trading, and none of that
 * was reachable from a chat request — the page was the only way in. These tools are that same
 * page's reads, callable by the agent.
 *
 * Every one of them is `low` risk and read-only except the halt, which is `medium` and
 * reversible: a halt stops new orders being prepared and can be cleared. There is deliberately
 * no tool here that prepares or sends an order. Sending stays where it was: a prepared ticket
 * the user approves on the page, spent once, before it expires.
 */

const reg = ToolRegistry.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

const venueParam = {
  type: 'string' as const,
  enum: ['pivex', 'alpaca-paper'] as VenueId[],
  description: 'Which venue: "pivex" (a simulation-only prop-firm challenge) or "alpaca-paper" (a real broker\'s simulated account).',
}

function venueInfoBlock(id: VenueId): string[] {
  const v = VENUES[id]
  return [
    `${v.name} — ${v.whatItIs}`,
    `  Money at stake: ${v.moneyAtStake}`,
    `  Regulator: ${v.regulator}`,
    `  Limits: ${v.budget.dailyLossPct}% daily loss, ${v.budget.overallLossPct}% overall, ${v.budget.perTradeCapPct}% per trade, ${v.budget.maxOrderNotional} max per order, ${v.budget.maxOpenPositions} positions.`,
  ]
}

reg.register({
  name: 'venue.info',
  description: 'What each practice venue is, what money is actually at stake, who supervises it and what its loss limits are. Read-only. Use this before saying anything about a venue, so "simulated" and "not a broker" are stated rather than assumed.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => ({
  success: true,
  data: [
    ...venueInfoBlock('pivex'), '',
    ...venueInfoBlock('alpaca-paper'), '',
    'Neither venue holds real money. Pivex pays a reward from a fee you already paid and is not a broker; Alpaca paper is a simulation at a real broker. Nothing here is income.',
  ].join('\n'),
}))

reg.register({
  name: 'venue.read',
  description: 'Read one practice venue\'s account: value, today\'s change, overall change, open positions with their profit or loss, and anything the reading could not establish. Read-only. Use this for "how is my pivex account doing" or "read my alpaca paper account".',
  parameters: { type: 'object', properties: { venue: venueParam }, required: ['venue'] },
  riskLevel: 'low', reversible: true, category: 'web',
}, async p => {
  try {
    const venue: VenueId = String(p.venue) === 'pivex' ? 'pivex' : 'alpaca-paper'
    if (venue === 'pivex') {
      const read = await readPivex()
      if (read.needsSignIn) {
        return {
          success: false,
          error: 'Pivex needs a sign-in before its account can be read. Goga does not sign in as you — open Pivex in the browser, sign in yourself, and ask again.',
        }
      }
      if (!read.account) {
        return {
          success: false,
          error: `The Pivex account could not be read. ${read.gaps.length ? read.gaps.join(' ') : 'The page did not show an account Goga could parse.'}`,
        }
      }
      const a = read.account
      return {
        success: true,
        data: [
          `${VENUES.pivex.name} — simulated challenge balance, not money: ${a.equity.toFixed(2)} ${a.currency}`,
          a.cash !== null ? `  cash ${a.cash.toFixed(2)}` : '',
          `  today ${a.dayPnlPct >= 0 ? '+' : ''}${a.dayPnlPct.toFixed(2)}%, overall ${a.overallPnlPct >= 0 ? '+' : ''}${a.overallPnlPct.toFixed(2)}%`,
          ...a.positions.map(pos => `  ${pos.symbol} ${pos.side} ${pos.size} @ ${pos.avgEntryPrice} → ${pos.currentPrice}, ${pos.unrealizedPl >= 0 ? '+' : ''}${pos.unrealizedPl.toFixed(2)} (${pos.unrealizedPlPct.toFixed(1)}%), ${pos.exposurePct.toFixed(1)}% of the account`),
          a.positions.length ? '' : '  nothing open',
          ...a.notes.map(n => `  note: ${n}`),
          ...read.gaps.map(g => `  gap: ${g}`),
          `  read at ${a.readAt}`,
        ].filter(Boolean).join('\n'),
      }
    }
    const read = await readAlpacaPaper()
    if (!read.account) {
      return { success: false, error: `The Alpaca paper account could not be read. ${read.error ?? 'No paper key may be stored.'}` }
    }
    const a = read.account
    return {
      success: true,
      data: [
        `${VENUES['alpaca-paper'].name} — simulated account at a real broker: ${a.equity.toFixed(2)} ${a.currency}`,
        a.cash !== null ? `  cash ${a.cash.toFixed(2)}` : '',
        `  today ${a.dayPnlPct >= 0 ? '+' : ''}${a.dayPnlPct.toFixed(2)}%, overall ${a.overallPnlPct >= 0 ? '+' : ''}${a.overallPnlPct.toFixed(2)}%`,
        ...a.positions.map(pos => `  ${pos.symbol} ${pos.side} ${pos.size} @ ${pos.avgEntryPrice} → ${pos.currentPrice}, ${pos.unrealizedPl >= 0 ? '+' : ''}${pos.unrealizedPl.toFixed(2)} (${pos.unrealizedPlPct.toFixed(1)}%)`),
        a.positions.length ? '' : '  nothing open',
        ...a.notes.map((n: string) => `  note: ${n}`),
        `  read at ${a.readAt}`,
      ].filter(Boolean).join('\n'),
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'venue.stats',
  description: 'The learning loop\'s numbers for one venue from closed practice trades: win rate, average win, average loss, expectancy and total, with a verdict. Says "too-few-trades" in those words when the sample is too small to mean anything. Read-only.',
  parameters: { type: 'object', properties: { venue: venueParam }, required: ['venue'] },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  try {
    const venue: VenueId = String(p.venue) === 'pivex' ? 'pivex' : 'alpaca-paper'
    const stats = analyse(latestTrades(readTrades()), venue)
    return {
      success: true,
      data: [
        stats.headline,
        `${stats.closedTrades} closed trade(s): ${stats.wins} up, ${stats.losses} down.`,
        stats.winRate !== null ? `  win rate ${(stats.winRate * 100).toFixed(0)}%` : '  win rate: not enough trades',
        stats.avgWin !== null ? `  average win ${stats.avgWin.toFixed(2)}` : '',
        stats.avgLoss !== null ? `  average loss ${stats.avgLoss.toFixed(2)}` : '',
        stats.expectancy !== null ? `  expectancy ${stats.expectancy >= 0 ? '+' : ''}${stats.expectancy.toFixed(2)} per trade` : '  expectancy: not enough trades',
        `  total ${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)}`,
        ...stats.findings.map(f => `  • ${f}`),
      ].filter(Boolean).join('\n'),
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'venue.trades',
  description: 'The practice-trade journal for one venue: each trade with its entry and exit price, its result and the reason recorded when it was opened. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      venue: venueParam,
      limit: { type: 'number', description: 'How many recent trades (default 30).' },
    },
    required: ['venue'],
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const venue: VenueId = String(p.venue) === 'pivex' ? 'pivex' : 'alpaca-paper'
  const trades = latestTrades(readTrades()).filter(t => t.venue === venue).slice(0, Number(p.limit) || 30)
  if (!trades.length) return { success: true, data: `No ${venue} trades in the journal yet.` }
  return {
    success: true,
    data: trades.map(t => [
      `${t.openedAt.slice(0, 16).replace('T', ' ')} ${t.side} ${t.size} ${t.sizeUnit} ${t.symbol} @ ${t.entryPrice}`,
      t.exitPrice !== null ? ` → ${t.exitPrice} (${t.pnl !== null && t.pnl >= 0 ? '+' : ''}${t.pnl ?? '?'}, ${t.pnlPct !== null ? `${t.pnlPct.toFixed(1)}%` : '?'})` : ' (still open)',
      ` — ${t.reason}`,
    ].join('')).join('\n'),
  }
})

reg.register({
  name: 'venue.studyBase',
  description: 'The practice curriculum Goga is measured against: what to practise on these venues, in order, so a session has a purpose beyond pressing buy. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => {
  try {
    const base = readStudyBase()
    if (!base.found) return { success: false, error: base.error ?? 'The study base could not be read.' }
    return {
      success: true,
      data: [
        `Read from ${base.source}${base.modifiedAt ? ` (last changed ${base.modifiedAt.slice(0, 10)})` : ''}.`,
        '',
        base.markdown.slice(0, 12000),
        base.markdown.length > 12000 ? '\n… [the rest of the study base was not shown]' : '',
      ].filter(Boolean).join('\n'),
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'venue.halt',
  description: 'Stop or resume preparing new orders on one venue. Halting is the safety switch: nothing new can be prepared or sent until it is cleared. Reversible.',
  parameters: {
    type: 'object',
    properties: {
      venue: venueParam,
      halted: { type: 'boolean', description: 'true to halt, false to clear the halt.' },
      reason: { type: 'string', description: 'Why — recorded with the halt and shown to the user.' },
    },
    required: ['venue', 'halted'],
  },
  riskLevel: 'medium', reversible: true, category: 'system',
}, async p => {
  try {
    const venue: VenueId = String(p.venue) === 'pivex' ? 'pivex' : 'alpaca-paper'
    const state = setHalt(venue, p.halted === true, String(p.reason ?? '') || null)
    return {
      success: true,
      data: state.halted
        ? `Trading is halted on ${venue}${state.reason ? ` (${state.reason})` : ''}. No new order can be prepared or sent until you clear it.`
        : `The halt on ${venue} is cleared. Orders can be prepared again — each one still needs your approval before it is sent.`,
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'venue.halts',
  description: 'Whether trading is halted on each venue, and the recorded reason. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => {
  const p = readHalt('pivex'), a = readHalt('alpaca-paper')
  return {
    success: true,
    data: [
      `pivex: ${p.halted ? `HALTED${p.reason ? ` (${p.reason})` : ''}` : 'not halted'}`,
      `alpaca-paper: ${a.halted ? `HALTED${a.reason ? ` (${a.reason})` : ''}` : 'not halted'}`,
    ].join('\n'),
  }
})

reg.register({
  name: 'venue.events',
  description: 'The venue event log: every halt, prepare, approval, refusal and send, with the time. Read-only. Use it to answer "what did you actually do on the practice account".',
  parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many recent events (default 40).' } } },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const events = readVenueEvents(Number(p.limit) || 40)
  if (!events.length) return { success: true, data: 'No venue events recorded yet.' }
  return {
    success: true,
    data: events.slice(-(Number(p.limit) || 40)).map(e => `${e.time.slice(0, 19).replace('T', ' ')} [${e.venue}] ${e.kind}: ${e.detail}`).join('\n'),
  }
})
