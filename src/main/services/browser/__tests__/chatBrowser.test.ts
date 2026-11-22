import { describe, expect, it, vi } from 'vitest'

/**
 * The chat path, held to the browser chosen in Settings — and to actually answering.
 *
 * Three defects from a run recorded on this repo, each pinned here:
 *
 *   1. browser.goto / browser.readPage went through the Firefox layer unconditionally, so
 *      browserEngine: "brave" was read only by the readiness display. The log from that run
 *      said "Opening ... in Goga's own Firefox" while Brave was the chosen engine.
 *   2. "read the Cantina program page scope" matched the word Cantina and returned the
 *      directory (cantina.xyz/bounties) instead of the program page, which is the only one
 *      that carries the scope.
 *   3. The run replied "On it, My Lady." and then produced nothing at all.
 *
 * The transports are faked here, so what is tested is the dispatch itself: which session a
 * read goes to, and what the turn says when the read cannot happen.
 */

import { createChatBrowser, type ChatBrowserDeps } from '../chatBrowser'
import { CANTINA_DIRECTORY_URL, CANTINA_PROGRAM_URL, cantinaProgramTarget } from '../siteResolve'

const SCOPE_TEXT = 'Cantina Bug Bounty Program. Scope: cantina.xyz and its subdomains, cantina.security and its '
  + 'subdomains. Critical $5,000. High $2,000. Out of scope: phishing, social engineering.'

function deps(over: Partial<ChatBrowserDeps> = {}): ChatBrowserDeps & {
  calls: string[]
} {
  const calls: string[] = []
  const base: ChatBrowserDeps = {
    engine: () => 'firefox',
    firefoxEnsure: async () => { calls.push('firefox.ensure'); return { ok: true } },
    firefoxNavigate: async (url: string) => { calls.push(`firefox.navigate ${url}`); return { url, title: 'Cantina' } },
    firefoxRead: async () => {
      calls.push('firefox.read')
      return { url: CANTINA_PROGRAM_URL, title: 'Cantina', text: 'firefox text', textClipped: false, elements: [] }
    },
    firefoxScreenshotToFile: async (p: string) => ({ path: p, bytes: 3 }),
    braveNavigateAndRead: async (url: string) => {
      calls.push(`brave.navigateAndRead ${url}`)
      return { ok: true, read: { url, title: 'Cantina', text: SCOPE_TEXT, textClipped: false, elements: [] }, message: 'Read it. Content rendered after 327 ms.' }
    },
    braveReadCurrent: async () => {
      calls.push('brave.readCurrent')
      return { ok: true, read: { url: CANTINA_PROGRAM_URL, title: 'Cantina', text: SCOPE_TEXT, textClipped: false, elements: [] }, message: 'Read it. Content rendered after 12 ms.' }
    },
    braveScreenshot: async () => { calls.push('brave.screenshot'); return { base64: Buffer.from('png').toString('base64'), url: CANTINA_PROGRAM_URL } },
    braveReadHosts: () => ['bounties.cantina.xyz', 'cantina.xyz'],
  }
  return Object.assign({ ...base, ...over }, { calls })
}

