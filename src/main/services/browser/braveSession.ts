import path from 'path'
import { app } from 'electron'
import type { Browser, BrowserContext, Page } from 'playwright'
import { resolveBravePath } from '../../adapters/browser'
import { LogService } from '../logs'
import {
  DEFAULT_BRAVE_SESSION_MODE, EVERYDAY_DEBUG_PORT, asBraveSessionMode, braveSessionModeSentence,
  cantinaCardText, cantinaSignInHint, everydayAttachInstructions, type BraveSessionMode,
} from '../../../shared/braveMode'

/**
 * The Brave window the Cantina work happens in — in one of two modes.
 *
 * OWN PROFILE (`own-profile`). Goga launches Brave itself, in a profile of its own under Goga's
 * userData, and the user signs in to that profile by hand. That profile is separate from the
 * everyday one, so it has a separate sign-in, and its login survives a Goga restart.
 *
 * EVERYDAY (`everyday`, the default). Goga attaches over CDP to the Brave the user already has
 * running, and does its work in a tab it opens itself. That is the user's real browser, already
 * signed in to whatever they are signed in to, so a Cantina login is the real one and there is no
 * second sign-in. What this does NOT do, in either mode:
 *
 *   - it never reads, copies or decrypts a cookie, a password, a token or any profile file;
 *   - it never launches Brave against the user's real profile directory, and never kills their
 *     brave.exe;
 *   - it never navigates, closes or takes over a tab the user is using — it opens its own;
 *   - it never enters credentials, and never handles CAPTCHA or MFA.
 *
 * The sign-in check in everyday mode reads the page it reached: if the Cantina page it lands on
 * shows a signed-in account, it says so, and if the page shows a Sign-in control it says that.
 * It does not consult cookies, localStorage or the profile to decide.
 *
 * Being signed in is not authorization. Every active request still goes through the scope gate,
 * the single-use approval, the rate cap and the stop, exactly as before this mode existed.
 */

const log = () => LogService.getInstance()

/** The one page Goga opens. */
export const CANTINA_BOUNTY_URL = 'https://bounties.cantina.xyz/cantina/bug-bounty'

/**
 * The hosts the Brave session will navigate to and read.
 *
 * Cantina publishes its bounty pages on these two, and nothing else is read through this
 * engine. A host outside this list is refused by name before anything is navigated, so a typo or
 * a pasted link to somewhere else cannot become a browsing session — which matters more now that
 * the everyday mode is the user's own signed-in browser.
 */
export const READ_HOSTS = ['bounties.cantina.xyz', 'cantina.xyz']

export type BraveSessionState =
  | 'stopped'         // nothing open
  | 'launching'       // Brave is coming up (own-profile mode)
  | 'attaching'       // connecting to the running Brave (everyday mode)
  | 'login-required'  // a Cantina page is open; a sign-in is still needed
  | 'open'            // signed in — either confirmed by the user or read off the page
  | 'disconnected'    // the window/tab closed, or the attach dropped

