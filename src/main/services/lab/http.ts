import type { Budget } from './runner'
import { checkTarget } from './targets'

/**
 * The one place a Lab tool sends an HTTP request.
 *
 * Every request goes through here, and here does three things in this order:
 *
 *   1. Checks the URL's host against the declarations. A URL that is not on a declared target
 *      is refused before a socket is opened, and the refusal names the host.
 *   2. Spends one unit of the run's budget. Past the cap, or after a stop, nothing is sent.
 *   3. Sends it with redirects NOT followed, because a redirect can leave the declared target.
 *
 * The response is read to a bounded size and returned with the status, the length and the
 * body. No cookies are kept between requests and no credentials are attached: a Lab request is
 * an anonymous request unless the caller explicitly sets a header, and the caller is a tool
 * whose parameters the user approved.
 */

const MAX_BYTES = 256_000
const TIMEOUT_MS = 15_000

export interface LabHttpRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  budget: Budget
  signal?: AbortSignal
}

export interface LabHttpResponse {
  ok: boolean
  /** Why it was refused or failed, when it was. */
  refusedReason: string | null
  status: number | null
  bytes: number
  body: string
  headers: Record<string, string>
  url: string
  /** True when the request was never sent because the host is not declared. */
  undeclared: boolean
}

const USER_AGENT = 'GogaLab/1.0 (authorized testing on a declared target)'

export async function labRequest(req: LabHttpRequest, http: typeof fetch = fetch): Promise<LabHttpResponse> {
  const refused = (reason: string, undeclared = false): LabHttpResponse => ({
    ok: false, refusedReason: reason, status: null, bytes: 0, body: '', headers: {}, url: req.url, undeclared,
  })

  let parsed: URL
  try { parsed = new URL(req.url) } catch { return refused(`"${req.url}" is not a URL`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return refused(`only http and https are supported (got ${parsed.protocol})`)

  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80)
  const check = checkTarget(parsed.hostname, port)
  if (!check.declared) return refused(check.reason, true)

  const spent = await req.budget.spend()
  if (spent === 'cap') return refused(`request cap reached (${req.budget.maxRequests}) — nothing more was sent`)
  if (spent === 'stopped') return refused('the run was stopped — nothing more was sent')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onAbort = () => controller.abort()
  req.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const res = await http(req.url, {
      method: req.method ?? 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...(req.headers ?? {}) },
      body: req.method === 'POST' ? (req.body ?? '') : undefined,
    })
    const buf = Buffer.from(await res.arrayBuffer())
    const headers: Record<string, string> = {}
    for (const name of ['content-type', 'server', 'x-powered-by', 'location', 'content-length']) {
      const v = res.headers.get(name)
      if (v) headers[name] = v.slice(0, 400)
    }
    return {
      ok: true,
      refusedReason: null,
      status: res.status,
      bytes: buf.byteLength,
      body: buf.subarray(0, MAX_BYTES).toString('utf8'),
      headers,
      url: req.url,
      undeclared: false,
    }
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError'
      ? `timed out after ${TIMEOUT_MS / 1000}s`
      : err instanceof Error ? err.message : String(err)
    return refused(`request failed: ${message}`)
  } finally {
    clearTimeout(timer)
    req.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * How similar two response bodies are, 0..1, after the identifier itself is normalised out.
 *
 * The normalisation is the point: an IDOR test compares two responses that differ only in the
 * identifier, so the identifier's own text must not count as a difference. A body that is
 * otherwise identical but carries a different name is the interesting case, and this keeps
 * that visible.
 */
export function bodySimilarity(a: string, b: string, normalise: string[] = []): number {
  const clean = (text: string): string => {
    let out = String(text ?? '')
    for (const token of normalise) {
      if (!token) continue
      out = out.split(token).join('«id»')
    }
    // Collapse whitespace so formatting differences do not read as content differences.
    return out.replace(/\s+/g, ' ').trim()
  }
  const left = clean(a), right = clean(b)
  if (!left && !right) return 1
  if (!left || !right) return 0
  if (left === right) return 1
  // Token overlap: cheap, deterministic, and good enough to rank a lead.
  const tokens = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2))
  const A = tokens(left), B = tokens(right)
  if (!A.size && !B.size) return left === right ? 1 : 0
  let shared = 0
  for (const t of A) if (B.has(t)) shared++
  return shared / Math.max(A.size, B.size)
}

/** A short excerpt around the first place two bodies differ, for the evidence line. */
export function firstDifference(a: string, b: string, width = 120): string {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[i] === b[i]) i++
  if (i >= limit && a.length === b.length) return 'the bodies are identical'
  const start = Math.max(0, i - Math.floor(width / 2))
  return `…${a.slice(start, start + width)}… vs …${b.slice(start, start + width)}…`
}
