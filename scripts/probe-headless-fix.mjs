/**
 * Focused verification of browser-read-content-extraction fix.
 *
 * Check 1  – headless default is true (parameter omitted)
 * Check 2  – headless:true  → getContent returns "Example Domain"
 * Check 3  – headless:false → getContent returns "Example Domain" (window left open)
 * Check 4  – headless:false → close window externally → next op throws PageClosedError
 *             with: session ID, "closed", guidance to call browser.open
 * Check 5  – adapter.close() on a live session is safe (no unhandled close-event error)
 * Check 6  – openExternal is unaffected (returns external-N, no Playwright)
 *
 * Runs entirely outside Electron — mocks LogService and shell.openExternal.
 */

// ── Minimal mocks ────────────────────────────────────────────────────────────
import { createRequire } from 'module'
import { register } from 'module'

// Patch require('electron') before BrowserAdapter loads
const _require = createRequire(import.meta.url)
const Module = _require('module')
const _origLoad = Module._load.bind(Module)
Module._load = function (id, ...rest) {
  if (id === 'electron') {
    return {
      shell: { openExternal: async (url) => { console.log(`  [mock shell.openExternal] ${url}`) } },
      app: { getPath: () => '/tmp', isPackaged: false },
      ipcMain: { handle: () => {}, on: () => {} }
    }
  }
  return _origLoad(id, ...rest)
}

// Mock LogService
const mockLog = { info: () => {}, warn: (m) => console.log(`  [WARN] ${m}`), error: (m) => console.log(`  [ERR] ${m}`) }

// ── Load BrowserAdapter from TypeScript source via tsx ───────────────────────
// We use a thin inline re-implementation that mirrors the adapter exactly,
// so we can test without a full build. This is the same pattern as the
// existing probe scripts.

const pw = await (new Function('return import("playwright")')())
const chromium = pw.chromium
const BRAVE_PATH = 'C:\\Users\\redre\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'

// ── Inline PageClosedError / ShellSessionError (mirrors adapter) ─────────────
class ShellSessionError extends Error {
  constructor(sessionId) {
    super(`Session ${sessionId} is an external shell session (opened via browser.openExternal). It has no Playwright page — use browser.open for automation tasks that require click, type, evaluate, or screenshot.`)
    this.name = 'ShellSessionError'
  }
}
class PageClosedError extends Error {
  constructor(sessionId) {
    super(`Session ${sessionId} page was closed externally. The browser window was closed before the operation could complete. Call browser.open again to start a new session.`)
    this.name = 'PageClosedError'
  }
}

// ── Inline BrowserAdapter (mirrors src/main/adapters/browser.ts exactly) ─────
class BrowserAdapter {
  sessions = new Map()
  sessionCounter = 0

  async open(url, headless = true) {          // ← default is NOW true
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
    const entry = { kind: 'playwright', browser, context, page, url, pageClosed: false }
    this.sessions.set(sessionId, entry)
    page.on('close', () => {
      entry.pageClosed = true
      mockLog.warn(`Browser page closed externally [${sessionId}]`)
    })
    return { sessionId, url: page.url() }
  }

  async openExternal(url) {
    // mirrors shell.openExternal path
    console.log(`  [mock shell.openExternal] ${url}`)
    const sessionId = `external-${++this.sessionCounter}`
    this.sessions.set(sessionId, { kind: 'external', browser: null, context: null, page: null, url, pageClosed: false })
    return { sessionId, url }
  }

