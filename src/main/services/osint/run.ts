import type { OsintAuditEntry, OsintMode } from '../../../shared/osint'
import type { ProgramImport } from '../../../shared/security'
import { activeProgram } from '../security/store'
import { LogService } from '../logs'
import { OsintHttp } from './http'
import { recordOsintAudit, readBreachKey } from './audit'
import { aggregateProfile, domainRecon, modeOf, reverseEmail, reverseUsername, type OsintContext } from './engine'

/**
 * One OSINT run, wrapped so that nothing can happen without an audit entry.
 *
 * The order is: write the audit entry *first* (what was asked, under what purpose, against
 * which program), then run, then append the sources that were actually contacted. A refusal
 * is recorded too — a run that was declined is as much a part of the trail as one that ran.
 *
 * The tools and the page both go through `runOsint`, so there is one path, one rate limit
 * and one audit format.
 */

export type OsintKind = 'username' | 'email' | 'domain' | 'profile'

export interface OsintRunDeps {
  http?: OsintHttp
  program?: ProgramImport | null
  search?: OsintContext['search']
  breachKey?: () => string | null
  /** Injected in tests so no audit file is touched. */
  record?: typeof recordOsintAudit
}

export interface OsintRunOutput {
  audit: OsintAuditEntry
  data: unknown
  /** Human-readable block for chat/UI: what was found, from where, when, and what was not checked. */
  text: string
}

const log = () => LogService.getInstance()

function summarise(kind: OsintKind, data: Record<string, unknown>): string {
  if (kind === 'username') {
    const found = (data.found as unknown[] | undefined)?.length ?? 0
    const absent = (data.absent as unknown[] | undefined)?.length ?? 0
    const blocked = (data.blocked as unknown[] | undefined)?.length ?? 0
    const skipped = (data.notChecked as unknown[] | undefined)?.length ?? 0
    return `${found} profile(s) answered, ${absent} site(s) said no such user, ${blocked} blocked, ${skipped} not checked`
  }
  if (kind === 'email') {
    const g = (data.gravatar as { outcome?: string } | undefined)?.outcome
    const b = (data.breach as { checked?: boolean; outcome?: string } | undefined)
    const m = (data.mentions as unknown[] | undefined)?.length ?? 0
    return `Gravatar ${g ?? 'unknown'}, breach ${b?.checked ? (b.outcome ?? 'unknown') : 'not checked'}, ${m} public mention(s)`
  }
  if (kind === 'domain') {
    const reg = (data.registration as { outcome?: string } | undefined)?.outcome
    const sub = (data.subdomains as { total?: number } | undefined)?.total ?? 0
    return `registration ${reg ?? 'unknown'}, ${sub} subdomain name(s) from certificate logs`
  }
  const self = (data.selfPublished as unknown[] | undefined)?.length ?? 0
  const facts = (data.facts as unknown[] | undefined)?.length ?? 0
  return `${self} self-published profile(s), ${facts} fact(s)`
}

export async function runOsint(kind: OsintKind, params: Record<string, unknown>, deps: OsintRunDeps = {}): Promise<OsintRunOutput> {
  const program = deps.program !== undefined ? deps.program : safeActiveProgram()
  const { mode, programName } = modeOf(program)
  const purpose = String(params.purpose ?? '').trim()
  const query = String(kind === 'domain' ? params.domain ?? '' : kind === 'email' ? params.email ?? '' : kind === 'profile' ? params.subject ?? '' : params.username ?? '')
  const http = deps.http ?? new OsintHttp()
  const record = deps.record ?? recordOsintAudit

  const started: OsintAuditEntry = {
    id: 'pending', time: new Date().toISOString(),
    tool: `osint.${kind}` as OsintAuditEntry['tool'],
    query, purpose, mode: mode as OsintMode, programName,
    sources: [], skipped: [], summary: 'started',
  }
  // Written before the first request, so a crash mid-run still leaves a record of the intent.
  try { record({ ...started, summary: 'started — logging before the first request' }) } catch { /* the store is best effort */ }
  log().info(`OSINT ${kind}: query="${query}" purpose="${purpose}" mode=${mode}`)

  const ctx: OsintContext = {
    http,
    program,
    purpose,
    search: deps.search,
    breachKey: deps.breachKey ?? (() => { try { return readBreachKey() } catch { return null } }),
  }

  let data: Record<string, unknown>
  let refusal: string | null = null
  try {
    data = kind === 'username' ? await reverseUsername(String(params.username ?? ''), ctx) as unknown as Record<string, unknown>
      : kind === 'email' ? await reverseEmail(String(params.email ?? ''), ctx) as unknown as Record<string, unknown>
      : kind === 'domain' ? await domainRecon(String(params.domain ?? ''), ctx) as unknown as Record<string, unknown>
      : await aggregateProfile(String(params.subject ?? ''), ctx) as unknown as Record<string, unknown>
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err)
    const audit = record({
      ...started,
      sources: http.contacted,
      skipped: http.refusedHosts(),
      summary: `refused or failed: ${refusal}`,
    })
    log().warn(`OSINT ${kind} did not run: ${refusal}`)
    return { audit: { ...audit, id: audit.id || 'pending', time: started.time }, data: { refused: refusal }, text: `OSINT ${kind} did not run: ${refusal}` }
  }

  const audit = record({
    ...started,
    sources: [...http.contacted, ...http.fromCache.map(h => `${h} (cached)`)],
    skipped: http.refusedHosts(),
    summary: summarise(kind, data),
  })
  return { audit, data, text: formatOsint(kind, data) }
}

