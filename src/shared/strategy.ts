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

export interface BacktestConfig {
  strategyId: StrategyId
  params: StrategyParams
  startingCapital: number
  /** Dollars per share, charged on entry and on exit. */
  commissionPerShare: number
  /** Adverse price move on every fill, in basis points (10 = 0.10%). */
  slippageBps: number
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
  slippageBps: number
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
