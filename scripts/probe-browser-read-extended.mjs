/**
 * Extended probe for browser-read-content-extraction defect.
 * Tests:
 *   1. getContent on a live session (should succeed)
 *   2. getContent on a stale/unknown sessionId (should throw)
 *   3. getContent after vision.analyze steps (session still alive?)
 *   4. Exact error message from requireSession on unknown id
 */
import { BrowserAdapter } from '../dist/main/main/adapters/browser.js'

// Mock LogService since we're outside Electron
const mockLog = { info: console.log, warn: console.warn, error: console.error }

// Patch LogService.getInstance to return mock
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// We can't easily mock LogService in compiled JS, so test via the probe script approach
const pw = await (new Function('return import("playwright")'))()
const chromium = pw.chromium
const BRAVE_PATH = 'C:\\Users\\redre\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'

console.log('\n=== Test 1: getContent on live session ===')
const browser = await chromium.launch({
  executablePath: BRAVE_PATH, headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
})
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
})
const page = await context.newPage()
await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30_000 })
console.log('readyState:', await page.evaluate('document.readyState'))
console.log('title:', await page.title())

// Simulate getContent exactly
try {
  const [title, html] = await Promise.all([page.title(), page.content()])
  const text = await page.evaluate('document.body ? document.body.innerText : ""')
  console.log('PASS: title=%s text.len=%d html.len=%d', title, text.length, html.length)
  console.log('text preview:', JSON.stringify(text.slice(0, 200)))
} catch (e) {
  console.error('FAIL getContent:', e.message)
}

console.log('\n=== Test 2: simulate stale sessionId (requireSession miss) ===')
// This is what happens if the LLM passes a sessionId from a prior run
try {
  // requireSession throws: "No browser session: browser-2. Call browser.open first."
  const fakeMap = new Map()
  const s = fakeMap.get('browser-2')
  if (!s) throw new Error('No browser session: browser-2. Call browser.open first.')
} catch (e) {
  console.log('Expected error:', e.message)
}

console.log('\n=== Test 3: page still alive after 7 seconds (simulating vision.analyze delay) ===')
await new Promise(r => setTimeout(r, 7000))
try {
  const text = await page.evaluate('document.body ? document.body.innerText : ""')
  console.log('PASS: page still alive after 7s, text.len=%d', text.length)
} catch (e) {
  console.error('FAIL: page died after 7s:', e.message)
}

console.log('\n=== Test 4: getContent after 7s delay ===')
try {
  const [title, html] = await Promise.all([page.title(), page.content()])
  const text = await page.evaluate('document.body ? document.body.innerText : ""')
  console.log('PASS: title=%s text.len=%d html.len=%d', title, text.length, html.length)
} catch (e) {
  console.error('FAIL getContent after delay:', e.message)
}

await browser.close()
console.log('\n--- done ---')
