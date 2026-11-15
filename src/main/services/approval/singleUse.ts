/**
 * The one single-use approval gate.
 *
 * Every place in Goga where the user approves something that then happens exactly once —
 * sending an order, installing a package, creating a virtual machine — goes through this
 * class. It exists so there is one approval pattern and not three: offer the exact thing,
 * let the user decide about that thing, then claim it once.
 *
 * The rule it enforces is the whole safety model in one sentence: an item can be claimed
 * exactly once, only after the user approved THAT item, and only before it expires.
 *
 * The approval is bound to a fingerprint of everything that makes the item what it is. If
 * any part of it changes after the user approves, the fingerprint no longer matches and the
 * gate refuses. That is what "single-use approval bound to that exact thing" has to mean to
 * be worth anything.
 *
 * Written as a plain class with an injected clock so the binding can be tested without a
 * browser, a broker, a package manager or a network.
 */

export type SingleUseRefusal = 'unknown' | 'already-spent' | 'not-approved' | 'expired' | 'changed'

/** The minimum an item needs: an id and the moment it stops being claimable. */
export interface SingleUseItem {
  id: string
  expiresAt: string
}

interface State {
  approvedFingerprint: string | null
  spent: boolean
}

/** A refusal a caller adds on top of the gate's own checks. */
export interface ExtraRefusal {
  reason: string
  message: string
}

export interface ClaimHooks<T> {
  /** Runs after the id is known and before the spent check. */
  beforeSpent?: (item: T) => ExtraRefusal | null
  /** Runs after the expiry check and before the fingerprint check. */
  afterExpiry?: (item: T) => ExtraRefusal | null
}

export interface ClaimResult<T> {
  ok: boolean
  item: T | null
  reason: string | null
  message: string
}

export interface DecideResult<T> {
  ok: boolean
  message: string
  item: T | null
}

export interface PeekResult<T> {
  item: T
  approved: boolean
  spent: boolean
  expired: boolean
}

export class SingleUseGate<T extends SingleUseItem> {
  private items = new Map<string, T>()
  private state = new Map<string, State>()

  constructor(
    private fingerprintOf: (item: T) => string,
    private now: () => number = () => Date.now(),
    private ttlMs = 120_000,
  ) {}

  /** Record a prepared item. Nothing is approved yet. */
  offer(item: T): T {
    this.items.set(item.id, item)
    this.state.set(item.id, { approvedFingerprint: null, spent: false })
    // Drop expired, unapproved items so the maps cannot grow without bound.
    for (const [id, held] of this.items) {
      const s = this.state.get(id)
      if (s && !s.spent && !s.approvedFingerprint && Date.parse(held.expiresAt) < this.now()) {
        this.items.delete(id)
        this.state.delete(id)
      }
    }
    return item
  }

  /** The user's decision about one exact item. Approving binds to this item only. */
  decide(id: string, approved: boolean, messages?: { unknown?: string; spent?: string; expired?: string; approved?: string; denied?: string }): DecideResult<T> {
    const item = this.items.get(id)
    const state = this.state.get(id)
    if (!item || !state) {
      return { ok: false, message: messages?.unknown ?? 'That is not something Goga offered. Prepare it again.', item: null }
    }
    if (state.spent) {
      return { ok: false, message: messages?.spent ?? 'That has already been done. It works once — prepare it again if you want another.', item: null }
    }
    if (Date.parse(item.expiresAt) < this.now()) {
      this.items.delete(id); this.state.delete(id)
      return { ok: false, message: messages?.expired ?? 'That expired before it was used. Nothing happened. Prepare it again.', item: null }
    }
    if (!approved) {
      this.items.delete(id); this.state.delete(id)
      return { ok: true, message: messages?.denied ?? 'Discarded. Nothing happened.', item: null }
    }
    state.approvedFingerprint = this.fingerprintOf(item)
    return { ok: true, message: messages?.approved ?? 'Approved. This exact item, once.', item }
  }

  /**
   * Spend an approval. This is the only way an approved item may be acted on.
   *
   * It marks the item spent BEFORE returning, so a second call cannot act twice even if the
   * caller ignores the result.
   */
  claim(id: string, hooks?: ClaimHooks<T>, messages?: { unknown?: string; spent?: string; notApproved?: string; expired?: string; changed?: string }): ClaimResult<T> {
    const item = this.items.get(id)
    const state = this.state.get(id)
    if (!item || !state) {
      return { ok: false, item: null, reason: 'unknown', message: messages?.unknown ?? 'That is not something Goga offered. Prepare it again.' }
    }
    const before = hooks?.beforeSpent?.(item)
    if (before) return { ok: false, item: null, reason: before.reason, message: before.message }
    if (state.spent) {
      return { ok: false, item: null, reason: 'already-spent', message: messages?.spent ?? 'That has already been done. It works once.' }
    }
    if (!state.approvedFingerprint) {
      return { ok: false, item: null, reason: 'not-approved', message: messages?.notApproved ?? 'This has not been approved. Nothing happened.' }
    }
    if (Date.parse(item.expiresAt) < this.now()) {
      this.items.delete(id); this.state.delete(id)
      return { ok: false, item: null, reason: 'expired', message: messages?.expired ?? 'That expired before it was used. Nothing happened.' }
    }
    const after = hooks?.afterExpiry?.(item)
    if (after) return { ok: false, item: null, reason: after.reason, message: after.message }
    // The item must still be the one the user approved.
    if (this.fingerprintOf(item) !== state.approvedFingerprint) {
      return { ok: false, item: null, reason: 'changed', message: messages?.changed ?? 'That changed after it was approved, so nothing happened. Prepare it again.' }
    }
    state.spent = true
    return { ok: true, item, reason: null, message: 'Approved and unspent.' }
  }

  /** For the UI: what the gate holds, so a stale item is not shown as live. */
  peek(id: string): PeekResult<T> | null {
    const item = this.items.get(id)
    const state = this.state.get(id)
    if (!item || !state) return null
    return {
      item,
      approved: state.approvedFingerprint !== null,
      spent: state.spent,
      expired: Date.parse(item.expiresAt) < this.now(),
    }
  }

  /** Everything the gate is holding, newest first, for a page that lists proposals. */
  list(): PeekResult<T>[] {
    return [...this.items.values()]
      .map(item => this.peek(item.id))
      .filter((p): p is PeekResult<T> => p !== null)
  }

  clear(): void { this.items.clear(); this.state.clear() }
}
