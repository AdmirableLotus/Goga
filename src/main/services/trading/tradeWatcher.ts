import fs from 'fs'
import path from 'path'
import type { AccountView, Position } from './paperTrading'

/**
 * Trade watcher: keeps an eye on the Alpaca PAPER account while Goga runs (asleep in the tray
 * too — crypto trades around the clock). It never places or cancels trades; it tells the user
 * what changed and what breaks their own risk rules, and keeps score so practice turns into
 * lessons (win rate, average win vs. loss, drawdown).
 */

export type WatchSeverity = 'info' | 'warning' | 'danger' | 'summary'
export interface WatchAlert { severity: WatchSeverity; title: string; detail: string }

export interface WatchRules {
  /** No new positions after the account is down this percent today (the user's own limit). */
  dailyLossPct: number
  /** Warn once when an open position is down this percent. */
  positionLossPct: number
  /** Suggest protecting profit once a position is up this percent. */
  positionGainPct: number
  /** Warn once when the account falls this far below its best value. */
  drawdownPct: number
}

export const DEFAULT_WATCH_RULES: WatchRules = { dailyLossPct: 3, positionLossPct: 5, positionGainPct: 10, drawdownPct: 10 }

interface SeenPosition { qty: number; avgPrice: number; price: number; pnl: number; pnlPct: number }
export interface ClosedTrade { symbol: string; pnl: number; pnlPct: number; closedAt: string }

export interface WatchState {
  positions: Record<string, SeenPosition>
  /** Alerts already given, so each is said once (cleared when the condition goes away). */
  fired: string[]
  peakEquity: number
  equityByDay: Record<string, number>
  closed: ClosedTrade[]
  lastSummaryDay?: string
}

/** The user's calendar day (not UTC), so "today" and the evening summary match their clock. */
export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const key = (symbol: string) => symbol.replace('/', '').toUpperCase()
const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

/** Whether an open order on this symbol is a stop that protects it. */
function isProtected(p: Position, openOrders: string[]): boolean {
  return openOrders.some(o => key(o).includes(key(p.symbol)) && /\bstop\b/i.test(o))
}

/** Practice statistics from closed trades — what the coach teaches from. */
export function tradeStats(closed: ClosedTrade[]) {
  const wins = closed.filter(t => t.pnl > 0), losses = closed.filter(t => t.pnl <= 0)
  const avg = (xs: ClosedTrade[]) => xs.length ? xs.reduce((s, t) => s + t.pnl, 0) / xs.length : 0
  return { trades: closed.length, winRate: closed.length ? wins.length / closed.length * 100 : 0, avgWin: avg(wins), avgLoss: avg(losses) }
}

/** One plain lesson from the record so far ('' when there isn't enough to say anything honest). */
export function lesson(closed: ClosedTrade[]): string {
  const s = tradeStats(closed)
  if (s.trades < 5) return `Only ${s.trades} closed trade${s.trades === 1 ? '' : 's'} so far — too few to judge a strategy. Keep each one small and journaled.`
  if (s.avgLoss && Math.abs(s.avgLoss) > s.avgWin * 1.2) return `Your average loss (${money(s.avgLoss)}) is bigger than your average win (${money(s.avgWin)}). That usually means stops are moved or skipped, or winners are cut early — let the plan's 2:1 target work.`
  if (s.winRate < 35) return `Only ${s.winRate.toFixed(0)}% of trades win. That can still work if winners are much bigger than losers, but check that entries follow the plan, not a hunch.`
  return `${s.winRate.toFixed(0)}% of trades win and the average win (${money(s.avgWin)}) beats the average loss (${money(s.avgLoss)}). That's the shape of a working process — stay consistent.`
}

/**
 * Compare the account now with what was seen before. Pure: returns the alerts to give and the
 * new state. `now` is passed in so days and summaries are testable.
 */
