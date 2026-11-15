import fs from 'fs'
import http from 'http'
import https from 'https'
import { forbiddenTarget } from '../security/scope'
import { decideRobots, OSINT_USER_AGENT } from './robots'
import { osintFile } from './paths'

/**
 * The one place OSINT talks to the network.
 *
 * Every rule the feature promises is enforced here, in code:
 *
 *   - a modest delay between requests to the same host (default 1000 ms) and a global cap
 *     of 2 requests in flight;
 *   - local, private-range and cloud-metadata hosts are refused outright, reusing the
 *     bug-bounty scope checker's `forbiddenTarget`;
 *   - redirects are followed only within the same site, at most twice, and every hop is
 *     re-checked against the same rules;
 *   - robots.txt is fetched once per origin and a page is refused when it is disallowed, or
 *     when robots.txt could not be read at all (we do not assume a yes);
 *   - responses are cached with the source URL and the time they were read, so the UI can
 *     say when a fact was true;
 *   - nothing sends credentials: no cookies, no session, and an Authorization header only
 *     for the one public API the user supplied a key for;
 *   - responses are bounded by size and by timeout.
 */

export interface OsintFetchResult {
  url: string
  finalUrl: string
  status: number | null
  ok: boolean
  body: string
  readAt: string
  cached: boolean
  /** Network-level failure text, when there was one. */
  error: string | null
  /** Set when the request was refused before it was sent. */
  refusedReason: string | null
}

interface CacheEntry { url: string; status: number; body: string; readAt: string }
interface RobotsEntry { fetchedAt: number; text: string | null; error: string | null }

const HOST_DELAY_MS = 1000
const MAX_CONCURRENT = 2
const TIMEOUT_MS = 15_000
const MAX_BYTES = 400_000
const CACHE_TTL_MS = 6 * 60 * 60_000
const ROBOTS_TTL_MS = 12 * 60 * 60_000
const MAX_REDIRECTS = 2

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Site key: the last two labels, or three for a known two-part public suffix. */
export function siteKey(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '')
  const parts = h.split('.')
  if (parts.length <= 2) return h
  const twoPart = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'or.jp', 'ne.jp', 'com.br', 'com.cn', 'co.nz', 'co.za', 'co.in', 'com.tr', 'com.mx'])
  const lastTwo = parts.slice(-2).join('.')
  return twoPart.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo
}

interface RawResponse { status: number | null; location: string | null; body: string; error: string | null }

/** One HTTP GET on the system's own TLS stack, bounded, with redirects handled by us. */
function rawGet(url: string, headers: Record<string, string>, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES): Promise<RawResponse> {
  return new Promise(resolve => {
    let settled = false
    const done = (r: RawResponse) => { if (!settled) { settled = true; resolve(r) } }
    let parsed: URL
    try { parsed = new URL(url) } catch { return done({ status: null, location: null, body: '', error: 'not a URL' }) }
    const lib = parsed.protocol === 'http:' ? http : https
    const req = lib.request(parsed, { method: 'GET', headers }, res => {
      const location = typeof res.headers.location === 'string' ? res.headers.location : null
      const status = res.statusCode ?? null
      if (status && status >= 300 && status < 400) {
        res.resume()
        res.on('end', () => done({ status, location, body: '', error: null }))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        chunks.push(chunk)
        if (total >= maxBytes) {
          req.destroy()
          done({ status, location: null, body: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), error: null })
        }
      })
      res.on('end', () => done({ status, location: null, body: Buffer.concat(chunks).toString('utf8').slice(0, maxBytes), error: null }))
      res.on('error', err => done({ status, location: null, body: '', error: err.message }))
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); done({ status: null, location: null, body: '', error: `no answer within ${Math.round(timeoutMs / 1000)}s` }) })
    req.on('error', err => done({ status: null, location: null, body: '', error: err.message }))
    req.end()
  })
}

export class OsintHttp {
  private lastHit = new Map<string, number>()
  private inFlight = 0
  private waiting: (() => void)[] = []
  private cache = new Map<string, CacheEntry>()
  private cacheLoaded = false
  private robots = new Map<string, RobotsEntry>()
  /** Every host contacted during this run, for the audit entry. */
  readonly contacted: string[] = []
  /** Hosts whose answer came from the local cache instead of the network. */
  readonly fromCache: string[] = []
  /** Every request refused before it was sent, with the reason. */
  readonly skipped: { host: string; reason: string }[] = []

  constructor(private readonly opts: { fetchImpl?: typeof rawGet; cacheFile?: string | null; hostDelayMs?: number } = {}) {}

