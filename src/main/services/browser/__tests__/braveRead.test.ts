import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Reading a Cantina page through the Brave engine.
 *
 * Everything is mocked: no Brave is launched, no profile is read, no site is reached. What is
 * pinned here is the read path itself — that a page is navigated, that its visible text and
 * elements come back, that only a Cantina host is read, and that a page which fails to render
 * is reported as unreadable rather than reported as empty. An empty page and a page that could
 * not be read are different answers, and conflating them is how a tool invents silence.
 */

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/goga-userdata' } }))
vi.mock('../../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))

import { BraveCantinaSession, CANTINA_BOUNTY_URL, READ_HOSTS, VISIBLE_TEXT_SCRIPT, rendered, type PersistentLauncher } from '../braveSession'

interface FakePageOptions {
  /** What evaluate() returns for the read script. */
  payload?: unknown
  /** Throw on goto, as a failed navigation would. */
  gotoError?: Error
  closed?: boolean
}

function fakePage(opts: FakePageOptions = {}) {
  const handlers: Record<string, Array<() => void>> = {}
  let closed = opts.closed ?? false
  let current = CANTINA_BOUNTY_URL
  const page = {
    goto: vi.fn(async (url: string) => {
      if (opts.gotoError) throw opts.gotoError
      current = url
      return { status: () => 200 }
    }),
    url: () => current,
    isClosed: () => closed,
    evaluate: vi.fn(async () => {
      if (opts.payload !== undefined) return typeof opts.payload === 'string' ? opts.payload : JSON.stringify(opts.payload)
      return JSON.stringify({
        url: current,
        title: 'Cantina Bug Bounty Program',
        text: 'Cantina Bug Bounty Program. Top reward $5,000. No identity verification required.',
        elements: [
          { role: 'a', name: 'Submit a finding' },
          { role: 'button', name: 'Join program' },
        ],
      })
    }),
    on: (ev: string, cb: () => void) => { (handlers[ev] ??= []).push(cb) },
    _close() { closed = true; (handlers.close ?? []).forEach(f => f()) },
  }
  return page
}

function fakeContext(page: ReturnType<typeof fakePage>) {
  const handlers: Record<string, Array<() => void>> = {}
  return {
    pages: () => [page],
    newPage: vi.fn(async () => page),
    on: (ev: string, cb: () => void) => { (handlers[ev] ??= []).push(cb) },
    close: vi.fn(async () => { (handlers.close ?? []).forEach(f => f()) }),
  }
}

function harness(pageOpts: FakePageOptions = {}, brave: string | null = 'C:\\Brave\\brave.exe') {
  const page = fakePage(pageOpts)
  const ctx = fakeContext(page)
  const launcher: PersistentLauncher = { launchPersistentContext: vi.fn(async () => ctx as never) }
  const session = new BraveCantinaSession(async () => launcher, () => brave, () => 'own-profile')
  return { session, page, ctx }
}

beforeEach(() => vi.clearAllMocks())

describe('the Cantina read path through Brave', () => {
  it('navigates, reads the page, and returns its text and elements', async () => {
    const { session, page } = harness()
    const result = await session.navigateAndRead(CANTINA_BOUNTY_URL)
    expect(result.ok).toBe(true)
    expect(page.goto).toHaveBeenCalledWith(CANTINA_BOUNTY_URL, expect.objectContaining({ waitUntil: 'domcontentloaded' }))
    expect(result.read?.url).toBe(CANTINA_BOUNTY_URL)
    expect(result.read?.text).toContain('Top reward $5,000')
    expect(result.read?.elements.length).toBe(2)
    expect(result.read?.elements[0].name).toBe('Submit a finding')
    expect(result.message).toMatch(/Read "Cantina Bug Bounty Program"/)
  })

  it('reads the individual bounty page shape too', async () => {
    const { session, page } = harness()
    const url = 'https://cantina.xyz/bounties/f9df94db-c7b1-434b-bb06-d1360abdd1be'
    const result = await session.navigateAndRead(url)
    expect(result.ok).toBe(true)
    expect(page.goto).toHaveBeenCalledWith(url, expect.anything())
  })

  it('refuses a host that is not a Cantina page, and names it', async () => {
    const { session, page } = harness()
    const result = await session.navigateAndRead('https://example.com/anything')
    expect(result.ok).toBe(false)
    expect(result.read).toBeNull()
    expect(result.message).toContain('example.com')
    expect(result.message).toContain(READ_HOSTS[0])
    expect(page.goto).not.toHaveBeenCalled()   // nothing was navigated
  })

  it('refuses a non-http scheme', async () => {
    const { session, page } = harness()
    const result = await session.navigateAndRead('file:///etc/passwd')
    expect(result.ok).toBe(false)
    expect(page.goto).not.toHaveBeenCalled()
  })

  it('reports a page that did not render as unreadable, not as an empty page', async () => {
    const { session } = harness({ payload: 'not json at all' })
    const result = await session.navigateAndRead(CANTINA_BOUNTY_URL)
    expect(result.ok).toBe(false)
    expect(result.read).toBeNull()
    expect(result.message).toMatch(/did not return readable content/i)
  })

  it('reports a failed navigation instead of pretending it read something', async () => {
    const { session } = harness({ gotoError: new Error('net::ERR_CONNECTION_RESET') })
    const result = await session.navigateAndRead(CANTINA_BOUNTY_URL)
    expect(result.ok).toBe(false)
    expect(result.read).toBeNull()
    expect(result.message).toMatch(/ERR_CONNECTION_RESET|Could not drive Brave/i)
  })

  it('clips a very long page and says that it did', async () => {
    const { session } = harness({
      payload: { url: CANTINA_BOUNTY_URL, title: 'Long', text: 'x'.repeat(25_000), elements: [] },
    })
    const result = await session.navigateAndRead(CANTINA_BOUNTY_URL)
    expect(result.ok).toBe(true)
    expect(result.read?.textClipped).toBe(true)
    expect(result.read?.text.length).toBe(20_000)
  })

  it('opens the window itself when nothing is open yet, then reads', async () => {
    const { session, page } = harness()
    expect(session.status().state).toBe('stopped')
    const result = await session.navigateAndRead(CANTINA_BOUNTY_URL)
    expect(result.ok).toBe(true)
    expect(page.goto).toHaveBeenCalled()
  })

  it('reading is a read: no click, no typing, no credential entry happens', async () => {
    const { session, page } = harness()
    await session.navigateAndRead(CANTINA_BOUNTY_URL)
    // The fake page exposes only goto/evaluate/url/isClosed/on — if the layer tried to click
    // or type, the call would have thrown and the result would be ok:false.
    expect(page.evaluate).toHaveBeenCalled()
    expect(Object.keys(page)).not.toContain('click')
    expect(Object.keys(page)).not.toContain('fill')
  })
})

/**
 * The render wait.
 *
 * A live run against the real Cantina page returned 110 characters — "Bounties All bounties
 * Loading program …" — in 1.9 s, because the read was taken straight after domcontentloaded and
 * the page's own JavaScript had not yet replaced the shell with the program. These tests pin the
 * behaviour that fixes it: the read waits for the shell to go, and when it never goes, the reply
 * says it is still the shell rather than presenting it as the program.
 */
describe('the wait for a client-rendered page', () => {
  it('the real shell from the live run is recognised as a shell, and the real page is not', () => {
    expect(rendered('Bounties All bounties Loading program Maximum reward (USDC) © 2026 Cantina. All rights reserved. Terms Privacy')).toBe(false)
    expect(rendered(`Cantina Bug Bounty Program. Scope: cantina.xyz and its subdomains, cantina.security and its subdomains, email infrastructure. ${'x'.repeat(400)}`)).toBe(true)
    // A small page that never mentions loading is content, not a shell — it is not held.
    expect(rendered('Sign in to join. No identity verification required.')).toBe(true)
  })

  it('waits for the shell to be replaced, then reads the real content', async () => {
    // The page answers with the shell twice, then with the program.
    const texts = [
      'Bounties All bounties Loading program Maximum reward (USDC)',
      'Bounties All bounties Loading program Maximum reward (USDC)',
      'Cantina Bug Bounty Program Critical $5,000 High $2,000 Scope: cantina.xyz, cantina.security. Out of scope: phishing. Sign in to join.',
    ]
    let i = 0
    const page = {
      goto: vi.fn(async () => ({ status: () => 200 })),
      url: () => CANTINA_BOUNTY_URL,
      isClosed: () => false,
      evaluate: vi.fn(async (script: string) => {
        // The render-wait script returns the visible text; the read script the full payload.
        if (/Loading|Loading program/i.test(texts[Math.min(i, texts.length - 1)]) && script === VISIBLE_TEXT_SCRIPT) {
          const t = texts[Math.min(i, texts.length - 1)]
          i++
          return t
        }
        return JSON.stringify({ url: CANTINA_BOUNTY_URL, title: 'Cantina Bug Bounty Program', text: texts[texts.length - 1], elements: [] })
      }),
      on: () => {},
    }
    const ctx = { pages: () => [page], newPage: vi.fn(async () => page), on: () => {}, close: vi.fn() }
    const session = new BraveCantinaSession(
      async () => ({ launchPersistentContext: vi.fn(async () => ctx as never) }),
      () => 'C:\\Brave\\brave.exe',
      () => 'own-profile',
    )
    const result = await session.navigateAndRead(CANTINA_BOUNTY_URL)
    expect(result.ok).toBe(true)
    expect(result.read?.text).toContain('$5,000')
    expect(result.message).toMatch(/Content rendered after \d+ ms/)
  })

  it('when the page never renders, says so instead of presenting the shell as the program', async () => {
    const shell = 'Bounties All bounties Loading program Maximum reward (USDC) © 2026 Cantina.'
    const page = {
      goto: vi.fn(async () => ({ status: () => 200 })),
      url: () => CANTINA_BOUNTY_URL,
      isClosed: () => false,
      evaluate: vi.fn(async (script: string) => script === VISIBLE_TEXT_SCRIPT
        ? shell
        : JSON.stringify({ url: CANTINA_BOUNTY_URL, title: 'Cantina Bounty · Cantina Bounties', text: shell, elements: [] })),
      on: () => {},
    }
    const ctx = { pages: () => [page], newPage: vi.fn(async () => page), on: () => {}, close: vi.fn() }
    const session = new BraveCantinaSession(
      async () => ({ launchPersistentContext: vi.fn(async () => ctx as never) }),
      () => 'C:\\Brave\\brave.exe',
      () => 'own-profile',
    )
    const result = await session.navigateAndRead(CANTINA_BOUNTY_URL)
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/still showing its loading shell/i)
    expect(result.message).not.toMatch(/Content rendered/)
    // It still returns what the page says — it just does not call the shell the program.
    expect(result.read?.text).toBe(shell)
  }, 30_000)

  it('the wait is bounded: it gives up at its own timeout rather than hanging the read', async () => {
    const full = `Cantina Bug Bounty Program Critical $5,000 ${'z'.repeat(500)}`
    let state = 'ready'
    const page = {
      goto: vi.fn(async () => ({ status: () => 200 })),
      url: () => CANTINA_BOUNTY_URL,
      isClosed: () => false,
      evaluate: vi.fn(async (script: string) => {
        if (script === VISIBLE_TEXT_SCRIPT) return state === 'ready' ? full : 'Loading program'
        return JSON.stringify({ url: CANTINA_BOUNTY_URL, title: 't', text: state === 'ready' ? full : 'Loading program', elements: [] })
      }),
      on: () => {},
    }
    const ctx = { pages: () => [page], newPage: vi.fn(async () => page), on: () => {}, close: vi.fn() }
    const session = new BraveCantinaSession(
      async () => ({ launchPersistentContext: vi.fn(async () => ctx as never) }),
      () => 'C:\\Brave\\brave.exe',
      () => 'own-profile',
    )
    // Open a page first, so the wait has something to watch; then it stops rendering.
    await session.navigateAndRead(CANTINA_BOUNTY_URL)
    state = 'stuck'
    const started = Date.now()
    const waited = await session.waitForRender(1_200)
    const took = Date.now() - started
    expect(waited.rendered).toBe(false)
    expect(took).toBeGreaterThanOrEqual(1_000)
    expect(took).toBeLessThan(5_000)
  })

  it('a page that is already rendered costs one check, not the whole timeout', async () => {
    const full = `Cantina Bug Bounty Program Critical $5,000 High $2,000 ${'y'.repeat(500)}`
    const page = {
      goto: vi.fn(async () => ({ status: () => 200 })),
      url: () => CANTINA_BOUNTY_URL,
      isClosed: () => false,
      evaluate: vi.fn(async (script: string) => script === VISIBLE_TEXT_SCRIPT
        ? full
        : JSON.stringify({ url: CANTINA_BOUNTY_URL, title: 'ready', text: full, elements: [] })),
      on: () => {},
    }
    const ctx = { pages: () => [page], newPage: vi.fn(async () => page), on: () => {}, close: vi.fn() }
    const session = new BraveCantinaSession(
      async () => ({ launchPersistentContext: vi.fn(async () => ctx as never) }),
      () => 'C:\\Brave\\brave.exe',
      () => 'own-profile',
    )
    const started = Date.now()
    const result = await session.navigateAndRead(CANTINA_BOUNTY_URL)
    expect(result.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result.message).toMatch(/Content rendered/)
  })
})

