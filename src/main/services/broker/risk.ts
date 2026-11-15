import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { BrokerMode, RiskLimitsView } from '../../../shared/broker'
import { SettingsService } from '../settings'

/**
 * Risk state and the rules every order must pass before it can be sent.
 *
 * Two things live here that the generic settings IPC deliberately cannot touch, so no
 * model, tool or stray renderer call can switch them on:
 *   - `liveEnabled`, which must be true before a real-money order is sent at all;
 *   - `halted`, the kill switch, which blocks new intents until the user clears it.
 */

export interface RiskState {
  liveEnabled: boolean
  halted: boolean
  haltReason: string | null
  haltedOn: string | null
  /** The trading day on which the daily loss limit was hit; blocks new buys that day. */
  lossHaltDay: string | null
  updatedAt: string
}

const defaults = (): RiskState => ({ liveEnabled: false, halted: false, haltReason: null, haltedOn: null, lossHaltDay: null, updatedAt: new Date().toISOString() })

export function stateFile(): string {
  return path.join(app.getPath('userData'), 'broker-risk-state.json')
}

export function readState(): RiskState {
  try { return { ...defaults(), ...(JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<RiskState>) } } catch { return defaults() }
}

export function writeState(patch: Partial<RiskState>): RiskState {
  const next: RiskState = { ...readState(), ...patch, updatedAt: new Date().toISOString() }
  const file = stateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
}

/** Today's date in the same reckoning the loss limit uses (local calendar day). */
export function tradingDay(now = new Date()): string {
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function limits(): RiskLimitsView {
  const s = SettingsService.getInstance().get()
  return {
    maxPositionPct: Number(s.brokerMaxPositionPct ?? 10),
    maxOpenPositions: Number(s.brokerMaxOpenPositions ?? 5),
    maxOrderNotional: Number(s.brokerMaxOrderNotional ?? 2000),
    dailyLossPct: Number(s.brokerDailyLossPct ?? 3),
  }
}

export interface OrderUnderReview {
  mode: BrokerMode
  symbol: string
  side: 'buy' | 'sell'
  estimatedNotional: number
  /** Equity of the account the order goes to. */
  equity: number
  /** Today's change as a percentage, from last_equity. */
  dayPnlPct: number
  /** Value already held in this symbol, if any. */
  existingPositionValue: number
  openPositionCount: number
}

/**
 * Every reason this order may NOT be sent, in plain words. Empty means it may.
 * Deliberately conservative: anything unknown is a refusal, not a pass.
 */
export function riskRefusals(o: OrderUnderReview, l: RiskLimitsView, state: RiskState, now = new Date()): string[] {
  const out: string[] = []
  if (state.halted) out.push(`the kill switch is on${state.haltReason ? ` (${state.haltReason})` : ''} — clear it in Goga → Trading first`)
  if (o.mode === 'live' && !state.liveEnabled) out.push('live trading is switched off, so no real-money order can be sent')
  if (!(o.estimatedNotional > 0)) out.push('the order has no computable dollar value (check the quantity and price)')
  if (!Number.isFinite(o.estimatedNotional)) out.push('the order value is not a finite number')
  if (!(o.equity > 0)) out.push('the account equity could not be read, so position limits cannot be checked')
  if (o.estimatedNotional > l.maxOrderNotional) out.push(`this order is $${o.estimatedNotional.toFixed(2)}, over your $${l.maxOrderNotional.toFixed(2)} per-order limit`)
  const positionValue = o.existingPositionValue + (o.side === 'buy' ? o.estimatedNotional : 0)
  const maxValue = o.equity * l.maxPositionPct / 100
  if (positionValue > maxValue) out.push(`that would put ${o.symbol} at $${positionValue.toFixed(2)}, over your ${l.maxPositionPct}% per-position limit ($${maxValue.toFixed(2)})`)
  if (o.side === 'buy' && o.existingPositionValue === 0 && o.openPositionCount >= l.maxOpenPositions) out.push(`you already hold ${o.openPositionCount} positions, your limit is ${l.maxOpenPositions}`)
  if (o.dayPnlPct <= -l.dailyLossPct) out.push(`the account is down ${Math.abs(o.dayPnlPct).toFixed(2)}% today, at or past your ${l.dailyLossPct}% daily loss limit — no new positions today`)
  if (state.lossHaltDay === tradingDay(now)) out.push(`the daily loss limit was hit today (${state.lossHaltDay}); trading resumes tomorrow unless you clear the halt`)
  return out
}

/** Every rule the order PASSED, so the confirmation can say what was checked. */
export function riskPasses(o: OrderUnderReview, l: RiskLimitsView, state: RiskState): string[] {
  const out: string[] = []
  out.push(state.liveEnabled || o.mode === 'paper' ? 'kill switch off' : 'kill switch off (live still off)')
  out.push(`order $${o.estimatedNotional.toFixed(2)} within the $${l.maxOrderNotional.toFixed(2)} per-order limit`)
  out.push(`position stays within ${l.maxPositionPct}% of equity ($${(o.equity * l.maxPositionPct / 100).toFixed(2)})`)
  out.push(`${o.openPositionCount} of ${l.maxOpenPositions} position slots used`)
  out.push(`today ${o.dayPnlPct >= 0 ? '+' : ''}${o.dayPnlPct.toFixed(2)}% vs a ${l.dailyLossPct}% daily loss limit`)
  return out
}

/** True when today's loss should halt trading outright (not just block new buys). */
export function lossLimitReached(dayPnlPct: number, l: RiskLimitsView, state: RiskState, now = new Date()): boolean {
  return state.lossHaltDay === tradingDay(now) || dayPnlPct <= -l.dailyLossPct
}
