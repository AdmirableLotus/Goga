import type { HeaderOfInterest, JsEndpoint, SampledText } from '../../../../shared/grimoire'

/**
 * Reading evidence well, with no capability to go and get more.
 *
 * Everything here works on text the user already has on this machine: a file they pointed at,
 * or a response body they pasted. There is no fetch, no socket and no browser in this module.
 *
 * Four ideas are borrowed from the Burp Suite Antigravity extension
 * (github.com/momika233/Burp_Suite-Antigravity_AI-Bug_Bounty_Hunter), and all four are about
 * reading rather than firing:
 *
 *   1. SAMPLING THAT FITS A BUDGET. That extension hands a model the first ~1500 characters,
 *      then the region around whatever it is looking for, then the tail. This does the same,
 *      and says in the output that the text was sampled and how much of it was kept. A model
 *      shown 3 KB of a 200 KB file and told nothing will invent the rest; one told "sampled"
 *      will not.
 *   2. HEADERS OF INTEREST. A token leaking in a header is invisible in the middle of a body,
 *      so headers are pulled out and shown separately, each with the reason it matters.
 *   3. ENDPOINTS IN JAVASCRIPT. Static analysis of files already on disk: list the API routes,
 *      absolute URLs and path templates so they can be read. Never fetched from a live host.
 *   4. DE-DUPLICATION BY LOCATION PLUS ISSUE CLASS. Two specialists will notice the same line
 *      from different angles. A stable key means the same candidate is one row, not five, and
 *      a later run can recognise it instead of raising it again.
 */

/* ─────────────────────────── 1. sampling ─────────────────────────── */

const HEAD_CHARS = 1500
const TAIL_CHARS = 500
const CONTEXT_RADIUS = 700
/** Below this, no sampling: the whole thing is cheap to read. */
const SAMPLE_THRESHOLD = 4000

/**
 * Keywords whose neighbourhood is worth keeping when a file is long. These are the words that
 * sit next to a real defect: an input read, an output write, a query, a fetch, a redirect.
 */
const KEYS = [
  '$_GET', '$_POST', '$_REQUEST', '$_COOKIE', '$_FILES', '$_SERVER',
  'wp_remote_', 'curl_', 'file_get_contents', 'unserialize', 'maybe_unserialize',
  'eval(', 'shell_exec', 'system(', 'passthru', 'proc_open', 'popen',
  'include', 'require', 'wp_redirect', 'wp_safe_redirect', 'header(',
  'permission_callback', 'check_ajax_referer', 'current_user_can', 'wp_verify_nonce',
  'get_post(', 'get_user_by(', 'get_comment(', 'prepare(', 'wpdb->',
  'echo ', 'print ', 'innerHTML', 'document.write', 'hash_equals', 'hash_hmac',
  'Access-Control-Allow', 'HTTP_ORIGIN', 'register_rest_route', 'wp_ajax_',
]

/**
 * Keep the start, the neighbourhood of every keyword, and the tail. Returned with an honest
 * account of what was kept, so a caller can say "this was sampled" rather than implying the
 * specialists read the whole file.
 */
