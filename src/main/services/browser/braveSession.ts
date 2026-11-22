import path from 'path'
import { app } from 'electron'
import type { BrowserContext, Page } from 'playwright'
import { resolveBravePath } from '../../adapters/browser'
import { LogService } from '../logs'

/**
 * One persistent Brave window that the USER signs in to, by hand.
 *
 * Goga opens Brave in a profile of its OWN — never the user's everyday Brave profile — pointed at
 * the Cantina bug-bounty page, and then gets out of the way: the user signs in manually, Goga never
 * touches credentials, CAPTCHA or MFA. The profile lives on disk, so the login session survives a
 * Goga restart; when it expires, Goga shows the window again and asks the user to sign in, and never
 * tries to work around authentication.
 *
 * What this is NOT: it is not a grant to test Cantina. Opening the page for a manual sign-in is the
 * only site interaction here. Being signed in is not authorization — every active request still goes
 * through the scope gate, which refuses out-of-scope and local/metadata targets whatever is logged in.
 *
 * No remote-debugging interface is opened: Playwright drives this persistent context directly over
 * its own pipe, so there is no CDP port to bind or leak.
 */

const log = () => LogService.getInstance()

/** The one page Goga opens for the manual sign-in. */
export const CANTINA_BOUNTY_URL = 'https://bounties.cantina.xyz/cantina/bug-bounty'

/**
 * The hosts the Brave session will navigate to and read.
 *
 * Cantina publishes its bounty pages on these two, and nothing else is read through this
 * engine. A host outside this list is refused by name, so a typo or a pasted link to somewhere
 * else cannot become a browsing session.
 */
export const READ_HOSTS = ['bounties.cantina.xyz', 'cantina.xyz']

export type BraveSessionState =
  | 'stopped'         // nothing open
  | 'launching'       // Brave is coming up
  | 'login-required'  // window is open at Cantina; the user still needs to sign in
  | 'open'            // the user has confirmed they are signed in
  | 'disconnected'    // the window/profile closed or the connection dropped

export interface BraveSessionStatus {
  state: BraveSessionState
  url: string | null
  braveExecutable: string | null
  profileDir: string
  /** Words the user can act on. */
  message: string
}

/** What a page read returns. Same shape for any engine, so the caller does not branch on it. */
export interface BravePageRead {
  url: string
  title: string
  /** Visible text, whitespace-collapsed, capped so one long page cannot flood a reply. */
  text: string
  textClipped: boolean
  /** The interactive elements a caller might want to name. */
  elements: { role: string; name: string }[]
}

/** The page-reading script. Deliberately the same idea as the Firefox layer's, and read-only. */
const READ_SCRIPT = `(() => {
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const body = document.body;
  const text = clean(body ? (body.innerText || body.textContent || '') : '');
  const els = [];
  const nodes = document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link]');
  for (let i = 0; i < nodes.length && els.length < 120; i++) {
    const el = nodes[i];
    const name = clean(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('name') || '');
    if (!name) continue;
    els.push({ role: el.tagName.toLowerCase(), name: name.slice(0, 120) });
  }
  return JSON.stringify({ url: location.href, title: document.title || '', text, elements: els });
})()`

/** The slice of Playwright's `chromium` this service uses — small, so a test can supply a fake. */
export interface PersistentLauncher {
  launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<BrowserContext>
}

export class BraveCantinaSession {
  private context: BrowserContext | null = null
  private page: Page | null = null
  private state: BraveSessionState = 'stopped'
  private lastMessage = ''

  constructor(
    private readonly launcher?: () => Promise<PersistentLauncher>,
    private readonly braveResolver: () => string | null = () => resolveBravePath(),
  ) {}

  /** Goga's OWN Brave profile, deliberately separate from the user's everyday Brave profile. */
  profileDir(): string {
    return path.join(app.getPath('userData'), 'brave-cantina-profile')
  }

  private async chromium(): Promise<PersistentLauncher> {
    if (this.launcher) return this.launcher()
    const { chromium } = await import('playwright')
    return chromium
  }

  /** True only when a live context is held. A closed window is not a live session. */
  private alive(): boolean {
    return this.context !== null
  }

  status(): BraveSessionStatus {
    return {
      state: this.state,
      url: this.page && !this.page.isClosed?.() ? safeUrl(this.page) : null,
      braveExecutable: this.braveResolver(),
      profileDir: this.profileDir(),
      message: this.lastMessage || this.defaultMessage(),
    }
  }

