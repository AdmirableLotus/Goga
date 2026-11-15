import type { ProbeResult } from '../../../shared/security'
import { decideScope, forbiddenTarget, parseTarget } from './scope'
import { activeProgram, consumeGrant, getProgram } from './store'

/**
 * One approved, in-scope GET.
 *
 * This is the ONLY code in Goga that sends a request at a bug-bounty target, and it will
 * not send one unless all of these hold:
 *   1. a program is imported and active;
 *   2. the target is covered by that program's eligible scope;
 *   3. the target is not a local, private or metadata address;
 *   4. the user approved this exact target and method, and that approval is unused;
 *   5. redirects are NOT followed (a redirect can leave scope).
 *
 * It reads a bounded response and returns an excerpt plus headers. No cookies, no auth
 * headers, no POST bodies: a single GET is what the approval covers.
 */

const MAX_BYTES = 512_000
const TIMEOUT_MS = 15_000

export interface ProbeRequest {
  programId?: string
  target: string
  grantId: string
}

export async function probe(req: ProbeRequest, http: typeof fetch = fetch): Promise<ProbeResult> {
  const refused = (reason: string): ProbeResult => ({
    ok: false, status: null, url: req.target ?? null, headers: {}, bodyExcerpt: '', bytes: 0, blockedReason: reason,
  })

  const program = req.programId ? getProgram(req.programId) : activeProgram()
  if (!program) return refused('no program scope is imported — import a program first, then approve a request against an eligible asset')

  let parsed
  try { parsed = parseTarget(req.target) } catch (err) { return refused(err instanceof Error ? err.message : String(err)) }
  const forbidden = forbiddenTarget(parsed.host)
  if (forbidden) return refused(forbidden)

  const decision = decideScope(program, req.target)
  if (!decision.inScope) return refused(`out of scope — ${decision.reason}`)

  const grant = consumeGrant(req.grantId, req.target, 'GET')
  if (!grant.ok) return refused(grant.reason)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await http(req.target, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'GogaBugBounty/1.0 (authorized testing; single approved request)', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    })
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: true, status: res.status, url: req.target,
        headers: { location: res.headers.get('location') ?? '' },
        bodyExcerpt: 'Redirect not followed: following it could leave the authorized scope. Add the redirect target to the program scope, then approve a request to it separately.',
        bytes: 0, blockedReason: null,
      }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const bytes = buf.byteLength
    const text = buf.subarray(0, MAX_BYTES).toString('utf8')
    const headers: Record<string, string> = {}
    for (const name of ['content-type', 'server', 'x-powered-by', 'content-security-policy', 'x-frame-options', 'strict-transport-security', 'set-cookie']) {
      const v = res.headers.get(name)
      if (v) headers[name] = name === 'set-cookie' ? '[present — value not retained]' : v.slice(0, 400)
    }
    return {
      ok: true,
      status: res.status,
      url: req.target,
      headers,
      bodyExcerpt: text.slice(0, 20_000),
      bytes,
      blockedReason: null,
    }
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError' ? `request timed out after ${TIMEOUT_MS / 1000}s` : err instanceof Error ? err.message : String(err)
    return refused(`request failed: ${message}`)
  } finally { clearTimeout(timer) }
}

/**
 * Look for the user's own unique marker in a response, and report the exact surrounding
 * context. This is the mechanical half of XSS confirmation: it tells you whether the input
 * came back, and inside what — an attribute, a script block, text, a URL — so you know
 * which encoding context you are in. It does not claim a vulnerability by itself.
 */
export function reflectionReport(bodyExcerpt: string, marker: string): {
  found: boolean
  occurrences: number
  contexts: { context: string; excerpt: string }[]
  verdict: string
} {
  const needle = String(marker ?? '')
  if (needle.length < 4) return { found: false, occurrences: 0, contexts: [], verdict: 'use a unique marker of at least 4 characters so it cannot match by accident' }
  const occurrences: number[] = []
  let at = bodyExcerpt.indexOf(needle)
  while (at >= 0 && occurrences.length < 20) { occurrences.push(at); at = bodyExcerpt.indexOf(needle, at + 1) }
  const contexts = occurrences.slice(0, 5).map(i => {
    const before = bodyExcerpt.slice(Math.max(0, i - 120), i)
    const after = bodyExcerpt.slice(i + needle.length, i + needle.length + 120)
    const context = describeContext(before, after)
    return { context, excerpt: `${before}[${needle}]${after}` }
  })
  return {
    found: occurrences.length > 0,
    occurrences: occurrences.length,
    contexts,
    verdict: occurrences.length === 0
      ? 'the marker did not come back in the readable response — it may be stored and shown elsewhere, encoded beyond recognition, or rejected'
      : `${occurrences.length} occurrence(s). Check each context: only a context where the value is not encoded for that location can be script execution.`,
  }
}

function describeContext(before: string, after: string): string {
  const lastOpenTag = before.lastIndexOf('<')
  const lastClose = before.lastIndexOf('>')
  const insideTag = lastOpenTag > lastClose
  if (/<script[^>]*>/i.test(before.slice(-400)) && !/<\/script>/i.test(before.slice(-400))) return 'inside a <script> block'
  if (insideTag) {
    const tag = /<([a-z0-9-]+)/i.exec(before.slice(lastOpenTag))?.[1] ?? 'tag'
    if (after.includes('>')) return `inside an attribute of <${tag}>`
    return `inside an attribute value of <${tag}>`
  }
  if (/^\s*(javascript|data):/i.test(after) || /(href|src)="[^"]*$/i.test(before.slice(-80))) return 'inside a URL-valued attribute'
  return 'in element text'
}
