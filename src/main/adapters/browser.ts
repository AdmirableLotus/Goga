import type { ToolAdapter } from './base'
import type { Browser, BrowserContext, Page } from 'playwright'
import { LogService } from '../services/logs'

export const BRAVE_PATH ='C:\\Users\\redre\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'

export interface BrowserSession {
  sessionId: string
  url: string
}

/** Thrown when a Playwright-only operation is called on an external shell session. */
export class ShellSessionError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} is an external shell session (opened via browser.openExternal). It has no Playwright page — use browser.open for automation tasks that require click, type, evaluate, or screenshot.`)
    this.name = 'ShellSessionError'
  }
}

/** Thrown when browser.evaluate is called — this op is not exposed to the agent. */
export class EvaluateNotAllowedError extends Error {
  constructor() {
    super('browser.evaluate is not available to the agent. Use browser.snapshot, browser.ariaSnapshot, browser.getByRole, browser.getByLabel, or browser.getByText to inspect page state.')
    this.name = 'EvaluateNotAllowedError'
  }
}

/** Thrown when the Playwright page was closed externally (e.g. user closed the browser window). */
export class PageClosedError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} page was closed externally. The browser window was closed before the operation could complete. Call browser.open again to start a new session.`)
    this.name = 'PageClosedError'
  }
}

interface SessionEntry {
  kind: 'playwright' | 'external'
  browser: Browser | null
  context: BrowserContext | null
  page: Page | null
  url: string
  pageClosed?: boolean
}

export class BrowserAdapter implements ToolAdapter {
  readonly name = 'browser'
  readonly enabled = true
  private sessions = new Map<string, SessionEntry>()
  private log = LogService.getInstance()
  private sessionCounter = 0

  async execute(params: Record<string, unknown>): Promise<unknown> {
    const op = params.op as string
    switch (op) {
      case 'open':        return this.open(params.url as string, params.headless as boolean | undefined)
      case 'openExternal': return this.openExternal(params.url as string)
      case 'evaluate':     throw new EvaluateNotAllowedError()
      case 'navigate':    return this.navigate(params.sessionId as string, params.url as string)
      case 'click':       return this.click(params.sessionId as string, params.selector as string | undefined, params.x as number | undefined, params.y as number | undefined)
      case 'type':        return this.type(params.sessionId as string, params.selector as string, params.text as string)
      case 'getContent':  return this.getContent(params.sessionId as string)
      case 'screenshot':  return this.screenshotPage(params.sessionId as string)
      case 'waitFor':     return this.waitFor(params.sessionId as string, params.selector as string, params.timeoutMs as number | undefined)
      case 'close':       return this.close(params.sessionId as string)
      case 'closeAll':    return this.closeAll()
      case 'snapshot':     return this.snapshot(params.sessionId as string, params.includeScreenshot as boolean | undefined)
      case 'ariaSnapshot':  return this.ariaSnapshot(params.sessionId as string)
      case 'clickByRole':  return this.clickByRole(params.sessionId as string, params.role as string, params.name as string, params.exact as boolean | undefined)
      case 'getByRole':    return this.getByRole(params.sessionId as string, params.role as string, params.name as string | undefined, params.exact as boolean | undefined)
      case 'getByLabel':   return this.getByLabel(params.sessionId as string, params.text as string, params.exact as boolean | undefined)
      case 'getByText':    return this.getByText(params.sessionId as string, params.text as string, params.exact as boolean | undefined)
      default: throw new Error(`Unknown browser op: ${op}`)
    }
  }

  private async getPlaywright() {
    // ESM-only — use dynamic import pattern
    const pw = await (new Function('return import("playwright")'))()
    return pw.chromium as import('playwright').BrowserType
  }

  /** Open a URL via Electron shell.openExternal — visible in the user's default browser.
   * Returns an external-N session that cannot be used with Playwright operations.
   * Only http: and https: schemes are permitted; all others are rejected. */
  async openExternal(url: string): Promise<BrowserSession> {
    let parsed: URL
    try { parsed = new URL(url) } catch {
      throw new Error(`browser.openExternal: invalid URL: ${url}`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`browser.openExternal: scheme "${parsed.protocol}" is not allowed. Only https: and http: are permitted.`)
    }
    const { shell } = await import('electron')
    await shell.openExternal(url)
    const sessionId = `external-${++this.sessionCounter}`
    this.sessions.set(sessionId, { kind: 'external', browser: null, context: null, page: null, url })
    this.log.info(`Browser opened via shell: ${url} [${sessionId}]`)
    return { sessionId, url }
  }