export function watchAccount(prev: WatchState | undefined, view: AccountView, rules: WatchRules, now: Date): { alerts: WatchAlert[]; state: WatchState } {
  const day = localDay(now)
  const positions: Record<string, SeenPosition> = {}
  for (const p of view.positions) positions[key(p.symbol)] = { qty: p.qty, avgPrice: p.avgPrice, price: p.price, pnl: p.pnl, pnlPct: p.pnlPct }

  const state: WatchState = {
    positions,
    fired: [],
    peakEquity: Math.max(prev?.peakEquity ?? 0, view.equity),
    equityByDay: { ...(prev?.equityByDay ?? {}), [day]: view.equity },
    closed: [...(prev?.closed ?? [])],
    lastSummaryDay: prev?.lastSummaryDay,
  }
  // Keep about four months of daily values.
  const days = Object.keys(state.equityByDay).sort()
  for (const d of days.slice(0, Math.max(0, days.length - 120))) delete state.equityByDay[d]

  // First look: remember everything, say nothing.
  if (!prev) return { alerts: [], state }

  const alerts: WatchAlert[] = []
  const wasFired = new Set(prev.fired)
  const fire = (id: string, alert: WatchAlert) => { state.fired.push(id); if (!wasFired.has(id)) alerts.push(alert) }

  // Positions opened and closed.
  for (const p of view.positions) {
    if (!prev.positions[key(p.symbol)]) {
      alerts.push({ severity: 'info', title: `New position: ${p.symbol}`, detail: `${p.qty} at ${money(p.avgPrice)} (now ${money(p.price)}).` })
    }
  }
  for (const [sym, was] of Object.entries(prev.positions)) {
    if (positions[sym]) continue
    state.closed.push({ symbol: sym, pnl: was.pnl, pnlPct: was.pnlPct, closedAt: now.toISOString() })
    if (state.closed.length > 500) state.closed.shift()
    alerts.push({
      severity: 'info', title: `Position closed: ${sym}`,
      detail: `Last seen ${money(was.pnl)} (${pct(was.pnlPct)}) — likely the stop or the target filled. Write one line in the journal: what went right or wrong?`,
    })
  }

  for (const p of view.positions) {
    const sym = key(p.symbol)
    if (!isProtected(p, view.openOrders)) {
      fire(`unprotected:${sym}`, { severity: 'warning', title: `${p.symbol} has no stop`, detail: `No open stop order protects this position (${p.qty} held, ${pct(p.pnlPct)}). Your rule is a stop on every trade — ask me for a plan to set one.` })
    }
    if (p.pnlPct <= -rules.positionLossPct * 2) {
      fire(`loss2:${sym}`, { severity: 'danger', title: `${p.symbol} is down ${Math.abs(p.pnlPct).toFixed(1)}%`, detail: `${money(p.pnl)} on this position. Losses this large usually mean the stop is missing or was moved.` })
    } else if (p.pnlPct <= -rules.positionLossPct) {
      fire(`loss:${sym}`, { severity: 'warning', title: `${p.symbol} is down ${Math.abs(p.pnlPct).toFixed(1)}%`, detail: `${money(p.pnl)}. Check that the stop is where your plan put it — don't widen it.` })
    }
    if (p.pnlPct >= rules.positionGainPct) {
      fire(`gain:${sym}`, { severity: 'info', title: `${p.symbol} is up ${p.pnlPct.toFixed(1)}%`, detail: `${money(p.pnl)} unrealized. Consider moving the stop up to your entry (${money(p.avgPrice)}) so this can't turn into a loss.` })
    }
  }

  if (view.dayPnlPct <= -rules.dailyLossPct) {
    fire(`daily:${day}`, { severity: 'danger', title: `Down ${Math.abs(view.dayPnlPct).toFixed(1)}% today`, detail: `That's past your ${rules.dailyLossPct}% daily loss limit. No new positions until tomorrow — this rule is what protects the account.` })
  }

  const drawdown = state.peakEquity > 0 ? (1 - view.equity / state.peakEquity) * 100 : 0
  if (drawdown >= rules.drawdownPct) {
    fire('drawdown', { severity: 'warning', title: `Account ${drawdown.toFixed(1)}% below its best`, detail: `Best ${money(state.peakEquity)}, now ${money(view.equity)}. A good time to pause, shrink position size, and review the journal before the next trade.` })
  }

  // A short end-of-day review, once a day after the US market closes (5 pm local or later).
  if (now.getHours() >= 17 && prev.lastSummaryDay !== day) {
    state.lastSummaryDay = day
    const start = state.equityByDay[Object.keys(state.equityByDay).sort()[0]]
    const open = view.positions.length
      ? view.positions.map(p => `${p.symbol} ${pct(p.pnlPct)}`).join(', ')
      : 'none'
    alerts.push({
      severity: 'summary', title: 'Trading practice — end of day',
      detail: `Account ${money(view.equity)} (${pct(view.dayPnlPct)} today${start ? `, ${pct((view.equity / start - 1) * 100)} since I started watching` : ''}). Open positions: ${open}. ${lesson(state.closed)}`,
    })
  }

  return { alerts, state }
}

export interface TradeWatcherDeps {
  dir: string
  account: () => Promise<AccountView | null>
  rules: () => WatchRules
  enabled: () => boolean
  onAlert: (alert: WatchAlert) => void
  log: { info: (m: string) => void; warn: (m: string) => void }
  now?: () => Date
}

const FIRST_CHECK_MS = 60_000
const CHECK_EVERY_MS = 5 * 60_000

export class TradeWatcher {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false

  constructor(private deps: TradeWatcherDeps) {}

  private get stateFile() { return path.join(this.deps.dir, 'trade-watch.json') }

  start(): void {
    if (this.timer) return
    this.deps.log.info('Trade watcher: watching the paper account')
    this.schedule(FIRST_CHECK_MS)
  }

  stop(): void { clearTimeout(this.timer); this.timer = undefined }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => { void this.check().finally(() => { if (this.timer) this.schedule(CHECK_EVERY_MS) }) }, ms)
    this.timer.unref?.()
  }

  /** One look at the account. Never throws; no keys or no network just means no look. */
  async check(): Promise<WatchAlert[]> {
    if (this.running || !this.deps.enabled()) return []
    this.running = true
    try {
      const view = await this.deps.account()
      if (!view) return []
      let prev: WatchState | undefined
      try { prev = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) } catch { /* first look */ }
      const { alerts, state } = watchAccount(prev, view, this.deps.rules(), this.deps.now?.() ?? new Date())
      fs.writeFileSync(this.stateFile, JSON.stringify(state), { mode: 0o600 })
      if (!prev) this.deps.log.info(`Trade watcher: baseline — equity ${view.equity}, ${view.positions.length} position(s)`)
      for (const alert of alerts) {
        this.deps.log.info(`Trade watcher: ${alert.title} — ${alert.detail}`)
        this.deps.onAlert(alert)
      }
      return alerts
    } catch (err) {
      this.deps.log.warn(`Trade watcher check failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    } finally {
      this.running = false
    }
  }
}
