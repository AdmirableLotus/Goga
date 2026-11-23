import { asBrowserEngine, type BrowserEngine } from './engine'

/**
 * Which browser a chat request drives — the one the user chose in Settings.
 *
 * The chat tools used to go through the Firefox layer unconditionally, so `browserEngine:
 * "brave"` was read in exactly one place (the readiness display) and never by the path a chat
 * request actually takes. A live run showed it: the user had Brave chosen, asked Goga to read a
 * Cantina page, and the log said "Opening … in Goga's own Firefox".
 *
 * This module is the single place that decides. It keeps the two engines behind one shape, so
 * the tools above it never branch on the engine themselves:
 *
 *   firefox  the WebDriver BiDi layer, Goga's own Firefox profile on its own debugging port.
 *   brave    the persistent Playwright/Chromium session driving brave.exe, Goga's OWN Brave
 *            profile — never the user's everyday Brave.
 *
 * Both are the sessions Goga already holds. Nothing here launches a second window or a second
 * Firefox profile: the Brave branch is the same `braveCantinaSession()` instance the Security
 * page's read uses, and the Firefox branch is the same `browserLayer()` instance the Browser
 * page uses.
 *
 * In Brave mode the render wait applies (it lives in `navigateAndRead`), so reading a
 * client-rendered page returns its content instead of its loading shell.
 *
 * The Brave branch keeps that session's own host allow-list. That profile is the one the user
 * signs in to Cantina with, so a chat request must not be able to use it to browse anywhere
 * else. A host outside the list is refused by name — never silently handed to Firefox, because
 * quietly driving a different browser than the one the user picked is its own bug.
 */

/** What a page read looks like, whichever engine produced it. */
export interface ChatPageRead {
  url: string
  title: string
  text: string
  textClipped: boolean
  elements: { role: string; name: string }[]
}

export interface ChatBrowserResult {
  ok: boolean
  engine: BrowserEngine
  read: ChatPageRead | null
  /** Plain words for the reply: what was read, or precisely why it could not be. */
  message: string
}

/** The seams a test can replace. Each one is a real call the production default makes. */
export interface ChatBrowserDeps {
  engine: () => BrowserEngine
  firefoxEnsure: () => Promise<{ ok: true } | { ok: false; message: string }>
  firefoxNavigate: (url: string) => Promise<{ url: string; title: string }>
  firefoxRead: () => Promise<ChatPageRead>
  firefoxScreenshotToFile: (filePath: string) => Promise<{ path: string; bytes: number }>
  braveNavigateAndRead: (url: string) => Promise<{ ok: boolean; read: ChatPageRead | null; message: string }>
  braveReadCurrent: () => Promise<{ ok: boolean; read: ChatPageRead | null; message: string }>
  braveScreenshot: () => Promise<{ base64: string; url: string } | null>
  braveReadHosts: () => string[]
}

export class ChatBrowser {
  constructor(private readonly deps: ChatBrowserDeps) {}

  /** The engine this turn uses — whatever Settings says right now, not what it said at boot. */
  engine(): BrowserEngine { return this.deps.engine() }

  /**
   * Open an address in the configured browser and read it back.
   *
   * In Brave mode the read waits for the page to render (inside `navigateAndRead`), so a
   * client-rendered page comes back as its content. A page that never renders is labelled a
   * shell rather than presented as the program.
   */
  async openAndRead(url: string): Promise<ChatBrowserResult> {
    const engine = this.deps.engine()
    const target = String(url ?? '').trim()
    if (!target) return { ok: false, engine, read: null, message: 'No address was given to open.' }

    if (engine === 'brave') {
      const refused = this.braveHostRefusal(target)
      if (refused) return { ok: false, engine, read: null, message: refused }
      const r = await this.deps.braveNavigateAndRead(target)
      return { ok: r.ok, engine, read: r.read, message: r.message }
    }

    const ready = await this.deps.firefoxEnsure()
    if (!ready.ok) return { ok: false, engine, read: null, message: ready.message }
    const nav = await this.deps.firefoxNavigate(target)
    const read = await this.deps.firefoxRead()
    return {
      ok: true, engine,
      read: { ...read, url: read.url || nav.url, title: read.title || nav.title },
      message: `Opened ${nav.url} in Goga's own Firefox — the page title is "${nav.title || '(no title)'}".`,
    }
  }

  /** Read the page already open, in the configured browser, without navigating. */
  async readCurrent(): Promise<ChatBrowserResult> {
    const engine = this.deps.engine()
    if (engine === 'brave') {
      const r = await this.deps.braveReadCurrent()
      return { ok: r.ok, engine, read: r.read, message: r.message }
    }
    const ready = await this.deps.firefoxEnsure()
    if (!ready.ok) return { ok: false, engine, read: null, message: ready.message }
    const read = await this.deps.firefoxRead()
    return { ok: true, engine, read, message: `Read ${read.url || 'the open page'} in Goga's own Firefox.` }
  }

