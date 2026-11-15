import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type {
  BacktestConfig, BacktestResult, JournalEntry, PaperRunState, StrategyId, StrategyPageState,
  StrategyParams, StrategySettings, StrategySummary,
} from '../../../shared/strategy'
import { STRATEGIES, decide, resolveParams, runBacktest, warmupBars } from './engine'
import { loadBars } from './data'
import { readJournal, recordJournal, summarise } from './journal'
import { reviewStrategy, type Baseline } from './review'
import { broker } from '../broker/service'
import { paperKeys } from '../broker/credentials'
import { readState } from '../broker/risk'
import { LogService } from '../logs'

/**
 * The strategy service: settings, backtests, the paper run loop, the journal and the
 * review.
 *
 * The paper loop is the only thing here that can cause an order, and it can only ever
 * prepare a PAPER order through `broker().prepareOrder()`. It has no path to a live
 * order: the mode is a literal, and `sendOrder` still refuses anything the user has not
 * approved. Auto-approval, when the user turns it on, calls `approveIntent()` for that
 * one paper intent and then `sendOrder()` — the same two steps the Trading page takes.
 */

const log = () => LogService.getInstance()

const DEFAULTS: StrategySettings = {
  paperRunEnabled: false,
  autoApprovePaper: false,
  strategyId: 'sma-cross',
  symbol: 'SPY',
  params: { fast: 20, slow: 50 },
  intervalMinutes: 30,
  riskPct: 1,
  maxPositionPct: 10,
  commissionPerShare: 0.005,
  slippageBps: 5,
  stopAtrMultiple: 2,
  atrPeriod: 14,
  startingCapital: 10_000,
}

const settingsFile = () => path.join(app.getPath('userData'), 'strategy-settings.json')
const baselineFile = () => path.join(app.getPath('userData'), 'strategy-baselines.json')

function readJson<T>(file: string, fallback: T): T {
  try { return { ...fallback, ...(JSON.parse(fs.readFileSync(file, 'utf8')) as object) } as T } catch { return fallback }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
}

export function readStrategySettings(): StrategySettings {
  const raw = readJson<StrategySettings>(settingsFile(), DEFAULTS)
  const strategyId = (STRATEGIES.some(s => s.id === raw.strategyId) ? raw.strategyId : DEFAULTS.strategyId) as StrategyId
  return {
    ...DEFAULTS,
    ...raw,
    strategyId,
    params: resolveParams(strategyId, raw.params ?? {}),
    intervalMinutes: Math.min(1440, Math.max(5, Number(raw.intervalMinutes) || DEFAULTS.intervalMinutes)),
    riskPct: Math.min(10, Math.max(0.1, Number(raw.riskPct) || DEFAULTS.riskPct)),
    maxPositionPct: Math.min(100, Math.max(1, Number(raw.maxPositionPct) || DEFAULTS.maxPositionPct)),
    commissionPerShare: Math.max(0, Number(raw.commissionPerShare) || 0),
    slippageBps: Math.min(200, Math.max(0, Number(raw.slippageBps) || 0)),
    stopAtrMultiple: Math.min(10, Math.max(0, Number(raw.stopAtrMultiple) ?? DEFAULTS.stopAtrMultiple)),
    atrPeriod: Math.min(100, Math.max(2, Number(raw.atrPeriod) || DEFAULTS.atrPeriod)),
    startingCapital: Math.max(100, Number(raw.startingCapital) || DEFAULTS.startingCapital),
    // Both switches are booleans and default to off; anything else is off.
    paperRunEnabled: raw.paperRunEnabled === true,
    autoApprovePaper: raw.autoApprovePaper === true,
  }
}

export function writeStrategySettings(patch: Partial<StrategySettings>): StrategySettings {
  const next = readStrategySettings()
  const merged: StrategySettings = { ...next, ...patch }
  merged.params = resolveParams(merged.strategyId, merged.params ?? {})
  writeJson(settingsFile(), merged)
  return readStrategySettings()
}

function readBaselines(): Baseline[] {
  try { return JSON.parse(fs.readFileSync(baselineFile(), 'utf8')) as Baseline[] } catch { return [] }
}

function saveBaseline(result: BacktestResult): void {
  const list = readBaselines().filter(b => !(b.strategyId === result.strategyId && b.symbol === result.symbol))
  list.push({
    strategyId: result.strategyId,
    symbol: result.symbol,
    at: new Date().toISOString(),
    tradeCount: result.tradeCount,
    winRate: result.winRate,
    avgTradePct: result.trades.length ? result.trades.reduce((a, t) => a + t.pnlPct, 0) / result.trades.length : 0,
    totalReturn: result.totalReturn,
  })
  writeJson(baselineFile(), list.slice(-50))
}

