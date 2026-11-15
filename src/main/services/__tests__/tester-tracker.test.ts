import { describe, expect, it } from 'vitest'
import type { TesterApp, TesterCandidate } from '../../../shared/business'
import {
  GOOGLE_OPT_IN_DAYS, GOOGLE_REQUIRED_TESTERS, dateInputToIso, describeApp, newTesterApp,
  optedInDays, stateTransition, summariseApp,
} from '../business/testers'

/**
 * The tester tracker decides whether an app has met Google's gate, so it is held to the rule
 * rather than to a convenient version of it: 12 testers, opted in continuously for 14 days,
 * per app. These tests use fixed dates so "today" never moves the answer.
 */

const NOW = new Date('2026-11-11T12:00:00.000Z')

function candidate(over: Partial<TesterCandidate> = {}): TesterCandidate {
  return {
    id: over.id ?? `id-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Tester', email: 'tester@example.com', source: 'test',
    state: 'opted-in', invitedAt: null, acceptedAt: null, installedAt: null,
    optedInAt: '2026-10-01T12:00:00.000Z', droppedAt: null, notes: '',
    ...over,
  }
}

function app(over: Partial<TesterApp> = {}): TesterApp {
  return {
    ...newTesterApp({ name: 'Only3', packageName: 'com.base6a76745e0296d6adfc52539f.app', id: 'app-1' }),
    ...over,
  }
}

const twelve = (optedInAt = '2026-10-01T12:00:00.000Z') =>
  Array.from({ length: 12 }, (_, i) => candidate({ id: `c${i}`, name: `T${i}`, email: `t${i}@example.com`, optedInAt }))

describe('the tester tracker', () => {
  it('needs 12 testers and 14 days, the figures Google publishes', () => {
    const only3 = newTesterApp({ name: 'Only3', packageName: 'com.a.b' })
    expect(only3.required).toBe(GOOGLE_REQUIRED_TESTERS)
    expect(only3.required).toBe(12)
    expect(only3.optInDays).toBe(GOOGLE_OPT_IN_DAYS)
    expect(only3.optInDays).toBe(14)
    expect(only3.track).toBe('closed')
  })

  it('counts only testers in the opted-in state', () => {
    const a = app({
      candidates: [
        ...twelve(),
        candidate({ id: 'x1', state: 'invited', invitedAt: '2026-11-01T00:00:00.000Z', optedInAt: null }),
        candidate({ id: 'x2', state: 'accepted', acceptedAt: '2026-11-01T00:00:00.000Z', optedInAt: null }),
        candidate({ id: 'x3', state: 'installed', installedAt: '2026-11-02T00:00:00.000Z', optedInAt: null }),
        candidate({ id: 'x4', state: 'candidate', optedInAt: null }),
      ],
    })
    const s = summariseApp(a, NOW)
    expect(s.optedIn).toBe(12)
    expect(s.outstanding).toBe(3)
    expect(s.meetsCount).toBe(true)
    expect(s.warning).toBeNull()
  })

  it('warns with the exact shortfall, and says the streak restarts after a drop-out', () => {
    const a = app({
      candidates: [
        ...twelve().slice(0, 10),
        candidate({ id: 'd1', state: 'dropped', optedInAt: null, droppedAt: '2026-11-09T09:00:00.000Z' }),
      ],
    })
    const s = summariseApp(a, NOW)
    expect(s.optedIn).toBe(10)
    expect(s.dropped).toBe(1)
    expect(s.meetsCount).toBe(false)
    expect(s.warning).toContain('2 short: 10 of 12 opted in')
    expect(s.warning).toContain('2026-11-09')
    expect(s.warning).toContain('restarts')
  })

  it('says so plainly when nobody is opted in', () => {
    const s = summariseApp(app({ candidates: [candidate({ state: 'invited', optedInAt: null })] }), NOW)
    expect(s.optedIn).toBe(0)
    expect(s.warning).toContain('No testers are opted in')
  })

  it('completes the streak on the 12th tester’s 14th day, not on the first tester’s', () => {
    // Eleven opted in on 1 October, the twelfth only on 5 November: until 19 November there
    // have never been 12 people in for 14 days at the same time.
    const a = app({
      candidates: [
        ...twelve('2026-10-01T12:00:00.000Z').slice(0, 11),
        candidate({ id: 'late', optedInAt: '2026-11-05T12:00:00.000Z' }),
      ],
    })
    const s = summariseApp(a, NOW)
    expect(s.optedIn).toBe(12)
    expect(s.meetsCount).toBe(true)
    expect(s.eligibleAt).toBe('2026-11-19T12:00:00.000Z')
    expect(s.daysRemaining).toBe(8)
    expect(s.status).toContain('8 days to go')
    // Only eleven have been in 14 days so far; the twelfth has not.
    expect(s.optedInLongEnough).toBe(11)
  })

  it('gives no completion date when fewer than 12 are opted in', () => {
    const s = summariseApp(app({ candidates: twelve().slice(0, 11) }), NOW)
    expect(s.eligibleAt).toBeNull()
    expect(s.daysRemaining).toBeNull()
  })

  it('will not let an opted-in tester with no date count as 14 days', () => {
    const a = app({ candidates: twelve().map((c, i) => (i === 0 ? { ...c, optedInAt: null } : c)) })
    const s = summariseApp(a, NOW)
    expect(s.optedIn).toBe(12)
    expect(s.optedInLongEnough).toBe(11)
    expect(optedInDays(a.candidates[0], NOW)).toBeNull()
  })

  it('counts days in, whole, from the recorded opt-in date', () => {
    expect(optedInDays(candidate({ optedInAt: '2026-11-01T12:00:00.000Z' }), NOW)).toBe(10)
    expect(optedInDays(candidate({ optedInAt: '2026-10-01T12:00:00.000Z' }), NOW)).toBe(41)
    expect(optedInDays(candidate({ optedInAt: '2026-11-07T13:00:00.000Z' }), NOW)).toBe(3)
  })

  it('keeps each app’s count separate', () => {
    const a = summariseApp(app({ id: 'a', candidates: twelve() }), NOW)
    const b = summariseApp(app({ id: 'b', packageName: 'com.other.app', candidates: twelve().slice(0, 4) }), NOW)
    expect(a.optedIn).toBe(12)
    expect(b.optedIn).toBe(4)
    expect(b.warning).toContain('8 short')
  })

  it('records the dates each state needs, and clears them when a tester leaves', () => {
    const c = candidate({ state: 'candidate', optedInAt: null })
    expect(stateTransition(c, 'invited', NOW).invitedAt).toBe(NOW.toISOString())
    expect(stateTransition(c, 'accepted', NOW).acceptedAt).toBe(NOW.toISOString())
    expect(stateTransition(c, 'installed', NOW).installedAt).toBe(NOW.toISOString())
    const opted = stateTransition(c, 'opted-in', NOW)
    expect(opted.optedInAt).toBe(NOW.toISOString())
    expect(opted.droppedAt).toBeNull()

    const inTester = candidate({ state: 'opted-in' })
    const dropped = stateTransition(inTester, 'dropped', NOW)
    expect(dropped.droppedAt).toBe(NOW.toISOString())
    // The 14-day clock cannot survive a drop-out, so the opt-in date goes with it.
    expect(dropped.optedInAt).toBeNull()

    // Coming back later starts the 14 days again rather than resuming.
    const back = stateTransition({ ...inTester, droppedAt: '2026-11-01T00:00:00.000Z' }, 'opted-in', NOW)
    expect(back.optedInAt).toBe(NOW.toISOString())
    expect(back.droppedAt).toBeNull()
  })

  it('takes a bare date as midday UTC so it cannot drift a day', () => {
    expect(dateInputToIso('2026-11-03')).toBe('2026-11-03T12:00:00.000Z')
    expect(dateInputToIso('')).toBeNull()
    expect(dateInputToIso('not a date')).toBeNull()
  })

  it('prints an app in plain lines a person can read', () => {
    const a = app({ candidates: twelve().slice(0, 3) })
    const text = describeApp(summariseApp(a, NOW), a)
    expect(text).toContain('Only3')
    expect(text).toContain('com.base6a76745e0296d6adfc52539f.app')
    expect(text).toContain('9 short')
  })
})