  /** A PNG of the page the configured browser is showing, saved where the user can open it. */
  async screenshotToFile(filePath: string): Promise<{ ok: boolean; engine: BrowserEngine; message: string }> {
    const engine = this.deps.engine()
    if (engine === 'brave') {
      const shot = await this.deps.braveScreenshot()
      if (!shot || !shot.base64) {
        return { ok: false, engine, message: 'There is no open Brave page to photograph. Open it first.' }
      }
      const fs = await import('fs')
      const path = await import('path')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const buf = Buffer.from(shot.base64, 'base64')
      fs.writeFileSync(filePath, buf)
      return { ok: true, engine, message: `Screenshot saved (${buf.length} bytes): ${filePath}` }
    }
    const ready = await this.deps.firefoxEnsure()
    if (!ready.ok) return { ok: false, engine, message: ready.message }
    const saved = await this.deps.firefoxScreenshotToFile(filePath)
    return { ok: true, engine, message: `Screenshot saved (${saved.bytes} bytes): ${saved.path}` }
  }

  /**
   * The reason a host is not read through the Brave profile, or null when it is allowed.
   *
   * The Brave session holds the user's Cantina login. Reading anything else through it would
   * spend that login on a page the user did not ask for, so the list stays as the session
   * defines it.
   */
  private braveHostRefusal(url: string): string | null {
    let host = ''
    try { host = new URL(url).hostname.toLowerCase() } catch {
      return `"${url}" is not a web address, so nothing was opened.`
    }
    const allowed = this.deps.braveReadHosts()
    if (allowed.includes(host)) return null
    // Says "session", not "profile": in everyday mode this is the user's own Brave, and calling it
    // Goga's profile would be a lie about which browser is being driven.
    return `${host} is not a host Goga's Brave session reads. It `
      + `reads ${allowed.join(', ')} only — the pages a Cantina bounty is described on — so nothing `
      + 'was opened and nothing was read. Switch the browser in Settings to Firefox to browse other sites.'
  }
}

/** The production wiring: the two sessions Goga already holds, plus Settings. */
function productionDeps(): ChatBrowserDeps {
  return {
    engine: () => {
      // Imported here so this module can be loaded by a test without Electron present.
      const { SettingsService } = require('../settings')
      return asBrowserEngine(SettingsService.getInstance().get().browserEngine)
    },
    firefoxEnsure: async () => {
      const { ensureAttached } = require('../../tools/browserFirefox') as { ensureAttached: () => Promise<{ ok: true } | { ok: false; message: string }> }
      return ensureAttached()
    },
    firefoxNavigate: async (url: string) => {
      const { browserLayer } = require('./layer') as typeof import('./layer')
      return browserLayer().navigate(url)
    },
    firefoxRead: async () => {
      const { browserLayer } = require('./layer') as typeof import('./layer')
      return browserLayer().readPage() as unknown as ChatPageRead
    },
    firefoxScreenshotToFile: async (filePath: string) => {
      const { browserLayer } = require('./layer') as typeof import('./layer')
      return browserLayer().screenshotToFile(filePath)
    },
    braveNavigateAndRead: async (url: string) => {
      const { braveCantinaSession } = require('./braveSession') as typeof import('./braveSession')
      return braveCantinaSession().navigateAndRead(url) as unknown as { ok: boolean; read: ChatPageRead | null; message: string }
    },
    braveReadCurrent: async () => {
      const { braveCantinaSession } = require('./braveSession') as typeof import('./braveSession')
      return braveCantinaSession().readCurrent() as unknown as { ok: boolean; read: ChatPageRead | null; message: string }
    },
    braveScreenshot: async () => {
      const { braveCantinaSession } = require('./braveSession') as typeof import('./braveSession')
      return braveCantinaSession().screenshot()
    },
    braveReadHosts: () => {
      const { READ_HOSTS } = require('./braveSession') as typeof import('./braveSession')
      return READ_HOSTS
    },
  }
}

let instance: ChatBrowser | null = null

/** The one dispatcher the chat tools use. */
export function chatBrowser(): ChatBrowser {
  return instance ??= new ChatBrowser(productionDeps())
}

/** A dispatcher over the given seams — for tests, and for a caller that holds its own sessions. */
export function createChatBrowser(deps: ChatBrowserDeps): ChatBrowser {
  return new ChatBrowser(deps)
}