describe('a chat read goes to the browser chosen in Settings', () => {
  it('dispatches to the Brave session when browserEngine is brave', async () => {
    const d = deps({ engine: () => 'brave' })
    const browser = createChatBrowser(d)
    const r = await browser.openAndRead(CANTINA_PROGRAM_URL)

    expect(r.ok).toBe(true)
    expect(r.engine).toBe('brave')
    expect(d.calls).toEqual([`brave.navigateAndRead ${CANTINA_PROGRAM_URL}`])
    expect(d.calls.some(c => c.startsWith('firefox.'))).toBe(false)
    // The render note travels with the read, so a shell can never be passed off as the program.
    expect(r.message).toMatch(/Content rendered after \d+ ms/)
    expect(r.read?.text).toContain('$5,000')
  })

  it('dispatches to the Firefox layer when browserEngine is firefox', async () => {
    const d = deps({ engine: () => 'firefox' })
    const browser = createChatBrowser(d)
    const r = await browser.openAndRead(CANTINA_PROGRAM_URL)

    expect(r.ok).toBe(true)
    expect(r.engine).toBe('firefox')
    expect(d.calls).toEqual(['firefox.ensure', `firefox.navigate ${CANTINA_PROGRAM_URL}`, 'firefox.read'])
    expect(d.calls.some(c => c.startsWith('brave.'))).toBe(false)
    expect(r.message).toMatch(/Firefox/)
  })

  it('reads the open page through the same engine, not always Firefox', async () => {
    const d = deps({ engine: () => 'brave' })
    const r = await createChatBrowser(d).readCurrent()
    expect(d.calls).toEqual(['brave.readCurrent'])
    expect(r.read?.text).toContain('cantina.security')
  })

  it('does not silently fall back to the other browser when Brave refuses a host', async () => {
    // The Brave profile holds the Cantina login, so it reads Cantina hosts only. Sending the
    // request to Firefox instead would drive a browser the user did not pick.
    const d = deps({ engine: () => 'brave' })
    const r = await createChatBrowser(d).openAndRead('https://example.com/scope')

    expect(r.ok).toBe(false)
    expect(r.message).toContain('example.com is not a host')
    expect(d.calls).toEqual([])
  })

  it('reports the engine it used even when the read fails, so the reply can name it', async () => {
    const d = deps({
      engine: () => 'brave',
      braveNavigateAndRead: async () => { d.calls.push('brave.navigateAndRead failed'); return { ok: false, read: null, message: 'The Brave window closed before it could be read.' } },
    })
    const r = await createChatBrowser(d).openAndRead(CANTINA_PROGRAM_URL)
    expect(r.ok).toBe(false)
    expect(r.engine).toBe('brave')
    expect(r.message).toMatch(/Brave window closed/)
  })
})

describe('a named Cantina program resolves to its program page, not the directory', () => {
  it('resolves "read the Cantina program page scope" to the program URL', () => {
    const t = cantinaProgramTarget('read the Cantina program page scope')
    expect(t?.url).toBe(CANTINA_PROGRAM_URL)
    expect(t?.url).not.toBe(CANTINA_DIRECTORY_URL)
  })

  it('says which program it is reading rather than picking silently', () => {
    // "the Cantina program" is ambiguous: Cantina runs its own program and hosts Uniswap's.
    // The reply has to name the one it read.
    const t = cantinaProgramTarget('read the cantina program scope')
    expect(t?.program).toMatch(/Cantina Bug Bounty Program/)
    expect(t?.program).toMatch(/not the Uniswap bounty/)
  })

  it('uses the handle of a specific program the user already imported', () => {
    const programs = [
      { source: 'cantina' as const, handle: 'uniswap', name: 'Uniswap Labs / Uniswap bounty', url: 'https://bounties.cantina.xyz/uniswap/bug-bounty' },
    ]
    const t = cantinaProgramTarget('read the Uniswap program scope on Cantina', programs)
    expect(t?.url).toBe('https://bounties.cantina.xyz/uniswap/bug-bounty')
    expect(t?.program).toMatch(/Uniswap/)
  })

  it('never invents a slug: a program with no stored record falls back to Cantina\'s own page', () => {
    const t = cantinaProgramTarget('read the SomeMadeUpName program scope on Cantina', [])
    expect(t?.url).toBe(CANTINA_PROGRAM_URL)
  })

  it('does not fire on a request that does not name a program', () => {
    expect(cantinaProgramTarget('how much does cantina charge?')).toBeNull()
    expect(cantinaProgramTarget('read the hackerone program scope')).toBeNull()
    // No Cantina at all.
    expect(cantinaProgramTarget('open the Coinbase bug bounty page')).toBeNull()
  })
})
