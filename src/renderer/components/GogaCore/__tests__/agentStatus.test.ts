import { describe, expect, it } from 'vitest'
import type { AgentState } from '@shared/types'
import {
  ACTIVE_PHASES, PULSE_FAST_MS, PULSE_SLOW_MS, STATUS_PHRASES, THINKING_TIERS, TOOL_LONG_AFTER_MS,
  heatFor, phaseOf, pulseMsFor, statusView, thinkingPhrase, toolPhrase,
} from '../agentStatus'

const state = (patch: Partial<AgentState>): AgentState => ({ status: 'idle', task: '', steps: [], ...patch })

describe('phaseOf — reads the real agent state, never a timer', () => {
  it('is idle with no state and nothing loading', () => {
    expect(phaseOf({ agentState: null, loading: false, streaming: false })).toBe('idle')
  })

  it('is thinking while a run has no tool in flight', () => {
    expect(phaseOf({ agentState: state({ status: 'running' }), loading: true, streaming: false })).toBe('thinking')
  })

  it('is a tool phase as soon as the loop reports currentTool', () => {
    expect(phaseOf({ agentState: state({ status: 'running', currentTool: 'filesystem.list' }), loading: true, streaming: false })).toBe('tool')
  })

  it('is approval while the loop waits on the user', () => {
    expect(phaseOf({
      agentState: state({ status: 'waiting-approval', pendingApproval: { id: 'a', tool: 'shell.execute', label: 'run it' } }),
      loading: true, streaming: false,
    })).toBe('approval')
  })

  it('is streaming once tokens arrive', () => {
    expect(phaseOf({ agentState: state({ status: 'done' }), loading: true, streaming: true })).toBe('streaming')
  })

  it('a new send outranks the previous run\'s terminal status', () => {
    expect(phaseOf({ agentState: state({ status: 'error', error: 'boom' }), loading: true, streaming: false })).toBe('thinking')
  })

  it('reports error, done and stopped when nothing is in flight', () => {
    expect(phaseOf({ agentState: state({ status: 'error' }), loading: false, streaming: false })).toBe('error')
    expect(phaseOf({ agentState: state({ status: 'done' }), loading: false, streaming: false })).toBe('done')
    expect(phaseOf({ agentState: state({ status: 'stopped' }), loading: false, streaming: false })).toBe('stopped')
  })
})

describe('wording', () => {
  it('escalates the thinking phrase with time', () => {
    expect(thinkingPhrase(0)).toBe(THINKING_TIERS[0].label)
    expect(thinkingPhrase(THINKING_TIERS[1].afterMs)).toBe(THINKING_TIERS[1].label)
    expect(thinkingPhrase(THINKING_TIERS[2].afterMs)).toBe(THINKING_TIERS[2].label)
    expect(thinkingPhrase(10 * 60_000)).toBe(THINKING_TIERS[2].label)
  })

  it('names the tool family, and switches to the long phrase only after it drags', () => {
    expect(toolPhrase('filesystem.search', 0)).toBe('digging through files')
    expect(toolPhrase('filesystem.search', TOOL_LONG_AFTER_MS)).toBe('still digging through files')
    expect(toolPhrase('browser.click', 0)).toBe('poking at the browser')
  })

  it('falls back to a neutral phrase for an unknown tool', () => {
    expect(toolPhrase('mystery.tool', 0)).toBe(STATUS_PHRASES.toolFallback)
    expect(toolPhrase('mystery.tool', TOOL_LONG_AFTER_MS)).toBe(STATUS_PHRASES.toolFallbackLong)
  })

  it('never claims work while idle', () => {
    const view = statusView('idle', 0, null)
    expect(view.label).toBe(STATUS_PHRASES.idle)
    expect(view.active).toBe(false)
    expect(view.heat).toBe(0)
  })
})