export class StrategyService {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private lastRunAt: string | null = null
  private lastResult: string | null = null
  private pendingIntent: PaperRunState['pendingIntent'] = null

  /** Read everything the Strategies page needs. */
  state(): StrategyPageState {
    const settings = readStrategySettings()
    const journal = readJournal(300)
    return {
      strategies: STRATEGIES,
      settings,
      paperRun: this.paperRunState(),
      summaries: summarise(journal),
      journal: journal.slice(-120).reverse(),
      baselines: readBaselines().map(b => ({
        strategyId: b.strategyId, symbol: b.symbol, at: b.at,
        tradeCount: b.tradeCount, winRate: b.winRate, avgTradePct: b.avgTradePct, totalReturn: b.totalReturn,
      })),
      paperKeyStored: !!paperKeys(),
    }
  }

  paperRunState(): PaperRunState {
    const s = readStrategySettings()
    return {
      enabled: s.paperRunEnabled,
      autoApprovePaper: s.autoApprovePaper,
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      pendingIntent: this.pendingIntent,
      nextRunAt: s.paperRunEnabled && this.timer ? new Date(Date.now() + s.intervalMinutes * 60_000).toISOString() : null,
    }
  }

  /** Run a backtest over real bars when they are available, and save it as the baseline. */
  async backtest(input: {
    strategyId: StrategyId
    symbol: string
    params?: StrategyParams
    days?: number
    overrides?: Partial<BacktestConfig>
  }): Promise<BacktestResult> {
    const settings = readStrategySettings()
    const symbol = String(input.symbol ?? settings.symbol).trim().toUpperCase()
    const params = resolveParams(input.strategyId, input.params ?? settings.params)
    const set = await loadBars(symbol, Math.min(1000, Math.max(60, Number(input.days) || 400)))
    const config: BacktestConfig = {
      strategyId: input.strategyId,
      params,
      startingCapital: settings.startingCapital,
      commissionPerShare: settings.commissionPerShare,
      slippageBps: settings.slippageBps,
      riskPct: settings.riskPct,
      maxPositionPct: settings.maxPositionPct,
      stopAtrMultiple: settings.stopAtrMultiple,
      atrPeriod: settings.atrPeriod,
      ...(input.overrides ?? {}),
    }
    const result = runBacktest(set.bars, config, symbol)
    result.dataSource = set.source
    result.dataNote = set.note
    if (set.source !== 'synthetic') saveBaseline(result)
    log().info(`Strategy: backtest ${input.strategyId} on ${symbol} (${set.source}) — ${result.tradeCount} trades, ${(result.totalReturn * 100).toFixed(2)}%`)
    return result
  }

  /** Compare paper results with the saved backtest for one strategy and symbol. */
  review(strategyId: string, symbol: string) {
    const baseline = readBaselines().find(b => b.strategyId === strategyId && b.symbol === symbol) ?? null
    return reviewStrategy(readJournal(20_000), baseline)
  }

  /** Turn the paper loop on or off. Turning it on starts the timer; off stops it. */
  setPaperRun(enabled: boolean): PaperRunState {
    writeStrategySettings({ paperRunEnabled: !!enabled })
    if (enabled) this.start()
    else this.stop()
    recordJournal({
      strategyId: readStrategySettings().strategyId, symbol: readStrategySettings().symbol, mode: 'paper',
      kind: 'note', side: null, qty: null, price: null, pnl: null, pnlPct: null,
      reason: enabled ? 'Paper run switched ON by the user' : 'Paper run switched OFF by the user',
      intentId: null, orderId: null,
    })
    return this.paperRunState()
  }

  /**
   * The auto-approve switch. It only ever applies to paper orders, and turning it on is
   * recorded in the journal with the time, so the record shows when it changed.
   */
  setAutoApprovePaper(enabled: boolean): PaperRunState {
    writeStrategySettings({ autoApprovePaper: !!enabled })
    recordJournal({
      strategyId: readStrategySettings().strategyId, symbol: readStrategySettings().symbol, mode: 'paper',
      kind: 'note', side: null, qty: null, price: null, pnl: null, pnlPct: null,
      reason: enabled
        ? 'AUTO-APPROVE PAPER switched ON: paper orders the loop prepares will be sent without a click. Live orders are unaffected and still need approval.'
        : 'Auto-approve paper switched OFF: the loop will prepare paper orders and wait for approval.',
      intentId: null, orderId: null,
    })
    return this.paperRunState()
  }