export interface BraveSessionStatus {
  state: BraveSessionState
  /** Which Brave this is: the user's everyday one, or the profile Goga launched. */
  mode: BraveSessionMode
  /** A sentence naming the browser, for the card and the live log. */
  browserLabel: string
  url: string | null
  /** The tab Goga is driving, so the user can see it is not one of theirs. */
  tab: { url: string; title: string; openedByGoga: boolean } | null
  braveExecutable: string | null
  profileDir: string
  /** Everyday mode only: the debugging port Goga looked for. */
  debugPort: number | null
  /** Words the user can act on. */
  message: string
  /** The card's limitation text for this mode, so the UI cannot print the other mode's. */
  cardText: string
  /** What the sign-in step is, in this mode. */
  signInHint: string
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

/** The page-reading script. Read-only, and it touches no storage and no cookie. */
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
export interface BraveLauncher {
  /** Own-profile mode: a separate profile Goga owns. */
  launchPersistentContext?(userDataDir: string, options: Record<string, unknown>): Promise<BrowserContext>
  /** Everyday mode: attach to a Brave that is already running. */
  connectOverCDP?(endpoint: string, options?: Record<string, unknown>): Promise<Browser>
}

/** What the page itself says about the sign-in. Never derived from a cookie or from storage. */
export interface SignedInVerdict {
  signedIn: boolean | null
  /** What on the page produced that verdict, in words. */
  evidence: string
}

/**
 * Read the sign-in off the page, not off the browser's state.
 *
 * Three answers, and the third is the honest one: a page that neither shows a Sign-in control nor
 * shows an account is not evidence of anything, so it says it could not tell rather than guessing.
 */
export function detectCantinaSignedIn(read: { text: string; elements: { role: string; name: string }[] } | null): SignedInVerdict {
  if (!read) return { signedIn: null, evidence: 'the page could not be read' }
  const text = String(read.text ?? '')
  const names = (read.elements ?? []).map(e => String(e.name ?? '').toLowerCase())
  const signInControl = names.some(n => /^(sign in|log in|login|sign up)/.test(n.trim()))
  if (/sign in to join/i.test(text)) {
    return { signedIn: false, evidence: 'the page says "Sign in to join"' }
  }
  if (signInControl) {
    const which = (read.elements ?? []).find(e => /^(sign in|log in|login|sign up)/i.test(String(e.name).trim()))
    return { signedIn: false, evidence: `the page shows a "${which?.name ?? 'Sign in'}" control` }
  }
  const account = /\b(sign out|log out|my submissions|your submissions|account settings|my profile)\b/i.exec(text)
  if (account) {
    return { signedIn: true, evidence: `the page shows "${account[0]}"` }
  }
  return { signedIn: null, evidence: 'the page shows neither a Sign-in control nor an account menu' }
}

export class BraveCantinaSession {
  private context: BrowserContext | null = null
  private page: Page | null = null
  /** Everyday mode: the attached browser. Held so the tab can be closed without closing it. */
  private browser: Browser | null = null
  private openedByGoga: Page | null = null
  private state: BraveSessionState = 'stopped'
  private lastMessage = ''
  private lastVerdict: SignedInVerdict | null = null
  /** The last page title Goga actually read. Playwright's title() is async, and status() is not. */
  private lastTitle = ''

  constructor(
    private readonly launcher?: () => Promise<BraveLauncher>,
    private readonly braveResolver: () => string | null = () => resolveBravePath(),
    private readonly modeReader: () => BraveSessionMode = () => DEFAULT_BRAVE_SESSION_MODE,
    private readonly port: number = EVERYDAY_DEBUG_PORT,
  ) {}

  /** The mode in force right now — whatever Settings says, not what it said at boot. */
  mode(): BraveSessionMode { return asBraveSessionMode(this.modeReader()) }

  /** Goga's OWN Brave profile. Only used in own-profile mode. */
  profileDir(): string {
    return path.join(app.getPath('userData'), 'brave-cantina-profile')
  }

  private async chromium(): Promise<BraveLauncher> {
    if (this.launcher) return this.launcher()
    const { chromium } = await import('playwright')
    return chromium as unknown as BraveLauncher
  }

  /** True only when a live context is held. A closed window is not a live session. */
  private alive(): boolean {
    return this.context !== null
  }

  status(): BraveSessionStatus {
    const mode = this.mode()
    const page = this.page && !this.page.isClosed?.() ? this.page : null
    return {
      state: this.state,
      mode,
      browserLabel: braveSessionModeSentence(mode),
      url: page ? safeUrl(page) : null,
      tab: page
        ? { url: safeUrl(page) ?? '', title: this.lastTitle, openedByGoga: true }
        : null,
      braveExecutable: this.braveResolver(),
      profileDir: this.profileDir(),
      debugPort: mode === 'everyday' ? this.port : null,
      message: this.lastMessage || this.defaultMessage(),
      cardText: cantinaCardText(mode),
      signInHint: cantinaSignInHint(mode),
    }
  }

