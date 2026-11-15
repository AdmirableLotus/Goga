import type { ProgramImport, ScopeDecision } from '../../../shared/security'

/**
 * Scope checking. Pure functions, no network, no filesystem — so the rule is testable and
 * the answer is the same every time.
 *
 * Default deny: a target is in scope only when an imported asset with
 * `eligibleForSubmission === true` covers it and no exclusion category applies. A target
 * that matches nothing is refused, not treated as "probably fine".
 *
 * The program's own words win in both directions. An asset HackerOne lists but marks as
 * NOT eligible for submission is kept at import time as a deny rule, and that deny is
 * decided before any allow: a wildcard elsewhere in the same program (`*.example.com`)
 * never overrides an entry that says `status.example.com` is out.
 */

export interface ParsedTarget {
  scheme: string
  host: string
  port: number | null
  path: string
}

/** Parse a target the way a request would see it. Throws on anything unusable. */
export function parseTarget(raw: string): ParsedTarget {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('no target given')
  if (text.length > 2048) throw new Error('target is too long')
  let url: URL
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`) } catch { throw new Error(`"${raw}" is not a URL or hostname`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`only http and https targets are supported (got ${url.protocol})`)
  if (!url.hostname) throw new Error(`"${raw}" has no host`)
  return { scheme: url.protocol.replace(':', ''), host: url.hostname.toLowerCase(), port: url.port ? Number(url.port) : null, path: url.pathname || '/' }
}

function ipToLong(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out = (out << 8) | n
  }
  return out >>> 0
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/')
  const bits = Number(bitsText)
  const ipNum = ipToLong(ip)
  const baseNum = ipToLong(base ?? '')
  if (ipNum === null || baseNum === null || !(bits >= 0 && bits <= 32)) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipNum & mask) === (baseNum & mask)
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Does one host pattern cover one hostname?
 *
 * A pattern with no `*` is an exact match. `*.example.com` covers the apex and any depth
 * below it, which is how bug-bounty programs read it. A `*` in another label position
 * (`status.*.example.com`) covers one label, or — for a deny rule — any number of them,
 * because a deny that matches too little would let a request through.
 */
export function hostMatches(patternHost: string, host: string, opts: { deny?: boolean } = {}): boolean {
  const pattern = String(patternHost ?? '').trim().toLowerCase().replace(/\.$/, '')
  const h = String(host ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!pattern || !h) return false
  if (!pattern.includes('*')) return pattern === h
  if (pattern.startsWith('*.') && !pattern.slice(2).includes('*')) {
    return h === pattern.slice(2) || h.endsWith(pattern.slice(1))
  }
  const star = opts.deny ? '[^.]+(?:\\.[^.]+)*' : '[^.]+'
  const body = pattern.split('.').map(label => (label === '*' ? star : escapeRegex(label))).join('\\.')
  return new RegExp(`^${body}$`).test(h)
}

/**
 * Does one imported asset cover one host?
 *
 * URL and wildcard assets are compared by host only, which is the conservative reading:
 * a program that lists `https://app.example.com/api` does not thereby authorize
 * `https://app.example.com/admin`. A path-bearing asset therefore also requires the
 * target path to start with the listed path.
 *
 * A deny rule (an asset the program marks not eligible) is matched on host alone: if the
 * program says that host is out, the whole host is out, whatever path was listed.
 */
export function assetCovers(identifier: string, assetType: string, target: ParsedTarget, targetPath = target.path, opts: { deny?: boolean } = {}): { covers: boolean; why: string } {
  const raw = String(identifier ?? '').trim()
  if (!raw) return { covers: false, why: 'empty asset identifier' }
  const type = String(assetType ?? '').toLowerCase()

  if (type === 'cidr' || /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(raw)) {
    const targetIp = ipToLong(target.host)
    if (targetIp === null) return { covers: false, why: `${raw} is an IP range and ${target.host} is not an IP` }
    const covered = inCidr(target.host, raw)
    return { covers: covered, why: covered ? `${target.host} inside ${raw}` : `${target.host} outside ${raw}` }
  }
  if (type === 'ip_address' || type === 'ip' || /^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
    const covered = target.host === raw
    return { covers: covered, why: covered ? `${target.host} equals ${raw}` : `${target.host} is not ${raw}` }
  }

  // URL or hostname. Strip the scheme; keep any path for a stricter comparison.
  let hostPart = raw, pathPart = ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? new URL(raw) : null
  if (withScheme) { hostPart = withScheme.hostname; pathPart = withScheme.pathname }
  else {
    const slash = raw.indexOf('/')
    if (slash > 0) { hostPart = raw.slice(0, slash); pathPart = raw.slice(slash) }
  }
  hostPart = hostPart.toLowerCase().replace(/\.$/, '')
  const hostHit = hostMatches(hostPart, target.host, opts)
  if (!hostHit) return { covers: false, why: hostPart.includes('*') ? `${target.host} is not under ${hostPart}` : `${target.host} is not ${hostPart}` }
  if (opts.deny || !pathPart || pathPart === '/') {
    return { covers: true, why: `${target.host} matches ${hostPart}${opts.deny ? '' : pathPart}` }
  }
  if (!(targetPath === pathPart || targetPath.startsWith(pathPart.endsWith('/') ? pathPart : `${pathPart}/`))) {
    return { covers: false, why: `${targetPath} is outside the listed path ${pathPart}` }
  }
  return { covers: true, why: `${target.host} matches ${hostPart}${pathPart}` }
}

/**
 * The decision for one target against one imported program.
 *
 * Order matters, and it is: deny rules first, then coverage, then exclusions, then allow.
 *
 *   1. An asset the program marks NOT eligible for submission is a deny rule. Nothing
 *      later can override it — not a wildcard, not a technique, not an approval.
 *   2. A target no eligible asset covers is refused (undetermined, deny by default).
 *   3. A program exclusion that names the technique is still a refusal on an in-scope
 *      target, which is why exclusions are consulted before the target is allowed.
 */
export function decideScope(program: ProgramImport | null, target: string, technique?: string): ScopeDecision {
  if (!program) return { inScope: false, matchedRule: null, undetermined: true, reason: 'no program scope is imported — import a program before any request' }
  const parsed = parseTarget(target)

  // 1. Deny rules, decided before anything can allow.
  for (const a of program.assets) {
    if (a.eligibleForSubmission) continue
    const { covers, why } = assetCovers(a.identifier, a.assetType, parsed, parsed.path, { deny: true })
    if (covers) {
      return {
        inScope: false,
        matchedRule: a.identifier,
        undetermined: false,
        reason: `${why}, and the program marks that asset NOT eligible for submission — deny rule, whatever else the program lists`,
      }
    }
  }

  // 2. Coverage.
  const matching = program.assets.filter(a => a.eligibleForSubmission && assetCovers(a.identifier, a.assetType, parsed, parsed.path).covers)
  if (!matching.length) {
    return { inScope: false, matchedRule: null, undetermined: true, reason: `${parsed.host} is not covered by any eligible asset in "${program.name}". Default deny.` }
  }

  // 3. Exclusions, before the allow.
  if (technique) {
    const word = technique.toLowerCase().trim()
    const hit = word ? program.exclusions.find(e => `${e.category} ${e.details}`.toLowerCase().includes(word)) : undefined
    if (hit) return { inScope: false, matchedRule: matching[0].identifier, undetermined: false, reason: `in scope, but the program excludes "${hit.category}": ${hit.details}` }
  }

  const best = matching.find(m => !m.instruction) ?? matching[0]
  return {
    inScope: true,
    matchedRule: best.identifier,
    undetermined: false,
    reason: `covered by ${best.identifier}${best.instruction ? ` — asset rule: ${best.instruction}` : ''}`,
  }
}

/** The deny rules an import kept: assets the program lists but does not allow submissions on. */
export function denyRules(program: ProgramImport | null): string[] {
  if (!program) return []
  return program.assets.filter(a => !a.eligibleForSubmission).map(a => a.identifier)
}

/** Hosts an import will never be allowed to reach, whatever a program says. */
export function forbiddenTarget(host: string): string | null {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return 'local and internal hostnames are never tested from Goga'
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return 'private and loopback addresses are never tested from Goga'
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return 'private addresses are never tested from Goga'
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return 'cloud metadata endpoints are never tested'
  return null
}
