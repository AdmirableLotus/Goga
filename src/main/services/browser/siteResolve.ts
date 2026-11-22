import type { ProgramImport } from '../../../shared/security'

/**
 * Where a Cantina request should actually point.
 *
 * Cantina publishes its own bounty program at /<org>/<program> on bounties.cantina.xyz, and the
 * directory of every program at cantina.xyz/bounties. Those are different pages: the directory
 * says nothing about scope, and the program page carries the scope, the two domains and the
 * rewards. A live run showed the cost of confusing them — "read the Cantina program page scope"
 * matched the word "Cantina", returned the directory, and nothing useful came back.
 *
 * So a request that names Cantina's *program* resolves to the program page, not the directory.
 * The handle is never invented: it is either Cantina's own published program handle or the
 * handle/url of an imported program record the user already has.
 */

/** Cantina's own bug-bounty program page — the one with cantina.xyz and cantina.security in scope. */
export const CANTINA_PROGRAM_URL = 'https://bounties.cantina.xyz/cantina/bug-bounty'

/** The directory of Cantina's programs. Not a scope page. */
export const CANTINA_DIRECTORY_URL = 'https://cantina.xyz/bounties'

export interface SiteTarget {
  url: string
  /** Which program this is, in words the reply can carry, so it is never a silent pick. */
  program: string
}

/** A program record the caller wants considered; defaults to the imported programs on disk. */
export type ProgramRef = Pick<ProgramImport, 'source' | 'handle' | 'name' | 'url'>

/**
 * The programs Goga already holds, read at call time.
 *
 * Loaded lazily so this module can be imported by a test that has no Electron present, and so
 * a missing or unreadable store simply means "no stored programs" rather than a crash.
 */
function defaultPrograms(): ProgramRef[] {
  try {
    const { listPrograms } = require('../security/store') as { listPrograms: () => ProgramRef[] }
    return listPrograms()
  } catch { return [] }
}

/** The words that make a request about a *program page* rather than the bounty directory. */
const PROGRAM_WORDS = /\b(program|programs|programme|scope|rules|program page)\b/i

/**
 * A named Cantina program in the request, resolved to its program page — or null.
 *
 * Fires only when the request names Cantina AND asks about a program. A request that merely
 * says "the cantina bounty" keeps the older behaviour and is handled by the caller.
 */
export function cantinaProgramTarget(task: string, programs: ProgramRef[] = defaultPrograms()): SiteTarget | null {
  const t = String(task ?? '')
  if (!/\bcantina\b/i.test(t)) return null
  if (!PROGRAM_WORDS.test(t)) return null

  // A specific program named in the request wins, when it matches a record Goga already holds.
  const named = programs.find(p => {
    const handle = String(p.handle ?? '').toLowerCase()
    const name = String(p.name ?? '').toLowerCase()
    const handleWords = handle.replace(/[-_]+/g, ' ').trim()
    return (handleWords.length > 2 && new RegExp(`\\b${escapeRe(handleWords)}\\b`, 'i').test(t))
      || (name.length > 3 && t.toLowerCase().includes(name))
  })
  if (named && named.url) {
    // Only a Cantina-hosted program page is reachable this way; anything else is not Cantina.
    try {
      const host = new URL(named.url).hostname.toLowerCase()
      if (host === 'bounties.cantina.xyz' || host === 'cantina.xyz') {
        return { url: named.url, program: named.name || named.handle }
      }
    } catch { /* an unparseable stored url is simply not used */ }
  }

  // No specific program named: Cantina's own program, said plainly rather than leaving the
  // reader to guess which of Cantina's programs was read.
  return { url: CANTINA_PROGRAM_URL, program: 'Cantina Bug Bounty Program (Cantina\'s own program, not the Uniswap bounty)' }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