  private defaultMessage(): string {
    const mode = this.mode()
    if (mode === 'everyday') {
      switch (this.state) {
        case 'stopped': return `Not attached. Goga uses your everyday Brave — start it with ${everydayAttachInstructions(this.braveResolver()).split('. ')[1] ?? ''}`.trim()
        case 'attaching': return 'Attaching to your everyday Brave…'
        case 'login-required': return 'Attached to your everyday Brave, in a tab Goga opened. That page does not show you as signed in to Cantina.'
        case 'open': return 'Attached to your everyday Brave, in a tab Goga opened, and that Cantina page shows you as signed in.'
        case 'disconnected': return 'The connection to your everyday Brave dropped, or the tab Goga opened was closed. Try attaching again.'
      }
    }
    switch (this.state) {
      case 'stopped': return 'Brave is not open. Use "Open Brave for Cantina" and sign in manually in the window Goga opens.'
      case 'launching': return 'Brave is starting…'
      case 'login-required': return 'Brave is open at the Cantina bug-bounty page in Goga\'s own profile. Sign in manually in that window, then tell me you are signed in.'
      case 'open': return 'You confirmed you are signed in to Cantina in Goga\'s Brave window.'
      case 'attaching': return 'Attaching…'
      case 'disconnected': return 'The Brave window closed. Open it again to continue; your login may still be remembered in Goga\'s profile.'
    }
  }

  /**
   * Open the Cantina page — attaching in everyday mode, launching in own-profile mode.
   *
   * Everyday mode never starts Brave. If nothing answers on the debugging port, it says exactly
   * what the user has to do and stops: launching their real profile itself is not an option,
   * because a second Brave on a live profile directory fails or corrupts it.
   */
  async open(): Promise<BraveSessionStatus> {
    const mode = this.mode()

    // Already held: put a Cantina page in front of the one Goga owns. Never the user's tab.
    if (this.alive()) {
      try {
        if (!this.page || this.page.isClosed()) this.page = await this.ownTab()
        await this.page.goto(CANTINA_BOUNTY_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        if (this.state !== 'open') this.state = 'login-required'
        this.lastMessage = ''
        return this.status()
      } catch (err) {
        return this.fail(err)
      }
    }

    if (mode === 'everyday') return this.attach()

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
      if (!chromium.launchPersistentContext) throw new Error('this build cannot launch a browser')
      const context = await chromium.launchPersistentContext(this.profileDir(), {
        executablePath: brave,
        headless: false,
        viewport: null,
        // No --remote-debugging-port here: Playwright controls this context over its own pipe.
        // The sandbox stays ON — chromiumSandbox: true is what stops Playwright adding
        // --no-sandbox (and the "unsupported command-line flag" banner that comes with it).
        chromiumSandbox: true,
        args: ['--no-first-run', '--no-default-browser-check'],
      })
      this.context = context
      context.on('close', () => {
        this.context = null
        this.page = null
        this.browser = null
        this.openedByGoga = null
        if (this.state !== 'stopped') {
          this.state = 'disconnected'
          this.lastMessage = ''
          log().warn('Brave/Cantina: the persistent context closed; session dropped cleanly (no retry).')
        }
      })
      const page = context.pages()[0] ?? await context.newPage()
      this.page = page
      this.openedByGoga = page
      page.on('close', () => { if (this.page === page) this.page = null })
      await page.goto(CANTINA_BOUNTY_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      this.lastTitle = await readTitle(page)
      this.state = 'login-required'
      this.lastMessage = 'Brave is open at the Cantina bug-bounty page in Goga\'s own profile. '
        + 'Sign in manually in that window — Goga will not enter credentials, and does not handle CAPTCHA or MFA. '
        + 'When you have signed in, tell me and I will note it.'
      log().info(`Brave/Cantina: opened persistent Brave at ${CANTINA_BOUNTY_URL} (own profile)`)
      return this.status()
    } catch (err) {
      return this.fail(err)
    }
  }

  /**
   * Attach to the Brave the user already has running, and open Goga's own tab in it.
   *
   * Playwright's CDP attach gives access to every tab in that browser. Goga asks for none of
   * them: it opens a new page and keeps only that reference. Nothing here enumerates, reads or
   * navigates a tab the user opened.
   */
  private async attach(): Promise<BraveSessionStatus> {
    const mode = this.mode()
    this.state = 'attaching'
    this.lastMessage = ''
    const chromium = await this.chromium().catch(() => null)
    if (!chromium?.connectOverCDP) {
      this.state = 'stopped'
      this.lastMessage = 'This build cannot attach to a running browser.'
      return this.status()
    }
    const endpoint = `http://127.0.0.1:${this.port}`
    let browser: Browser
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 8_000 })
    } catch (err) {
      this.state = 'stopped'
      this.lastMessage = everydayAttachInstructions(this.braveResolver())
      log().warn(`Brave/Cantina: everyday attach failed at ${endpoint}: ${err instanceof Error ? err.message : String(err)}`)
      return this.status()
    }

