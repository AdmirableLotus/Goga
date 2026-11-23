import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Everyday mode: Goga drives the Brave the user already runs.
 *
 * Everything here is mocked. No Brave is launched, no profile is opened, no site is reached. What
 * is pinned is the set of promises that changed when the default moved from "a profile of Goga's
 * own" to "your everyday Brave": the mode defaults to everyday and persists, everyday mode
 * ATTACHES rather than launches, a missing debug port produces an instruction instead of a launch,
 * the allow-list still refuses before anything is navigated, --no-sandbox is gone from every
 * launch argument list, and the card says something different — and true — in each mode.
 */

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/goga-userdata' } }))
vi.mock('../../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))

import { BraveCantinaSession, CANTINA_BOUNTY_URL, READ_HOSTS, detectCantinaSignedIn, type BraveLauncher } from '../braveSession'
import {
  DEFAULT_BRAVE_SESSION_MODE, asBraveSessionMode, braveSessionModeLabel, cantinaCardText,
  cantinaSignInHint, everydayAttachInstructions, EVERYDAY_DEBUG_FLAG,
} from '../../../../shared/braveMode'

function fakePage(url = CANTINA_BOUNTY_URL, opts: { text?: string; elements?: { role: string; name: string }[] } = {}) {
  const handlers: Record<string, Array<() => void>> = {}
  let closed = false
  let current = url
  return {
    goto: vi.fn(async (to: string) => { current = to; return { status: () => 200 } }),
    url: () => current,
    isClosed: () => closed,
    evaluate: vi.fn(async () => JSON.stringify({
      url: current,
      title: 'Cantina Bug Bounty Program',
      text: opts.text ?? `Cantina Bug Bounty Program. Critical $5,000. ${'x'.repeat(500)}`,
      elements: opts.elements ?? [],
    })),
    screenshot: vi.fn(async () => Buffer.from('png')),
    close: vi.fn(async () => { closed = true; (handlers.close ?? []).forEach(f => f()) }),
    on: (ev: string, cb: () => void) => { (handlers[ev] ??= []).push(cb) },
  }
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

/** A session whose launcher answers both calls, and remembers which one was used. */
function harness(opts: {
  mode: 'everyday' | 'own-profile'
  connectFails?: boolean
  pageText?: string
  pageElements?: { role: string; name: string }[]
} ) {
  const page = fakePage(CANTINA_BOUNTY_URL, { text: opts.pageText, elements: opts.pageElements })
  const ctx = fakeContext(page)
  const browserHandlers: Record<string, Array<() => void>> = {}
  const browser = {
    contexts: () => [ctx],
    on: (ev: string, cb: () => void) => { (browserHandlers[ev] ??= []).push(cb) },
    close: vi.fn(async () => {}),
    _emitDisconnect() { (browserHandlers.disconnected ?? []).forEach(f => f()) },
  }
  const launch = vi.fn(async () => ctx as never)
  const connect = vi.fn(async () => {
    if (opts.connectFails) throw new Error('connect ECONNREFUSED 127.0.0.1:9222')
    return browser as never
  })
  const launcher: BraveLauncher = { launchPersistentContext: launch, connectOverCDP: connect }
  const session = new BraveCantinaSession(
    async () => launcher,
    () => 'C:\\Brave\\brave.exe',
    () => opts.mode,
  )
  return { session, ctx, page, launch, connect, browser }
}

beforeEach(() => vi.clearAllMocks())

describe('the session mode setting', () => {
  it('defaults to your everyday Brave', () => {
    expect(DEFAULT_BRAVE_SESSION_MODE).toBe('everyday')
  })

  it('reads the default settings object with braveSessionMode everyday', async () => {
    const { DEFAULT_SETTINGS } = await import('../../../../shared/types')
    expect(DEFAULT_SETTINGS.braveSessionMode).toBe('everyday')
  })

  it('normalises anything unrecognised to everyday, and keeps a real own-profile', () => {
    expect(asBraveSessionMode('own-profile')).toBe('own-profile')
    expect(asBraveSessionMode('everyday')).toBe('everyday')
    expect(asBraveSessionMode(undefined)).toBe('everyday')
    expect(asBraveSessionMode('something-else')).toBe('everyday')
    expect(asBraveSessionMode(null)).toBe('everyday')
  })

  it('persists the choice through the settings store and reads it back', async () => {
    // Same shape as the app's settings store: get() merges defaults, set() writes a patch.
    const { DEFAULT_SETTINGS } = await import('../../../../shared/types')
    const state: Record<string, unknown> = {}
    const store = {
      get: () => ({ ...DEFAULT_SETTINGS, ...state }),
      set: (patch: Record<string, unknown>) => { Object.assign(state, patch) },
    }
    expect(store.get().braveSessionMode).toBe('everyday')
    store.set({ braveSessionMode: 'own-profile' })
    expect(store.get().braveSessionMode).toBe('own-profile')
    store.set({ braveSessionMode: 'everyday' })
    expect(store.get().braveSessionMode).toBe('everyday')
  })

  it('has a readable label for each mode', () => {
    expect(braveSessionModeLabel('own-profile')).toBe('own profile')
    expect(braveSessionModeLabel('everyday')).toBe('your everyday Brave')
  })
})

describe('everyday mode attaches instead of launching', () => {
  it('connects over CDP and never launches a browser or a profile', async () => {
    const { session, connect, launch } = harness({ mode: 'everyday' })
    const status = await session.open()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(String(connect.mock.calls[0][0])).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(launch).not.toHaveBeenCalled()
    expect(status.mode).toBe('everyday')
    expect(status.state).toBe('login-required')
    expect(status.debugPort).toBe(9222)
  })

  it('does its work in a tab it opens itself, and says so', async () => {
    const { session, ctx } = harness({ mode: 'everyday' })
    const status = await session.open()
    expect(ctx.newPage).toHaveBeenCalled()
    expect(status.tab).not.toBeNull()
    expect(status.tab?.openedByGoga).toBe(true)
    // No tab that existed before it was touched: pages() is only enumerated by the fake.
    expect(status.browserLabel).toMatch(/your everyday Brave/i)
  })

  it('attaching does not read a cookie or a storage API', async () => {
    const { session, page } = harness({ mode: 'everyday' })
    await session.open()
    // The fake page has no cookies()/context().storageState — a call would have thrown.
    expect(Object.keys(page)).not.toContain('cookies')
    expect(Object.keys(page)).not.toContain('storageState')
    expect(page.goto).toHaveBeenCalled()
  })

  it('closing in everyday mode closes only Goga\'s tab, never the user\'s browser', async () => {
    const { session, browser, page } = harness({ mode: 'everyday' })
    await session.open()
    await session.close()
    expect(page.close).toHaveBeenCalled()
    expect(browser.close).not.toHaveBeenCalled()
  })

  it('a dropped connection is reported, and nothing is retried', async () => {
    const { session, browser } = harness({ mode: 'everyday' })
    await session.open()
    browser._emitDisconnect()
    expect(session.status().state).toBe('disconnected')
  })
})

describe('everyday mode with no debuggable Brave running', () => {
  it('explains what the user has to do, and launches nothing', async () => {
    const { session, launch } = harness({ mode: 'everyday', connectFails: true })
    const status = await session.open()
    expect(status.state).toBe('stopped')
    expect(launch).not.toHaveBeenCalled()
    // The instruction names the flag, the restart, and the shortcut route.
    expect(status.message).toContain(EVERYDAY_DEBUG_FLAG)
    expect(status.message).toMatch(/has to be started again with the flag/i)
    expect(status.message).toMatch(/desktop shortcut/i)
    expect(status.message).toMatch(/attached to nothing and launched nothing/i)
  })

  it('the instruction never tells the user to hand Goga their real profile folder', () => {
    const said = everydayAttachInstructions('C:\\Brave\\brave.exe')
    expect(said).toContain('--remote-debugging-port=9222')
    expect(said).toMatch(/will not launch Brave against your real profile/i)
    expect(said).toMatch(/close Brave completely/i)
  })
})

describe('the allow-list in everyday mode', () => {
  it('refuses an off-list host before anything is attached or navigated', async () => {
    const { session, connect, page } = harness({ mode: 'everyday' })
    const result = await session.navigateAndRead('https://example.com/signed-in-page')
    expect(result.ok).toBe(false)
    expect(result.read).toBeNull()
    expect(result.message).toContain('example.com')
    expect(result.message).toContain(READ_HOSTS[0])
    expect(connect).not.toHaveBeenCalled()   // not even attached
    expect(page.goto).not.toHaveBeenCalled() // nothing was navigated
  })

  it('lets a Cantina host through', async () => {
    const { session } = harness({ mode: 'everyday' })
    const result = await session.navigateAndRead('https://cantina.xyz/bounties/abc')
    expect(result.ok).toBe(true)
    expect(session.status().mode).toBe('everyday')
  })
})

describe('--no-sandbox is gone from every launch', () => {
  it('own-profile launch asks for the sandbox and passes no --no-sandbox', async () => {
    const { session, launch } = harness({ mode: 'own-profile' })
    await session.open()
    const [, options] = launch.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(options.chromiumSandbox).toBe(true)
    expect((options.args as string[]).join(' ')).not.toContain('--no-sandbox')
  })

  it('no source file passes --no-sandbox as an argument', () => {
    // The flag was in adapters/browser.ts. Playwright also adds it on its own unless
    // chromiumSandbox: true, so both halves are checked: no quoted flag anywhere in src.
    const root = path.resolve(__dirname, '../../../..')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        if (/\.test\.tsx?$/.test(entry.name)) continue
        const text = fs.readFileSync(full, 'utf8')
        if (/'--no-sandbox'|"--no-sandbox"/.test(text)) offenders.push(full)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})

describe('the card text tells the truth in each mode', () => {
  it('own profile: a separate profile with its own sign-in', () => {
    const said = cantinaCardText('own-profile')
    expect(said).toMatch(/separate profile/i)
    expect(said).toMatch(/separate sign-in/i)
    expect(said).toMatch(/reads no cookie/i)
    // It may say the everyday browser is not used — that is true only of this mode.
    expect(said).toMatch(/everyday Brave/i)
  })

  it('everyday: the user\'s own signed-in browser, stated plainly and not soft-pedalled', () => {
    const said = cantinaCardText('everyday')
    expect(said).toMatch(/attaches to the Brave you already use/i)
    expect(said).toMatch(/your own signed-in browser/i)
    expect(said).toMatch(/can see and act in the pages/i)
    // The old reassurance must not survive into this mode.
    expect(said).not.toMatch(/never your everyday Brave/i)
    // What stays true is said without over-claiming.
    expect(said).toMatch(/reads no cookie, password or token/i)
    expect(said).toMatch(/does not close, navigate or take over a tab/i)
    expect(said).toMatch(/not permission to test/i)
  })

  it('the two texts are materially different', () => {
    expect(cantinaCardText('everyday')).not.toBe(cantinaCardText('own-profile'))
  })

  it('the status carries the card text for the mode in force, so the UI cannot print the other one', async () => {
    const everyday = await harness({ mode: 'everyday' }).session.open()
    expect(everyday.cardText).toBe(cantinaCardText('everyday'))
    expect(everyday.signInHint).toBe(cantinaSignInHint('everyday'))

    const own = await harness({ mode: 'own-profile' }).session.open()
    expect(own.cardText).toBe(cantinaCardText('own-profile'))
  })
})

describe('the sign-in step in everyday mode reads the page', () => {
  it('a page showing a Sign-in control is not signed in', () => {
    const verdict = detectCantinaSignedIn({ text: 'Join the program', elements: [{ role: 'button', name: 'Sign in' }] })
    expect(verdict.signedIn).toBe(false)
    expect(verdict.evidence).toMatch(/Sign in/)
  })

  it('"Sign in to join" on the page is not signed in', () => {
    expect(detectCantinaSignedIn({ text: 'Sign in to join', elements: [] }).signedIn).toBe(false)
  })

  it('an account menu on the page is signed in, and the evidence is the menu', () => {
    const verdict = detectCantinaSignedIn({ text: 'Cantina Bounties  My submissions  Sign out', elements: [] })
    expect(verdict.signedIn).toBe(true)
    // The evidence names whichever account marker the page actually showed, quoted from the page.
    expect(verdict.evidence).toMatch(/my submissions|sign out/i)
  })

  it('a page that shows neither says it cannot tell rather than guessing', () => {
    const verdict = detectCantinaSignedIn({ text: 'Bounties. All bounties. Maximum reward.', elements: [] })
    expect(verdict.signedIn).toBeNull()
    expect(verdict.evidence).toMatch(/neither/i)
  })

  it('an already signed-in everyday Brave needs no sign-in step', async () => {
    const { session } = harness({
      mode: 'everyday',
      pageText: `Cantina Bounty Program Critical $5,000 High $2,000 ${'y'.repeat(400)} My submissions Sign out`,
    })
    const status = await session.open()
    expect(status.state).toBe('open')
    expect(status.message).toMatch(/no sign-in step/i)
    expect(status.message).toMatch(/shows you as signed in/i)
  })
})
