import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { SecurityWorkspace } from '../../shared/types'
import { LEARNING_PATH, type ResearchSource, type ToolInventoryEntry } from '../../shared/securityGuide'
import { readableText } from '../tools/web'

export function policyFingerprint(ws: Pick<SecurityWorkspace, 'programRules' | 'authorizedAssets' | 'excludedAssets' | 'allowedTechniques' | 'prohibitedTechniques' | 'rateLimit' | 'hackerOne'>): string {
  // Import timestamps are metadata, not policy changes.
  let rules: unknown = ws.programRules
  try { const parsed = JSON.parse(ws.programRules); delete parsed.importedAt; rules = parsed } catch { /* manual policy */ }
  return createHash('sha256').update(JSON.stringify([rules, ws.authorizedAssets, ws.excludedAssets, ws.allowedTechniques, ws.prohibitedTechniques, ws.rateLimit, ws.hackerOne?.submissionState, ws.hackerOne?.scopes])).digest('hex')
}

export function researchUrl(input: string): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Invalid research URL')
  const url = new URL(input)
  const fixed = LEARNING_PATH.some(s => s.url === url.href)
  const report = url.origin === 'https://hackerone.com' && /^\/reports\/\d+$/.test(url.pathname) && !url.search
  if (url.username || url.password || url.hash || (!fixed && !report)) throw new Error('Choose a learning source or a public HackerOne report URL')
  return url.href
}

/** One bounded public GET; redirects cannot reach target assets or carry credentials. */
export async function readResearch(input: string): Promise<ResearchSource> {
  const url = researchUrl(input)
  return { url, retrievedAt: new Date().toISOString(), content: readableText(await publicGet(url)).slice(0, 24000) }
}

async function publicGet(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  if (!response.ok || response.status >= 300) { await response.body?.cancel(); throw new Error(`Public source unavailable (HTTP ${response.status}); redirects and authenticated reports are unsupported`) }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty source')
  const chunks: Uint8Array[] = []; let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      bytes += value.length
      if (bytes > 1_000_000) { await reader.cancel(); throw new Error('Public source exceeds size limit') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}

export async function searchResearch(query: string, kind: 'programs' | 'disclosures') {
  if (typeof query !== 'string' || !query.trim() || query.length > 200 || !['programs', 'disclosures'].includes(kind)) throw new Error('Enter a research query (maximum 200 characters)')
  const filter = kind === 'disclosures' ? 'site:hackerone.com/reports/' : 'site:hackerone.com bug bounty program policy'
  const html = await publicGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${filter} ${query.trim()}`)}`)
  const results: Array<{ title: string; url: string; retrievedAt: string }> = []
  const links = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = links.exec(html)) && results.length < 8) {
    try {
      const wrapped = new URL(match[1].replace(/&amp;/g, '&'), 'https://html.duckduckgo.com')
      const url = new URL(wrapped.searchParams.get('uddg') ?? wrapped.href)
      if (url.origin !== 'https://hackerone.com' || url.username || url.password) continue
      if (kind === 'disclosures' && !/^\/reports\/\d+$/.test(url.pathname)) continue
      results.push({ title: readableText(match[2]), url: url.href, retrievedAt: new Date().toISOString() })
    } catch { /* Ignore malformed search results. Never follow them. */ }
  }
  return results
}

const TOOLS = [
  { name: 'curl', officialSource: 'https://curl.se/download.html' },
  { name: 'nmap', officialSource: 'https://nmap.org/download.html' },
  { name: 'nuclei', officialSource: 'https://github.com/projectdiscovery/nuclei/releases' },
  { name: 'httpx', officialSource: 'https://github.com/projectdiscovery/httpx/releases' },
]
/** Passive presence check only: never invoke a discovered executable. */
export function inventoryTools(searchPath = process.env.PATH ?? '', platform = process.platform): ToolInventoryEntry[] {
  const directories = searchPath.split(platform === 'win32' ? ';' : ':').filter(p => path.isAbsolute(p)).slice(0, 256)
  return TOOLS.map(tool => {
    const candidates = directories.map(dir => path.join(dir, tool.name + (platform === 'win32' ? '.exe' : '')))
    const location = candidates.find(candidate => { try { return fs.statSync(candidate).isFile() } catch { return false } }) ?? null
    return { ...tool, location, version: 'Not executed', status: location ? 'Found on PATH' : 'Not found on PATH' }
  })
}
