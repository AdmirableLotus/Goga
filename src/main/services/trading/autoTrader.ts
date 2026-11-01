import fs from 'fs'
import path from 'path'
import { backtest, inMarketSeries, type BacktestResult, type Bar, type Strategy } from './indicators'
import { tradePlan } from './tradePlan'
import type { Timeframe } from './marketData'
import type { AccountView, OrderRequest } from './paperTrading'
import { localDay, type WatchAlert } from './tradeWatcher'

/**
 * Auto-trader: Goga trades the Alpaca PAPER account on his own, to learn. Every decision is
 * rule-based (no language model guessing): for each symbol he backtests a few strategies on
 * real bars, keeps the best one that made money, and buys only on a fresh signal from it —
 * with a 2×ATR stop, a 2R target and a small, fixed risk. His own closed trades teach him:
 * a strategy that loses money live is dropped, and a symbol that keeps losing is benched.
 * The user's own positions are never touched.
 */

export type AutoMarket = 'stock' | 'crypto'
export interface WatchSymbol { symbol: string; market: AutoMarket }

export const WATCHLIST: WatchSymbol[] = [
  ...['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META'].map(symbol => ({ symbol, market: 'stock' as const })),
  ...['BTC/USD', 'ETH/USD', 'SOL/USD'].map(symbol => ({ symbol, market: 'crypto' as const })),
]
/** Stocks on daily bars; crypto never closes, so hourly bars give it more practice. */
export const TIMEFRAME: Record<AutoMarket, Timeframe> = { stock: '1Day', crypto: '1Hour' }
const STRATEGIES: Strategy[] = ['sma-cross', 'rsi-reversion', 'breakout']

export interface AutoRules {
  /** Percent of the account lost if a stop is hit. */
  riskPct: number
  /** Most positions Goga holds at once. */
  maxOpen: number
  maxPositionPct: number
  dailyLossPct: number
  /** Losses in a row on one symbol before it is benched, and for how long. */
  benchAfterLosses: number
  benchDays: number
}

export const DEFAULT_AUTO_RULES: AutoRules = { riskPct: 0.5, maxOpen: 3, maxPositionPct: 10, dailyLossPct: 3, benchAfterLosses: 2, benchDays: 7 }

export interface AutoPosition { symbol: string; market: AutoMarket; strategy: Strategy; entry: number; stop: number; target: number; qty: number; openedAt: string; lastPnl: number; lastPnlPct: number }
export interface AutoClosed { symbol: string; strategy: Strategy; pnl: number; pnlPct: number; closedAt: string; why: string }
export interface AutoState { open: Record<string, AutoPosition>; closed: AutoClosed[]; benched: Record<string, string>; lastSummaryDay?: string }

export interface Look { symbol: string; market: AutoMarket; bars: Bar[] }
export interface AutoInput { account: AccountView; looks: Look[]; state: AutoState; rules: AutoRules; stockOpen: boolean; now: Date }

export type AutoAction =
  | { kind: 'buy'; position: AutoPosition; order: OrderRequest; why: string }
  | { kind: 'sell'; symbol: string; why: string }

export const emptyAutoState = (): AutoState => ({ open: {}, closed: [], benched: {} })
const key = (symbol: string) => symbol.replace('/', '').toUpperCase()
const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

/** Goga's own live record with one strategy. */
export function strategyRecord(closed: AutoClosed[], strategy: Strategy) {
  const mine = closed.filter(t => t.strategy === strategy)
  return { trades: mine.length, pnl: mine.reduce((s, t) => s + t.pnl, 0), wins: mine.filter(t => t.pnl > 0).length }
}

/**
 * The strategy to trade this symbol with: the backtest winner by return per unit of drawdown,
 * among those that made money over at least 5 trades and haven't lost money for Goga live.
 */
export function chooseStrategy(bars: Bar[], closed: AutoClosed[]): { strategy: Strategy; test: BacktestResult } | null {
  let best: { strategy: Strategy; test: BacktestResult } | null = null
  let bestScore = -Infinity
  for (const strategy of STRATEGIES) {
    const live = strategyRecord(closed, strategy)
    if (live.trades >= 5 && live.pnl < 0) continue
    const test = backtest(bars, strategy)
    if (test.trades < 5 || test.totalReturn <= 0 || test.avgTrade <= 0) continue
    const score = test.totalReturn / (test.maxDrawdown + 0.05)
    if (score > bestScore) { best = { strategy, test }; bestScore = score }
  }
  return best
}

/** The strategy switched to "hold" within the last two bars (not a trend that's been running for weeks). */
function freshBuy(series: boolean[]): boolean {
  return series.length >= 3 && series[series.length - 1] && series.slice(-3).includes(false)
}

/** Losses in a row at the end of one symbol's record. */
function lossStreak(closed: AutoClosed[], sym: string): number {
  let n = 0
  for (const t of [...closed].reverse().filter(t => key(t.symbol) === sym)) { if (t.pnl > 0) break; n++ }
  return n
}