export function sampleText(text: string, opts: { marker?: string; budget?: number } = {}): SampledText {
  const original = String(text ?? '')
  const originalChars = original.length
  if (originalChars <= SAMPLE_THRESHOLD) {
    return {
      text: original,
      sampled: false,
      originalChars,
      kept: [{ region: 'whole file', chars: originalChars }],
      note: `${originalChars} characters — the whole file was read, not a sample.`,
      // Nothing was cut, so sample line N is original line N.
      lineMap: Array.from({ length: original.split(/\r?\n/).length }, (_, i) => i + 1),
    }
  }

  const budget = opts.budget ?? 6000
  const kept: { region: string; chars: number }[] = []
  const ranges: [number, number][] = []
  const addRange = (from: number, to: number, label: string) => {
    const a = Math.max(0, from), b = Math.min(originalChars, to)
    if (b <= a) return
    ranges.push([a, b])
    kept.push({ region: label, chars: b - a })
  }

  addRange(0, HEAD_CHARS, 'start of file')

  // The user's own marker first: it is the thing they are actually asking about.
  const marker = String(opts.marker ?? '').trim()
  if (marker.length >= 3) {
    let at = original.indexOf(marker)
    let n = 0
    while (at >= 0 && n < 3) {
      addRange(at - CONTEXT_RADIUS, at + marker.length + CONTEXT_RADIUS, `around your marker ${JSON.stringify(marker)}`)
      at = original.indexOf(marker, at + marker.length)
      n++
    }
  }

  // Then the keyword neighbourhoods, nearest the top first, until the budget is spent.
  const spots: number[] = []
  for (const key of KEYS) {
    let at = original.indexOf(key)
    let n = 0
    while (at >= 0 && n < 2) { spots.push(at); at = original.indexOf(key, at + key.length); n++ }
  }
  spots.sort((a, b) => a - b)
  let spent = ranges.reduce((sum, [a, b]) => sum + (b - a), 0)
  for (const at of spots) {
    if (spent >= budget) break
    const span = Math.min(CONTEXT_RADIUS, Math.max(160, Math.floor((budget - spent) / 2)))
    const before = ranges.reduce((s, [a, b]) => s + (b - a), 0)
    addRange(at - span, at + span, `around line ${lineAt(original, at)}`)
    spent += ranges.reduce((s, [a, b]) => s + (b - a), 0) - before
  }

  addRange(originalChars - TAIL_CHARS, originalChars, 'end of file')

  // Merge overlapping ranges so the excerpt is not repeated five times.
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }

  // Build the sample line by line, carrying each line's original line number with it, so the
  // mapping can never drift from the text it describes. A gap between two kept regions is a
  // single marker line whose original line is 0 — never a line the specialists did not see.
  const GAP_LINE = '… [gap] …'
  const outLines: string[] = []
  const lineMap: number[] = []
  merged.forEach(([a, b], i) => {
    if (i > 0) { outLines.push(GAP_LINE); lineMap.push(0) }
    const piece = original.slice(a, b)
    let offset = 0
    for (const line of piece.split(/\r?\n/)) {
      outLines.push(line)
      lineMap.push(lineAt(original, a + offset))
      offset += line.length + 1
    }
  })
  const out = outLines.join('\n')

  const pct = Math.round((out.length / originalChars) * 100)
  return {
    text: out,
    sampled: true,
    originalChars,
    kept,
    note: `Sampled: ${out.length.toLocaleString()} of ${originalChars.toLocaleString()} characters (${pct}%) — the start, the region around the keywords and your marker, and the tail. The specialists did not see the gaps.`,
    lineMap,
  }
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/* ─────────────────────────── 2. headers of interest ─────────────────────────── */

/**
 * The headers that carry signal, pulled out of a response so they are not lost inside a body.
 * Every one states why it matters; nothing here is a finding on its own.
 */
export function headersOfInterest(headers: Record<string, string>): HeaderOfInterest[] {
  const out: HeaderOfInterest[] = []
  const seen = new Set<string>()
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = String(rawName).toLowerCase()
    if (seen.has(name)) continue
    const value = String(rawValue ?? '')
    const hit = describeHeader(name, value)
    if (!hit) continue
    seen.add(name)
    out.push({ name, value: value.slice(0, 400), ...hit })
  }
  // CORS first (a reflected origin with credentials is a real class), then tokens, then the rest.
  const rank = (h: HeaderOfInterest) => (h.name.startsWith('access-control') ? 0 : h.sensitive ? 1 : 2)
  return out.sort((a, b) => rank(a) - rank(b))
}

function describeHeader(name: string, value: string): { why: string; sensitive: boolean } | null {
  if (name.startsWith('x-')) {
    const sensitive = /token|auth|key|secret|session|debug|trace/i.test(name) || /^[A-Za-z0-9._-]{20,}$/.test(value.trim())
    return {
      why: sensitive
        ? 'A custom header whose name or value looks like a credential. A token in a header is a finding; the same token inside 200 KB of HTML is invisible.'
        : 'A custom header: often an internal identifier, a cache marker or a framework name worth knowing.',
      sensitive,
    }
  }
  switch (name) {
    case 'access-control-allow-origin':
      return { why: value.trim() === '*' ? 'Wildcard origin. Harmless alone; a defect when the response carries private data or credentials.' : 'A specific origin is echoed — check whether it is reflected from the request Origin, and whether credentials are allowed with it.', sensitive: false }
    case 'access-control-allow-credentials':
      return { why: 'Credentials allowed cross-origin. Together with a reflected origin this is the CORS bug class.', sensitive: false }
    case 'access-control-allow-methods':
    case 'access-control-allow-headers':
    case 'access-control-expose-headers':
      return { why: 'Part of the cross-origin policy; read it with the origin header.', sensitive: false }
    case 'set-cookie':
      return { why: 'A cookie is being set. Check HttpOnly, Secure and SameSite in the flags — the value itself is not retained.', sensitive: true }
    case 'authorization':
    case 'www-authenticate':
    case 'x-api-key':
      return { why: 'An authentication header. The value is shown so you can tell a real credential from a placeholder; never send it anywhere.', sensitive: true }
    case 'server':
    case 'x-powered-by':
      return { why: 'Discloses the stack and often the version. Version disclosure is usually informational, but it tells you which code to read.', sensitive: false }
    case 'content-security-policy':
      return { why: 'The page\'s own XSS defence. An absent or weak policy does not create a bug, but it changes the impact of one you find.', sensitive: false }
    case 'x-frame-options':
    case 'referrer-policy':
    case 'strict-transport-security':
    case 'permissions-policy':
      return { why: 'A browser-side hardening header. Its absence is context for another finding, not a finding by itself.', sensitive: false }
    case 'location':
      return { why: 'A redirect target. If it was built from something the caller sent, that is the open-redirect class.', sensitive: false }
    case 'x-debug-token':
    case 'x-debug-token-link':
      return { why: 'A debug token. If this is reachable on a production host, the profiler behind it exposes internals.', sensitive: true }
    default:
      return null
  }
}