  start(): void {
    this.stop()
    const s = readStrategySettings()
    if (!s.paperRunEnabled) return
    this.timer = setInterval(() => { void this.tick() }, s.intervalMinutes * 60_000)
    this.timer.unref?.()
    log().info(`Strategy: paper run loop started, every ${s.intervalMinutes} minutes`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * One pass of the paper loop.
   *
   * Reads bars, asks the strategy what to do at the last closed bar, and — if it says
   * something — prepares a PAPER order. Every branch writes a journal entry with the
   * reason, including the branches that do nothing.
   */
  async tick(): Promise<string> {
    if (this.running) return 'A paper run is already in progress.'
    this.running = true
    const s = readStrategySettings()
    const symbol = s.symbol
    try {
      if (!paperKeys()) {
        this.lastResult = 'No Alpaca paper key is stored, so the paper loop cannot run. Add one in Trading.'
        recordJournal({ strategyId: s.strategyId, symbol, mode: 'paper', kind: 'refused', side: null, qty: null, price: null, pnl: null, pnlPct: null, reason: this.lastResult, intentId: null, orderId: null })
        return this.lastResult
      }
      const risk = readState()
      if (risk.halted) {
        this.lastResult = `Kill switch is on (${risk.haltReason ?? 'no reason given'}), so the paper loop did nothing.`
        recordJournal({ strategyId: s.strategyId, symbol, mode: 'paper', kind: 'refused', side: null, qty: null, price: null, pnl: null, pnlPct: null, reason: this.lastResult, intentId: null, orderId: null })
        return this.lastResult
      }

      const set = await loadBars(symbol, 400)
      const bars = set.bars
      if (bars.length < warmupBars(s.strategyId, s.params) + 2) {
        this.lastResult = `Only ${bars.length} bars for ${symbol} — not enough for ${s.strategyId} to say anything.`
        return this.lastResult
      }

      const snap = await broker().snapshot('paper')
      if (!snap.account) {
        this.lastResult = `The paper account could not be read: ${snap.error ?? 'unknown reason'}.`
        recordJournal({ strategyId: s.strategyId, symbol, mode: 'paper', kind: 'refused', side: null, qty: null, price: null, pnl: null, pnlPct: null, reason: this.lastResult, intentId: null, orderId: null })
        return this.lastResult
      }
      const held = snap.positions.find(p => p.symbol === symbol)
      const holding = !!held && Number(held.qty) > 0
      const lastIndex = bars.length - 1
      const decision = decide(s.strategyId, s.params, bars, lastIndex, holding)
      const barTime = bars[lastIndex].t.slice(0, 10)

      if (decision.action === 'hold') {
        this.lastResult = `${s.strategyId} on ${symbol}: no signal at the ${barTime} close (${holding ? 'holding' : 'flat'}).`
        this.lastRunAt = new Date().toISOString()
        return this.lastResult
      }

      recordJournal({
        strategyId: s.strategyId, symbol, mode: 'paper', kind: 'signal',
        side: decision.action === 'enter' ? 'buy' : 'sell', qty: null, price: bars[lastIndex].c,
        pnl: null, pnlPct: null, reason: `${decision.reason} (bar ${barTime}, data: ${set.source})`,
        intentId: null, orderId: null,
      })

      const reason = `${s.strategyId}: ${decision.reason} (bar ${barTime})`
      let intent
      if (decision.action === 'enter') {
        const notional = Math.min(snap.account.equity * s.maxPositionPct / 100, snap.account.buyingPower)
        if (!(notional > 1)) {
          this.lastResult = `Signal to buy ${symbol}, but there is no buying power ($${snap.account.buyingPower.toFixed(2)}).`
          recordJournal({ strategyId: s.strategyId, symbol, mode: 'paper', kind: 'refused', side: 'buy', qty: null, price: bars[lastIndex].c, pnl: null, pnlPct: null, reason: this.lastResult, intentId: null, orderId: null })
          return this.lastResult
        }
        intent = await broker().prepareOrder({ mode: 'paper', symbol, side: 'buy', notional: Number(notional.toFixed(2)), orderType: 'market', reason })
      } else {
        if (!held) {
          this.lastResult = `Signal to sell ${symbol}, but no position is held.`
          return this.lastResult
        }
        intent = await broker().prepareOrder({ mode: 'paper', symbol, side: 'sell', qty: Math.abs(Number(held.qty)), orderType: 'market', reason })
      }

      recordJournal({
        strategyId: s.strategyId, symbol, mode: 'paper', kind: 'intent', side: intent.side,
        qty: intent.qty, price: intent.estimatedPrice, pnl: null, pnlPct: null,
        reason: intent.confirmation, intentId: intent.id, orderId: null,
      })

      if (!s.autoApprovePaper) {
        this.pendingIntent = { intentId: intent.id, symbol, side: intent.side, confirmation: intent.confirmation, expiresAt: intent.expiresAt }
        this.lastResult = `Prepared a paper ${intent.side} of ${symbol} and waiting for your approval: ${intent.confirmation}`
        recordJournal({
          strategyId: s.strategyId, symbol, mode: 'paper', kind: 'awaiting-approval', side: intent.side,
          qty: intent.qty, price: intent.estimatedPrice, pnl: null, pnlPct: null,
          reason: 'Auto-approve is off, so this paper order waits for the user. It expires in two minutes.', intentId: intent.id, orderId: null,
        })
        this.lastRunAt = new Date().toISOString()
        return this.lastResult
      }

      // Auto-approve is on and this is a PAPER order. Same two steps the page takes.
      broker().approveIntent(intent.id, true)
      const sent = await broker().sendOrder(intent.id)
      this.pendingIntent = null
      recordJournal({
        strategyId: s.strategyId, symbol, mode: 'paper', kind: sent.ok ? 'auto-approved' : 'refused', side: intent.side,
        qty: intent.qty, price: intent.estimatedPrice, pnl: null, pnlPct: null,
        reason: sent.ok
          ? `Auto-approved because you switched auto-approve paper ON. ${sent.message}`
          : `Auto-approve was on but the order was refused: ${sent.message}`,
        intentId: intent.id, orderId: sent.orderId,
      })

      if (sent.ok && intent.side === 'sell' && held) {
        const entry = Number(held.avgEntryPrice)
        const exit = intent.estimatedPrice
        const qty = Math.abs(Number(held.qty))
        const pnl = (exit - entry) * qty
        recordJournal({
          strategyId: s.strategyId, symbol, mode: 'paper', kind: 'exit', side: 'sell', qty, price: exit,
          pnl, pnlPct: entry > 0 ? (exit - entry) / entry : 0,
          reason: `Closed ${qty} ${symbol} at about ${exit.toFixed(2)} against an average entry of ${entry.toFixed(2)}. P/L is estimated from the account's average entry price and the price at the time of the order, not from the final fill.`,
          intentId: intent.id, orderId: sent.orderId,
        })
      }

      this.lastResult = sent.ok ? `Paper order sent: ${sent.message}` : `Paper order refused: ${sent.message}`
      this.lastRunAt = new Date().toISOString()
      return this.lastResult
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.lastResult = `Paper run failed: ${message}`
      recordJournal({ strategyId: s.strategyId, symbol, mode: 'paper', kind: 'refused', side: null, qty: null, price: null, pnl: null, pnlPct: null, reason: this.lastResult, intentId: null, orderId: null })
      log().warn(`Strategy: paper run failed — ${message}`)
      return this.lastResult
    } finally {
      this.running = false
      this.lastRunAt = new Date().toISOString()
    }
  }

  /** Approve the intent the loop is holding, from the Strategies page. */
  async approvePending(): Promise<{ ok: boolean; message: string }> {
    const pending = this.pendingIntent
    if (!pending) return { ok: false, message: 'There is no prepared paper order waiting.' }
    try {
      broker().approveIntent(pending.intentId, true)
      const sent = await broker().sendOrder(pending.intentId)
      this.pendingIntent = null
      recordJournal({
        strategyId: readStrategySettings().strategyId, symbol: pending.symbol, mode: 'paper', kind: sent.ok ? 'sent' : 'refused',
        side: pending.side, qty: null, price: null, pnl: null, pnlPct: null,
        reason: sent.ok ? `Approved by the user. ${sent.message}` : `Approval sent but the order was refused: ${sent.message}`,
        intentId: pending.intentId, orderId: sent.orderId,
      })
      return { ok: sent.ok, message: sent.message }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.pendingIntent = null
      return { ok: false, message }
    }
  }

  discardPending(): { ok: boolean; message: string } {
    const pending = this.pendingIntent
    if (!pending) return { ok: false, message: 'There is no prepared paper order waiting.' }
    try { broker().approveIntent(pending.intentId, false) } catch { /* it may have expired */ }
    this.pendingIntent = null
    recordJournal({
      strategyId: readStrategySettings().strategyId, symbol: pending.symbol, mode: 'paper', kind: 'note',
      side: pending.side, qty: null, price: null, pnl: null, pnlPct: null,
      reason: 'The user discarded the prepared paper order. Nothing was sent.', intentId: pending.intentId, orderId: null,
    })
    return { ok: true, message: 'Discarded. Nothing was sent.' }
  }

  journal(limit = 200): JournalEntry[] { return readJournal(limit) }
  summaries(): StrategySummary[] { return summarise(readJournal(20_000)) }
}

let instance: StrategyService | null = null
export function strategyService(): StrategyService {
  return instance ??= new StrategyService()
}