    try {
      const context = browser.contexts()[0]
      if (!context) throw new Error('the attached browser reported no context')
      this.browser = browser
      this.context = context
      // The attached browser going away is a dropped connection, not a closed window of ours.
      browser.on('disconnected', () => {
        if (this.browser !== browser) return
        this.browser = null
        this.context = null
        this.page = null
        this.openedByGoga = null
        if (this.state !== 'stopped') {
          this.state = 'disconnected'
          this.lastMessage = 'The connection to your everyday Brave dropped. Nothing was retried.'
        }
      })

      const page = await context.newPage()
      this.page = page
      this.openedByGoga = page
      page.on('close', () => {
        if (this.page === page) {
          this.page = null
          if (this.state !== 'stopped') {
            this.state = 'disconnected'
            this.lastMessage = 'The tab Goga opened was closed. Nothing else in your browser was touched.'
          }
        }
      })
      await page.goto(CANTINA_BOUNTY_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await this.waitForRender().catch(() => ({ rendered: false, ms: 0 }))

      // Read the sign-in off the page Goga reached. Not from cookies, not from storage.
      this.lastTitle = await readTitle(page)
      const verdict = await this.readSignedIn()
      this.lastVerdict = verdict
      this.state = verdict?.signedIn === true ? 'open' : 'login-required'
      this.lastMessage = verdict?.signedIn === true
        ? `Attached to your everyday Brave in a tab Goga opened. That Cantina page shows you as signed in — ${verdict.evidence} — so there is no sign-in step.`
        : verdict?.signedIn === false
          ? `Attached to your everyday Brave in a tab Goga opened. That Cantina page does not show you as signed in — ${verdict.evidence}. Sign in yourself in that tab if you want to continue; Goga will not enter credentials.`
          : `Attached to your everyday Brave in a tab Goga opened. ${verdict?.evidence ?? 'The page could not be read'}, so Goga cannot tell whether you are signed in — sign in yourself if you are not.`
      log().info(`Brave/Cantina: attached to the running Brave at ${endpoint}; opened its own tab at ${CANTINA_BOUNTY_URL} (mode ${mode})`)
      return this.status()
    } catch (err) {
      return this.fail(err)
    }
  }

  /** A new page in whichever mode is in force, used only when Goga's own tab went away. */
  private async ownTab(): Promise<Page> {
    if (!this.context) throw new Error('the browser is not attached')
    const page = await this.context.newPage()
    this.page = page
    this.openedByGoga = page
    page.on('close', () => { if (this.page === page) this.page = null })
    return page
  }

  /** Read the page's own text and elements, and say what they mean for the sign-in. */
  private async readSignedIn(): Promise<SignedInVerdict | null> {
    if (!this.page || this.page.isClosed?.()) return null
    try {
      const raw = await this.page.evaluate(READ_SCRIPT) as string
      const parsed = JSON.parse(raw) as { text?: string; elements?: { role: string; name: string }[] }
      return detectCantinaSignedIn({ text: parsed.text ?? '', elements: parsed.elements ?? [] })
    } catch {
      return null
    }
  }

  /** The last sign-in verdict, for the card. Null until the page has been read. */
  signedInVerdict(): SignedInVerdict | null { return this.lastVerdict }

  /**
   * Check the sign-in by reading the Cantina page Goga is on, and report what the page says.
   *
   * In everyday mode this is the whole sign-in step: the page's own account menu is the evidence.
   * In own-profile mode the user's confirmation is still what counts, and this reports the page
   * alongside it without overwriting it.
   */
  async checkSignedIn(): Promise<BraveSessionStatus> {
    if (!this.alive() || !this.page) {
      this.lastMessage = this.mode() === 'everyday'
        ? 'Nothing is attached yet. ' + everydayAttachInstructions(this.braveResolver())
        : 'There is no open Brave window to check. Open Brave for Cantina first.'
      return this.status()
    }
    const verdict = await this.readSignedIn()
    this.lastVerdict = verdict
    if (verdict?.signedIn === true) {
      this.state = 'open'
      this.lastMessage = `That Cantina page shows you as signed in — ${verdict.evidence}. Goga read that off the page, not from cookies or storage.`
    } else if (verdict?.signedIn === false) {
      this.state = 'login-required'
      this.lastMessage = `That Cantina page does not show you as signed in — ${verdict.evidence}. Sign in yourself in that tab if you want to continue; Goga will not enter credentials.`
    } else {
      this.lastMessage = `${verdict?.evidence ?? 'The page could not be read'}, so Goga cannot tell whether you are signed in.`
    }
    return this.status()
  }

