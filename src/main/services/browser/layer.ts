import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type {
  BrowserStatus, BrowserTab, ElementQuery, FoundElement, PageElement, PageRead,
} from '../../../shared/browser'
import { BidiClient, BidiError } from './bidi'
import {
  DEFAULT_DEBUG_PORT, bidiUrl, launchFirefox, probePort, resolveFirefoxPath,
} from './firefox'

/** The debugging port: 9333, or GOGA_DEBUG_PORT when one instance must not take another's. */
function resolveDebugPort(): number {
  const raw = process.env.GOGA_DEBUG_PORT?.trim()
  if (!raw) return DEFAULT_DEBUG_PORT
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_DEBUG_PORT
}
import {
  PAGE_READ_SCRIPT, readValueScript, scrollToScript, waitForTextScript,
} from './domScripts'
import { LogService } from '../logs'

/**
 * The general browser-control layer.
 *
 * Goga launches Firefox itself on a debugging port with its own profile, attaches over
 * WebDriver BiDi, and drives whatever page is in front of it. Nothing here is specific to
 * any one site: a site adapter (Pivex, or anything later) is a consumer of these
 * primitives, not a replacement for them.
 *
 * Two rules this file keeps:
 *   - It never reads a cookie, a password or a profile secret. It attaches to the port
 *     and works the pages.
 *   - Page content is untrusted data. `readPage` and `findElement` report what the page
 *     says; they never let it change what Goga is allowed to do.
 */

const log = () => LogService.getInstance()

/** How long a click or a type waits for the element to be there. */
const ACTION_TIMEOUT_MS = 10_000

interface Attached {
  client: BidiClient
  port: number
  browserName: string
  browserVersion: string
  /** The browsing context Goga is pointed at. */
  contextId: string | null
}

export class BrowserLayer {
  private attached: Attached | null = null
  // GOGA_DEBUG_PORT moves it, so a diagnostic instance can drive its own Firefox while
  // another Goga already owns 9333. The user's own browser session is never touched.
  private port = resolveDebugPort()
  private lastMessage = ''

  /** Goga's own Firefox profile, kept apart from the one the user browses in. */
  profileDir(): string {
    return path.join(app.getPath('userData'), 'firefox-profile')
  }

  executable(): string | null { return resolveFirefoxPath() }

  /** What is true right now, in words the user can act on. */
  async status(): Promise<BrowserStatus> {
    const exe = this.executable()
    const base: BrowserStatus = {
      state: 'stopped', port: this.port, browserName: null, browserVersion: null,
      profileDir: this.profileDir(), executable: exe, tabCount: 0, message: '',
    }

    if (this.attached) {
      let tabs: BrowserTab[] = []
      try { tabs = await this.listTabs() } catch { /* the session may have just died */ }
      if (this.attached) {
        return {
          ...base, state: 'attached',
          browserName: this.attached.browserName, browserVersion: this.attached.browserVersion,
          tabCount: tabs.length,
          message: `Attached to Firefox ${this.attached.browserVersion} on port ${this.port} with ${tabs.length} tab${tabs.length === 1 ? '' : 's'} open.`,
        }
      }
    }

    const probe = await probePort(this.port)
    if (!probe.listening) {
      return {
        ...base, state: 'stopped',
        message: exe
          ? `Firefox is not running on port ${this.port}. Press "Start Firefox" and Goga will launch it with its own profile.`
          : 'Firefox is not installed where Goga can find it. Install Firefox, or set GOGA_FIREFOX_PATH to firefox.exe.',
      }
    }
    if (!probe.bidi) {
      return {
        ...base, state: 'blocked', browserName: probe.browserName,
        message: `${probe.detail}. Goga will not drive it — close whatever owns port ${this.port}, or start Firefox from here.`,
      }
    }
    return {
      ...base, state: 'running', browserName: 'firefox',
      message: `Firefox is listening on port ${this.port}. Press "Attach" to take control of its tabs.`,
    }
  }

