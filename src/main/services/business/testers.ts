import { randomUUID } from 'crypto'
import type { PlayTrack, TesterApp, TesterAppSummary, TesterCandidate, TesterState } from '../../../shared/business'
import { TESTER_STATES } from '../../../shared/business'

/**
 * The tester tracker's arithmetic.
 *
 * Everything here is a pure function of the records the user keeps: no network, no clock of
 * its own beyond the one passed in, no guessing. That matters because the one number Google
 * actually acts on is "12 testers opted in continuously for 14 days", and a tracker that
 * rounds in the developer's favour is worse than no tracker at all.
 *
 * Three things this deliberately does NOT do:
 *  - it does not read Play Console, so "opted in" is what the user recorded, not what Google
 *    says;
 *  - it does not treat an invite, an acceptance or an install as a tester, because Google
 *    does not;
 *  - it does not delete a drop-out. The date they left is the only record of the streak
 *    breaking, so it is kept.
 */

export const GOOGLE_REQUIRED_TESTERS = 12
export const GOOGLE_OPT_IN_DAYS = 14

const DAY_MS = 86_400_000

/** A new app with nothing on it yet. Ids are generated here so tests can pass their own. */
export function newTesterApp(input: {
  name: string
  packageName: string
  track?: PlayTrack
  required?: number
  optInDays?: number
  notes?: string
  now?: Date
  id?: string
}): TesterApp {
  const at = (input.now ?? new Date()).toISOString()
  return {
    id: input.id ?? randomUUID(),
    name: String(input.name ?? '').trim(),
    packageName: String(input.packageName ?? '').trim(),
    track: input.track ?? 'closed',
    required: Number(input.required) > 0 ? Math.floor(Number(input.required)) : GOOGLE_REQUIRED_TESTERS,
    optInDays: Number(input.optInDays) > 0 ? Math.floor(Number(input.optInDays)) : GOOGLE_OPT_IN_DAYS,
    candidates: [],
    notes: String(input.notes ?? '').trim(),
    createdAt: at,
    updatedAt: at,
  }
}

export function isTesterState(value: unknown): value is TesterState {
  return typeof value === 'string' && (TESTER_STATES as string[]).includes(value)
}

/** Whole days between two instants, floored, never negative when `to` is in the past. */
function daysBetween(fromIso: string, to: Date): number | null {
  const from = Date.parse(fromIso)
  if (Number.isNaN(from)) return null
  return (to.getTime() - from) / DAY_MS
}

/**
 * How long each opted-in tester has been in, in whole days, as of `now`. A tester with no
 * recorded opt-in date counts as opted in but with an unknown duration — which is exactly
 * what it is, so it cannot silently satisfy the 14 days.
 */
export function optedInDays(c: TesterCandidate, now: Date): number | null {
  if (c.state !== 'opted-in' || !c.optedInAt) return null
  const d = daysBetween(c.optedInAt, now)
  return d === null ? null : Math.floor(d)
}

/**
 * The counted view of one app.
 *
 * `eligibleAt` is the moment the app would satisfy Google's rule on the dates recorded here:
 * the `required`-th most recent opt-in, plus `optInDays`. If fewer people than that are
 * opted in, there is no such moment and the field is null — no estimate is invented.
 */
