import type { ToolAdapter } from './base'
import type { Browser, BrowserContext, Page } from 'playwright'
import { LogService } from '../services/logs'

const BRAVE_PATH = 'C:\\Users\\redre\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'

export interface BrowserSession {
  sessionId: string
  url: string
}

interface SessionEntry {
  browser: Browser
  context: BrowserContext
  page: Page
  url: string
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
      case 'navigate':    return this.navigate(params.sessionId as string, params.url as string)
      case 'click':       return this.click(params.sessionId as string, params.selector as string | undefined, params.x as number | undefined, params.y as number | undefined)
      case 'type':        return this.type(params.sessionId as string, params.selector as string, params.text as string)
      case 'getContent':  return this.getContent(params.sessionId as string)
      case 'screenshot':  return this.screenshotPage(params.sessionId as string)
      case 'evaluate':    return this.evaluate(params.sessionId as string, params.script as string)
      case 'waitFor':     return this.waitFor(params.sessionId as string, params.selector as string, params.timeoutMs as number | undefined)
      case 'close':       return this.close(params.sessionId as string)
      case 'closeAll':    return this.closeAll()
      default: throw new Error(`Unknown browser op: ${op}`)
    }
  }

  private async getPlaywright() {
    // ESM-only — use dynamic import pattern
    const pw = await (new Function('return import("playwright")'))()
    return pw.chromium as import('playwright').BrowserType
  }

  async open(url: string, headless = false): Promise<BrowserSession> {
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
    this.sessions.set(sessionId, { browser, context, page, url })
    this.log.info(`Browser opened: ${url} [${sessionId}]`)
    return { sessionId, url: page.url() }
  }

  async navigate(sessionId: string, url: string): Promise<{ url: string; title: string }> {
    const s = this.requireSession(sessionId)
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    s.url = s.page.url()
    return { url: s.page.url(), title: await s.page.title() }
  }

  async click(sessionId: string, selector?: string, x?: number, y?: number): Promise<{ clicked: string }> {
    const s = this.requireSession(sessionId)
    if (selector) {
      await s.page.click(selector, { timeout: 10_000 })
      return { clicked: selector }
    }
    if (x !== undefined && y !== undefined) {
      await s.page.mouse.click(x, y)
      return { clicked: `(${x},${y})` }
    }
    throw new Error('click requires selector or x,y coordinates')
  }

  async type(sessionId: string, selector: string, text: string): Promise<{ typed: string }> {
    const s = this.requireSession(sessionId)
    await s.page.fill(selector, text, { timeout: 10_000 })
    return { typed: text }
  }

  async getContent(sessionId: string): Promise<{ url: string; title: string; text: string; html: string }> {
    const s = this.requireSession(sessionId)
    const [title, html] = await Promise.all([s.page.title(), s.page.content()])
    // Strip scripts/styles for a clean text version
    const text = await s.page.evaluate('document.body ? document.body.innerText : ""') as string
    return { url: s.page.url(), title, text: text.slice(0, 12_000), html: html.slice(0, 20_000) }
  }

  async screenshotPage(sessionId: string): Promise<{ base64: string; url: string }> {
    const s = this.requireSession(sessionId)
    const buf = await s.page.screenshot({ type: 'png', fullPage: false })
    return { base64: buf.toString('base64'), url: s.page.url() }
  }

  async evaluate(sessionId: string, script: string): Promise<{ result: unknown }> {
    const s = this.requireSession(sessionId)
    const result = await s.page.evaluate(script)
    return { result }
  }

  async waitFor(sessionId: string, selector: string, timeoutMs = 10_000): Promise<{ found: boolean }> {
    const s = this.requireSession(sessionId)
    try {
      await s.page.waitForSelector(selector, { timeout: timeoutMs })
      return { found: true }
    } catch {
      return { found: false }
    }
  }

  async close(sessionId: string): Promise<{ closed: string }> {
    const s = this.sessions.get(sessionId)
    if (s) {
      await s.browser.close()
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
    return s
  }

  getSessionUrl(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.url
  }

  listSessions(): { sessionId: string; url: string }[] {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({ sessionId: id, url: s.url }))
  }
}
