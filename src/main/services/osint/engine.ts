import { createHash } from 'crypto'
import type {
  DomainResult, EmailResult, OsintItem, OsintMode, OsintNote, OsintRedaction, OsintSiteCheck,
  OsintSource, ProfileResult, UsernameResult,
} from '../../../shared/osint'
import type { ProgramImport } from '../../../shared/security'
import { decideScope, forbiddenTarget } from '../security/scope'
import type { OsintHttp } from './http'
import { EXCLUDED, SITES, validDomain, validEmail, validUsername, type SiteDefinition } from './sites'
import { redact } from './redact'

/**
 * The four searches, and the rules they share.
 *
 * Each function is pure with respect to *policy*: it takes the active program (or null),
 * the stated purpose and an OsintHttp, and returns a result in which every fact carries
 * its source and read time, and every gap is named. Nothing here logs in, solves a
 * challenge, or invents a value.
 */

export interface OsintContext {
  http: OsintHttp
  program: ProgramImport | null
  purpose: string
  signal?: AbortSignal
  /** Run the existing web.search tool, for public mentions. Injected so it stays testable. */
  search?: (query: string, maxResults: number) => Promise<{ title: string; url: string; snippet: string }[]>
  /** The stored breach-check key, read at call time. Absent means the check is skipped. */
  breachKey?: () => string | null
}

export interface OsintRefusal extends Error { refused: true }

function refuse(message: string): OsintRefusal {
  const err = new Error(message) as OsintRefusal
  err.refused = true
  return err
}

/**
 * The purpose gate.
 *
 * Building a dossier on a named person is the one thing in this feature that can do harm
 * without a reason, so a purpose is required — and required for everything when the
 * subject looks like a person's name rather than a handle. It is recorded in the audit log
 * with the query, which is what makes the run reviewable later.
 */
export const MIN_PURPOSE = 12

const PLACEHOLDER_PURPOSES = /^(test|testing|none|n\/?a|asdf|why|because|idk|no reason|curiosity)\.?$/i

export function requirePurpose(purpose: string, what: string, always: boolean): string {
  const p = String(purpose ?? '').trim()
  if (!p && !always) return ''
  if (!p) throw refuse(`stating a legitimate purpose is required before Goga will run ${what}. One line is enough — for example "authorised assessment for the Example program" or "checking my own accounts".`)
  if (PLACEHOLDER_PURPOSES.test(p)) throw refuse(`"${p}" is not a purpose. Say what the research is for, in one line.`)
  if (p.length < MIN_PURPOSE) throw refuse(`the stated purpose is too short to record (${p.length} characters; ${MIN_PURPOSE} minimum). Say what the research is for.`)
  return p
}