export function summariseApp(app: TesterApp, now: Date = new Date()): TesterAppSummary {
  const required = app.required > 0 ? app.required : GOOGLE_REQUIRED_TESTERS
  const needDays = app.optInDays > 0 ? app.optInDays : GOOGLE_OPT_IN_DAYS

  const optedInList = app.candidates.filter(c => c.state === 'opted-in')
  const longEnough = optedInList.filter(c => {
    const d = optedInDays(c, now)
    return d !== null && d >= needDays
  })
  const outstanding = app.candidates.filter(c => c.state === 'invited' || c.state === 'accepted' || c.state === 'installed').length
  const dropped = app.candidates.filter(c => c.state === 'dropped').length
  const latestDrop = app.candidates
    .filter(c => c.state === 'dropped')
    .map(c => c.droppedAt ?? '')
    .filter(Boolean)
    .sort()
    .pop() ?? null

  // The moment the rule is satisfied: the `required`-th earliest opt-in plus the required
  // days. Earlier than that, fewer than `required` people have been in long enough; with
  // exactly 12, it is simply when the newest of them has been in 14 days.
  let eligibleAt: string | null = null
  const dates = optedInList
    .map(c => c.optedInAt)
    .filter((d): d is string => !!d && !Number.isNaN(Date.parse(d)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (dates.length >= required) {
    const start = Date.parse(dates[required - 1])
    if (!Number.isNaN(start)) eligibleAt = new Date(start + needDays * DAY_MS).toISOString()
  }

  const optedIn = optedInList.length
  const meetsCount = optedIn >= required
  const daysRemaining = eligibleAt === null
    ? null
    : Math.ceil((Date.parse(eligibleAt) - now.getTime()) / DAY_MS)

  let warning: string | null = null
  if (!meetsCount) {
    const short = required - optedIn
    warning = optedIn === 0
      ? `No testers are opted in. Google needs ${required} opted in continuously for ${needDays} days.`
      : `${short} short: ${optedIn} of ${required} opted in. Google's clock needs ${required} opted in at the same time for ${needDays} days.`
    if (latestDrop) {
      warning += ` The most recent drop-out was recorded ${latestDrop.slice(0, 10)}; a break in the streak restarts that tester's ${needDays} days.`
    }
  }

  const status = !meetsCount
    ? `${optedIn} of ${required} opted in`
    : daysRemaining !== null && daysRemaining > 0
      ? `${optedIn} of ${required} opted in — ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} to go`
      : `${optedIn} of ${required} opted in — the ${needDays}-day streak is complete`

  return {
    appId: app.id,
    name: app.name,
    packageName: app.packageName,
    track: app.track,
    required,
    optInDays: needDays,
    optedIn,
    optedInLongEnough: longEnough.length,
    outstanding,
    dropped,
    meetsCount,
    eligibleAt,
    daysRemaining,
    status,
    warning,
    latestDropAt: latestDrop,
  }
}

/** What changes when the user moves a tester to a new state, including the dates. */
export function stateTransition(c: TesterCandidate, next: TesterState, now: Date, at?: string | null): Partial<TesterCandidate> {
  const stamp = (at ? new Date(at) : now).toISOString()
  const patch: Partial<TesterCandidate> = { state: next }
  if (next === 'invited' && !c.invitedAt) patch.invitedAt = stamp
  if (next === 'accepted' && !c.acceptedAt) patch.acceptedAt = stamp
  if (next === 'installed' && !c.installedAt) patch.installedAt = stamp
  if (next === 'opted-in') {
    // A tester who left and comes back starts the 14 days again, so the date is replaced,
    // not kept.
    patch.optedInAt = at ? new Date(at).toISOString() : (c.state === 'opted-in' && c.optedInAt && !c.droppedAt ? c.optedInAt : stamp)
    patch.droppedAt = null
  }
  if (next === 'dropped') {
    patch.droppedAt = at ? new Date(at).toISOString() : stamp
    patch.optedInAt = null
  }
  if (next === 'candidate') {
    patch.optedInAt = null
    patch.droppedAt = null
  }
  return patch
}

/** "2011-10-05" → an ISO instant at midday UTC, so a bare date cannot drift a day either way. */
export function dateInputToIso(value: string): string | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const d = new Date(`${text}T12:00:00.000Z`)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  const d = new Date(text)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** The plain-text lines one app's tracker prints, used by the tool and by the audit trail. */
export function describeApp(s: TesterAppSummary, app: TesterApp): string {
  const lines = [
    `${s.name || s.packageName} — ${s.packageName} (${s.track} track)`,
    `  ${s.status}`,
    `  outstanding: ${s.outstanding} invited/accepted/installed and not yet opted in; dropped: ${s.dropped}`,
  ]
  if (s.eligibleAt) {
    lines.push(`  by the dates recorded here, the ${s.optInDays}-day streak completes ${s.eligibleAt.slice(0, 10)}`)
  } else if (s.optedIn > 0) {
    lines.push(`  no completion date yet: only ${s.optedIn} of ${s.required} opted in`)
  }
  if (s.warning) lines.push(`  ⚠ ${s.warning}`)
  for (const c of app.candidates) {
    const days = optedInDays(c, new Date())
    lines.push(
      `  ${c.state.padEnd(10)} ${c.name || '(no name)'} <${c.email}>` +
      `${c.state === 'opted-in' && days !== null ? ` — ${days} day${days === 1 ? '' : 's'} in` : ''}` +
      `${c.optedInAt ? ` (opted in ${c.optedInAt.slice(0, 10)})` : ''}` +
      `${c.droppedAt ? ` (dropped ${c.droppedAt.slice(0, 10)})` : ''}` +
      `${c.notes ? ` — ${c.notes}` : ''}`,
    )
  }
  return lines.join('\n')
}
