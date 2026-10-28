/**
 * Reading the user's Schematik (schematik.io) projects. Schematik has no API, so Goga opens
 * it in a browser window of his own that remembers the user's sign-in. The user signs in
 * there themselves, once; Goga only reads the page and never types or clicks in Schematik.
 */

const PAGE_CHARS = 6000
const SETTLE_MS = 6000
const SIGN_IN_WAIT_MS = 4 * 60_000

/** Only Schematik's own pages; anything else is refused. */
export function schematikUrl(url: string | undefined): string {
  const target = new URL(url || 'https://www.schematik.io/app')
  if (target.protocol !== 'https:' || !/^(www\.)?schematik\.io$/.test(target.hostname)) throw new Error('only https://www.schematik.io pages can be read this way')
  return target.toString()
}

/** Whether the page is asking the user to sign in rather than showing their project. */
export function needsSignIn(url: string, text: string): boolean {
  return /\/(login|sign-?in|auth)\b/i.test(new URL(url).pathname) || (text.length < 1500 && /\b(sign in|log in|continue with google)\b/i.test(text))
}

/** The page text, tidied and kept short enough for the brain. */
export function pageText(text: string): string {
  const tidy = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
  return tidy.length > PAGE_CHARS ? `${tidy.slice(0, PAGE_CHARS)}\n…(cut short)` : tidy
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Context = any

export class SchematikReader {
  private context: Context = null

  constructor(private profileDir: string, private browserPath?: string) {}

  /** Reads the page. On a sign-in page, waits (up to `signInWaitMs`) for the user to sign in. */
  async read(url?: string, signInWaitMs = SIGN_IN_WAIT_MS, signal?: AbortSignal): Promise<{ url: string; signIn: boolean; text: string }> {
    const target = schematikUrl(url)
    const context = await this.open()
    const page = context.pages()[0] ?? await context.newPage()
    const load = async () => {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => { /* a live app never goes quiet */ })
      return String(await page.evaluate('document.body ? document.body.innerText : ""'))
    }
    let text = await load()
    const deadline = Date.now() + signInWaitMs
    while (needsSignIn(page.url(), text) && Date.now() < deadline && !signal?.aborted && !page.isClosed()) {
      await new Promise(r => setTimeout(r, 3000))
      if (page.isClosed()) break
      const now = String(await page.evaluate('document.body ? document.body.innerText : ""').catch(() => ''))
      // Signed in: back to the page that was asked for.
      if (!needsSignIn(page.url(), now)) text = await load()
    }
    const signIn = page.isClosed() || needsSignIn(page.url(), text)
    // Left open for the user to sign in; closed once read.
    if (!signIn) await this.close()
    return { url: target, signIn, text: signIn ? '' : pageText(text) }
  }

  async close(): Promise<void> {
    try { await this.context?.close() } catch { /* already closed */ }
    this.context = null
  }

  private async open(): Promise<Context> {
    if (this.context) return this.context
    const pw = await (new Function('return import("playwright")'))()
    this.context = await pw.chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      executablePath: this.browserPath,
      viewport: { width: 1280, height: 860 },
    })
    this.context.on('close', () => { this.context = null })
    return this.context
  }
}