/** True when the subject looks like a person's name rather than a handle or address. */
export function looksLikePersonName(input: string): boolean {
  const s = String(input ?? '').trim()
  if (s.includes('@') || s.includes('.') || s.includes('/')) return false
  return /^[A-Z][a-z]+(\s+[A-Z][a-z'’-]+){1,3}$/.test(s)
}

export function modeOf(program: ProgramImport | null): { mode: OsintMode; programName: string | null } {
  return program ? { mode: 'program', programName: program.name } : { mode: 'unattributed', programName: null }
}

/** Collect redactions from every text field of a result, in one list for the UI. */
function gatherRedactions(list: OsintRedaction[][]): OsintRedaction[] {
  const totals = new Map<string, number>()
  for (const hits of list) for (const h of hits) totals.set(h.kind, (totals.get(h.kind) ?? 0) + h.count)
  return [...totals.entries()].map(([kind, count]) => ({ kind, count }))
}

function sourceOf(r: { url: string; readAt: string; status: number | null; cached: boolean }, name: string): OsintSource {
  return { source: name, url: r.url, readAt: r.readAt, status: r.status, cached: r.cached }
}

// ------------------------------------------------------------------ username

function classify(def: SiteDefinition, status: number | null, body: string, error: string | null): { outcome: OsintSiteCheck['outcome']; detail?: string } {
  if (status === null) return { outcome: 'error', detail: error ?? 'no answer' }
  if (status === 403 || status === 429 || status === 401 || status === 999) {
    return { outcome: 'blocked', detail: `the site answered ${status} to an automated read, so this says nothing either way` }
  }
  if (def.verdict === 'status') {
    if (status >= 200 && status < 300) return { outcome: 'found' }
    if (status === 404 || status === 410) return { outcome: 'absent' }
    return { outcome: 'error', detail: `unexpected status ${status}` }
  }
  if (!(status >= 200 && status < 300)) return { outcome: 'error', detail: `unexpected status ${status}` }
  try {
    const doc = JSON.parse(body) as unknown
    if (def.verdict === 'json-array') {
      if (Array.isArray(doc)) return doc.length ? { outcome: 'found' } : { outcome: 'absent' }
      return { outcome: 'error', detail: 'the API answered with something other than a list' }
    }
    if (def.verdict === 'json-null') {
      if (doc === null) return { outcome: 'absent' }
      return doc && typeof doc === 'object' ? { outcome: 'found' } : { outcome: 'error', detail: 'unexpected JSON shape' }
    }
    const total = doc && typeof doc === 'object' ? Number((doc as { total?: number }).total ?? 0) : 0
    return total > 0 ? { outcome: 'found' } : { outcome: 'absent' }
  } catch {
    return { outcome: 'error', detail: 'the answer was not readable JSON' }
  }
}

export async function reverseUsername(usernameInput: string, ctx: OsintContext): Promise<UsernameResult> {
  // A person's name is not a handle, and searching by name is exactly the case this feature
  // will not do against sites that index people. Send it to profile aggregation, which
  // requires a stated purpose and only collects what the person published themselves.
  if (looksLikePersonName(usernameInput)) {
    throw refuse(`"${usernameInput.trim()}" looks like a person's name, not a handle. A username search takes one handle; to research a named individual, use osint.profile with a confirmed handle or address and a stated legitimate purpose.`)
  }
  const username = validUsername(usernameInput)
  if (!username) throw refuse('that is not a username Goga can check: use letters, digits, dot, dash or underscore, up to 64 characters')
  const purpose = requirePurpose(ctx.purpose, 'a username search', looksLikePersonName(usernameInput))
  const { mode, programName } = modeOf(ctx.program)
  const startedAt = new Date().toISOString()
  const notes: OsintNote[] = []
  const redactions: OsintRedaction[][] = []
  const checked: OsintSiteCheck[] = []

  if (!ctx.program) {
    notes.push({ kind: 'scope', detail: 'No bug-bounty program is active, so these results are unattributed public research. They are not tied to any authorized scope.' })
  }

  for (const def of SITES) {
    if (ctx.signal?.aborted) { notes.push({ kind: 'inconclusive', detail: 'the run was stopped before every site was checked' }); break }
    const url = def.url(username)
    const res = await ctx.http.get(url, { respectRobots: !def.api, maxRedirects: 1 })
    if (res.refusedReason) {
      checked.push({ site: def.site, url: def.profileUrl ? def.profileUrl(username) : url, outcome: 'not_checked', status: null, readAt: null, detail: res.refusedReason })
      continue
    }
    const cls = classify(def, res.status, res.body, res.error)
    const r = redact(cls.detail ?? '')
    if (r.hits.length) redactions.push(r.hits)
    checked.push({
      site: def.site,
      url: def.profileUrl ? def.profileUrl(username) : res.finalUrl,
      outcome: cls.outcome,
      status: res.status,
      readAt: res.readAt,
      detail: r.text || undefined,
    })
  }

  for (const ex of EXCLUDED) {
    checked.push({ site: ex.site, url: ex.url.replace('{u}', encodeURIComponent(username)), outcome: 'not_checked', status: null, readAt: null, detail: ex.reason })
  }

  const found = checked.filter(c => c.outcome === 'found')
  const absent = checked.filter(c => c.outcome === 'absent')
  const blocked = checked.filter(c => c.outcome === 'blocked')
  const notChecked = checked.filter(c => c.outcome === 'not_checked' || c.outcome === 'error')

  if (absent.length) notes.push({ kind: 'inconclusive', detail: `"not found" here means only that these sites did not answer with a profile for this name just now: ${absent.map(a => a.site).join(', ')}. It does not establish that the person has no account there — names are reused, released, and hidden.` })
  if (!found.length && !blocked.length) notes.push({ kind: 'inconclusive', detail: 'no site in the checked list returned a profile. That is an absence of results, not proof of absence.' })

  return {
    query: username, mode, programName, purpose, checked, found, absent, blocked, notChecked, notes,
    redactions: gatherRedactions(redactions), startedAt, finishedAt: new Date().toISOString(),
  }
}

// ------------------------------------------------------------------ email

export interface GravatarShape {
  entry?: {
    profileUrl?: string
    displayName?: string
    aboutMe?: string
    preferredUsername?: string
    currentLocation?: string
    job_title?: string
    company?: string
    urls?: { title?: string; value?: string }[]
    accounts?: { domain?: string; display?: string; url?: string; verified?: boolean; shortname?: string }[]
  }[]
}

export function gravatarHash(email: string): string {
  return createHash('md5').update(email.trim().toLowerCase()).digest('hex')
}

export async function reverseEmail(emailInput: string, ctx: OsintContext): Promise<EmailResult> {
  const email = validEmail(emailInput)
  if (!email) throw refuse('that is not an email address Goga can check')
  const purpose = requirePurpose(ctx.purpose, 'an email search', true)
  const { mode, programName } = modeOf(ctx.program)
  const startedAt = new Date().toISOString()
  const notes: OsintNote[] = []
  const redactions: OsintRedaction[][] = []
  const domain = email.split('@')[1]

  // --- Gravatar: the owner publishes this themselves, so it is the strongest public signal.
  const hash = gravatarHash(email)
  const gravatarUrl = `https://gravatar.com/${hash}.json`
  const gRes = await ctx.http.get(gravatarUrl, { respectRobots: false, maxRedirects: 1 })
  const gravatar: EmailResult['gravatar'] = {
    outcome: 'not_checked', displayName: null, aboutMe: null, linkedAccounts: [], urls: [], source: null,
  }
  if (gRes.refusedReason) {
    gravatar.outcome = 'not_checked'
    gravatar.detail = gRes.refusedReason
  } else if (gRes.status === 404) {
    gravatar.outcome = 'absent'
    gravatar.detail = 'Gravatar has no profile for this address. Most people have no Gravatar at all, so this is a weak signal.'
    gravatar.source = sourceOf(gRes, 'Gravatar public profile')
  } else if (gRes.status && gRes.status >= 200 && gRes.status < 300) {
    gravatar.source = sourceOf(gRes, 'Gravatar public profile')
    try {
      const doc = JSON.parse(gRes.body) as GravatarShape
      const entry = doc.entry?.[0]
      if (!entry) {
        gravatar.outcome = 'absent'
        gravatar.detail = 'the answer had no profile in it'
      } else {
        gravatar.outcome = 'found'
        const d = redact(entry.displayName ?? '')
        const a = redact(entry.aboutMe ?? '')
        redactions.push(d.hits, a.hits)
        gravatar.displayName = d.text || null
        gravatar.aboutMe = a.text || null
        gravatar.linkedAccounts = (entry.accounts ?? [])
          .filter(ac => !!ac.url)
          .map(ac => ({ label: ac.display || ac.domain || ac.shortname || 'account', url: String(ac.url), verified: ac.verified === true }))
        gravatar.urls = (entry.urls ?? []).map(u => String(u.value ?? '')).filter(Boolean)
      }
    } catch {
      gravatar.outcome = 'error'
      gravatar.detail = 'the answer was not readable JSON'
    }
  } else if (gRes.status === 403 || gRes.status === 429) {
    gravatar.outcome = 'blocked'
    gravatar.detail = `Gravatar answered ${gRes.status} to an automated read`
  } else {
    gravatar.outcome = 'error'
    gravatar.detail = gRes.error ?? `unexpected status ${gRes.status}`
  }

  // --- Domain context: does the domain take mail, and who registered it.
  const mx = await ctx.http.dns(domain, 'MX')
  const rdap = await ctx.http.get(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { respectRobots: false, maxRedirects: 2, allowCrossSite: true })
  const registration = parseRdapDomain(rdap.body)
  // RFC 7505: a single MX of "0 ." is a null MX — the domain says it accepts no mail.
  const nullMx = mx.records.length === 1 && /^0\s+\.?$/.test(mx.records[0].trim())
  const domainContext: EmailResult['domainContext'] = {
    domain,
    mx: mx.records,
    hasMailRoute: mx.ok ? (mx.records.length > 0 && !nullMx) : null,
    rdapSummary: registration.summary,
    registrar: registration.registrar,
    registeredAt: registration.registeredAt,
    expiresAt: registration.expiresAt,
    sources: [
      ...(mx.ok ? [{ source: 'DNS over HTTPS (Cloudflare)', url: mx.url, readAt: mx.readAt, status: mx.status, cached: mx.cached }] : []),
      ...(rdap.status && rdap.status >= 200 && rdap.status < 300 ? [sourceOf(rdap, 'RDAP registration record (rdap.org)')] : []),
    ],
  }
  if (!mx.ok) notes.push({ kind: 'inconclusive', detail: `the MX lookup failed (${mx.error ?? 'unknown reason'}), so mail routing for ${domain} is unknown` })
  if (mx.ok && nullMx) notes.push({ kind: 'inconclusive', detail: `${domain} publishes a null MX ("0 ."), which is an explicit statement that it accepts no mail. An address at that domain cannot receive mail.` })
  if (mx.ok && !mx.records.length) notes.push({ kind: 'inconclusive', detail: `${domain} publishes no MX records right now. That usually means it does not receive mail — but a domain can still route mail through an A record fallback, so this is not conclusive.` })

  // --- Breach status, only when the user has supplied a key.
  const breach: EmailResult['breach'] = { checked: false, outcome: 'not_checked', breaches: [], detail: 'no breach-check API key is stored, so breach status was not checked' }
  const key = ctx.breachKey?.() ?? null
  if (key) {
    const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`
    const res = await ctx.http.getWithKey(url, { 'hibp-api-key': key, 'User-Agent': 'GogaOSINT/1.0' })
    breach.checked = true
    if (res.refusedReason) { breach.outcome = 'not_checked'; breach.detail = res.refusedReason }
    else if (res.status === 404) {
      breach.outcome = 'absent'
      breach.detail = 'the breach service has no record of this address in its public breaches. It cannot know about breaches that were never published.'
    } else if (res.status === 200) {
      try {
        const list = JSON.parse(res.body) as { Name?: string; Domain?: string; BreachDate?: string; DataClasses?: string[] }[]
        breach.outcome = list.length ? 'found' : 'absent'
        breach.breaches = list.map(b => ({ name: String(b.Name ?? ''), domain: String(b.Domain ?? ''), date: String(b.BreachDate ?? ''), dataClasses: (b.DataClasses ?? []).map(String) }))
        breach.detail = list.length ? `${list.length} published breach(es) include this address` : 'no published breach includes this address'
      } catch { breach.outcome = 'error'; breach.detail = 'the breach service answered with something unreadable' }
    } else if (res.status === 401 || res.status === 403) {
      breach.outcome = 'blocked'; breach.detail = 'the breach service rejected the stored key'
    } else if (res.status === 429) {
      breach.outcome = 'blocked'; breach.detail = 'the breach service rate-limited the request'
    } else {
      breach.outcome = 'error'; breach.detail = res.error ?? `unexpected status ${res.status}`
    }
  }

  // --- Public mentions, via the existing web search.
  const mentions: EmailResult['mentions'] = []
  if (ctx.search) {
    try {
      const hits = await ctx.search(`"${email}"`, 8)
      const readAt = new Date().toISOString()
      for (const h of hits) {
        if (!h.url || !/^https?:/i.test(h.url)) continue
        const t = redact(h.title ?? ''), s = redact(h.snippet ?? '')
        redactions.push(t.hits, s.hits)
        mentions.push({ title: t.text, url: h.url, snippet: s.text, readAt })
      }
      if (!mentions.length) notes.push({ kind: 'inconclusive', detail: 'the web search returned no page containing this address. Search indexes are incomplete and this query is exact-match only.' })
    } catch (err) {
      notes.push({ kind: 'inconclusive', detail: `the public-mentions search failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  } else {
    notes.push({ kind: 'not-checked', detail: 'public mentions were not checked: no web search was available in this run' })
  }

  if (gravatar.linkedAccounts.length) {
    notes.push({ kind: 'purpose', detail: 'the linked accounts below were published by the address owner on their own Gravatar profile, which is why they are treated as self-published rather than inferred.' })
  }

  return {
    query: email, mode, programName, purpose, gravatar, domainContext, breach, mentions, notes,
    redactions: gatherRedactions(redactions), startedAt, finishedAt: new Date().toISOString(),
  }
}

// ------------------------------------------------------------------ domain

export interface RdapDomainSummary {
  registrar: string | null
  registeredAt: string | null
  expiresAt: string | null
  updatedAt: string | null
  statuses: string[]
  nameservers: string[]
  summary: string[]
}

/** Pull the few registration facts that are actually in an RDAP domain object. */
export function parseRdapDomain(body: string): RdapDomainSummary {
  const empty: RdapDomainSummary = { registrar: null, registeredAt: null, expiresAt: null, updatedAt: null, statuses: [], nameservers: [], summary: [] }
  let doc: Record<string, unknown>
  try { doc = JSON.parse(body) as Record<string, unknown> } catch { return empty }
  const events = Array.isArray(doc.events) ? doc.events as { eventAction?: string; eventDate?: string }[] : []
  const at = (action: string) => events.find(e => String(e.eventAction ?? '').toLowerCase() === action)?.eventDate ?? null
  const entities = Array.isArray(doc.entities) ? doc.entities as Record<string, unknown>[] : []
  let registrar: string | null = null
  for (const e of entities) {
    const roles = Array.isArray(e.roles) ? (e.roles as string[]) : []
    if (!roles.includes('registrar')) continue
    const vcard = Array.isArray(e.vcardArray) ? (e.vcardArray as unknown[])[1] : null
    const fn = Array.isArray(vcard) ? (vcard as unknown[][]).find(x => Array.isArray(x) && x[0] === 'fn') : null
    registrar = fn ? String((fn as unknown[])[3] ?? '') || null : null
    if (!registrar && typeof e.handle === 'string') registrar = e.handle
  }
  const statuses = Array.isArray(doc.status) ? (doc.status as string[]).map(String) : []
  const nameservers = Array.isArray(doc.nameservers)
    ? (doc.nameservers as { ldhName?: string }[]).map(n => String(n.ldhName ?? '')).filter(Boolean)
    : []
  const summary: string[] = []
  if (doc.ldhName) summary.push(`Registered name: ${String(doc.ldhName)}`)
  if (doc.handle) summary.push(`Registry handle: ${String(doc.handle)}`)
  if (registrar) summary.push(`Registrar: ${registrar}`)
  const reg = at('registration'), exp = at('expiration'), upd = at('last changed') ?? at('last update of rdap database')
  if (reg) summary.push(`First registered: ${reg.slice(0, 10)}`)
  if (exp) summary.push(`Expires: ${exp.slice(0, 10)}`)
  if (upd) summary.push(`Record last changed: ${upd.slice(0, 10)}`)
  if (statuses.length) summary.push(`Status: ${statuses.join(', ')}`)
  if (nameservers.length) summary.push(`Nameservers: ${nameservers.join(', ')}`)
  return { registrar, registeredAt: reg, expiresAt: exp, updatedAt: upd, statuses, nameservers, summary }
}

export interface RdapIpSummary { name: string | null; handle: string | null; network: string | null; asn: string | null; summary: string[] }

export function parseRdapIp(body: string): RdapIpSummary {
  const empty: RdapIpSummary = { name: null, handle: null, network: null, asn: null, summary: [] }
  let doc: Record<string, unknown>
  try { doc = JSON.parse(body) as Record<string, unknown> } catch { return empty }
  const name = typeof doc.name === 'string' ? doc.name : null
  const handle = typeof doc.handle === 'string' ? doc.handle : null
  const start = typeof doc.startAddress === 'string' ? doc.startAddress : null
  const end = typeof doc.endAddress === 'string' ? doc.endAddress : null
  const network = start && end ? `${start} – ${end}` : null
  let asn: string | null = null
  const entities = Array.isArray(doc.entities) ? doc.entities as Record<string, unknown>[] : []
  for (const e of entities) {
    const ids = Array.isArray(e.publicIds) ? e.publicIds as { type?: string; identifier?: string }[] : []
    const hit = ids.find(i => /autnum|as number|origin/i.test(String(i.type ?? '')))
    if (hit?.identifier) { asn = `AS${String(hit.identifier).replace(/^AS/i, '')}`; break }
  }
  const summary: string[] = []
  if (name) summary.push(`Network name: ${name}`)
  if (handle) summary.push(`Handle: ${handle}`)
  if (network) summary.push(`Range: ${network}`)
  if (asn) summary.push(`ASN: ${asn}`)
  return { name, handle, network, asn, summary }
}

export async function domainRecon(domainInput: string, ctx: OsintContext): Promise<DomainResult> {
  const domain = validDomain(domainInput)
  if (!domain) throw refuse('that is not a domain Goga can check')
  const purpose = requirePurpose(ctx.purpose, 'domain reconnaissance', false)
  const { mode, programName } = modeOf(ctx.program)
  const startedAt = new Date().toISOString()
  const notes: OsintNote[] = []
  const redactions: OsintRedaction[][] = []

  const forbidden = forbiddenTarget(domain)
  if (forbidden) throw refuse(`${domain} cannot be researched: ${forbidden}`)

  // In a program, the domain itself must be covered before anything is contacted.
  if (ctx.program) {
    const decision = decideScope(ctx.program, `https://${domain}/`)
    if (!decision.inScope) {
      throw refuse(`${domain} is not covered by the active program "${ctx.program.name}": ${decision.reason}. Domain recon refuses out-of-scope targets.`)
    }
    notes.push({ kind: 'scope', detail: `in scope under ${decision.matchedRule ?? 'the program'}: ${decision.reason}` })
  } else {
    notes.push({ kind: 'scope', detail: 'No bug-bounty program is active, so this is unattributed public research, not an authorized test. Only public registration, DNS and certificate data is read.' })
  }

  // --- Registration
  const rdapUrl = `https://rdap.org/domain/${encodeURIComponent(domain)}`
  const rdapRes = await ctx.http.get(rdapUrl, { respectRobots: false, maxRedirects: 2, allowCrossSite: true })
  const parsed = parseRdapDomain(rdapRes.body)
  const registration: DomainResult['registration'] = {
    outcome: 'not_checked', registrar: parsed.registrar, registeredAt: parsed.registeredAt,
    expiresAt: parsed.expiresAt, updatedAt: parsed.updatedAt, statuses: parsed.statuses,
    nameservers: parsed.nameservers, summary: parsed.summary, source: null,
  }
  if (rdapRes.refusedReason) { registration.outcome = 'not_checked'; registration.detail = rdapRes.refusedReason }
  else if (rdapRes.status && rdapRes.status >= 200 && rdapRes.status < 300) {
    registration.outcome = parsed.summary.length ? 'found' : 'error'
    registration.source = sourceOf(rdapRes, 'RDAP registration record (rdap.org)')
    if (!parsed.summary.length) registration.detail = 'the registry answered, but not with a record Goga could read'
  } else if (rdapRes.status === 404) { registration.outcome = 'absent'; registration.detail = 'the registry has no record for that name' }
  else { registration.outcome = 'error'; registration.detail = rdapRes.error ?? `unexpected status ${rdapRes.status}` }
  const r1 = redact(JSON.stringify(registration)); if (r1.hits.length) redactions.push(r1.hits)

  // --- DNS
  const dns: DomainResult['dns'] = []
  for (const type of ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CAA']) {
    if (ctx.signal?.aborted) { notes.push({ kind: 'inconclusive', detail: 'the run was stopped during the DNS lookups' }); break }
    const r = await ctx.http.dns(domain, type)
    const value = redact(r.records.join(' | '))
    if (value.hits.length) redactions.push(value.hits)
    dns.push({
      type,
      values: value.text ? value.text.split(' | ') : [],
      source: r.ok ? { source: 'DNS over HTTPS (Cloudflare)', url: r.url, readAt: r.readAt, status: r.status, cached: r.cached } : null,
      note: r.ok ? (r.records.length ? undefined : `no ${type} record is published`) : `could not be read: ${r.error ?? 'unknown reason'}`,
    })
  }

  // --- Certificate transparency subdomains
  const ctUrl = `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json&exclude=expired`
  const ctRes = await ctx.http.get(ctUrl, { respectRobots: false, maxRedirects: 1, timeoutMs: 45_000 })
  const subdomains: DomainResult['subdomains'] = {
    names: [], total: 0, source: null,
    note: 'Names here were published in public certificate logs — the set of certificates issued for the domain. Not every name still exists or resolves.',
  }
  if (ctRes.refusedReason) { subdomains.detail = ctRes.refusedReason }
  else if (ctRes.status && ctRes.status >= 200 && ctRes.status < 300) {
    subdomains.source = sourceOf(ctRes, 'Certificate Transparency logs (crt.sh)')
    try {
      const rows = JSON.parse(ctRes.body) as { name_value?: string; common_name?: string }[]
      const set = new Set<string>()
      for (const row of rows) {
        const text = String(row.name_value ?? row.common_name ?? '')
        for (const raw of text.split('\n')) {
          const name = raw.trim().toLowerCase().replace(/^\*\./, '')
          if (!name || name === domain) continue
          if (!name.endsWith(`.${domain}`)) continue
          set.add(name)
        }
      }
      subdomains.names = [...set].sort().slice(0, 400)
      subdomains.total = set.size
      if (!set.size) subdomains.detail = 'no subdomain names appear in the certificate logs for this domain'
    } catch { subdomains.detail = 'the log answer was not readable JSON' }
  } else if (ctRes.status === 404) { subdomains.detail = 'the log has no entry for this domain' }
  else { subdomains.detail = ctRes.error ?? `unexpected status ${ctRes.status}` }

  // --- Host metadata for a few names we saw (in-scope ones only, when a program governs)
  const hosts: DomainResult['hosts'] = []
  const candidates = [domain, ...subdomains.names].slice(0, 6)
  for (const host of candidates) {
    if (ctx.signal?.aborted) break
    if (ctx.program) {
      const decision = decideScope(ctx.program, `https://${host}/`)
      if (!decision.inScope) {
        hosts.push({ host, addresses: [], network: null, asn: null, source: null, detail: `not resolved: ${decision.reason}` })
        continue
      }
    }
    const a = await ctx.http.dns(host, 'A')
    const addresses = a.records.filter(v => /^\d{1,3}(\.\d{1,3}){3}$/.test(v))
    let network: string | null = null, asn: string | null = null
    let source: OsintSource | null = null
    let detail: string | undefined = a.ok ? undefined : `DNS failed: ${a.error ?? 'unknown'}`
    if (addresses[0]) {
      const ipRes = await ctx.http.get(`https://rdap.org/ip/${encodeURIComponent(addresses[0])}`, { respectRobots: false, maxRedirects: 2, allowCrossSite: true })
      if (ipRes.status && ipRes.status >= 200 && ipRes.status < 300) {
        const ip = parseRdapIp(ipRes.body)
        network = ip.network ?? ip.name
        asn = ip.asn
        source = sourceOf(ipRes, 'RDAP network record (rdap.org)')
      } else {
        detail = ipRes.error ?? `the network registry answered ${ipRes.status ?? 'nothing'}`
      }
    }
    hosts.push({ host, addresses, network, asn, source, detail })
  }

  if (!subdomains.names.length && subdomains.detail) {
    notes.push({ kind: 'inconclusive', detail: `subdomain enumeration was incomplete: ${subdomains.detail}` })
  }
  notes.push({ kind: 'inconclusive', detail: 'Only DNS, RDAP and certificate-transparency data was read. No ports were scanned, no pages were requested, and nothing was tested for vulnerabilities.' })

  return {
    query: domainInput, domain, mode, programName, purpose, registration, dns, subdomains, hosts, notes,
    redactions: gatherRedactions(redactions), startedAt, finishedAt: new Date().toISOString(),
  }
}

// ------------------------------------------------------------------ profile

export async function aggregateProfile(subjectInput: string, ctx: OsintContext): Promise<ProfileResult> {
  const subject = String(subjectInput ?? '').trim()
  if (!subject) throw refuse('give a confirmed identity to aggregate: a username, an email address, or a profile URL')
  // A person's name is exactly the case that needs a stated purpose, and it is always required here.
  const purpose = requirePurpose(ctx.purpose, 'profile aggregation', true)
  const { mode, programName } = modeOf(ctx.program)
  const startedAt = new Date().toISOString()
  const notes: OsintNote[] = []
  const redactions: OsintRedaction[][] = []
  const selfPublished: ProfileResult['selfPublished'] = []
  const facts: OsintItem[] = []

  const email = validEmail(subject)
  const username = email ? null : validUsername(subject)
  if (!email && !username) throw refuse('that is neither an email address nor a username Goga can resolve')

  if (looksLikePersonName(subject)) {
    notes.push({ kind: 'purpose', detail: 'A person\'s name was given rather than a handle. Goga does not search by name against data brokers; aggregation is limited to accounts the person published themselves under a handle or address.' })
  }

  const addFact = (label: string, value: string, src: OsintSource | null, note?: string) => {
    const r = redact(value)
    if (r.hits.length) redactions.push(r.hits)
    if (r.text) facts.push({ label, value: r.text, source: src, note })
  }

  if (email) {
    const hash = gravatarHash(email)
    const g = await ctx.http.get(`https://gravatar.com/${hash}.json`, { respectRobots: false, maxRedirects: 1 })
    if (g.status && g.status >= 200 && g.status < 300) {
      const src = sourceOf(g, 'Gravatar public profile')
      try {
        const doc = JSON.parse(g.body) as GravatarShape
        const entry = doc.entry?.[0]
        if (entry) {
          selfPublished.push({ site: 'Gravatar', url: entry.profileUrl ?? `https://gravatar.com/${hash}`, source: src })
          if (entry.displayName) addFact('Display name (self-published)', entry.displayName, src)
          if (entry.aboutMe) addFact('About text (self-published)', entry.aboutMe, src)
          if (entry.company) addFact('Company (self-published)', entry.company, src)
          if (entry.job_title) addFact('Job title (self-published)', entry.job_title, src)
          if (entry.currentLocation) addFact('Location (self-published)', entry.currentLocation, src)
          for (const ac of entry.accounts ?? []) {
            if (!ac.url) continue
            selfPublished.push({ site: ac.domain || ac.shortname || 'linked account', url: String(ac.url), source: { ...src, source: `Gravatar linked account (${ac.verified ? 'verified' : 'unverified'})` } })
          }
        }
      } catch { notes.push({ kind: 'inconclusive', detail: 'the Gravatar answer was unreadable, so its profile was not used' }) }
    } else if (g.status === 404) {
      notes.push({ kind: 'inconclusive', detail: 'this address has no Gravatar profile, so there was nothing self-published to anchor the aggregation on.' })
    } else {
      notes.push({ kind: 'inconclusive', detail: `Gravatar did not answer usefully (${g.status ?? g.error ?? 'no answer'})` })
    }
  }

  const handle = username ?? (facts.find(f => f.label === 'Display name (self-published)')?.value ?? '')
  if (handle && validUsername(handle)) {
    // GitHub's public API is self-published data: name, bio, company, links the person filled in.
    const gh = await ctx.http.get(`https://api.github.com/users/${encodeURIComponent(handle)}`, { respectRobots: false, maxRedirects: 0 })
    if (gh.status && gh.status >= 200 && gh.status < 300) {
      const src = sourceOf(gh, 'GitHub public user API')
      try {
        const doc = JSON.parse(gh.body) as Record<string, unknown>
        selfPublished.push({ site: 'GitHub', url: String(doc.html_url ?? `https://github.com/${handle}`), source: src })
        if (doc.name) addFact('Name on GitHub (self-published)', String(doc.name), src)
        if (doc.bio) addFact('GitHub bio (self-published)', String(doc.bio), src)
        if (doc.company) addFact('GitHub company (self-published)', String(doc.company), src)
        if (doc.location) addFact('GitHub location (self-published)', String(doc.location), src)
        if (doc.blog) addFact('GitHub website (self-published)', String(doc.blog), src)
        if (doc.twitter_username) addFact('GitHub-linked X handle', `@${String(doc.twitter_username)}`, src)
        if (doc.public_repos !== undefined) addFact('Public repositories', String(doc.public_repos), src)
        if (doc.created_at) addFact('GitHub account created', String(doc.created_at).slice(0, 10), src)
      } catch { notes.push({ kind: 'inconclusive', detail: 'the GitHub answer was unreadable' }) }
    } else if (gh.status !== 404) {
      notes.push({ kind: 'inconclusive', detail: `GitHub's API did not answer usefully (${gh.status ?? gh.error ?? 'no answer'})` })
    }

    // Keybase: cryptographic proofs, so a match is a self-published claim of identity.
    const kb = await ctx.http.get(`https://keybase.io/_/api/1.0/user/lookup.json?username=${encodeURIComponent(handle)}&fields=basics,proofs_summary`, { respectRobots: false, maxRedirects: 0 })
    if (kb.status && kb.status >= 200 && kb.status < 300) {
      try {
        const doc = JSON.parse(kb.body) as { status?: { code?: number }; them?: { basics?: { username?: string }; proofs_summary?: { all?: { proof_type?: string; nametag?: string; human_url?: string; state?: number }[] } }[] }
        const them = Array.isArray(doc.them) ? doc.them[0] : undefined
        if (them?.basics?.username) {
          const src = sourceOf(kb, 'Keybase proofs API')
          selfPublished.push({ site: 'Keybase', url: `https://keybase.io/${handle}`, source: src })
          for (const proof of them.proofs_summary?.all ?? []) {
            if (!proof.human_url) continue
            selfPublished.push({
              site: `Keybase proof: ${proof.proof_type ?? 'account'}${proof.state === 1 ? ' (verified)' : ''}`,
              url: proof.human_url,
              source: { ...src, source: `Keybase cryptographic proof (${proof.state === 1 ? 'verified' : 'not verified'})` },
            })
          }
        }
      } catch { /* no usable proof summary */ }
    }

    // Hacker News: the public "about" field only.
    const hn = await ctx.http.get(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(handle)}.json`, { respectRobots: false, maxRedirects: 0 })
    if (hn.status && hn.status >= 200 && hn.status < 300 && hn.body.trim() !== 'null') {
      try {
        const doc = JSON.parse(hn.body) as { about?: string; created?: number; karma?: number }
        const src = sourceOf(hn, 'Hacker News user API')
        selfPublished.push({ site: 'Hacker News', url: `https://news.ycombinator.com/user?id=${handle}`, source: src })
        if (doc.about) addFact('Hacker News about text (self-published)', doc.about, src)
        if (doc.created) addFact('Hacker News account created', new Date(doc.created * 1000).toISOString().slice(0, 10), src)
      } catch { /* nothing usable */ }
    }
  } else if (!email) {
    notes.push({ kind: 'inconclusive', detail: 'the subject did not resolve to a handle, so only self-published profiles under that exact name could be checked' })
  }

  if (!selfPublished.length) {
    notes.push({ kind: 'inconclusive', detail: 'no self-published profile was confirmed for this identity. That means nothing was found in the sources that were checked; it does not mean the identity has no accounts.' })
  }
  notes.push({ kind: 'purpose', detail: `purpose recorded with the query in the audit log: ${purpose}` })

  return {
    subject, purpose, mode, programName, selfPublished, facts, notes,
    redactions: gatherRedactions(redactions), startedAt, finishedAt: new Date().toISOString(),
  }
}

/** Every host this search type touches, for the UI's "sources" summary. */
export function sourcesFor(kind: 'username' | 'email' | 'domain' | 'profile'): string[] {
  if (kind === 'username') return [...SITES.map(s => s.site), ...EXCLUDED.map(e => `${e.site} (skipped)`)]
  if (kind === 'email') return ['Gravatar public profile', 'DNS over HTTPS (Cloudflare)', 'RDAP registration record', 'Breach service (only with a key)', 'Web search for public mentions']
  if (kind === 'domain') return ['RDAP registration record', 'DNS over HTTPS (Cloudflare)', 'Certificate Transparency logs (crt.sh)', 'RDAP network record']
  return ['Gravatar public profile', 'GitHub public user API', 'Keybase proofs API', 'Hacker News user API']
}