/**
 * One round of decisions. Pure: returns what to sell and buy and the state with closures
 * already recorded. New buys are added to the state by the caller only once they are placed.
 */
export function decide(input: AutoInput): { actions: AutoAction[]; state: AutoState } {
  const { account, looks, rules, stockOpen, now } = input
  const state: AutoState = { open: { ...input.state.open }, closed: [...input.state.closed], benched: { ...input.state.benched }, lastSummaryDay: input.state.lastSummaryDay }
  const held = new Map(account.positions.map(p => [key(p.symbol), p]))
  const actions: AutoAction[] = []

  // Positions Goga opened: gone means the stop or target filled at the broker.
  for (const [sym, pos] of Object.entries(state.open)) {
    const p = held.get(sym)
    if (p) { state.open[sym] = { ...pos, lastPnl: p.pnl, lastPnlPct: p.pnlPct }; continue }
    recordClose(state, pos, pos.lastPnl, pos.lastPnlPct, now, pos.lastPnl > 0 ? 'target filled' : 'stop filled', rules)
  }
  for (const [sym, until] of Object.entries(state.benched)) if (new Date(until) <= now) delete state.benched[sym]

  // Exits: target reached, or the strategy no longer wants to hold.
  const lookFor = new Map(looks.map(l => [key(l.symbol), l]))
  for (const [sym, pos] of Object.entries(state.open)) {
    const look = lookFor.get(sym)
    const p = held.get(sym)
    if (!look || !p || (pos.market === 'stock' && !stockOpen)) continue
    if (p.price >= pos.target) actions.push({ kind: 'sell', symbol: pos.symbol, why: `target ${pos.target} reached` })
    else if (!inMarketSeries(look.bars, pos.strategy).at(-1)) actions.push({ kind: 'sell', symbol: pos.symbol, why: `${pos.strategy} signalled an exit` })
  }

  // Entries.
  const selling = new Set(actions.flatMap(a => a.kind === 'sell' ? [key(a.symbol)] : []))
  let open = Object.keys(state.open).filter(s => !selling.has(s)).length
  if (account.dayPnlPct <= -rules.dailyLossPct) return { actions, state }
  let cash = account.cash
  const ideas = looks.flatMap(look => {
    const sym = key(look.symbol)
    if (held.has(sym) || state.benched[sym] || (look.market === 'stock' && !stockOpen) || look.bars.length < 60) return []
    const pick = chooseStrategy(look.bars, state.closed)
    if (!pick || !freshBuy(inMarketSeries(look.bars, pick.strategy))) return []
    return [{ look, ...pick }]
  }).sort((a, b) => b.test.totalReturn - a.test.totalReturn)

  for (const { look, strategy, test } of ideas) {
    if (open >= rules.maxOpen) break
    let plan
    try { plan = tradePlan(look.symbol, look.bars, 'buy', { equity: account.equity, riskPct: rules.riskPct, maxPositionPct: rules.maxPositionPct }) } catch { continue }
    const qty = look.market === 'stock' ? Math.floor(plan.suggestedQty) : plan.suggestedQty
    const value = qty * plan.entry
    if (!(qty > 0) || value > cash) continue
    // Whole cents: Alpaca refuses sub-penny stop and target prices.
    const stop = Math.round(plan.stop * 100) / 100
    const target = Math.round(plan.targets[1].price * 100) / 100
    if (!(stop > 0 && stop < plan.entry)) continue
    const why = `${strategy} signal (${STRATEGIES_TEXT[strategy]}); backtest ${pct(test.totalReturn * 100)} over ${test.trades} trades, ${Math.round(test.winRate * 100)}% winners`
    actions.push({
      kind: 'buy', why,
      position: { symbol: look.symbol, market: look.market, strategy, entry: plan.entry, stop, target, qty, openedAt: now.toISOString(), lastPnl: 0, lastPnlPct: 0 },
      order: { symbol: look.symbol, side: 'buy', qty, stopPrice: stop, takeProfit: target, reason: `Goga auto-trade (learning): ${why}` },
    })
    cash -= value
    open++
  }
  return { actions, state }
}

const STRATEGIES_TEXT: Record<Strategy, string> = {
  'sma-cross': '20-bar average crossed above the 50',
  'rsi-reversion': 'RSI dipped below 30',
  'breakout': 'closed above the 20-bar high',
  'buy-and-hold': 'hold',
}

/** Move a position to the record, and bench its symbol after a losing streak. */
export function recordClose(state: AutoState, pos: AutoPosition, pnl: number, pnlPct: number, now: Date, why: string, rules: AutoRules): void {
  const sym = key(pos.symbol)
  delete state.open[sym]
  state.closed.push({ symbol: pos.symbol, strategy: pos.strategy, pnl, pnlPct, closedAt: now.toISOString(), why })
  if (state.closed.length > 500) state.closed.shift()
  if (lossStreak(state.closed, sym) >= rules.benchAfterLosses) {
    state.benched[sym] = new Date(now.getTime() + rules.benchDays * 86_400_000).toISOString()
  }
}