/* ─────────────────────────── 3. endpoints in JavaScript ─────────────────────────── */

/**
 * Static extraction of endpoints from JavaScript the user already has.
 *
 * The extension this borrows from uses 17 regex patterns. These are the ones that pay for
 * themselves on ordinary application JavaScript, and each records which pattern matched so
 * the user can see how a string was found rather than trusting a list.
 *
 * It reads a string. It does not fetch a URL, and there is nowhere in this module that could.
 */
const PATTERNS: { via: string; kind: JsEndpoint['kind']; re: RegExp }[] = [
  { via: 'fetch call', kind: 'api-path', re: /fetch\s*\(\s*['"`]([^'"`]{2,200})['"`]/g },
  { via: 'axios call', kind: 'api-path', re: /axios\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]{2,200})['"`]/g },
  { via: 'jQuery ajax url', kind: 'api-path', re: /url\s*:\s*['"`]([^'"`]{2,200})['"`]\s*,\s*(?:type|method)\s*:/g },
  { via: 'XMLHttpRequest open', kind: 'api-path', re: /\.open\s*\(\s*['"`](?:GET|POST|PUT|PATCH|DELETE)['"`]\s*,\s*['"`]([^'"`]{2,200})['"`]/gi },
  { via: 'assignment to a path literal', kind: 'api-path', re: /(?:endpoint|apiUrl|api_url|baseUrl|base_url|restUrl|rest_url|route)\s*[:=]\s*['"`]([^'"`]{2,200})['"`]/gi },
  { via: 'quoted /wp-json path', kind: 'api-path', re: /['"`](\/wp-json\/[^'"`\s]{1,200})['"`]/g },
  { via: 'quoted /wp-admin path', kind: 'api-path', re: /['"`](\/wp-admin\/[^'"`\s]{1,200})['"`]/g },
  { via: 'quoted admin-ajax path', kind: 'api-path', re: /['"`](\/wp-admin\/admin-ajax\.php[^'"`\s]*)['"`]/g },
  { via: 'absolute URL', kind: 'absolute-url', re: /['"`](https?:\/\/[A-Za-z0-9._~:\/?#\[\]@!$&'()*+,;=%-]{4,300})['"`]/g },
  { via: 'path template', kind: 'route-template', re: /['"`](\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)*(?:\/\$\{[^}]+\}|\/:?[a-z]+\b)[^'"`\s]{0,120})['"`]/gi },
  { via: 'quoted api path', kind: 'relative-path', re: /['"`](\/api\/[^'"`\s]{1,200})['"`]/gi },
]

export function jsEndpoints(source: string, opts: { max?: number } = {}): JsEndpoint[] {
  const text = String(source ?? '')
  const max = opts.max ?? 200
  const found = new Map<string, JsEndpoint>()
  for (const p of PATTERNS) {
    p.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.re.exec(text)) !== null) {
      const value = String(m[1] ?? '').trim()
      if (!value || value.length < 2) continue
      // A bare `/` or a CSS-ish path is noise, and so is a data: URL.
      if (value === '/' || value.startsWith('data:') || value.startsWith('//')) continue
      const key = `${p.kind}:${value}`
      if (found.has(key)) continue
      found.set(key, { value, kind: p.kind, line: lineAt(text, m.index), via: p.via })
      if (found.size >= max) return [...found.values()].sort((a, b) => a.line - b.line)
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line)
}

/* ─────────────────────────── 4. de-duplication ─────────────────────────── */

/**
 * A stable key for "this candidate, in this place, of this class".
 *
 * The extension this borrows from de-duplicates by an MD5 of URL plus issue name. The idea
 * travels; the hash does not. A readable key is better here because the memory file is
 * something the user can open and read, and a key they can read is a key they can trust.
 */
export function candidateKey(material: string, location: string, line: number | null, specialist: string): string {
  const where = String(location ?? material ?? '').replace(/\\/g, '/')
  const at = line === null || line === undefined ? 'file' : `L${line}`
  return `${where}#${at}::${specialist}`
}

/** Collapse identical keys, keeping the first and counting the rest. */
export function dedupe<T extends { key: string }>(items: T[]): { unique: T[]; merged: number } {
  const seen = new Map<string, T>()
  let merged = 0
  for (const item of items) {
    if (seen.has(item.key)) { merged++; continue }
    seen.set(item.key, item)
  }
  return { unique: [...seen.values()], merged }
}