  /**
   * Record that the USER has confirmed they are signed in. Goga does not verify this itself in
   * own-profile mode — it does not scrape Cantina — so the state reflects the user's confirmation.
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
   * Navigate the Brave tab to one address and read the page back.
   *
   * This is the read half of the Brave engine. It is read-only — it clicks nothing, types
   * nothing, and enters no credentials — and it is limited to the hosts on the session's own
   * allow-list, refused by name BEFORE anything is navigated. In everyday mode that check is the
   * thing that keeps Goga out of the user's other signed-in pages.
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
        message: `${parsed.hostname} is not a host this Brave session reads. It reads ${READ_HOSTS.join(', ')} — the pages a Cantina bounty is described on — and nothing else, in either mode.`,
      }
    }

    // Open (or attach) if nothing is held. open() navigates to the Cantina page first; the goto
    // below then takes Goga's own tab to the exact address that was asked for.
    if (!this.alive()) {
      const opened = await this.open()
      if (!this.alive()) return { ok: false, read: null, message: opened.message }
    }

    try {
      const page = this.page ?? await this.ownTab()
      this.page = page
      if (page.isClosed?.()) {
        this.page = await this.ownTab()
        return { ok: false, read: null, message: 'The Brave tab Goga opened closed before it could be read. Open it again.' }
      }
      const response = await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
      // A client-rendered page answers domcontentloaded while it is still showing its loading
      // shell. Read then and the reply is the shell, honestly labelled. Wait for the content.
      const waited = await this.waitForRender()
      const raw = await page.evaluate(READ_SCRIPT) as string
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
      this.lastTitle = read.title
      if (this.state !== 'open') this.state = 'login-required'
      const modeName = this.mode() === 'everyday' ? 'your everyday Brave' : 'Goga\'s own Brave profile'
      const renderNote = waited.rendered
        ? ` Content rendered after ${waited.ms} ms.`
        : ` The page was still showing its loading shell after ${waited.ms} ms, so what is below is the shell, not the program.`
      this.lastMessage = `Read "${read.title || read.url}" through ${modeName} — HTTP ${response?.status() ?? 'unknown'}, ${read.text.length} chars of visible text, ${read.elements.length} interactive element(s).${renderNote}`
      log().info(`Brave/Cantina: read ${read.url} (${read.text.length} chars) in ${this.mode()} mode`)
      return { ok: true, read, message: this.lastMessage }
    } catch (err) {
      const failed = this.fail(err)
      return { ok: false, read: null, message: failed.message }
    }
  }

  /**
   * Wait until the page stops showing a loading shell, or the budget runs out.
   *
   * It is a wait for CONTENT, not a fixed sleep: the page is asked, repeatedly, whether its
   * visible text has changed from the shell it started with.
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
        // The page is navigating or the tab closed; the read will report what is there.
        return { rendered: false, ms: Date.now() - started }
      }
      if (rendered(last)) return { rendered: true, ms: Date.now() - started }
      await new Promise(resolve => setTimeout(resolve, RENDER_POLL_MS))
    }
    return { rendered: rendered(last), ms: Date.now() - started }
  }

  /**
   * A PNG of the page Goga's own tab is showing, base64, with the address it was taken at.
   * Same page the read uses — no second capture route, and in everyday mode only Goga's own tab.
   */
  async screenshot(): Promise<{ base64: string; url: string } | null> {
    if (!this.alive() || !this.page || this.page.isClosed?.()) return null
    try {
      const buf = await this.page.screenshot({ type: 'png' })
      return { base64: Buffer.from(buf).toString('base64'), url: safeUrl(this.page) ?? '' }
    } catch { return null }
  }

