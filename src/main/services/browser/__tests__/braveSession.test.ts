import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Everything is mocked: no Brave is launched, no profile is read, no site is reached. The tests pin
 * the safety-critical promises — a DEDICATED profile (never the user's real one), NO remote-debugging
 * port, a clean refusal when Brave is missing, and no false "signed in" that the user did not confirm.
 */

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/goga-userdata' } }))
vi.mock('../../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))

import { BraveCantinaSession, CANTINA_BOUNTY_URL, type PersistentLauncher } from '../braveSession'

function fakePage(url = CANTINA_BOUNTY_URL) {
  const handlers: Record<string, Array<() => void>> = {}
  let closed = false
  return {
    goto: vi.fn(async () => {}),
    url: () => url,
    isClosed: () => closed,
    on: (ev: string, cb: () => void) => { (handlers[ev] ??= []).push(cb) },
    _close() { closed = true; (handlers.close ?? []).forEach(f => f()) },
  }
}

function fakeContext() {
  const page = fakePage()
  const handlers: Record<string, Array<() => void>> = {}
  return {
    pages: () => [page],
    newPage: vi.fn(async () => page),
    on: (ev: string, cb: () => void) => { (handlers[ev] ??= []).push(cb) },
    close: vi.fn(async () => { (handlers.close ?? []).forEach(f => f()) }),
    _page: page,
    _emitClose() { (handlers.close ?? []).forEach(f => f()) },
  }
}

function harness(opts: { brave?: string | null } = {}) {
  const ctx = fakeContext()
  const launch = vi.fn(async (_dir: string, _o: Record<string, unknown>) => ctx as any)
  const launcher: PersistentLauncher = { launchPersistentContext: launch }
  const session = new BraveCantinaSession(
    async () => launcher,
    () => (opts.brave === undefined ? 'C:\\Brave\\brave.exe' : opts.brave),
    () => 'own-profile',
  )
  return { session, ctx, launch }
}

beforeEach(() => vi.clearAllMocks())

describe('BraveCantinaSession', () => {
  it('refuses cleanly when Brave is not installed — launches nothing', async () => {
    const { session, launch } = harness({ brave: null })
    const status = await session.open()
    expect(status.state).toBe('stopped')
    expect(status.message).toMatch(/GOGA_BRAVE_PATH/)
    expect(status.message).toMatch(/not open a different browser/i)
    expect(launch).not.toHaveBeenCalled()
  })

  it('opens Brave in a DEDICATED profile, with no remote-debugging port', async () => {
    const { session, launch } = harness()
    const status = await session.open()
    expect(launch).toHaveBeenCalledTimes(1)
    const [profileDir, options] = launch.mock.calls[0]
    // Dedicated profile — never the user's everyday Brave profile.
    expect(profileDir).toMatch(/brave-cantina-profile/)
    expect(profileDir).not.toMatch(/BraveSoftware|User Data/i)
    expect(options.executablePath).toBe('C:\\Brave\\brave.exe')
    expect(options.headless).toBe(false)
    // No debug interface is opened.
    const args = (options.args as string[]) ?? []
    expect(args.join(' ')).not.toMatch(/remote-debugging/)
    expect(status.state).toBe('login-required')
    expect(status.url).toBe(CANTINA_BOUNTY_URL)
  })

  it('navigates the opened page to the Cantina bug-bounty URL', async () => {
    const { session, ctx } = harness()
    await session.open()
    expect(ctx._page.goto).toHaveBeenCalledWith(CANTINA_BOUNTY_URL, expect.objectContaining({ waitUntil: 'domcontentloaded' }))
  })

  it('does not claim "signed in" on its own — stays login-required until the user confirms', async () => {
    const { session } = harness()
    const opened = await session.open()
    expect(opened.state).toBe('login-required')
    const confirmed = session.confirmSignedIn()
    expect(confirmed.state).toBe('open')
    expect(confirmed.message).toMatch(/did not verify this itself/i)
  })

  it('will not confirm a sign-in when no window is open', async () => {
    const { session } = harness()
    const status = session.confirmSignedIn()
    expect(status.state).toBe('stopped')
    expect(status.message).toMatch(/Open Brave for Cantina first/i)
  })

  it('reuses the open window instead of relaunching', async () => {
    const { session, launch } = harness()
    await session.open()
    await session.open()
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('drops to disconnected when the window closes — no retry, no false success', async () => {
    const { session, ctx } = harness()
    await session.open()
    ctx._emitClose()
    expect(session.status().state).toBe('disconnected')
  })

  it('close() stops the session but keeps the on-disk profile', async () => {
    const { session, ctx } = harness()
    await session.open()
    const status = await session.close()
    expect(ctx.close).toHaveBeenCalled()
    expect(status.state).toBe('stopped')
  })
})
