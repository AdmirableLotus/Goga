import { describe, expect, it } from 'vitest'
import { ApprovalGate, TICKET_TTL_MS, riskPasses, riskRefusals, type RiskInput } from '../venues/guard'
import { VENUES } from '../../../shared/venues'
import type { VenueTicket } from '../../../shared/venues'

/**
 * The approval gate and the risk guard.
 *
 * These are the two things that stand between Goga and an order nobody asked for, so they
 * are tested directly, with a clock the test controls, and with no browser or broker in
 * the way.
 */

function ticket(over: Partial<VenueTicket> = {}): VenueTicket {
  return {
    id: 't1',
    venue: 'pivex',
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(TICKET_TTL_MS).toISOString(),
    symbol: 'EURUSD',
    side: 'buy',
    size: 0.01,
    sizeUnit: 'lots',
    orderType: 'market',
    limitPrice: null,
    estimatedPrice: 1.085,
    estimatedNotional: 1085,
    confirmation: 'BUY 0.01 lots EURUSD at about 1.08500',
    checks: [],
    reason: 'test reason long enough',
    spent: false,
    ...over,
  }
}

describe('approval gate — single use, bound to the exact order', () => {
  it('refuses a ticket that was never approved', () => {
    const gate = new ApprovalGate(() => 0)
    gate.offer(ticket())
    const claim = gate.claim('t1', 'pivex', false)
    expect(claim.ok).toBe(false)
    expect(claim.reason).toBe('not-approved')
    expect(claim.message).toContain('has not been approved')
  })

  it('refuses a ticket it never issued', () => {
    const gate = new ApprovalGate(() => 0)
    const claim = gate.claim('made-up', 'pivex', false)
    expect(claim.ok).toBe(false)
    expect(claim.reason).toBe('unknown')
  })

  it('sends once after approval, and refuses the second attempt', () => {
    const gate = new ApprovalGate(() => 0)
    gate.offer(ticket())
    expect(gate.decide('t1', true).ok).toBe(true)

    const first = gate.claim('t1', 'pivex', false)
    expect(first.ok).toBe(true)
    expect(first.ticket?.id).toBe('t1')

    const second = gate.claim('t1', 'pivex', false)
    expect(second.ok).toBe(false)
    expect(second.reason).toBe('already-spent')
    expect(second.message).toContain('already been sent')
  })

  it('refuses an expired ticket even when it was approved', () => {
    let now = 0
    const gate = new ApprovalGate(() => now)
    gate.offer(ticket())
    gate.decide('t1', true)
    now = TICKET_TTL_MS + 1
    const claim = gate.claim('t1', 'pivex', false)
    expect(claim.ok).toBe(false)
    expect(claim.reason).toBe('expired')
  })

  it('refuses when the order changed after approval', () => {
    const gate = new ApprovalGate(() => 0)
    const t = ticket()
    gate.offer(t)
    gate.decide('t1', true)
    // Someone edits the size on the ticket the gate is holding.
    t.size = 5
    const claim = gate.claim('t1', 'pivex', false)
    expect(claim.ok).toBe(false)
    expect(claim.reason).toBe('not-approved')
    expect(claim.message).toContain('changed after it was approved')
  })

  it('refuses a ticket belonging to the other venue', () => {
    const gate = new ApprovalGate(() => 0)
    gate.offer(ticket())
    gate.decide('t1', true)
    const claim = gate.claim('t1', 'alpaca-paper', false)
    expect(claim.ok).toBe(false)
    expect(claim.reason).toBe('venue-mismatch')
  })

  it('refuses while trading is halted, and does not spend the approval', () => {
    const gate = new ApprovalGate(() => 0)
    gate.offer(ticket())
    gate.decide('t1', true)
    const halted = gate.claim('t1', 'pivex', true, 'kill switch')
    expect(halted.ok).toBe(false)
    expect(halted.reason).toBe('halted')
    expect(halted.message).toContain('kill switch')
    // The approval survives a halt, so clearing the halt lets the same order go once.
    const after = gate.claim('t1', 'pivex', false)
    expect(after.ok).toBe(true)
  })

  it('a denial discards the ticket so it can never be sent', () => {
    const gate = new ApprovalGate(() => 0)
    gate.offer(ticket())
    const denied = gate.decide('t1', false)
    expect(denied.ok).toBe(true)
    expect(denied.message).toContain('Nothing was sent')
    const claim = gate.claim('t1', 'pivex', false)
    expect(claim.ok).toBe(false)
    expect(claim.reason).toBe('unknown')
  })

  it('binds approval to the fingerprint, so two different orders are not interchangeable', () => {
    const a = ApprovalGate.fingerprint(ticket())
    const b = ApprovalGate.fingerprint(ticket({ size: 0.02 }))
    const c = ApprovalGate.fingerprint(ticket({ side: 'sell' }))
    const d = ApprovalGate.fingerprint(ticket({ venue: 'alpaca-paper' }))
    expect(new Set([a, b, c, d]).size).toBe(4)
  })

  it('reports a ticket as spent to the UI after it is claimed', () => {
    const gate = new ApprovalGate(() => 0)
    gate.offer(ticket())
    gate.decide('t1', true)
    gate.claim('t1', 'pivex', false)
    const peek = gate.peek('t1')
    expect(peek?.spent).toBe(true)
    expect(peek?.approved).toBe(true)
  })
})