  private defaultMessage(): string {
    switch (this.state) {
      case 'stopped': return 'Brave is not open. Use "Open Brave for Cantina" and sign in manually in the window Goga opens.'
      case 'launching': return 'Brave is starting…'
      case 'login-required': return 'Brave is open at the Cantina bug-bounty page. Sign in manually in that window, then tell me you are signed in.'
      case 'open': return 'You confirmed you are signed in to Cantina in Goga\'s Brave window.'
      case 'disconnected': return 'The Brave window closed. Open it again to continue; your login may still be remembered in Goga\'s profile.'
    }
  }

  /**
   * Open (or re-focus) the Goga-controlled Brave window at the Cantina page.
   *
   * If Brave is not installed, it says so and opens NOTHING else — it will not silently fall back to
   * another browser for this action, because the whole point is the user's Brave login.
   */
  async open(): Promise<BraveSessionStatus> {
    // Already have a live window: just make sure a Cantina page is in front, don't relaunch.
    if (this.alive()) {
      try {
        if (!this.page || this.page.isClosed()) this.page = await this.context!.newPage()
        await this.page.goto(CANTINA_BOUNTY_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        if (this.state !== 'open') this.state = 'login-required'
        this.lastMessage = ''
        return this.status()
      } catch (err) {
        return this.fail(err)
      }
    }

    const brave = this.braveResolver()
    if (!brave) {
      this.state = 'stopped'
      this.lastMessage = 'Brave is not installed where Goga can find it. Install Brave, or set GOGA_BRAVE_PATH to brave.exe. '
        + 'Goga will not open a different browser for this — the point is your Cantina login in Brave.'
      return this.status()
    }

    this.state = 'launching'
    this.lastMessage = ''
    try {
      const chromium = await this.chromium()
      const context = await chromium.launchPersistentContext(this.profileDir(), {
        executablePath: brave,
        headless: false,
        viewport: null,
        // No --remote-debugging-port: Playwright controls this context over its own pipe. Only the
        // flags needed to keep a dedicated profile quiet and non-default.
        args: ['--no-first-run', '--no-default-browser-check'],
      })
      this.context = context
      context.on('close', () => {
        this.context = null
        this.page = null
        if (this.state !== 'stopped') {
          this.state = 'disconnected'
          this.lastMessage = ''
          log().warn('Brave/Cantina: the persistent context closed; session dropped cleanly (no retry).')
        }
      })
      const page = context.pages()[0] ?? await context.newPage()
      this.page = page
      page.on('close', () => { if (this.page === page) this.page = null })
      await page.goto(CANTINA_BOUNTY_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      this.state = 'login-required'
      this.lastMessage = 'Brave is open at the Cantina bug-bounty page in Goga\'s own profile. '
        + 'Sign in manually in that window — Goga will not enter credentials, and does not handle CAPTCHA or MFA. '
        + 'When you have signed in, tell me and I will note it.'
      log().info(`Brave/Cantina: opened persistent Brave at ${CANTINA_BOUNTY_URL}`)
      return this.status()
    } catch (err) {
      return this.fail(err)
    }
  }

  /**
   * Record that the USER has confirmed they are signed in. Goga does not verify this itself — it
   * does not scrape Cantina — so the state reflects the user's own confirmation, nothing more.
   */
  confirmSignedIn(): BraveSessionStatus {
    if (!this.alive()) {
      this.lastMessage = 'There is no open Brave window to confirm. Open Brave for Cantina first.'
      return this.status()
    }
    this.state = 'open'
    this.lastMessage = 'Noted — you confirmed you are signed in. Goga did not verify this itself; it trusts your confirmation.'
    return this.status()
  }

  /**
   * Navigate the Brave window to one address and read the page back.
   *
   * This is the read half of the Brave engine: it opens the window if it is not open, goes to
   * the address, waits for the DOM, and returns the visible text and the interactive elements.
   * It is read-only — it clicks nothing, types nothing, and enters no credentials — and it is
   * limited to the hosts on the session's own allow-list, so it cannot be pointed anywhere the
   * user did not ask for.
   *
   * The distinction it keeps: a page that renders is not a page that is authorized to be
   * tested. Reading Cantina's policy page is a read. It is not a permission to send anything.
   */
  async navigateAndRead(url: string): Promise<{ ok: boolean; read: BravePageRead | null; message: string }> {
    const target = String(url ?? '').trim()
    let parsed: URL
    try { parsed = new URL(target) } catch {
      return { ok: false, read: null, message: `"${target}" is not a web address.` }
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, read: null, message: `Only http and https addresses are read, not "${parsed.protocol}".` }
    }
    if (!READ_HOSTS.includes(parsed.hostname.toLowerCase())) {
      return {
        ok: false, read: null,
        message: `${parsed.hostname} is not a host this Brave session reads. It reads ${READ_HOSTS.join(', ')} — the pages a Cantina bounty is described on.`,
      }
    }

    // Open the window if it is not already up. open() navigates to the Cantina page first; the
    // goto below then takes it to the exact address that was asked for.
    if (!this.alive()) {
      const opened = await this.open()
      if (!this.alive()) return { ok: false, read: null, message: opened.message }
    }

    try {
      const page = this.page ?? await this.context!.newPage()
      this.page = page
      if (page.isClosed?.()) {
        this.page = await this.context!.newPage()
        return { ok: false, read: null, message: 'The Brave tab closed before it could be read. Open Brave for Cantina again.' }
      }
      const response = await this.page.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
      const raw = await this.page.evaluate(READ_SCRIPT) as string
      let parsedRead: { url?: string; title?: string; text?: string; elements?: { role: string; name: string }[] }
      try { parsedRead = JSON.parse(raw) } catch {
        return { ok: false, read: null, message: 'The page did not return readable content. It may still be loading.' }
      }
      const fullText = parsedRead.text ?? ''
      const textClipped = fullText.length > 20_000
      const read: BravePageRead = {
        url: parsedRead.url ?? parsed.toString(),
        title: parsedRead.title ?? '',
        text: textClipped ? fullText.slice(0, 20_000) : fullText,
        textClipped,
        elements: (parsedRead.elements ?? []).slice(0, 120),
      }
      if (this.state !== 'open') this.state = 'login-required'
      this.lastMessage = `Read "${read.title || read.url}" through Brave — HTTP ${response?.status() ?? 'unknown'}, ${read.text.length} chars of visible text, ${read.elements.length} interactive element(s).`
      log().info(`Brave/Cantina: read ${read.url} (${read.text.length} chars)`)
      return { ok: true, read, message: this.lastMessage }
    } catch (err) {
      const failed = this.fail(err)
      return { ok: false, read: null, message: failed.message }
    }
  }

  /**
   * A PNG of the page Goga's own Brave window is showing, base64, with the address it was taken
   * at. Same Playwright page the read uses — no second capture route, and nothing from the
   * user's own Brave profile.
   */
  async screenshot(): Promise<{ base64: string; url: string } | null> {
    if (!this.alive() || !this.page || this.page.isClosed?.()) return null
    try {
      const buf = await this.page.screenshot({ type: 'png' })
      return { base64: Buffer.from(buf).toString('base64'), url: safeUrl(this.page) ?? '' }
    } catch { return null }
  }

  /** Read the page that is open now, without navigating. */  async readCurrent(): Promise<{ ok: boolean; read: BravePageRead | null; message: string }> {
    if (!this.alive() || !this.page) {
      return { ok: false, read: null, message: 'No Brave page is open. Open Brave for Cantina first, or navigate to an address.' }
    }
    return this.navigateAndRead(safeUrl(this.page) ?? CANTINA_BOUNTY_URL)
  }

  /** Close the window and drop the live session. The on-disk profile (and its login) is kept. */
  async close(): Promise<BraveSessionStatus> {
    const ctx = this.context
    this.context = null
    this.page = null
    this.state = 'stopped'
    this.lastMessage = ''
    if (ctx) { try { await ctx.close() } catch { /* going anyway */ } }
    return this.status()
  }

  private fail(err: unknown): BraveSessionStatus {
    this.state = 'disconnected'
    this.lastMessage = `Could not drive Brave: ${err instanceof Error ? err.message : String(err)}. The window was not opened or the connection dropped; Goga stopped instead of retrying.`
    this.context = null
    this.page = null
    return this.status()
  }
}

function safeUrl(page: Page): string | null {
  try { return page.url() } catch { return null }
}

let instance: BraveCantinaSession | null = null
export function braveCantinaSession(): BraveCantinaSession {
  return instance ??= new BraveCantinaSession()
}