  /** Read the page that is open now, without navigating. */
  async readCurrent(): Promise<{ ok: boolean; read: BravePageRead | null; message: string }> {
    if (!this.alive() || !this.page) {
      return { ok: false, read: null, message: 'No Brave page is open. Open Brave for Cantina first, or navigate to an address.' }
    }
    return this.navigateAndRead(safeUrl(this.page) ?? CANTINA_BOUNTY_URL)
  }

  /**
   * Visit ONE address in Goga's own tab for a joined live attempt, and report what the page did.
   *
   * This is the only method that navigates outside the read allow-list, and it is deliberately
   * not a general browsing surface: the caller is the joining run, whose exact URL the scope gate
   * has allowed and the user has approved with a single-use approval. It reads no cookie, no
   * storage, no token and no password, and it types nothing.
   */
  async visitForJoin(url: string): Promise<{ status: number | null; title: string; bodyText: string }> {
    if (!this.alive() || !this.page) throw new Error('the Brave session Goga drives is not open')
    const page = this.page
    if (page.isClosed?.()) throw new Error('the Brave tab closed')
    const response = await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 30_000 })
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

  /**
   * Drop the session. In own-profile mode this closes the Brave window Goga launched. In everyday
   * mode it closes only the tab Goga opened: the user's browser is left running, with their tabs
   * exactly as they were.
   */
  async close(): Promise<BraveSessionStatus> {
    const mode = this.mode()
    const ctx = this.context
    const page = this.openedByGoga
    this.context = null
    this.page = null
    this.openedByGoga = null
    this.browser = null
    this.state = 'stopped'
    this.lastMessage = ''
    if (mode === 'everyday') {
      // Only Goga's own tab. Never Browser.close(), which would close the user's browser.
      if (page) { try { await page.close() } catch { /* going anyway */ } }
      log().info('Brave/Cantina: closed Goga\'s own tab in the everyday Brave; the browser was left running.')
    } else if (ctx) {
      try { await ctx.close() } catch { /* going anyway */ }
    }
    return this.status()
  }

  private fail(err: unknown): BraveSessionStatus {
    this.state = 'disconnected'
    this.lastMessage = `Could not drive Brave: ${err instanceof Error ? err.message : String(err)}. The window was not opened or the connection dropped; Goga stopped instead of retrying.`
    this.context = null
    this.page = null
    this.openedByGoga = null
    this.browser = null
    return this.status()
  }
}

/**
 * The page's title, or '' when the page cannot tell us.
 *
 * Kept defensive on purpose: title() is a Playwright method, and a page object that does not
 * have one (a test double) must leave the session working with an empty title, not fail the open.
 */
async function readTitle(page: Page): Promise<string> {
  try {
    if (typeof (page as unknown as { title?: unknown }).title !== 'function') return ''
    return String(await page.title() ?? '')
  } catch { return '' }
}

function safeUrl(page: Page): string | null {
  try { return page.url() } catch { return null }
}

/**
 * Whether a page's visible text looks like content rather than a loading shell.
 *
 * The shell is short and says "Loading": Cantina's is 110 characters. Real content is far longer.
 * A small page that never mentions loading counts as rendered, so the wait does not hold every
 * page for its full timeout.
 */
export function rendered(text: string): boolean {
  const t = String(text ?? '').trim()
  return !(t.length < RENDERED_MIN_CHARS && LOADING_SHELL_RE.test(t))
}

let instance: BraveCantinaSession | null = null

/**
 * The one session the whole app shares. Its mode is read from Settings on every call, so flipping
 * the mode on the Security page takes effect on the next action without a restart.
 */
export function braveCantinaSession(): BraveCantinaSession {
  return instance ??= new BraveCantinaSession(
    undefined,
    undefined,
    () => {
      // Required lazily so this module loads in a test without Electron or a settings store.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SettingsService } = require('../settings') as typeof import('../settings')
      return asBraveSessionMode(SettingsService.getInstance().get().braveSessionMode)
    },
  )
}

/** Test hook: drop the shared instance so a test gets a fresh one. */
export function resetBraveCantinaSessionForTests(): void {
  instance = null
}
