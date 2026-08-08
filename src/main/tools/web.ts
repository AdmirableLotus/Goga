import https from 'https'
import http from 'http'
import { ToolRegistry } from './registry'

const reg = ToolRegistry.getInstance()

function fetchUrl(url: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
      timeout: timeoutMs
    }, (res) => {
      // Follow one redirect
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject)
      }
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve(body))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')) })
  })
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

reg.register({
  name: 'web.search',
  description: 'Search the web using DuckDuckGo. Returns titles, URLs and snippets.',
  parameters: {
    type: 'object',
    properties: {
      query:  { type: 'string', description: 'Search query.' },
      maxResults: { type: 'number', description: 'Max results to return. Default: 8.' }
    },
    required: ['query']
  },
  riskLevel: 'low', reversible: true, category: 'web'
}, async (p) => {
  const query = encodeURIComponent(p.query as string)
  const max = (p.maxResults as number | undefined) ?? 8
  try {
    const html = await fetchUrl(`https://html.duckduckgo.com/html/?q=${query}`)
    const results: { title: string; url: string; snippet: string }[] = []

    // Parse result blocks from DDG HTML
    const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi

    let match: RegExpExecArray | null
    const snippets: string[] = []
    while ((match = snippetRe.exec(html)) !== null) {
      snippets.push(stripHtml(match[1]).slice(0, 200))
    }

    let i = 0
    while ((match = blockRe.exec(html)) !== null && results.length < max) {
      const rawUrl = match[1]
      const title = stripHtml(match[2])
      // DDG wraps URLs — extract the actual URL from uddg param
      const uddg = rawUrl.match(/uddg=([^&]+)/)
      const url = uddg ? decodeURIComponent(uddg[1]) : rawUrl
      results.push({ title, url, snippet: snippets[i] ?? '' })
      i++
    }

    return { success: true, data: results }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

reg.register({
  name: 'web.fetch',
  description: 'Fetch a URL and return its text content (HTML stripped). Useful for reading web pages, APIs, documentation.',
  parameters: {
    type: 'object',
    properties: {
      url:       { type: 'string', description: 'URL to fetch.' },
      maxChars:  { type: 'number', description: 'Max characters to return. Default: 8000.' },
      raw:       { type: 'boolean', description: 'Return raw HTML instead of stripped text. Default: false.' }
    },
    required: ['url']
  },
  riskLevel: 'low', reversible: true, category: 'web'
}, async (p) => {
  try {
    const html = await fetchUrl(p.url as string)
    const max = (p.maxChars as number | undefined) ?? 8000
    const content = p.raw ? html.slice(0, max) : stripHtml(html).slice(0, max)
    return { success: true, data: { url: p.url, content, truncated: content.length >= max } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

export function registerWebTools() {
  return ToolRegistry.getInstance()
}
