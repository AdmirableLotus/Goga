/**
 * The two venues Goga can practise on, and the shapes both go through.
 *
 * Pivex and Alpaca paper are different things and this file keeps that visible:
 *   - `pivex` is a simulation-only evaluation platform. Its balance is not money and
 *     cannot be withdrawn, and no regulator supervises it.
 *   - `alpaca-paper` is a real broker's simulated account, with real market data.
 *
 * Neither is real money. Nothing in this file places an order; the only code that sends
 * anything is the venue service, behind the shared approval gate.
 */

export type VenueId = 'pivex' | 'alpaca-paper'

/**
 * How much of the thing at stake each venue can lose before Goga stops.
 *
 * Pivex's own challenge rules are 4% daily and 6% overall. Alpaca paper has no such rule,
 * so Goga applies a user-set daily figure, and the same overall cap, so both venues are
 * measured the same way.
 */
export interface VenueBudget {
  /** Percent of starting equity that can be lost in one day. */
  dailyLossPct: number
  /** Percent of starting equity that can be lost in total. */
  overallLossPct: number
  /** The most one order may risk, as a percent of equity. */
  perTradeCapPct: number
  /** The most one order may commit, in account currency. */
  maxOrderNotional: number
  /** The most positions open at once. */
  maxOpenPositions: number
}

/** What the UI needs to say honestly about a venue. */
export interface VenueInfo {
  id: VenueId
  name: string
  /** One line a person can read without knowing the industry. */
  whatItIs: string
  /** The blunt version: is any money at stake, and where. */
  moneyAtStake: string
  /** Who supervises it, if anyone. */
  regulator: string
  /** True only for a real-money account. Neither venue here is one. */
  realMoney: boolean
  budget: VenueBudget
}

export const VENUES: Record<VenueId, VenueInfo> = {
  'pivex': {
    id: 'pivex',
    name: 'Pivex',
    whatItIs: 'A practice exam for traders. You pay a fee, you trade a fake balance, and if you hit the targets it may pay you a reward. It is not a broker.',
    moneyAtStake: 'The challenge fee you already paid. The balance on screen is not money: it cannot be withdrawn and it is not yours.',
    regulator: 'None. Its terms say it is not regulated by the CFTC, NFA, SEC, FINRA or any financial authority.',
    realMoney: false,
    budget: { dailyLossPct: 4, overallLossPct: 6, perTradeCapPct: 1, maxOrderNotional: 100_000, maxOpenPositions: 20 },
  },
  'alpaca-paper': {
    id: 'alpaca-paper',
    name: 'Alpaca paper',
    whatItIs: 'A simulated account at a real US broker, filled with real market prices. The fills are simulated; the quotes are not.',
    moneyAtStake: 'Nothing. The account is simulated, and its balance is not money you can withdraw.',
    regulator: 'Alpaca is a real, registered US broker-dealer; this particular account is its paper simulation, not a funded one.',
    realMoney: false,
    budget: { dailyLossPct: 3, overallLossPct: 6, perTradeCapPct: 5, maxOrderNotional: 2_000, maxOpenPositions: 5 },
  },
}

export interface VenueAccount {
  venue: VenueId
  /** Call it what the venue calls it, but never present it as money. */
  equity: number
  cash: number | null
  /** Today's change as a percent of the previous close. */
  dayPnlPct: number
  /** Change since the account started, as a percent. */
  overallPnlPct: number
  currency: string
  positions: VenuePosition[]
  /** Plain words about anything the user should know about this reading. */
  notes: string[]
  readAt: string
}

export interface VenuePosition {
  symbol: string
  side: 'long' | 'short' | 'flat'
  size: number
  avgEntryPrice: number
  currentPrice: number
  unrealizedPl: number
  unrealizedPlPct: number
  /** Share of the account this position represents, in percent. */
  exposurePct: number
}

export interface VenueQuote {
  symbol: string
  bid: number | null
  ask: number | null
  /** Ask minus bid, in the instrument's own price units. */
  spread: number | null
  /** The spread as a percentage of the mid price, which is what it costs you. */
  spreadPct: number | null
  asOf: string
}

/** An order worked out but NOT sent. It expires, and it can be sent once. */
export interface VenueTicket {
  id: string
  venue: VenueId
  createdAt: string
  expiresAt: string
  symbol: string
  side: 'buy' | 'sell'
  /** Units. For Pivex this is lots; for Alpaca paper it is shares or a dollar amount. */
  size: number
  sizeUnit: 'lots' | 'shares' | 'notional'
  orderType: 'market' | 'limit'
  limitPrice: number | null
  estimatedPrice: number
  estimatedNotional: number
  /** Plain words shown with the approval request, exactly what will be sent. */
  confirmation: string
  /** Every risk rule this order was checked against and passed. */
  checks: string[]
  /** Why, in the user's words, kept with the trade forever. */
  reason: string
  /** True once it has been approved and sent, so it can never be sent again. */
  spent: boolean
}

export interface VenueSendResult {
  ok: boolean
  /** What the venue or the gate said. Always plain words. */
  message: string
  /** The venue's own id for the order, when it gave one. */
  venueOrderId: string | null
  /** True when the gate refused it, as opposed to the venue rejecting it. */
  refusedByGate: boolean
}

/** One closed trade, as the journal records it. */
export interface TradeRecord {
  id: string
  venue: VenueId
  symbol: string
  side: 'buy' | 'sell'
  size: number
  sizeUnit: 'lots' | 'shares' | 'notional'
  entryPrice: number
  exitPrice: number | null
  /** Total profit or loss in the account's simulated units. */
  pnl: number | null
  pnlPct: number | null
  /** The reason given when the trade was opened. Never rewritten afterwards. */
  reason: string
  openedAt: string
  closedAt: string | null
  ticketId: string
  venueOrderId: string | null
}

/**
 * What the learning loop says about a venue's numbers.
 *
 * `verdict` is `too-few-trades` until the sample is large enough for the numbers to mean
 * anything, and the headline says so in those words rather than quoting a flattering
 * average from five trades.
 */
export interface LoopStats {
  venue: VenueId
  closedTrades: number
  wins: number
  losses: number
  winRate: number | null
  avgWin: number | null
  avgLoss: number | null
  /** Average win divided by average loss. Null when there is no loss to divide by. */
  winLossRatio: number | null
  /** Average result per trade: the number that decides whether a system works. */
  expectancy: number | null
  totalPnl: number
  verdict: 'too-few-trades' | 'negative' | 'break-even' | 'positive'
  headline: string
  findings: string[]
}

export const MIN_TRADES_FOR_STATS = 20
