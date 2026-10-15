/**
 * Direct reproduction of browser-read-content-extraction defect.
 * Bypasses the LLM planner — exercises BrowserAdapter.open() + getContent()
 * exactly as the agent does, against https://example.com.
 */
const pw = await (new Function('return import("playwright")'))()
const chromium = pw.chromium
const BRAVE_PATH = 'C:\\Users\\redre\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'

console.log('--- launch ---')
const browser = await chromium.launch({
  executablePath: BRAVE_PATH,
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
})
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
})
const page = await context.newPage()

console.log('--- goto domcontentloaded ---')
const t0 = Date.now()
const response = await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30_000 })
console.log('nav ms       :', Date.now() - t0)
console.log('status       :', response ? response.status() : 'null')
console.log('final url    :', page.url())

console.log('--- readiness probe ---')
const readyState   = await page.evaluate('document.readyState')
const title        = await page.title()
const bodyExists   = await page.evaluate('!!document.body')
const innerTextLen = await page.evaluate('document.body ? document.body.innerText.length : -1')
const htmlLen      = await page.evaluate('document.documentElement.outerHTML.length')
console.log('readyState   :', readyState)
console.log('title        :', title)
console.log('bodyExists   :', bodyExists)
console.log('innerText.len:', innerTextLen)
console.log('html.len     :', htmlLen)

console.log('--- getContent simulation (exact adapter code) ---')
const [gcTitle, gcHtml] = await Promise.all([page.title(), page.content()])
const gcText = await page.evaluate('document.body ? document.body.innerText : ""')
console.log('gc title     :', gcTitle)
console.log('gc text.len  :', gcText.length)
console.log('gc html.len  :', gcHtml.length)
console.log('gc text[0:300]:', JSON.stringify(gcText.slice(0, 300)))
console.log('gc html[0:200]:', JSON.stringify(gcHtml.slice(0, 200)))

await browser.close()
console.log('--- done ---')
