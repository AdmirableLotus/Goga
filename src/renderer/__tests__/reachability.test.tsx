// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { ALL_SECTIONS, NAV } from '../nav'

/**
 * Every folded page is still reachable.
 *
 * Two failure modes are ruled out here:
 *
 *   1. A section the nav offers that the shell cannot draw — a link to a blank pane.
 *   2. A page the shell draws that the nav never offers — a page hidden off-nav, which is how
 *      a "consolidation" quietly becomes a deletion.
 *
 * The check is structural: the shell's render switch and its imports are read from its own
 * source, and each page module is checked on disk. `npx tsc --noEmit` and `npm run build`
 * prove the modules compile and resolve; this proves the shell actually reaches them.
 */

const APP = path.resolve(__dirname, '..', 'App.tsx')
const source = fs.readFileSync(APP, 'utf8')

/** The section ids the shell's render switch actually draws. */
function renderedSections(): string[] {
  const found = new Set<string>()
  for (const m of source.matchAll(/section === '([a-z-]+)'/g)) found.add(m[1])
  return [...found]
}

/** The page modules the shell imports. */
function importedPages(): string[] {
  return [...source.matchAll(/import (\w+) from '\.\/pages\/(\w+)'/g)].map(m => m[2])
}

describe('the shell draws every section the nav offers', () => {
  it('has a render branch for each one', () => {
    const drawn = renderedSections()
    for (const { section } of ALL_SECTIONS) {
      expect(drawn, `nav offers "${section.id}" but App.tsx has no branch for it`).toContain(section.id)
    }
  })

  it('draws nothing the nav does not offer', () => {
    const offered = ALL_SECTIONS.map(s => s.section.id)
    for (const id of renderedSections()) {
      expect(offered, `App.tsx draws "${id}" but the nav never offers it`).toContain(id)
    }
  })

  it('keeps the exported section list in step with the nav model', () => {
    const block = source.match(/RENDERED_SECTIONS = \[([\s\S]*?)\]/)?.[1] ?? ''
    const listed = [...block.matchAll(/'([a-z-]+)'/g)].map(m => m[1])
    expect(new Set(listed)).toEqual(new Set(ALL_SECTIONS.map(s => s.section.id)))
  })
})

describe('every page module still exists and is still imported', () => {
  // The file each section renders. A folded page whose module was deleted, or whose import
  // was dropped from the shell, would pass a nav test and fail here.
  const modules: Record<string, string> = {
    chat: 'ChatPage', activity: 'ActivityPage', approvals: 'ApprovalsPage', settings: 'SettingsPage',
    security: 'SecurityPage', osint: 'OsintPage', engineering: 'EngineeringPage',
    trading: 'TradingPage', practice: 'VenuesPage', strategy: 'StrategyPage', markets: 'MarketsPage',
    business: 'BusinessPage', jobs: 'JobsPage',
    browser: 'BrowserPage', setup: 'SetupPage',
    memory: 'MemoryPage', library: 'LibraryPage', evolution: 'EvolutionPage', developer: 'DeveloperPage',
  }

  it('covers every section in the nav', () => {
    for (const { section } of ALL_SECTIONS) {
      expect(modules[section.id], `no page module recorded for section "${section.id}"`).toBeTruthy()
    }
  })

  it('has a real file for each one, exporting a component', () => {
    for (const [section, file] of Object.entries(modules)) {
      const full = path.resolve(__dirname, '..', 'pages', `${file}.tsx`)
      expect(fs.existsSync(full), `section "${section}" points at a missing page: ${file}.tsx`).toBe(true)
      const text = fs.readFileSync(full, 'utf8')
      expect(/export default function|export default \w+/.test(text), `${file}.tsx does not export a component`).toBe(true)
    }
  })

  it('is imported by the shell, so the render branch can reach it', () => {
    const imported = importedPages()
    for (const [section, file] of Object.entries(modules)) {
      expect(imported, `section "${section}" renders ${file} but App.tsx never imports it`).toContain(file)
    }
  })
})

describe('the nav is what the user asked for', () => {
  it('is nine destinations, and chat is the first', () => {
    expect(NAV).toHaveLength(9)
    expect(NAV[0].id).toBe('chat')
  })
})
