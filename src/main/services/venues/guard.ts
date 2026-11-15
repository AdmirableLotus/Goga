import type { VenueBudget, VenueId, VenueTicket } from '../../../shared/venues'
import { SingleUseGate } from '../approval/singleUse'

/**
 * The one approval gate, shared by every venue.
 *
 * The rule it enforces is the whole safety model in one sentence: a ticket can be sent
 * exactly once, only after the user approved THAT ticket, and only before it expires.
 *
 * The single-use mechanics live in `SingleUseGate`, which the tool-install and virtual-machine
 * gates use too — one approval pattern in the codebase, not three. What stays here is the
 * venue-specific part: which venue a ticket belongs to, and whether trading is halted.
 */

export const TICKET_TTL_MS = 120_000

export type GateRefusal =
  | 'unknown'
  | 'already-spent'
  | 'not-approved'
  | 'expired'
  | 'halted'
  | 'venue-mismatch'

/** What the gate says when it refuses, in words the user can act on. */
export function refusalMessage(reason: GateRefusal, extra?: string): string {
  switch (reason) {
    case 'unknown': return 'That ticket is not one Goga issued. Prepare the order again.'
    case 'already-spent': return 'That ticket has already been sent. A ticket works once — prepare a new order if you want another.'
    case 'not-approved': return 'This order has not been approved. Nothing was sent.'
    case 'expired': return 'That ticket expired before it was sent. Nothing was sent. Prepare it again.'
    case 'halted': return `Trading is halted${extra ? ` (${extra})` : ''}, so nothing was sent. Clear the halt first.`
    case 'venue-mismatch': return 'That ticket belongs to a different venue, so nothing was sent.'
  }
}

export interface GateState {
  /** Fingerprint of the exact order the user approved, per ticket. */
  approvedFingerprint: string | null
  spent: boolean
}

/**
 * The venue gate. Every venue resolves to one instance.
 *
 * The single-use mechanics are `SingleUseGate`'s; this class adds the two venue-specific
 * refusals: a ticket from another venue, and a venue whose trading is halted.
 */
export class ApprovalGate {
  private gate: SingleUseGate<VenueTicket>

  constructor(private now: () => number = () => Date.now()) {
    this.gate = new SingleUseGate<VenueTicket>(t => ApprovalGate.fingerprint(t), now, TICKET_TTL_MS)
  }

  /**
   * A fingerprint of everything that makes this order what it is.
   *
   * The approval is bound to THIS string. If any part of the order changes after the
   * user approves it, the fingerprint no longer matches and the gate refuses — which is
   * what "single-use approval bound to that exact order" has to mean to be worth
   * anything.
   */
  static fingerprint(t: Pick<VenueTicket,
    'venue' | 'symbol' | 'side' | 'size' | 'sizeUnit' | 'orderType' | 'limitPrice' | 'estimatedNotional'
  >): string {
    return [
      t.venue, t.symbol, t.side, String(t.size), t.sizeUnit, t.orderType,
      t.limitPrice === null ? '-' : String(t.limitPrice),
      t.estimatedNotional.toFixed(2),
    ].join('|')
  }

  /** Record a prepared ticket. Nothing is approved yet. */
  offer(ticket: VenueTicket): VenueTicket {
    return this.gate.offer(ticket)
  }

  /** The user's decision about one exact ticket. Approving binds to this order only. */
  decide(ticketId: string, approved: boolean): { ok: boolean; message: string; ticket: VenueTicket | null } {
    const result = this.gate.decide(ticketId, approved, {
      unknown: refusalMessage('unknown'),
      spent: refusalMessage('already-spent'),
      expired: refusalMessage('expired'),
      approved: 'Approved. Sending this exact order once.',
      denied: 'Order discarded. Nothing was sent.',
    })
    return { ok: result.ok, message: result.message, ticket: result.item }
  }

  /**
   * Spend an approval. This is the only way a send can be authorised.
   *
   * Returns the ticket to send, or the reason it may not go.
   */
  claim(ticketId: string, venue: VenueId, halted: boolean, haltReason?: string): { ok: boolean; ticket: VenueTicket | null; reason: GateRefusal | null; message: string } {
    const result = this.gate.claim(ticketId, {
      beforeSpent: item => item.venue !== venue
        ? { reason: 'venue-mismatch', message: refusalMessage('venue-mismatch') }
        : null,
      afterExpiry: () => halted
        ? { reason: 'halted', message: refusalMessage('halted', haltReason) }
        : null,
    }, {
      unknown: refusalMessage('unknown'),
      spent: refusalMessage('already-spent'),
      notApproved: refusalMessage('not-approved'),
      expired: refusalMessage('expired'),
      changed: 'That order changed after it was approved, so nothing was sent. Prepare it again.',
    })
    if (result.ok && result.item) result.item.spent = true
    const known: GateRefusal[] = ['unknown', 'already-spent', 'not-approved', 'expired', 'halted', 'venue-mismatch']
    // A changed order is reported as not-approved: the approval no longer covers it.
    const mapped = result.reason === 'changed' ? 'not-approved' : result.reason
    const reason = mapped && (known as string[]).includes(mapped) ? mapped as GateRefusal : null
    return { ok: result.ok, ticket: result.item, reason: result.ok ? null : reason, message: result.message }
  }