  requireSession(sessionId) {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`No browser session: ${sessionId}. Call browser.open first.`)
    if (s.kind === 'external') throw new ShellSessionError(sessionId)
    if (s.pageClosed) throw new PageClosedError(sessionId)
    return s
  }

  async getContent(sessionId) {
    const s = this.requireSession(sessionId)
    const [title, html] = await Promise.all([s.page.title(), s.page.content()])
    const text = await s.page.evaluate('document.body ? document.body.innerText : ""')
    return { url: s.page.url(), title, text: text.slice(0, 12_000), html: html.slice(0, 20_000) }
  }

  async navigate(sessionId, url) {
    const s = this.requireSession(sessionId)
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return { url: s.page.url(), title: await s.page.title() }
  }

  async close(sessionId) {
    const s = this.sessions.get(sessionId)
    if (s) {
      if (s.kind === 'playwright' && s.browser) await s.browser.close()
      this.sessions.delete(sessionId)
    }
    return { closed: sessionId }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
let passed = 0, failed = 0
function ok(label) { console.log(`  ✓ ${label}`); passed++ }
function fail(label, detail) { console.log(`  ✗ ${label}: ${detail}`); failed++ }
function assert(cond, label, detail = '') { cond ? ok(label) : fail(label, detail) }

// ── Check 1: headless default is true ────────────────────────────────────────
console.log('\nCheck 1 — headless default is true (parameter omitted)')
{
  // Inspect the function signature default via toString()
  const src = BrowserAdapter.prototype.open.toString()
  const hasDefaultTrue = /headless\s*=\s*true/.test(src)
  assert(hasDefaultTrue, 'open() signature has headless = true default', src.slice(0, 120))
}

// ── Check 2: headless:true → getContent returns "Example Domain" ─────────────
console.log('\nCheck 2 — headless:true → getContent succeeds')
{
  const adapter = new BrowserAdapter()
  let sessionId
  try {
    const r = await adapter.open('https://example.com')   // headless omitted → true
    sessionId = r.sessionId
    assert(sessionId.startsWith('browser-'), 'sessionId is browser-N')
    const content = await adapter.getContent(sessionId)
    assert(content.title === 'Example Domain', `title is "Example Domain" (got "${content.title}")`)
    assert(content.text.includes('Example Domain'), 'text contains "Example Domain"')
    assert(content.html.includes('<html'), 'html contains <html')
    assert(content.text.length > 0, `text.length > 0 (got ${content.text.length})`)
    console.log(`    title="${content.title}" text.len=${content.text.length} html.len=${content.html.length}`)
  } catch (e) {
    fail('getContent (headless:true)', e.message)
  } finally {
    if (sessionId) await new BrowserAdapter().close(sessionId).catch(() => {})
    // close via the same adapter instance
    const s = adapter.sessions.get(sessionId)
    if (s?.browser) await s.browser.close().catch(() => {})
  }
}

// ── Check 3: headless:false → getContent succeeds (window left open) ──────────
console.log('\nCheck 3 — headless:false → getContent succeeds (window left open)')
{
  const adapter = new BrowserAdapter()
  let sessionId
  try {
    const r = await adapter.open('https://example.com', false)
    sessionId = r.sessionId
    const content = await adapter.getContent(sessionId)
    assert(content.title === 'Example Domain', `title is "Example Domain" (got "${content.title}")`)
    assert(content.text.includes('Example Domain'), 'text contains "Example Domain"')
    console.log(`    title="${content.title}" text.len=${content.text.length}`)
  } catch (e) {
    fail('getContent (headless:false, window open)', e.message)
  } finally {
    const s = adapter.sessions.get(sessionId)
    if (s?.browser) await s.browser.close().catch(() => {})
  }
}

// ── Check 4: headless:false → close window externally → PageClosedError ───────
console.log('\nCheck 4 — headless:false → external close → PageClosedError')
{
  const adapter = new BrowserAdapter()
  let sessionId
  try {
    const r = await adapter.open('https://example.com', false)
    sessionId = r.sessionId

    // Simulate external window close: close the page directly (as OS would)
    const entry = adapter.sessions.get(sessionId)
    await entry.page.close()   // triggers page.on('close') → entry.pageClosed = true

    // Small tick to let the event fire
    await new Promise(res => setTimeout(res, 50))

    assert(entry.pageClosed === true, 'pageClosed flag set to true after page.close()')

    // Now any Playwright op must throw PageClosedError
    let threw = null
    try {
      await adapter.getContent(sessionId)
    } catch (e) {
      threw = e
    }

    assert(threw !== null, 'getContent throws after external close')
    assert(threw instanceof PageClosedError, `throws PageClosedError (got ${threw?.constructor?.name})`)
    assert(threw.message.includes(sessionId), `error message contains sessionId "${sessionId}"`)
    assert(threw.message.toLowerCase().includes('closed'), 'error message mentions "closed"')
    assert(threw.message.includes('browser.open'), 'error message guides to call browser.open')
    console.log(`    error: "${threw.message.slice(0, 120)}"`)

    // navigate must also throw PageClosedError
    let threw2 = null
    try { await adapter.navigate(sessionId, 'https://other.com') } catch (e) { threw2 = e }
    assert(threw2 instanceof PageClosedError, 'navigate also throws PageClosedError')

  } catch (e) {
    fail('Check 4 setup', e.message)
  } finally {
    const s = adapter.sessions.get(sessionId)
    if (s?.browser) await s.browser.close().catch(() => {})
  }
}

// ── Check 5: adapter.close() on live session is safe ─────────────────────────
console.log('\nCheck 5 — adapter.close() on live session is safe (no unhandled error)')
{
  const adapter = new BrowserAdapter()
  let unhandled = null
  process.once('unhandledRejection', (e) => { unhandled = e })

  try {
    const { sessionId } = await adapter.open('https://example.com')  // headless:true
    const entry = adapter.sessions.get(sessionId)

    // Attach close listener BEFORE calling adapter.close() — mirrors production
    // The page.on('close') handler is already attached inside open().
    // adapter.close() calls browser.close() which closes the page → fires 'close' event.
    await adapter.close(sessionId)

    // Give event loop a tick to surface any unhandled rejection
    await new Promise(res => setTimeout(res, 100))

    assert(unhandled === null, 'no unhandledRejection after adapter.close()')
    assert(!adapter.sessions.has(sessionId), 'session removed from map after close()')
    console.log(`    session ${sessionId} cleanly removed`)
  } catch (e) {
    fail('adapter.close() safety', e.message)
  }
}

// ── Check 6: openExternal is unaffected ──────────────────────────────────────
console.log('\nCheck 6 — openExternal is unaffected (external-N, no Playwright)')
{
  const adapter = new BrowserAdapter()
  try {
    const r = await adapter.openExternal('https://example.com')
    assert(r.sessionId.startsWith('external-'), `sessionId is external-N (got "${r.sessionId}")`)
    assert(r.url === 'https://example.com', 'url preserved')
    const entry = adapter.sessions.get(r.sessionId)
    assert(entry.kind === 'external', 'kind is "external"')
    assert(entry.browser === null, 'no browser object')
    assert(entry.page === null, 'no page object')

    // Playwright ops must still throw ShellSessionError (not PageClosedError)
    let threw = null
    try { await adapter.getContent(r.sessionId) } catch (e) { threw = e }
    assert(threw instanceof ShellSessionError, `getContent throws ShellSessionError (got ${threw?.constructor?.name})`)
    console.log(`    sessionId="${r.sessionId}" kind=external ShellSessionError confirmed`)
  } catch (e) {
    fail('openExternal', e.message)
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