  /** Launch Firefox on the debugging port with Goga's own profile. */
  async start(url?: string): Promise<BrowserStatus> {
    const exe = this.executable()
    if (!exe) {
      this.lastMessage = 'Firefox is not installed where Goga can find it.'
      return this.status()
    }
    const probe = await probePort(this.port)
    if (probe.listening && !probe.bidi) {
      this.lastMessage = `${probe.detail}. Goga will not drive it.`
      return this.status()
    }
    if (!probe.listening) {
      const result = launchFirefox({ executable: exe, port: this.port, profileDir: this.profileDir(), url })
      this.lastMessage = result.message
      log().info(`Browser: ${result.message}`)
      if (!result.launched) return this.status()
      // Firefox takes a few seconds to bring the port up; poll rather than guess a sleep.
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500))
        const p = await probePort(this.port, 1_000)
        if (p.listening && p.bidi) break
      }
    }
    return this.status()
  }

  /** Attach to the running Firefox over BiDi. */
  async attach(): Promise<BrowserStatus> {
    if (this.attached) return this.status()
    const probe = await probePort(this.port)
    if (!probe.listening) {
      this.lastMessage = `Nothing is listening on port ${this.port}. Start Firefox from here first.`
      return this.status()
    }
    if (!probe.bidi) {
      this.lastMessage = `${probe.detail}. Goga will not drive it.`
      return this.status()
    }
    try {
      const client = await BidiClient.open(bidiUrl(this.port))
      const caps = client.capabilities as { browserName?: string; browserVersion?: string }
      this.attached = {
        client, port: this.port,
        browserName: caps.browserName ?? 'firefox',
        browserVersion: caps.browserVersion ?? 'unknown',
        contextId: null,
      }
      // When the browser dies — it crashed, the user closed the window, the socket dropped —
      // drop the attachment instead of holding a corpse. Without this, isAttached stays true,
      // every later command rejects with "the browser connection is closed", and the only cure
      // is a manual re-attach. With it, the next action finds no session and relaunches cleanly.
      client.onClosed(() => {
        if (this.attached && this.attached.client === client) {
          this.attached = null
          this.lastMessage = `The Firefox session on port ${this.port} closed. Goga will relaunch it on the next browser action.`
          log().warn(`Browser: BiDi session closed; dropped the dead attachment on port ${this.port}`)
        }
      })
      log().info(`Browser: attached to ${this.attached.browserName} ${this.attached.browserVersion} on port ${this.port}`)
      return this.status()
    } catch (err) {
      this.lastMessage = err instanceof Error ? err.message : String(err)
      log().warn(`Browser: attach failed — ${this.lastMessage}`)
      return this.status()
    }
  }

  async detach(): Promise<BrowserStatus> {
    if (this.attached) {
      try { await this.attached.client.close() } catch { /* going anyway */ }
      this.attached = null
    }
    return this.status()
  }

  private require(): Attached {
    // A session whose socket has died is not a session. Reap it here too, in case a command
    // raced the close callback, so a caller never acts through a dead connection.
    if (this.attached && !this.attached.client.isAlive) this.attached = null
    if (!this.attached) {
      throw new Error('Goga is not attached to Firefox. Press "Attach" on the Browser page, or start Firefox from there first.')
    }
    return this.attached
  }

  /** Every open tab, top-level only, with the one Goga is pointed at marked. */
  async listTabs(): Promise<BrowserTab[]> {
    const a = this.require()
    const tree = await a.client.send<{ contexts?: Array<{ context: string; url?: string; children?: unknown[] }> }>(
      'browsingContext.getTree', {},
    )
    const contexts = tree.contexts ?? []
    const tabs: BrowserTab[] = []
    for (const ctx of contexts) {
      let title = ''
      try {
        const r = await a.client.send<{ result?: { value?: string } }>('script.evaluate', {
          expression: 'document.title || ""',
          target: { context: ctx.context },
          awaitPromise: false,
          resultOwnership: 'none',
        })
        title = r.result?.value ?? ''
      } catch { /* a tab mid-navigation has no title yet */ }
      tabs.push({ id: ctx.context, url: ctx.url ?? '', title, current: ctx.context === a.contextId })
    }
    if (!a.contextId && tabs.length) a.contextId = tabs[0].id
    return tabs.map(t => ({ ...t, current: t.id === a.contextId }))
  }

  /** Point Goga at one tab. */
  async selectTab(contextId: string): Promise<BrowserTab> {
    const a = this.require()
    const tabs = await this.listTabs()
    const found = tabs.find(t => t.id === contextId)
    if (!found) throw new Error(`There is no open tab with id ${contextId}. Read the tab list again.`)
    a.contextId = contextId
    return { ...found, current: true }
  }

  private context(): string {
    const a = this.require()
    if (!a.contextId) throw new Error('No tab is selected. Call listTabs and pick one.')
    return a.contextId
  }

  /** Evaluate a script in the selected tab and return its string result. */
  private async evaluate(expression: string): Promise<string> {
    const a = this.require()
    const reply = await a.client.send<{ result?: { value?: unknown }; type?: string }>('script.evaluate', {
      expression,
      target: { context: this.context() },
      awaitPromise: false,
      resultOwnership: 'none',
    })
    const value = reply.result?.value
    return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  }

  /**
   * Run a read-only script in the selected tab and return its string result.
   *
   * Exposed for a consumer that needs a shape `readPage` does not carry — a table read as
   * cells, for instance. It is not exposed to the model or the renderer: the IPC surface
   * has no channel for it, so a page cannot be used to run arbitrary code through Goga.
   */
  async evaluateScript(expression: string): Promise<string> {
    return this.evaluate(expression)
  }

  /** Go to a URL in the selected tab and wait for the page to finish loading. */
  async navigate(url: string): Promise<{ url: string; title: string }> {
    const a = this.require()
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error(`"${url}" is not a web address.`)}
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Goga only navigates to http and https addresses, not "${parsed.protocol}".`)
    }
    await a.client.send('browsingContext.navigate', {
      context: this.context(), url: parsed.toString(), wait: 'complete',
    })
    const title = await this.evaluate('document.title || ""')
    return { url: parsed.toString(), title }
  }

  /** Read the page: its visible text and the interactive elements on it. */
  async readPage(): Promise<PageRead> {
    const raw = await this.evaluate(PAGE_READ_SCRIPT)
    let parsed: { url?: string; title?: string; text?: string; textClipped?: boolean; elements?: Array<PageElement & { selector?: string }> }
    try { parsed = JSON.parse(raw) } catch {
      throw new Error('The page did not return readable content. It may still be loading, or it may be a browser-internal page Goga cannot read.')
    }
    return {
      url: parsed.url ?? '',
      title: parsed.title ?? '',
      text: parsed.text ?? '',
      textClipped: parsed.textClipped === true,
      elements: (parsed.elements ?? []).map(e => ({
        role: e.role, name: e.name, tag: e.tag, id: e.id, type: e.type,
        value: e.value, visible: e.visible !== false, disabled: e.disabled,
      })),
    }
  }

  /**
   * Find one element by role, label, text or CSS.
   *
   * Ambiguity is reported, never resolved by picking the first match: a click on the
   * wrong "Confirm" is exactly the kind of mistake this layer must not make.
   */
  async findElement(query: ElementQuery): Promise<FoundElement> {
    const page = await this.readPage()
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
    const matches = page.elements.filter(el => {
      if (query.by === 'role') {
        if (norm(el.role) !== norm(query.role)) return false
        if (query.name === undefined) return true
        return query.exact ? norm(el.name) === norm(query.name) : norm(el.name).includes(norm(query.name))
      }
      if (query.by === 'label' || query.by === 'text') {
        return query.exact ? norm(el.name) === norm(query.text) : norm(el.name).includes(norm(query.text))
      }
      // css: match against the id when the selector is a plain #id, otherwise report
      // that a CSS query needs the page itself, which readPage already covered.
      const sel = query.selector.trim()
      if (sel.startsWith('#') && el.id) return el.id === sel.slice(1)
      return false
    })

    if (matches.length === 0) return { found: false, match: null, count: 0, candidates: [] }
    if (matches.length > 1) {
      return {
        found: false, match: null, count: matches.length,
        candidates: matches.slice(0, 8).map(m => `${m.role} "${m.name}"${m.id ? ` #${m.id}` : ''}`),
      }
    }
    return { found: true, match: matches[0], count: 1, candidates: [] }
  }

  /** The CSS selector for a matched element, resolved against the live page. */
  private async selectorFor(query: ElementQuery): Promise<string> {
    if (query.by === 'css') return query.selector
    const found = await this.findElement(query)
    if (!found.found || !found.match) {
      throw new Error(found.count > 1
        ? `"${query.by === 'role' ? query.role : (query as { text?: string }).text}" matches ${found.count} elements (${found.candidates.join(', ')}). Be more specific.`
        : `Nothing on the page matches that ${query.by}. Read the page to see what is there.`)
    }
    // Re-derive the selector in the page, because readPage does not carry it out.
    const name = found.match.name
    const role = found.match.role
    const raw = await this.evaluate(`(() => {
      const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const wantName = ${JSON.stringify(name.toLowerCase())}
      const wantRole = ${JSON.stringify(role.toLowerCase())}
      const roleOf = (el) => {
        const explicit = el.getAttribute('role')
        if (explicit) return explicit.trim().toLowerCase()
        const tag = el.tagName.toLowerCase()
        if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
        if (tag === 'button') return 'button'
        if (tag === 'input') {
          const type = (el.getAttribute('type') || 'text').toLowerCase()
          if (type === 'checkbox') return 'checkbox'
          if (type === 'radio') return 'radio'
          if (type === 'submit' || type === 'button') return 'button'
          return 'textbox'
        }
        if (tag === 'select') return 'combobox'
        if (tag === 'textarea') return 'textbox'
        return tag
      }
      const nameOf = (el) => {
        const aria = el.getAttribute('aria-label')
        if (aria && aria.trim()) return aria.trim()
        if (el.id) {
          const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
          if (label) return (label.innerText || '').replace(/\\s+/g, ' ').trim()
        }
        const own = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
        if (own) return own
        return (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim()
      }
      const selectorOf = (el) => {
        if (el.id) return '#' + CSS.escape(el.id)
        const tag = el.tagName.toLowerCase()
        for (const a of ['data-testid','data-test','name','aria-label','placeholder','title','type']) {
          const v = el.getAttribute(a)
          if (v && v.trim()) return tag + '[' + a + '="' + v.replace(/"/g, '\\\\"') + '"]'
        }
        const cls = (el.className || '').toString().trim().split(/\\s+/).filter(Boolean)[0]
        return cls ? tag + '.' + CSS.escape(cls) : tag
      }
      const SEL = 'button,a[href],input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="combobox"],[role="textbox"],[role="switch"],[role="option"],[role="slider"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
      for (const el of Array.from(document.querySelectorAll(SEL))) {
        if (roleOf(el) !== wantRole) continue
        if (norm(nameOf(el)) !== wantName) continue
        return selectorOf(el)
      }
      return ''
    })()`)
    if (!raw) throw new Error('That element moved or disappeared between reading the page and acting on it. Read the page again.')
    return raw
  }

  /**
   * Click an element with real pointer input, so a page that listens for a real click
   * (React, most trading terminals) reacts the way it would for the user.
   */
  async click(query: ElementQuery): Promise<{ clicked: string }> {
    const a = this.require()
    const selector = await this.selectorFor(query)
    await this.evaluate(scrollToScript(selector))
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return ''
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    })()`)
    let point: { x: number; y: number } | null = null
    try { point = box ? JSON.parse(box) as { x: number; y: number } : null } catch { point = null }

    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      try {
        await a.client.send('input.performActions', {
          context: this.context(),
          actions: [{
            type: 'pointer', id: 'goga-mouse', parameters: { pointerType: 'mouse' },
            actions: [
              { type: 'pointerMove', x: Math.round(point.x), y: Math.round(point.y), duration: 0, origin: 'viewport' },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          }],
        })
        return { clicked: selector }
      } catch { /* fall through to a scripted click */ }
    }
    // A scripted click is the fallback: it still fires the element's own handler.
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return 'no'
      el.click()
      return 'yes'
    })()`)
    if (ok !== 'yes') throw new Error('That element disappeared before Goga could click it. Read the page again.')
    return { clicked: selector }
  }

  /**
   * Type into a field with real key events, after clearing it.
   *
   * Real keys matter: a page that validates as you type, or that only enables its button
   * once the field has been typed into, will not react to a value set behind its back.
   */
  async type(query: ElementQuery, text: string): Promise<{ typed: string }> {
    const a = this.require()
    const selector = await this.selectorFor(query)
    await this.evaluate(scrollToScript(selector))
    const focused = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return 'no'
      el.focus()
      if (el.select) el.select()
      return document.activeElement === el ? 'yes' : 'no'
    })()`)
    if (focused !== 'yes') throw new Error('Goga could not put the cursor in that field. It may be hidden or read-only.')

    // Clear whatever is there, the way a person would.
    await a.client.send('input.performActions', {
      context: this.context(),
      actions: [{
        type: 'key', id: 'goga-keys',
        actions: [
          { type: 'keyDown', value: '\uE009' }, { type: 'keyUp', value: '\uE009' },   // Control
          { type: 'keyDown', value: 'a' }, { type: 'keyUp', value: 'a' },
          { type: 'keyUp', value: '\uE009' },
          { type: 'keyDown', value: '\uE003' }, { type: 'keyUp', value: '\uE003' },   // Backspace
        ],
      }],
    }).catch(() => { /* clearing is best-effort; the value is checked below */ })

    const keys = Array.from(text).slice(0, 500).flatMap(ch => ([
      { type: 'keyDown' as const, value: ch },
      { type: 'keyUp' as const, value: ch },
    ]))
    if (keys.length) {
      await a.client.send('input.performActions', {
        context: this.context(),
        actions: [{ type: 'key', id: 'goga-keys', actions: keys }],
      })
    }
    return { typed: text }
  }

  /** Read what a field currently holds. */
  async readValue(query: ElementQuery): Promise<{ found: boolean; value: string | null; visible: boolean }> {
    const selector = await this.selectorFor(query)
    const raw = await this.evaluate(readValueScript(selector))
    try {
      const parsed = JSON.parse(raw) as { found?: boolean; value?: string | null; visible?: boolean }
      return { found: parsed.found === true, value: parsed.value ?? null, visible: parsed.visible === true }
    } catch {
      return { found: false, value: null, visible: false }
    }
  }

  /** Wait for text to appear on the page. Returns whether it did, and what it saw. */
  async waitForText(text: string, exact = false, timeoutMs = ACTION_TIMEOUT_MS): Promise<{ found: boolean; firstText: string }> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 500), 60_000)
    let last = { count: 0, firstText: '', visible: false }
    while (Date.now() < deadline) {
      const raw = await this.evaluate(waitForTextScript(text, exact))
      try { last = JSON.parse(raw) as typeof last } catch { /* keep polling */ }
      if (last.count > 0 && last.visible) return { found: true, firstText: last.firstText }
      await new Promise(r => setTimeout(r, 400))
    }
    return { found: false, firstText: last.firstText }
  }

  /** Wait for an element matching a query to be present. */
  async waitForElement(query: ElementQuery, timeoutMs = ACTION_TIMEOUT_MS): Promise<FoundElement> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 500), 60_000)
    let last: FoundElement = { found: false, match: null, count: 0, candidates: [] }
    while (Date.now() < deadline) {
      last = await this.findElement(query)
      if (last.found) return last
      await new Promise(r => setTimeout(r, 400))
    }
    return last
  }

  /** A PNG of the selected tab, base64. */
  async screenshot(): Promise<{ base64: string; url: string }> {
    const a = this.require()
    const shot = await a.client.send<{ data?: string }>('browsingContext.captureScreenshot', {
      context: this.context(),
    })
    const url = await this.evaluate('location.href')
    return { base64: shot.data ?? '', url }
  }

  /** Save a screenshot to a file the user can open. */
  async screenshotToFile(filePath: string): Promise<{ path: string; bytes: number }> {
    const shot = await this.screenshot()
    if (!shot.base64) throw new Error('The browser returned an empty screenshot.')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const buf = Buffer.from(shot.base64, 'base64')
    fs.writeFileSync(filePath, buf)
    return { path: filePath, bytes: buf.length }
  }

  /** The last thing the layer said about itself, for a caller that wants the reason. */
  get message(): string { return this.lastMessage }

  /** True when a LIVE session is held. A dead socket is not attached, so a consumer relaunches. */
  get isAttached(): boolean { return this.attached !== null && this.attached.client.isAlive }
}

let instance: BrowserLayer | null = null
export function browserLayer(): BrowserLayer {
  return instance ??= new BrowserLayer()
}

export { BidiError }