  private get fetchImpl(): typeof rawGet { return this.opts.fetchImpl ?? rawGet }
  private get delayMs(): number { return this.opts.hostDelayMs ?? HOST_DELAY_MS }

  // ---------- cache ----------

  private cacheFile(): string | null {
    if (this.opts.cacheFile !== undefined) return this.opts.cacheFile
    return osintFile('goga-osint-cache.json')
  }

  private loadCache(): void {
    if (this.cacheLoaded) return
    this.cacheLoaded = true
    const file = this.cacheFile()
    if (!file) return
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, CacheEntry>
      for (const [k, v] of Object.entries(raw)) {
        if (Date.parse(v.readAt) && Date.now() - Date.parse(v.readAt) < CACHE_TTL_MS * 4) this.cache.set(k, v)
      }
    } catch { /* no cache yet */ }
  }

  private saveCache(): void {
    const file = this.cacheFile()
    if (!file) return
    try {
      const entries = [...this.cache.entries()].slice(-400)
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 })
    } catch { /* caching is best effort; the result still stands */ }
  }

  private getCached(url: string): CacheEntry | null {
    this.loadCache()
    const hit = this.cache.get(url)
    if (!hit) return null
    if (Date.now() - Date.parse(hit.readAt) > CACHE_TTL_MS) return null
    return hit
  }

  // ---------- concurrency + per-host delay ----------

  private async slot(): Promise<void> {
    if (this.inFlight < MAX_CONCURRENT) { this.inFlight++; return }
    await new Promise<void>(resolve => this.waiting.push(resolve))
    this.inFlight++
  }

  private release(): void {
    this.inFlight--
    const next = this.waiting.shift()
    if (next) next()
  }

  private async respectHostDelay(host: string): Promise<void> {
    const last = this.lastHit.get(host) ?? 0
    const wait = this.delayMs - (Date.now() - last)
    if (wait > 0) await sleep(wait)
    this.lastHit.set(host, Date.now())
  }

  // ---------- robots ----------

  private async robotsFor(origin: string): Promise<RobotsEntry> {
    const known = this.robots.get(origin)
    if (known && Date.now() - known.fetchedAt < ROBOTS_TTL_MS) return known
    const res = await this.fetchImpl(`${origin}/robots.txt`, { 'User-Agent': OSINT_USER_AGENT, Accept: 'text/plain,*/*;q=0.5' }, 10_000, 200_000)
    let entry: RobotsEntry
    if (res.status === 200) entry = { fetchedAt: Date.now(), text: res.body, error: null }
    else if (res.status && res.status >= 400 && res.status < 500) entry = { fetchedAt: Date.now(), text: '', error: null }
    else entry = { fetchedAt: Date.now(), text: null, error: res.error ?? `robots.txt answered ${res.status ?? 'nothing'}` }
    this.robots.set(origin, entry)
    return entry
  }

  /**
   * May this URL be read? Returns a refusal reason when it must not be read.
   * `respectRobots: false` is used only for endpoints documented for machine use (DNS,
   * RDAP, certificate transparency), where robots.txt describes a crawl, not an API call.
   */
  async check(url: string, respectRobots = true): Promise<string | null> {
    let parsed: URL
    try { parsed = new URL(url) } catch { return 'that is not a URL Goga can read' }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return `only http and https can be read (got ${parsed.protocol})`
    const forbidden = forbiddenTarget(parsed.hostname)
    if (forbidden) return forbidden
    if (!respectRobots) return null
    const robots = await this.robotsFor(parsed.origin)
    if (robots.text === null) {
      return `robots.txt could not be read (${robots.error ?? 'unknown reason'}), so Goga did not read this page`
    }
    const verdict = decideRobots(robots.text, `${parsed.pathname}${parsed.search}`)
    return verdict.verdict === 'disallowed' ? verdict.reason : null
  }

  // ---------- public GET ----------

  async get(url: string, opts: { respectRobots?: boolean; maxRedirects?: number; accept?: string; allowCrossSite?: boolean; timeoutMs?: number } = {}): Promise<OsintFetchResult> {
    const cached = this.getCached(url)
    if (cached) {
      try {
        const h = new URL(cached.url).hostname
        if (!this.fromCache.includes(h)) this.fromCache.push(h)
      } catch { /* unparseable cached URL: nothing to record */ }
      return { url, finalUrl: cached.url, status: cached.status, ok: cached.status >= 200 && cached.status < 300, body: cached.body, readAt: cached.readAt, cached: true, error: null, refusedReason: null }
    }

    let current = url
    const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS
    await this.slot()
    try {
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const refusal = await this.check(current, opts.respectRobots ?? true)
        if (refusal) {
          this.skipped.push({ host: new URL(current).hostname, reason: refusal })
          return { url, finalUrl: current, status: null, ok: false, body: '', readAt: new Date().toISOString(), cached: false, error: null, refusedReason: refusal }
        }
        const host = new URL(current).hostname
        await this.respectHostDelay(host)
        const res = await this.fetchImpl(
          current,
          { 'User-Agent': OSINT_USER_AGENT, Accept: opts.accept ?? 'text/html,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' },
          opts.timeoutMs ?? TIMEOUT_MS,
        )
        if (!this.contacted.includes(host)) this.contacted.push(host)
        if (res.status && res.status >= 300 && res.status < 400 && res.location) {
          let next: string
          try { next = new URL(res.location, current).toString() } catch { next = '' }
          if (!next) {
            return { url, finalUrl: current, status: res.status, ok: false, body: '', readAt: new Date().toISOString(), cached: false, error: 'redirect to an unreadable location', refusedReason: null }
          }
          // A few documented APIs redirect to the authoritative server on purpose (RDAP
          // bootstrap does exactly this). That hop is allowed only when the caller opts in,
          // and it is still checked for forbidden hosts and for https by `check()` above.
          const crossSite = new URL(next).protocol === 'https:' && opts.allowCrossSite === true
          if (!crossSite && siteKey(new URL(next).hostname) !== siteKey(host)) {
            this.skipped.push({ host: new URL(next).hostname, reason: `a redirect from ${host} to another site was not followed` })
            return { url, finalUrl: current, status: res.status, ok: false, body: '', readAt: new Date().toISOString(), cached: false, error: `redirect to another site was not followed`, refusedReason: null }
          }
          current = next
          continue
        }
        const readAt = new Date().toISOString()
        this.cache.set(url, { url: current, status: res.status ?? 0, body: res.body, readAt })
        this.saveCache()
        return { url, finalUrl: current, status: res.status, ok: !!res.status && res.status >= 200 && res.status < 300, body: res.body, readAt, cached: false, error: res.error, refusedReason: null }
      }
      return { url, finalUrl: current, status: null, ok: false, body: '', readAt: new Date().toISOString(), cached: false, error: 'too many redirects', refusedReason: null }
    } finally {
      this.release()
    }
  }

  /** A GET with a caller-supplied API key, for the one public API that needs one. */
  async getWithKey(url: string, headers: Record<string, string>): Promise<OsintFetchResult> {
    const readAt = new Date().toISOString()
    await this.slot()
    try {
      const refusal = await this.check(url, false)
      if (refusal) {
        this.skipped.push({ host: new URL(url).hostname, reason: refusal })
        return { url, finalUrl: url, status: null, ok: false, body: '', readAt, cached: false, error: null, refusedReason: refusal }
      }
      const host = new URL(url).hostname
      await this.respectHostDelay(host)
      const res = await this.fetchImpl(url, { 'User-Agent': OSINT_USER_AGENT, Accept: 'application/json', ...headers })
      if (!this.contacted.includes(host)) this.contacted.push(host)
      return { url, finalUrl: url, status: res.status, ok: !!res.status && res.status >= 200 && res.status < 300, body: res.body, readAt, cached: false, error: res.error, refusedReason: null }
    } finally { this.release() }
  }

  /** A DNS-over-HTTPS lookup (Cloudflare's JSON endpoint; no key, no account). */
  async dns(name: string, type: string): Promise<{ ok: boolean; records: string[]; status: number | null; error: string | null; readAt: string; cached: boolean; url: string }> {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`
    // Cloudflare's JSON endpoint requires this Accept header; without it the answer is a 400.
    const res = await this.get(url, { respectRobots: false, maxRedirects: 0, accept: 'application/dns-json' })
    const base = { status: res.status, readAt: res.readAt, cached: res.cached, url }
    if (res.refusedReason) return { ...base, ok: false, records: [], error: res.refusedReason }
    if (res.error) return { ...base, ok: false, records: [], error: res.error }
    try {
      const doc = JSON.parse(res.body) as { Status?: number; Answer?: { data?: string }[] }
      const records = (doc.Answer ?? []).map(a => String(a.data ?? '').replace(/^"|"$/g, '')).filter(Boolean)
      return { ...base, ok: true, records, error: null }
    } catch {
      return { ...base, ok: false, records: [], error: 'the DNS answer was not readable JSON' }
    }
  }

  refusedHosts(): { host: string; reason: string }[] { return [...this.skipped] }
}