describe('escalation is capped, and visible from the first frame', () => {
  // These three assertions changed with the backdrop work. The old curve started
  // at 0 heat and ramped over 30 s, so on this machine — where a think lasts about
  // 2 s — the scene never got above 0.07 and the animation had nothing to show.
  // The point of heat is that a working Goga looks different from an idle one, so
  // every active phase now starts at a visible floor. The cap assertions are the
  // same guarantee as before: a long run never runs away.

  it('starts thinking at a visible heat and rises to 1', () => {
    expect(heatFor('thinking', 0)).toBeGreaterThanOrEqual(0.35)
    expect(heatFor('thinking', 10_000)).toBeGreaterThan(heatFor('thinking', 0))
    expect(heatFor('thinking', 10 * 60_000)).toBe(1)
  })

  it('done and idle are still completely still', () => {
    expect(heatFor('idle', 0)).toBe(0)
    expect(heatFor('done', 0)).toBe(0)
  })

  it('streaming holds a visible value, not a token one', () => {
    // Streaming is the state that actually lasts, so it must carry the animation.
    expect(heatFor('streaming', 0)).toBeGreaterThanOrEqual(0.4)
    expect(heatFor('streaming', 10 * 60_000)).toBe(heatFor('streaming', 0))
  })

  it('caps tool heat below full so a long tool call stays watchable', () => {
    expect(heatFor('tool', 10 * 60_000)).toBeLessThanOrEqual(0.9)
    expect(heatFor('tool', 10 * 60_000)).toBeGreaterThanOrEqual(0.8)
  })

  it('is zero for every settled phase', () => {
    for (const p of ['idle', 'error', 'done', 'stopped'] as const) expect(heatFor(p, 60_000)).toBe(0)
  })

  it('only the in-flight phases are active', () => {
    expect([...ACTIVE_PHASES].sort()).toEqual(['approval', 'streaming', 'thinking', 'tool'])
  })
})

describe('statusView', () => {
  it('carries the pending tool as detail while waiting on the user', () => {
    const view = statusView('approval', 0, state({ status: 'waiting-approval', pendingApproval: { id: 'a', tool: 'shell.execute', label: 'x' } }))
    expect(view.label).toBe(STATUS_PHRASES.approval)
    expect(view.detail).toBe('shell.execute')
    expect(view.tone).toBe('wait')
  })

  it('shows the error text as detail', () => {
    const view = statusView('error', 0, state({ status: 'error', error: 'model unreachable' }))
    expect(view.label).toBe(STATUS_PHRASES.error)
    expect(view.detail).toBe('model unreachable')
    expect(view.tone).toBe('bad')
  })
})

describe('pulse speed — capped, and stopped entirely when idle', () => {
  it('runs no animation at all in a settled phase', () => {
    for (const p of ['idle', 'error', 'done', 'stopped'] as const) {
      expect(pulseMsFor(p, 0)).toBe(0)
      expect(pulseMsFor(p, 1)).toBe(0)
    }
  })

  it('quickens with heat but never goes below the strobe floor', () => {
    const calm = pulseMsFor('thinking', 0)
    const hot = pulseMsFor('thinking', 1)
    expect(calm).toBe(PULSE_SLOW_MS)
    expect(hot).toBe(PULSE_FAST_MS)
    expect(hot).toBeLessThan(calm)
    // Never fast enough to read as a strobe, even if a caller passes nonsense heat.
    for (const h of [0, 0.25, 0.5, 0.75, 1, 5, -3, Number.NaN]) {
      const ms = pulseMsFor('tool', h)
      expect(ms).toBeGreaterThanOrEqual(PULSE_FAST_MS)
      expect(ms).toBeLessThanOrEqual(PULSE_SLOW_MS)
    }
  })

  it('gives every active phase a pulse and the settled ones none', () => {
    for (const p of ACTIVE_PHASES) expect(pulseMsFor(p, 0.5)).toBeGreaterThan(0)
  })
})