function safeActiveProgram(): ProgramImport | null {
  try { return activeProgram() } catch { return null }
}

/**
 * The text a person reads. Every value is followed by where it came from and when; every
 * gap is named in its own line rather than being left out.
 */
export function formatOsint(kind: OsintKind, data: Record<string, unknown>): string {
  const lines: string[] = []
  if (kind === 'username') {
    const d = data as unknown as import('../../../shared/osint').UsernameResult
    lines.push(`Username "${d.query}" — ${d.mode === 'program' ? `under program ${d.programName}` : 'unattributed public research'}`)
    if (d.purpose) lines.push(`Purpose recorded: ${d.purpose}`)
    if (d.found.length) {
      lines.push('', 'Profiles that answered:')
      for (const f of d.found) lines.push(`  • ${f.site}: ${f.url} — read ${f.readAt?.slice(0, 19).replace('T', ' ')}Z (HTTP ${f.status})`)
    }
    if (d.absent.length) {
      lines.push('', 'Sites that answered "no such user" (a statement about those sites only):')
      for (const a of d.absent) lines.push(`  • ${a.site} — read ${a.readAt?.slice(0, 19).replace('T', ' ')}Z`)
    }
    if (d.blocked.length) {
      lines.push('', 'Could not be checked (the site refused an automated read):')
      for (const b of d.blocked) lines.push(`  • ${b.site}: ${b.detail ?? ''}`)
    }
    if (d.notChecked.length) {
      lines.push('', 'Not checked:')
      for (const n of d.notChecked) lines.push(`  • ${n.site}: ${n.detail ?? 'no reason recorded'}`)
    }
    for (const n of d.notes) lines.push('', `${n.kind}: ${n.detail}`)
    if (d.redactions.length) lines.push('', `Removed before display: ${d.redactions.map(r => `${r.count}× ${r.kind}`).join(', ')}`)
    return lines.join('\n')
  }
  if (kind === 'email') {
    const d = data as unknown as import('../../../shared/osint').EmailResult
    lines.push(`Email "${d.query}" — ${d.mode === 'program' ? `under program ${d.programName}` : 'unattributed public research'}`)
    lines.push(`Purpose recorded: ${d.purpose}`)
    lines.push('', `Gravatar: ${d.gravatar.outcome}`)
    if (d.gravatar.displayName) lines.push(`  Name: ${d.gravatar.displayName}`)
    if (d.gravatar.aboutMe) lines.push(`  About: ${d.gravatar.aboutMe}`)
    for (const a of d.gravatar.linkedAccounts) lines.push(`  linked: ${a.label} — ${a.url}${a.verified ? ' (verified by Gravatar)' : ''}`)
    if (d.gravatar.source) lines.push(`  source: ${d.gravatar.source.url} read ${d.gravatar.source.readAt.slice(0, 19).replace('T', ' ')}Z`)
    if (d.gravatar.detail) lines.push(`  ${d.gravatar.detail}`)
    const nullMx = d.domainContext.mx.length === 1 && /^0\s+\.?$/.test(d.domainContext.mx[0].trim())
    lines.push('', `Domain ${d.domainContext.domain}: MX ${d.domainContext.hasMailRoute === null ? 'unknown' : d.domainContext.hasMailRoute ? 'present' : nullMx ? 'null MX — the domain states it accepts no mail' : 'none published'}`)
    if (d.domainContext.mx.length) lines.push(`  MX: ${d.domainContext.mx.join(', ')}`)
    for (const s of d.domainContext.rdapSummary) lines.push(`  ${s}`)
    lines.push('', `Breach status: ${d.breach.checked ? d.breach.outcome : 'not checked'} — ${d.breach.detail}`)
    for (const b of d.breach.breaches) lines.push(`  • ${b.name} (${b.domain}, ${b.date}): ${b.dataClasses.join(', ')}`)
    if (d.mentions.length) {
      lines.push('', 'Public mentions:')
      for (const m of d.mentions) lines.push(`  • ${m.title} — ${m.url}`)
    }
    for (const n of d.notes) lines.push('', `${n.kind}: ${n.detail}`)
    if (d.redactions.length) lines.push('', `Removed before display: ${d.redactions.map(r => `${r.count}× ${r.kind}`).join(', ')}`)
    return lines.join('\n')
  }
  if (kind === 'domain') {
    const d = data as unknown as import('../../../shared/osint').DomainResult
    lines.push(`Domain "${d.domain}" — ${d.mode === 'program' ? `under program ${d.programName}` : 'unattributed public research'}`)
    if (d.purpose) lines.push(`Purpose recorded: ${d.purpose}`)
    lines.push('', `Registration: ${d.registration.outcome}`)
    for (const s of d.registration.summary) lines.push(`  ${s}`)
    if (d.registration.source) lines.push(`  source: ${d.registration.source.url} read ${d.registration.source.readAt.slice(0, 19).replace('T', ' ')}Z`)
    if (d.registration.detail) lines.push(`  ${d.registration.detail}`)
    lines.push('', 'DNS:')
    for (const r of d.dns) lines.push(`  ${r.type}: ${r.values.length ? r.values.join(', ') : (r.note ?? 'none')}`)
    lines.push('', `Certificate-transparency names: ${d.subdomains.total} found${d.subdomains.detail ? ` — ${d.subdomains.detail}` : ''}`)
    for (const n of d.subdomains.names.slice(0, 60)) lines.push(`  • ${n}`)
    if (d.subdomains.names.length > 60) lines.push(`  … and ${d.subdomains.names.length - 60} more`)
    if (d.hosts.length) {
      lines.push('', 'Host metadata:')
      for (const h of d.hosts) lines.push(`  ${h.host}: ${h.addresses.join(', ') || 'no address'}${h.network ? ` — ${h.network}` : ''}${h.asn ? ` ${h.asn}` : ''}${h.detail ? ` (${h.detail})` : ''}`)
    }
    for (const n of d.notes) lines.push('', `${n.kind}: ${n.detail}`)
    if (d.redactions.length) lines.push('', `Removed before display: ${d.redactions.map(r => `${r.count}× ${r.kind}`).join(', ')}`)
    return lines.join('\n')
  }
  const d = data as unknown as import('../../../shared/osint').ProfileResult
  lines.push(`Profile aggregation for "${d.subject}" — ${d.mode === 'program' ? `under program ${d.programName}` : 'unattributed public research'}`)
  lines.push(`Purpose recorded: ${d.purpose}`)
  if (d.selfPublished.length) {
    lines.push('', 'Profiles the person published themselves:')
    for (const p of d.selfPublished) lines.push(`  • ${p.site}: ${p.url} — ${p.source.source}, read ${p.source.readAt.slice(0, 19).replace('T', ' ')}Z`)
  }
  if (d.facts.length) {
    lines.push('', 'Facts, each with its source:')
    for (const f of d.facts) lines.push(`  ${f.label}: ${f.value}${f.source ? ` — ${f.source.url} (read ${f.source.readAt.slice(0, 19).replace('T', ' ')}Z)` : ''}${f.note ? ` — ${f.note}` : ''}`)
  }
  for (const n of d.notes) lines.push('', `${n.kind}: ${n.detail}`)
  if (d.redactions.length) lines.push('', `Removed before display: ${d.redactions.map(r => `${r.count}× ${r.kind}`).join(', ')}`)
  return lines.join('\n')
}