  /** For the UI: what the gate holds, so a stale ticket is not shown as live. */
  peek(ticketId: string): { ticket: VenueTicket; approved: boolean; spent: boolean; expired: boolean } | null {
    const peeked = this.gate.peek(ticketId)
    return peeked ? { ticket: peeked.item, approved: peeked.approved, spent: peeked.spent, expired: peeked.expired } : null
  }

  clear(): void { this.gate.clear() }
}

/** The shared gate. Venue services all resolve to this one instance. */
export const approvalGate = new ApprovalGate()

// ── The risk guard ─────────────────────────────────────────────────────────────

export interface RiskInput {
  venue: VenueId
  budget: VenueBudget
  /** Equity in the account right now. */
  equity: number
  /** Change today as a percent, negative when down. */
  dayPnlPct: number
  /** Change since the account started, as a percent, negative when down. */
  overallPnlPct: number
  /** Dollar value this order commits. */
  orderNotional: number
  /** What this order could lose if it went wrong, as a percent of equity. */
  riskPct: number
  /** How many positions are open now. */
  openPositions: number
  /** True when the order adds a new position rather than changing an existing one. */
  opensNewPosition: boolean
  /** The loss halt recorded for this venue, if any. */
  halted: boolean
  haltReason: string | null
}

/**
 * Every reason an order must be refused, in plain words. Empty means it may go.
 *
 * Deliberately conservative: anything that cannot be checked is a refusal, not a pass.
 * The Pivex numbers (4% daily, 6% overall) come in through `budget` from the venue
 * definition, so the same function governs both venues.
 */
export function riskRefusals(input: RiskInput): string[] {
  const out: string[] = []
  const b = input.budget

  if (input.halted) out.push(`trading is halted${input.haltReason ? ` (${input.haltReason})` : ''}, so no new order can be prepared`)

  if (!Number.isFinite(input.equity) || input.equity <= 0) {
    out.push('the account value could not be read, so the loss limits cannot be checked')
  }
  if (!Number.isFinite(input.orderNotional) || input.orderNotional <= 0) {
    out.push('this order has no computable value (check the size and the price)')
  } else {
    if (input.orderNotional > b.maxOrderNotional) {
      out.push(`this order is ${input.orderNotional.toFixed(2)}, over the ${b.maxOrderNotional.toFixed(2)} limit for one order on this venue`)
    }
    // Pivex's own rule: a position may not consume most of the permitted drawdown.
    const roomLeft = Math.max(0, b.dailyLossPct + Math.min(0, input.dayPnlPct))
    const riskMoney = input.equity * input.riskPct / 100
    if (roomLeft > 0 && riskMoney > input.equity * roomLeft / 100) {
      out.push(`this order risks ${riskMoney.toFixed(2)}, more than the ${roomLeft.toFixed(2)}% of the account still allowed by today's loss budget`)
    }
    if (b.perTradeCapPct > 0 && input.riskPct > b.perTradeCapPct) {
      out.push(`this order risks ${input.riskPct.toFixed(2)}% of the account, over the ${b.perTradeCapPct}% per-trade cap`)
    }
  }

  if (input.opensNewPosition && input.openPositions >= b.maxOpenPositions) {
    out.push(`there are already ${input.openPositions} positions open, which is the limit of ${b.maxOpenPositions}`)
  }
  if (input.dayPnlPct <= -b.dailyLossPct) {
    out.push(`the account is down ${Math.abs(input.dayPnlPct).toFixed(2)}% today, at or past the ${b.dailyLossPct}% daily loss limit — no new positions today`)
  }
  if (input.overallPnlPct <= -b.overallLossPct) {
    out.push(`the account is down ${Math.abs(input.overallPnlPct).toFixed(2)}% in total, at or past the ${b.overallLossPct}% overall loss limit — this challenge is over`)
  }
  return out
}

/** What the order passed, so the confirmation can say what was checked. */
export function riskPasses(input: RiskInput): string[] {
  const b = input.budget
  return [
    `order value ${input.orderNotional.toFixed(2)} is within the ${b.maxOrderNotional.toFixed(2)} per-order limit`,
    `risk of ${input.riskPct.toFixed(2)}% is within the ${b.perTradeCapPct}% per-trade cap`,
    `today is ${input.dayPnlPct >= 0 ? '+' : ''}${input.dayPnlPct.toFixed(2)}% against a ${b.dailyLossPct}% daily limit`,
    `overall is ${input.overallPnlPct >= 0 ? '+' : ''}${input.overallPnlPct.toFixed(2)}% against a ${b.overallLossPct}% overall limit`,
    `${input.openPositions} of ${b.maxOpenPositions} position slots used`,
  ]
}