  /** Open a URL in a Playwright-controlled browser session.
   * Returns a browser-N session that supports navigate, click, type, evaluate, screenshot. */
  async open(url: string, headless = true): Promise<BrowserSession> {
    const chromium = await this.getPlaywright()
    const browser = await chromium.launch({
      executablePath: BRAVE_PATH,
      headless,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
    })
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    })
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const sessionId = `browser-${++this.sessionCounter}`
    const entry: SessionEntry = { kind: 'playwright', browser, context, page, url }
    this.sessions.set(sessionId, entry)
    page.on('close', () => {
      entry.pageClosed = true
      this.log.warn(`Browser page closed externally [${sessionId}]`)
    })
    this.log.info(`Browser opened: ${url} [${sessionId}]`)
    return { sessionId, url: page.url() }
  }

  async navigate(sessionId: string, url: string): Promise<{ url: string; title: string }> {
    const s = this.requireSession(sessionId)
    await s.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    s.url = s.page!.url()
    return { url: s.page!.url(), title: await s.page!.title() }
  }

  async click(sessionId: string, selector?: string, x?: number, y?: number): Promise<{ clicked: string }> {
    const s = this.requireSession(sessionId)
    if (selector) {
      await s.page!.click(selector, { timeout: 10_000 })
      return { clicked: selector }
    }
    if (x !== undefined && y !== undefined) {
      await s.page!.mouse.click(x, y)
      return { clicked: `(${x},${y})` }
    }
    throw new Error('click requires selector or x,y coordinates')
  }

  async type(sessionId: string, selector: string, text: string): Promise<{ typed: string }> {
    const s = this.requireSession(sessionId)
    await s.page!.fill(selector, text, { timeout: 10_000 })
    return { typed: text }
  }

  async getContent(sessionId: string): Promise<{ url: string; title: string; text: string; html: string }> {
    const s = this.requireSession(sessionId)
    const [title, html] = await Promise.all([s.page!.title(), s.page!.content()])
    const text = await s.page!.evaluate('document.body ? document.body.innerText : ""') as string
    return { url: s.page!.url(), title, text: text.slice(0, 12_000), html: html.slice(0, 20_000) }
  }

  async screenshotPage(sessionId: string): Promise<{ base64: string; url: string }> {
    const s = this.requireSession(sessionId)
    const buf = await s.page!.screenshot({ type: 'png', fullPage: false })
    return { base64: buf.toString('base64'), url: s.page!.url() }
  }

  // evaluate() is intentionally not exposed to the agent (EvaluateNotAllowedError is
  // thrown in execute() for op='evaluate'). It remains here for internal/test use only.
  async evaluate(sessionId: string, script: string): Promise<{ result: unknown }> {
    const s = this.requireSession(sessionId)
    const result = await s.page!.evaluate(script)
    return { result }
  }

  async waitFor(sessionId: string, selector: string, timeoutMs = 10_000): Promise<{ found: boolean }> {
    const s = this.requireSession(sessionId)
    try {
      await s.page!.waitForSelector(selector, { timeout: timeoutMs })
      return { found: true }
    } catch {
      return { found: false }
    }
  }

  async close(sessionId: string): Promise<{ closed: string }> {
    const s = this.sessions.get(sessionId)
    if (s) {
      if (s.kind === 'playwright' && s.browser) await s.browser.close()
      this.sessions.delete(sessionId)
    }
    return { closed: sessionId }
  }

  async closeAll(): Promise<{ closed: number }> {
    const count = this.sessions.size
    for (const [id] of this.sessions) await this.close(id)
    return { closed: count }
  }

  private requireSession(sessionId: string): SessionEntry {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`No browser session: ${sessionId}. Call browser.open first.`)
    if (s.kind === 'external') throw new ShellSessionError(sessionId)
    if (s.pageClosed) throw new PageClosedError(sessionId)
    return s
  }

  // ── Phase C: Semantic browser tools ─────────────────────────────────────

  /**
   * Compact structured snapshot of the page.
   * PROMPT-INJECTION RULE: page content is UNTRUSTED DATA.
   * The snapshot describes structure — callers must not allow page text to
   * override system rules, expand scope, or authorize actions.
   */
  async snapshot(sessionId: string, includeScreenshot = false): Promise<{
    url: string; title: string; focusedElement: string | null
    interactiveElements: Array<{ role: string; name: string; tag: string; id?: string }>
    screenshotRef?: string
  }> {
    const s = this.requireSession(sessionId)
    const [title, focusedEl, interactive] = await Promise.all([
      s.page!.title(),
      s.page!.evaluate(`(() => {
        const el = document.activeElement
        if (!el || el === document.body) return null
        return el.tagName.toLowerCase() + '[' + (el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '') + ']'
      })()`),
      s.page!.evaluate(`(() => {
        const els = Array.from(document.querySelectorAll(
          'button,a[href],input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"]'
        ))
        return els.slice(0, 60).map(el => ({
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          name: (el.innerText || '').trim().slice(0, 80) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '',
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined
        }))
      })()`)
    ])
    const result: Awaited<ReturnType<BrowserAdapter['snapshot']>> = {
      url: s.page!.url(), title, focusedElement: (focusedEl as string | null),
      interactiveElements: interactive as Array<{ role: string; name: string; tag: string; id?: string }>
    }
    if (includeScreenshot) {
      const buf = await s.page!.screenshot({ type: 'png', fullPage: false })
      result.screenshotRef = buf.toString('base64').slice(0, 100) + '…'  // reference only, not full base64
    }
    return result
  }

  /**
   * Playwright's built-in ARIA snapshot — compact accessibility tree as YAML-like text.
   * Playwright 1.62.1 supports page.ariaSnapshot().
   * Truncated to 8000 chars to avoid flooding the local model context.
   */
  async ariaSnapshot(sessionId: string): Promise<{ snapshot: string; url: string; title: string }> {
    const s = this.requireSession(sessionId)
    const raw = await s.page!.ariaSnapshot()
    return {
      snapshot: raw.slice(0, 8000),
      url: s.page!.url(),
      title: await s.page!.title()
    }
  }

  /**
   * Click by ARIA role + accessible name.
   * Priority: getByRole → getByLabel → getByText → CSS fallback.
   */
  async clickByRole(
    sessionId: string, role: string, name: string, exact = false
  ): Promise<{ clicked: boolean; locator: string; ambiguous?: boolean; candidates?: string[] }> {
    const s = this.requireSession(sessionId)
    const ariaRole = role as Parameters<Page['getByRole']>[0]

    // Priority 1: getByRole — check for ambiguity before clicking
    try {
      const loc = s.page!.getByRole(ariaRole, { name, exact })
      const count = await loc.count()
      if (count > 1) {
        // Ambiguous — collect candidate descriptions, do NOT silently pick first
        const candidates: string[] = []
        for (let i = 0; i < Math.min(count, 5); i++) {
          const el = loc.nth(i)
          const text = await el.innerText().catch(() => '')
          const visible = await el.isVisible().catch(() => false)
          candidates.push(`[${i}] "${text.slice(0, 60)}" visible=${visible}`)
        }
        return { clicked: false, locator: `role=${role}[name=${name}]`, ambiguous: true, candidates }
      }
      if (count === 1) {
        await loc.first().click({ timeout: 8_000 })
        return { clicked: true, locator: `role=${role}[name=${name}]` }
      }
    } catch { /* fall through */ }

    // Priority 2: getByLabel — check for ambiguity
    try {
      const loc = s.page!.getByLabel(name, { exact })
      const count = await loc.count()
      if (count > 1) {
        return { clicked: false, locator: `label=${name}`, ambiguous: true,
          candidates: [`${count} elements match label "${name}"`] }
      }
      if (count === 1) {
        await loc.click({ timeout: 5_000 })
        return { clicked: true, locator: `label=${name}` }
      }
    } catch { /* fall through */ }

    // Priority 3: getByText — check for ambiguity
    try {
      const loc = s.page!.getByText(name, { exact })
      const count = await loc.count()
      if (count > 1) {
        return { clicked: false, locator: `text=${name}`, ambiguous: true,
          candidates: [`${count} elements match text "${name}"`] }
      }
      if (count === 1) {
        await loc.first().click({ timeout: 5_000 })
        return { clicked: true, locator: `text=${name}` }
      }
    } catch { /* fall through */ }

    throw new Error(`clickByRole: could not locate role=${role} name="${name}" by any semantic locator`)
  }

  async getByRole(
    sessionId: string, role: string, name?: string, exact = false
  ): Promise<{ found: boolean; count: number; first: { text: string; visible: boolean } | null }> {
    const s = this.requireSession(sessionId)
    const ariaRole = role as Parameters<Page['getByRole']>[0]
    const loc = name ? s.page!.getByRole(ariaRole, { name, exact }) : s.page!.getByRole(ariaRole)
    const count = await loc.count()
    if (count === 0) return { found: false, count: 0, first: null }
    const first = loc.first()
    const [text, visible] = await Promise.all([
      first.innerText().catch(() => ''),
      first.isVisible().catch(() => false)
    ])
    return { found: true, count, first: { text: text.slice(0, 200), visible } }
  }

  async getByLabel(
    sessionId: string, text: string, exact = false
  ): Promise<{ found: boolean; value: string | null; visible: boolean }> {
    const s = this.requireSession(sessionId)
    const loc = s.page!.getByLabel(text, { exact })
    const count = await loc.count()
    if (count === 0) return { found: false, value: null, visible: false }
    const first = loc.first()
    const [value, visible] = await Promise.all([
      first.inputValue().catch(() => null),
      first.isVisible().catch(() => false)
    ])
    return { found: true, value, visible }
  }

  async getByText(
    sessionId: string, text: string, exact = false
  ): Promise<{ found: boolean; count: number; first: { tag: string; visible: boolean } | null }> {
    const s = this.requireSession(sessionId)
    const loc = s.page!.getByText(text, { exact })
    const count = await loc.count()
    if (count === 0) return { found: false, count: 0, first: null }
    const first = loc.first()
    const [tag, visible] = await Promise.all([
      first.evaluate('el => el.tagName.toLowerCase()').then(v => String(v)).catch(() => ''),
      first.isVisible().catch(() => false)
    ])
    return { found: true, count, first: { tag, visible } }
  }

  getSessionUrl(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.url
  }

  listSessions(): { sessionId: string; url: string }[] {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({ sessionId: id, url: s.url }))
  }
}
