/**
 * M4.1 — Agent-loop resilience (pure helpers used by the production AgentLoop).
 *
 * Exercises the real FailureCycleTracker / isTaskTimedOut / signature logic
 * from agentResilience.ts, plus the vague-website routing guard.
 */
import { describe, it, expect } from 'vitest'
import {
  FailureCycleTracker,
  failureSignature,
  isTaskTimedOut,
  MAX_EQUIVALENT_FAILURES,
  OVERALL_TASK_TIMEOUT_MS,
} from '../agentResilience'

describe('M4.1 — agent resilience: repeated-failure cycle detection', () => {
  it('breaks after MAX_EQUIVALENT_FAILURES identical failures', () => {
    const t = new FailureCycleTracker()
    let cycled = false
    for (let i = 0; i < MAX_EQUIVALENT_FAILURES; i++) {
      cycled = t.record('web.fetch', { url: 'bad://url' }, 'Invalid URL')
    }
    expect(cycled).toBe(true)
    expect(t.count('web.fetch', { url: 'bad://url' }, 'Invalid URL')).toBe(MAX_EQUIVALENT_FAILURES)
  })

  it('does not break on distinct failures (different params/errors)', () => {
    const t = new FailureCycleTracker()
    expect(t.record('web.fetch', { url: 'a' }, 'e1')).toBe(false)
    expect(t.record('web.fetch', { url: 'b' }, 'e2')).toBe(false)
    expect(t.record('web.search', { q: 'c' }, 'e3')).toBe(false)
  })

  it('catches the observed web.search/web.fetch bad-URL loop', () => {
    // Interleaving two tools that keep failing on the SAME bad URL/error still
    // trips the per-signature cycle guard (each signature counted independently).
    const t = new FailureCycleTracker()
    const results: boolean[] = []
    for (let i = 0; i < 3; i++) {
      results.push(t.record('web.fetch', { url: 'https://wrong' }, 'Invalid URL'))
      results.push(t.record('web.search', { query: 'hackerone bounty' }, 'no results'))
    }
    // The fetch signature reaches 3 on the 3rd fetch (index 4 in results)
    expect(results.some(r => r === true)).toBe(true)
  })

  it('failureSignature is stable for equal tool+params+error', () => {
    const a = failureSignature('web.fetch', { url: 'x' }, 'err')
    const b = failureSignature('web.fetch', { url: 'x' }, 'err')
    expect(a).toBe(b)
    const c = failureSignature('web.fetch', { url: 'y' }, 'err')
    expect(a).not.toBe(c)
  })
})

describe('M4.1 — agent resilience: overall task timeout', () => {
  it('not timed out within budget', () => {
    const start = 1_000_000
    expect(isTaskTimedOut(start, start + 1000)).toBe(false)
    expect(isTaskTimedOut(start, start + 86_400_000)).toBe(false)
    expect(OVERALL_TASK_TIMEOUT_MS).toBe(Number.POSITIVE_INFINITY)
  })

  it('times out when an explicit finite budget is exceeded', () => {
    const start = 1_000_000
    expect(isTaskTimedOut(start, start + 90_001, 90_000)).toBe(true)
  })

  it('respects a custom budget', () => {
    expect(isTaskTimedOut(0, 500, 400)).toBe(true)
    expect(isTaskTimedOut(0, 300, 400)).toBe(false)
  })
})
