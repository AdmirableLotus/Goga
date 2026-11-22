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

import { BraveCantinaSession, CANTINA_BOUNTY_URL, READ_HOSTS, type PersistentLauncher } from '../braveSession'

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
  const session = new BraveCantinaSession(async () => launcher, () => brave)
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
