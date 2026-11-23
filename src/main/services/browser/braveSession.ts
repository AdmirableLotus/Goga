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

/**
 * How long a page gets to replace its loading shell with real content, and how often it is checked.
 *
 * Cantina's bounty pages are built by client-side JavaScript: `domcontentloaded` fires while the
 * body still reads "Bounties All bounties Loading program" — about 110 characters — and the
 * program itself arrives a second or two later. A read taken straight after the DOM event
 * therefore returns the shell, honestly labelled as the page's text. This wait is what makes the
 * read return the program.
 *
 * It is a wait for CONTENT, not a fixed sleep: the page is asked, repeatedly, whether its visible
 * text has changed from the shell it started with. A page that is already rendered costs one
 * check; a page that never renders costs the timeout and is then read as it is, so the reply is
 * "the shell" rather than a lie or a hang.
 */
export const RENDER_WAIT_MS = 15_000
const RENDER_POLL_MS = 250

/** The text a client-rendered page shows before its content arrives. */
export const LOADING_SHELL_RE = /\bLoading\b/i

/** The smallest page that is worth considering "rendered": more than the shell's chrome. */
const RENDERED_MIN_CHARS = 400

/** A script that reports the page's current visible text, for the render wait to compare. */
export const VISIBLE_TEXT_SCRIPT = `(() => {
  const b = document.body;
  return String(b ? (b.innerText || b.textContent || '') : '').replace(/\\s+/g, ' ').trim();
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
      // A client-rendered page answers domcontentloaded while it is still showing its loading
      // shell. Read now and the reply is the shell, honestly labelled — which is what happened
      // live: 110 chars, "Bounties All bounties Loading program". Wait for the content instead.
      const waited = await this.waitForRender()
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
      // Say whether the page actually rendered, so "the shell" is never presented as the program.
      const renderNote = waited.rendered
        ? ` Content rendered after ${waited.ms} ms.`
        : ` The page was still showing its loading shell after ${waited.ms} ms, so what is below is the shell, not the program.`
      this.lastMessage = `Read "${read.title || read.url}" through Brave — HTTP ${response?.status() ?? 'unknown'}, ${read.text.length} chars of visible text, ${read.elements.length} interactive element(s).${renderNote}`
      log().info(`Brave/Cantina: read ${read.url} (${read.text.length} chars)`)
      return { ok: true, read, message: this.lastMessage }
    } catch (err) {
      const failed = this.fail(err)
      return { ok: false, read: null, message: failed.message }
    }
  }

  /**
   * Wait until the page stops showing a loading shell, or the budget runs out.
   *
   * Cantina's bounty pages are client-rendered: right after `domcontentloaded` the body reads
   * "Bounties All bounties Loading program" (110 characters), and the program arrives a second
   * or two later. This polls the page's own visible text and returns as soon as it is no longer
   * that shell — so a rendered page costs one check, and a page that never renders costs the
   * timeout and is then read as it is.
   *
   * Returns the elapsed time either way, so the reply can say which of the two happened instead
   * of presenting a shell as if it were the program.
   */
  async waitForRender(timeoutMs = RENDER_WAIT_MS): Promise<{ rendered: boolean; ms: number }> {
    const started = Date.now()
    if (!this.page || this.page.isClosed?.()) return { rendered: false, ms: 0 }
    const deadline = started + Math.max(0, timeoutMs)
    let last = ''
    while (Date.now() < deadline) {
      try {
        last = String(await this.page.evaluate(VISIBLE_TEXT_SCRIPT) ?? '')
      } catch {
        // The page is navigating or the window closed; the read below will report what is there.
        return { rendered: false, ms: Date.now() - started }
      }
      if (rendered(last)) return { rendered: true, ms: Date.now() - started }
      await new Promise(resolve => setTimeout(resolve, RENDER_POLL_MS))
    }
    return { rendered: rendered(last), ms: Date.now() - started }
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

  /**
   * Visit ONE address in Goga's own Brave window for a joined live attempt, and report what the
   * page did.
   *
   * This is the only method on this class that navigates outside the read allow-list, and it is
   * deliberately not a general browsing surface: the caller is the joining run, whose exact URL
   * the scope gate has allowed and the user has approved with a single-use approval. What it
   * returns is the status, the title and the visible text — the three things the execution rule
   * needs. It reads no cookie, no storage, no token and no password, and it types nothing: there
   * is no code here that could sign in as the user.
   *
   * It does not open the window. If the session is not up, the caller is told so and nothing is
   * navigated.
   */
  async visitForJoin(url: string): Promise<{ status: number | null; title: string; bodyText: string }> {
    if (!this.alive() || !this.page) throw new Error('Goga\'s Brave window is not open')
    const page = this.page
    if (page.isClosed?.()) throw new Error('the Brave tab closed')
    const response = await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    // A client-rendered page answers domcontentloaded before its content arrives. Wait the same
    // way the read does, so a payload that runs just after load is not missed by reading early.
    await this.waitForRender().catch(() => ({ rendered: false, ms: 0 }))
    const raw = await page.evaluate(READ_SCRIPT) as string
    let parsed: { title?: string; text?: string } = {}
    try { parsed = JSON.parse(raw) } catch { /* the fields stay empty, which is the honest answer */ }
    return {
      status: response?.status() ?? null,
      title: String(parsed.title ?? ''),
      bodyText: String(parsed.text ?? ''),
    }
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

/**
 * Whether a page's visible text looks like content rather than a loading shell.
 *
 * The shell is short and says "Loading": Cantina's is 110 characters, "Bounties All bounties
 * Loading program …". Real content is far longer than that. So a page is still a shell when it is
 * BOTH shorter than the chrome-worth of content AND still saying "Loading". A small page that
 * never mentions loading counts as rendered, and so does a long page, so the wait does not hold
 * every page for its full timeout.
 */
export function rendered(text: string): boolean {
  const t = String(text ?? '').trim()
  return !(t.length < RENDERED_MIN_CHARS && LOADING_SHELL_RE.test(t))
}

let instance: BraveCantinaSession | null = null
export function braveCantinaSession(): BraveCantinaSession {
  return instance ??= new BraveCantinaSession()
}