describe('risk guard — refuses what breaches the budget', () => {
  const base: RiskInput = {
    venue: 'pivex',
    budget: VENUES.pivex.budget,
    equity: 10_000,
    dayPnlPct: 0,
    overallPnlPct: 0,
    orderNotional: 1_085,
    riskPct: 0.5,
    openPositions: 2,
    opensNewPosition: true,
    halted: false,
    haltReason: null,
  }

  it('passes an order inside every limit', () => {
    expect(riskRefusals(base)).toHaveLength(0)
    expect(riskPasses(base).length).toBeGreaterThan(0)
  })

  it('refuses an order over the per-order notional limit', () => {
    const refusals = riskRefusals({ ...base, orderNotional: 500_000 })
    expect(refusals.join(' ')).toContain('over the')
    expect(refusals.join(' ')).toContain('limit for one order')
  })

  it('refuses an order that risks more than the per-trade cap', () => {
    const refusals = riskRefusals({ ...base, riskPct: 5 })
    expect(refusals.join(' ')).toContain('per-trade cap')
  })

  it('refuses when the daily loss limit is already reached', () => {
    const refusals = riskRefusals({ ...base, dayPnlPct: -4 })
    expect(refusals.join(' ')).toContain('daily loss limit')
  })

  it('refuses when the overall loss limit is reached', () => {
    const refusals = riskRefusals({ ...base, overallPnlPct: -6 })
    expect(refusals.join(' ')).toContain('overall loss limit')
  })

  it('refuses an order that would eat the remaining daily budget', () => {
    // Down 3.5% of a 4% daily budget: only 0.5% of the account is left to risk.
    const refusals = riskRefusals({ ...base, dayPnlPct: -3.5, riskPct: 1 })
    expect(refusals.join(' ')).toContain('still allowed by today')
  })

  it('refuses a new position when the position slots are full', () => {
    const refusals = riskRefusals({ ...base, openPositions: 20 })
    expect(refusals.join(' ')).toContain('positions open')
  })

  it('allows adding to an existing position when the slots are full', () => {
    expect(riskRefusals({ ...base, openPositions: 20, opensNewPosition: false })).toHaveLength(0)
  })

  it('refuses while halted', () => {
    const refusals = riskRefusals({ ...base, halted: true, haltReason: 'manual stop' })
    expect(refusals.join(' ')).toContain('halted')
    expect(refusals.join(' ')).toContain('manual stop')
  })

  it('refuses when the account value could not be read', () => {
    expect(riskRefusals({ ...base, equity: 0 }).join(' ')).toContain('could not be read')
    expect(riskRefusals({ ...base, equity: Number.NaN }).join(' ')).toContain('could not be read')
  })

  it('refuses an order with no computable value', () => {
    expect(riskRefusals({ ...base, orderNotional: 0 }).join(' ')).toContain('no computable value')
  })

  it('applies the same rules to Alpaca paper with its own budget', () => {
    const alpaca: RiskInput = { ...base, venue: 'alpaca-paper', budget: VENUES['alpaca-paper'].budget, orderNotional: 2_500 }
    expect(riskRefusals(alpaca).join(' ')).toContain('limit for one order')
    // The same order is fine on Pivex, whose per-order limit is larger.
    expect(riskRefusals({ ...base, orderNotional: 2_500 })).toHaveLength(0)
  })
})