/** What Goga has learned so far, strategy by strategy. */
export function learningReport(state: AutoState): string {
  if (!state.closed.length) return 'No auto-trades have closed yet, so there is nothing to learn from yet.'
  const total = state.closed.reduce((s, t) => s + t.pnl, 0)
  const lines = STRATEGIES.map(s => ({ s, r: strategyRecord(state.closed, s) })).filter(x => x.r.trades)
    .map(({ s, r }) => `${s}: ${r.trades} trades, ${r.wins} won, ${money(r.pnl)}${r.trades >= 5 && r.pnl < 0 ? ' — dropped, it loses money live' : ''}`)
  const benched = Object.keys(state.benched)
  return `${state.closed.length} auto-trades closed, ${money(total)} in total. ${lines.join('; ')}.${benched.length ? ` Benched after losing streaks: ${benched.join(', ')}.` : ''}`
}

export interface AutoTraderDeps {
  dir: string
  enabled: () => boolean
  rules: () => AutoRules
  account: () => Promise<AccountView | null>
  bars: (symbol: string, tf: Timeframe) => Promise<Bar[]>
  stockOpen: () => Promise<boolean>
  order: (req: OrderRequest) => Promise<string>
  close: (symbol: string, reason: string) => Promise<string>
  onTrade: (alert: WatchAlert) => void
  log: { info: (m: string) => void; warn: (m: string) => void }
  now?: () => Date
}

const FIRST_RUN_MS = 2 * 60_000
const RUN_EVERY_MS = 15 * 60_000

export class AutoTrader {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false

  constructor(private deps: AutoTraderDeps) {}

  private get stateFile() { return path.join(this.deps.dir, 'auto-trades.json') }

  start(): void {
    if (this.timer) return
    this.deps.log.info('Auto-trader: ready (paper account only)')
    this.schedule(FIRST_RUN_MS)
  }

  stop(): void { clearTimeout(this.timer); this.timer = undefined }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => { void this.run().finally(() => { if (this.timer) this.schedule(RUN_EVERY_MS) }) }, ms)
    this.timer.unref?.()
  }

  readState(): AutoState {
    try { return { ...emptyAutoState(), ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) } } catch { return emptyAutoState() }
  }

  private save(state: AutoState): void {
    fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 })
  }

  /** One round: look, decide, act. Never throws. */
  async run(): Promise<AutoAction[]> {
    if (this.running || !this.deps.enabled()) return []
    this.running = true
    try {
      const account = await this.deps.account()
      if (!account) return []
      const now = this.deps.now?.() ?? new Date()
      const rules = this.deps.rules()
      const stockOpen = await this.deps.stockOpen().catch(() => false)
      const looks: Look[] = []
      for (const w of WATCHLIST) {
        try { looks.push({ ...w, bars: await this.deps.bars(w.symbol, TIMEFRAME[w.market]) }) } catch (err) {
          this.deps.log.warn(`Auto-trader: no bars for ${w.symbol} (${err instanceof Error ? err.message : String(err)})`)
        }
      }
      const { actions, state } = decide({ account, looks, state: this.readState(), rules, stockOpen, now })
      const done: AutoAction[] = []
      for (const action of actions) {
        try {
          if (action.kind === 'sell') {
            const pos = state.open[key(action.symbol)]
            const result = await this.deps.close(action.symbol, `Goga auto-trade exit: ${action.why}`)
            recordClose(state, pos, pos.lastPnl, pos.lastPnlPct, now, action.why, rules)
            this.tell('info', `I sold ${action.symbol}`, `${action.why}. ${result} Result about ${money(pos.lastPnl)} (${pct(pos.lastPnlPct)}).`)
          } else {
            const result = await this.deps.order(action.order)
            state.open[key(action.position.symbol)] = action.position
            const p = action.position
            this.tell('info', `I bought ${p.symbol}`, `${p.qty} at about ${money(p.entry)}, stop ${money(p.stop)}, target ${money(p.target)} — risking about ${rules.riskPct}% of the account. Why: ${action.why}. ${result}`)
          }
          done.push(action)
        } catch (err) {
          this.deps.log.warn(`Auto-trader: ${action.kind} ${action.kind === 'buy' ? action.position.symbol : action.symbol} failed — ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const day = localDay(now)
      if (now.getHours() >= 17 && state.lastSummaryDay !== day) {
        state.lastSummaryDay = day
        const open = Object.values(state.open).map(p => `${p.symbol} ${pct(p.lastPnlPct)}`).join(', ') || 'none'
        this.tell('summary', 'What I learned trading today', `My open positions: ${open}. ${learningReport(state)}`)
      }
      this.save(state)
      this.deps.log.info(`Auto-trader: looked at ${looks.length} symbols, ${done.length} trade(s), ${Object.keys(state.open).length} open`)
      return done
    } catch (err) {
      this.deps.log.warn(`Auto-trader round failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    } finally {
      this.running = false
    }
  }

  private tell(severity: WatchAlert['severity'], title: string, detail: string): void {
    this.deps.log.info(`Auto-trader: ${title} — ${detail}`)
    this.deps.onTrade({ severity, title, detail })
  }
}
