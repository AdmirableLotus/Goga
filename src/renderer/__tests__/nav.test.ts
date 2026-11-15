import { describe, expect, it } from 'vitest'
import { ALL_SECTIONS, LEGACY_TABS, NAV, destinationOf, resolveLegacy } from '../nav'

/**
 * The navigation is nine destinations, and nothing was lost getting there.
 *
 * The user's complaint was the tab count itself: twenty tabs where he was still doing the
 * work. The fix is a shorter nav with chat as the front door — but a shorter nav that quietly
 * drops a page is a deleted feature, not a redesign. These tests hold both halves: the count
 * is down, and every tab that existed before still resolves to a section that renders.
 */

describe('the nav is short', () => {
  it('has nine destinations, not twenty tabs', () => {
    expect(NAV).toHaveLength(9)
    expect(NAV.map(d => d.id)).toEqual([
      'chat', 'security', 'trading', 'work', 'machine', 'memory', 'activity', 'approvals', 'settings',
    ])
  })

  it('keeps chat first, because it is the front door', () => {
    expect(NAV[0].id).toBe('chat')
    expect(NAV[0].sections).toHaveLength(1)
  })

  it('keeps Settings, Activity and Approvals as their own destinations', () => {
    for (const id of ['settings', 'activity', 'approvals'] as const) {
      const dest = NAV.find(d => d.id === id)
      expect(dest, id).toBeDefined()
      expect(dest!.sections).toHaveLength(1)
    }
  })

  it('gives every destination a purpose a person can read', () => {
    for (const d of NAV) expect(d.purpose.length).toBeGreaterThan(20)
  })
})

describe('nothing became unreachable', () => {
  it('resolves every tab that existed before the consolidation', () => {
    for (const tab of LEGACY_TABS) {
      const hit = resolveLegacy(tab)
      expect(hit, `old tab "${tab}" no longer resolves`).not.toBeNull()
      expect(hit!.destination).toBeTruthy()
      expect(hit!.section).toBeTruthy()
    }
  })

  it('has no duplicate section ids, so a section cannot shadow another', () => {
    const ids = ALL_SECTIONS.map(s => s.section.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has no duplicate legacy ids, so an old link lands in one place', () => {
    const legacy = ALL_SECTIONS.map(s => s.section.legacy)
    expect(new Set(legacy).size).toBe(legacy.length)
  })

  it('puts each folded page in the destination the grouping promised', () => {
    const expected: Record<string, string> = {
      // one security-research surface
      security: 'security', osint: 'security', engineering: 'security',
      // one trading surface
      trading: 'trading', practice: 'trading', strategy: 'trading', markets: 'trading',
      // one work surface
      business: 'work', jobs: 'work',
      // one machine surface
      browser: 'machine', setup: 'machine',
      // one memory surface
      memory: 'memory', library: 'memory', evolution: 'memory', developer: 'memory',
    }
    for (const [section, destination] of Object.entries(expected)) {
      expect(destinationOf(section), section).toBe(destination)
    }
  })

  it('returns null for a section that does not exist rather than guessing', () => {
    expect(destinationOf('nope')).toBeNull()
    expect(resolveLegacy('nope')).toBeNull()
  })
})

describe('the old tab list is genuinely gone', () => {
  it('no longer has a top-level tab for a folded page', () => {
    const topLevel = NAV.map(d => d.id) as string[]
    for (const folded of ['osint', 'engineering', 'practice', 'strategy', 'markets', 'business', 'jobs', 'browser', 'setup', 'library', 'evolution', 'developer']) {
      expect(topLevel, `"${folded}" is still a top-level tab`).not.toContain(folded)
    }
  })
})
