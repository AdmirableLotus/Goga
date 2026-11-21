/**
 * Strategy, backtest, journal and review types.
 *
 * Everything here is plain data. The strategy rules themselves live in
 * `src/main/services/strategy/engine.ts` and are pure functions over bars, so the same
 * code decides a backtest trade and a paper trade. Nothing in this file places an order.
 */

export interface Bar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

export type StrategyId = 'sma-cross' | 'breakout' | 'mean-reversion'

export interface StrategyParamSpec {
  key: string
  label: string
  default: number
  min: number
  max: number
  step: number
  help: string
}

export interface StrategyDefinition {
  id: StrategyId
  name: string
  summary: string
  /** The exact entry rule, in words, matching the code. */
  entryRule: string
  /** The exact exit rule, in words, matching the code. */
  exitRule: string
  params: StrategyParamSpec[]
  /** How many shares to buy, in words, matching `sizePosition`. */
  sizing: string
}

export type StrategyParams = Record<string, number>

export interface Signal {
  /** Index of the bar whose CLOSE produced this decision. */
  index: number
  action: 'enter' | 'exit'
  reason: string
}

export interface Trade {
  entryIndex: number
  entryTime: string
  entryPrice: number
  exitIndex: number
  exitTime: string
  exitPrice: number
  qty: number
  /** Dollars, after commission on both sides. */
  pnl: number
  /** Fraction of the money committed to the trade (0.05 = +5%). */
  pnlPct: number
  barsHeld: number
  exitReason: 'signal' | 'stop' | 'end-of-test'
}

/**
 * How trading fees are charged in a backtest.
 *   - 'per-share': a fixed dollar amount per share on each side — the right shape for US
 *     equities (e.g. $0.005/share). On crypto this is near-zero and understates real cost.
 *   - 'percent': a percent of the fill's notional value on each side, in basis points — the
 *     right shape for crypto exchanges (e.g. 10 bps = 0.10% taker).
 * Default is 'per-share', so existing stock backtests are unchanged.
 */
export type FeeMode = 'per-share' | 'percent'

export interface BacktestConfig {
  strategyId: StrategyId
  params: StrategyParams
  startingCapital: number
  /** Dollars per share, charged on entry and on exit. Used when feeMode is 'per-share'. */
  commissionPerShare: number
  /** How fees are charged. Omitted means 'per-share' (the historical default). */
  feeMode?: FeeMode
  /** Fee as basis points of notional on each side, used only when feeMode is 'percent' (10 = 0.10%). */
  feeBps?: number
  /** Adverse price move on every fill, in basis points (10 = 0.10%). */
  slippageBps: number
  /**
   * Bid/ask spread in basis points (the full spread, e.g. 20 = 0.20%). A buy fills half the
   * spread above the mid and a sell half below it, so one round trip pays the full spread. This
   * is a separate cost from `slippageBps` (price impact) and from fees. Omitted means 0 — the
   * documented default — which models no spread and understates real cost, especially on crypto.
   */
  spreadBps?: number
  /** Percent of equity risked between entry and the ATR stop. */
  riskPct: number
  /** Hard cap: percent of equity in one position. */
  maxPositionPct: number
  /** Stop distance in ATRs. 0 turns the stop off. */
  stopAtrMultiple: number
  atrPeriod: number
}

export interface BacktestResult {
  strategyId: StrategyId
  symbol: string
  barCount: number
  from: string
  to: string
  startingCapital: number
  endingEquity: number
  totalReturn: number
  buyHoldReturn: number
  maxDrawdown: number
  winRate: number
  avgWin: number
  avgLoss: number
  profitFactor: number
  tradeCount: number
  exposure: number
  /** The bid/ask spread assumption used, in basis points. */
  spreadBps: number
  /** Total fees charged across all fills (entry + exit), in account currency. */
  totalFees: number
  /** Total cost attributable to the bid/ask spread across all fills, reported separately from fees. */
  totalSpreadCost: number
  trades: Trade[]
  equityCurve: { t: string; equity: number }[]
  /** What the numbers assume. Shown in the UI next to the result. */
  assumptions: string[]
  warnings: string[]
  /** Where the bars came from: real Alpaca data, a saved copy, or a synthetic sample. */
  dataSource: 'alpaca' | 'cache' | 'synthetic'
  dataNote: string
}

export type JournalKind =
  | 'signal' | 'intent' | 'auto-approved' | 'awaiting-approval'
  | 'sent' | 'refused' | 'exit' | 'note'

export interface JournalEntry {
  id: string
  time: string
  strategyId: string
  symbol: string
  mode: 'paper' | 'live'
  kind: JournalKind
  side: 'buy' | 'sell' | null
  qty: number | null
  price: number | null
  /** Realised dollars, only on an `exit` entry. */
  pnl: number | null
  /** Realised fraction of the money committed, only on an `exit` entry. */
  pnlPct: number | null
  reason: string
  intentId: string | null
  orderId: string | null
}

export interface StrategySummary {
  strategyId: string
  symbol: string
  closedTrades: number
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  avgWin: number
  avgLoss: number
  avgPnlPct: number
  lastTradeAt: string | null
}

export interface StrategySettings {
  /** The paper run loop is off until the user turns it on. */
  paperRunEnabled: boolean
  /**
   * Paper orders the loop prepares are sent without a click. Off by default; it can
   * never apply to a live order.
   */
  autoApprovePaper: boolean
  strategyId: StrategyId
  symbol: string
  params: StrategyParams
  intervalMinutes: number
  riskPct: number
  maxPositionPct: number
  commissionPerShare: number
  /** How fees are charged for this symbol's backtests and the paper loop. Defaults to 'per-share'. */
  feeMode: FeeMode
  /** Fee in basis points of notional, used only when feeMode is 'percent' (10 = 0.10%). */
  feeBps: number
  slippageBps: number
  /** Bid/ask spread in basis points (full spread; half is paid on each fill). Default 0. */
  spreadBps: number
  stopAtrMultiple: number
  atrPeriod: number
  startingCapital: number
}

export interface PaperRunState {
  enabled: boolean
  autoApprovePaper: boolean
  running: boolean
  lastRunAt: string | null
  lastResult: string | null
  /** An intent the loop prepared and is waiting for the user to approve. */
  pendingIntent: { intentId: string; symbol: string; side: 'buy' | 'sell'; confirmation: string; expiresAt: string } | null
  nextRunAt: string | null
}

export type ReviewVerdict = 'too-few-trades' | 'in-line' | 'weaker' | 'diverging' | 'better'

export interface ReviewResult {
  strategyId: string
  symbol: string
  verdict: ReviewVerdict
  headline: string
  findings: string[]
  backtest: { tradeCount: number; winRate: number; avgTradePct: number; totalReturn: number } | null
  live: { tradeCount: number; winRate: number; avgTradePct: number; totalReturn: number }
}

export interface StrategyPageState {
  strategies: StrategyDefinition[]
  settings: StrategySettings
  paperRun: PaperRunState
  summaries: StrategySummary[]
  journal: JournalEntry[]
  /** The most recent backtest saved for each strategy+symbol, used by the review. */
  baselines: { strategyId: string; symbol: string; at: string; tradeCount: number; winRate: number; avgTradePct: number; totalReturn: number }[]
  paperKeyStored: boolean
}
