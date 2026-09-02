import { ToolRegistry } from './registry'
import { BrowserAdapter } from '../adapters/browser'

// Singleton adapter — sessions persist across tool calls within one agent task
const browser = new BrowserAdapter()
const reg = ToolRegistry.getInstance()

reg.register({
  name: 'browser.open',
  description: 'Open a URL in Brave browser using Playwright. Returns a sessionId used by all other browser tools.',
  parameters: {
    type: 'object',
    properties: {
      url:      { type: 'string', description: 'URL to open.' },
      headless: { type: 'boolean', description: 'Run headless (no visible window). Default: false.' }
    },
    required: ['url']
  },
  riskLevel: 'low', reversible: true, category: 'browser'
}, async (p) => {
  const r = await browser.open(p.url as string, p.headless as boolean | undefined)
  return { success: true, data: r }
})

reg.register({
  name: 'browser.navigate',
  description: 'Navigate an existing browser session to a new URL.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session ID from browser.open.' },
      url:       { type: 'string', description: 'URL to navigate to.' }
    },
    required: ['sessionId', 'url']
  },
  riskLevel: 'low', reversible: true, category: 'browser'
}, async (p) => {
  const r = await browser.navigate(p.sessionId as string, p.url as string)
  return { success: true, data: r }
})

reg.register({
  name: 'browser.click',
  description: 'Click an element in the browser by CSS selector, or by x,y coordinates.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      selector:  { type: 'string', description: 'CSS selector of element to click.' },
      x:         { type: 'number', description: 'X coordinate (alternative to selector).' },
      y:         { type: 'number', description: 'Y coordinate (alternative to selector).' }
    },
    required: ['sessionId']
  },
  riskLevel: 'medium', reversible: true, category: 'browser'
}, async (p) => {
  const r = await browser.click(p.sessionId as string, p.selector as string | undefined, p.x as number | undefined, p.y as number | undefined)
  return { success: true, data: r }
})

reg.register({
  name: 'browser.type',
  description: 'Fill a text input in the browser by CSS selector.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      selector:  { type: 'string', description: 'CSS selector of the input element.' },
      text:      { type: 'string', description: 'Text to type into the input.' }
    },
    required: ['sessionId', 'selector', 'text']
  },
  riskLevel: 'medium', reversible: true, category: 'browser'
}, async (p) => {
  const r = await browser.type(p.sessionId as string, p.selector as string, p.text as string)
  return { success: true, data: r }
})

reg.register({
  name: 'browser.read',
  description: 'Get the current page URL, title, visible text content and HTML of a browser session.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' }
    },
    required: ['sessionId']
  },
  riskLevel: 'low', reversible: true, category: 'browser'
}, async (p) => {
  const r = await browser.getContent(p.sessionId as string)
  return { success: true, data: r }
})

reg.register({
  name: 'browser.screenshot',
  description: 'Take a screenshot of the current browser page. Returns base64 PNG.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' }
    },
    required: ['sessionId']
  },
  riskLevel: 'low', reversible: true, category: 'browser'
}, async (p) => {
  const r = await browser.screenshotPage(p.sessionId as string)
  return { success: true, data: r }
})

reg.register({
  name: 'browser.evaluate',
  description: 'Run JavaScript in the browser page context and return the result. Use for extracting data, checking state, or interacting with the DOM.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      script:    { type: 'string', description: 'JavaScript expression or function body to evaluate.' }
    },
    required: ['sessionId', 'script']
  },
  riskLevel: 'medium', reversible: true, category: 'browser'
}, async (p) => {
  const r = await browser.evaluate(p.sessionId as string, p.script as string)
  return { success: true, data: r }
})

reg.register({
  name: 'browser.waitFor',
  description: 'Wait for a CSS selector to appear on the page.',
  parameters: {
    type: 'object',
    properties: {
      sessionId:  { type: 'string' },
      selector:   { type: 'string', description: 'CSS selector to wait for.' },
      timeoutMs:  { type: 'number', description: 'Max wait time in ms. Default: 10000.' }
    },
    required: ['sessionId', 'selector']
  },
  riskLevel: 'low', reversible: true, category: 'browser'
}, async (p) => {
  const r = await browser.waitFor(p.sessionId as string, p.selector as string, p.timeoutMs as number | undefined)
  return { success: true, data: r }
})

reg.register({
  name: 'browser.close',
  description: 'Close a browser session.',
  parameters: {
    type: 'object',
    properties: { sessionId: { type: 'string' } },
    required: ['sessionId']
  },
  riskLevel: 'low', reversible: true, category: 'browser'
}, async (p) => {
  const r = await browser.close(p.sessionId as string)
  return { success: true, data: r }
})

// Export adapter so agent loop can inspect active sessions
export { browser as browserAdapter }

export function registerBrowserTools() {
  return ToolRegistry.getInstance()
}
