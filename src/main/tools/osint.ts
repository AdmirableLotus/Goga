import { ToolRegistry, type ToolContext } from './registry'
import { runOsint, type OsintRunDeps } from '../services/osint/run'
import { readOsintAudit } from '../services/osint/audit'
import { SITES, EXCLUDED } from '../services/osint/sites'

/**
 * OSINT tools.
 *
 * Four searches that reach public sources, and one that only reads the local audit trail.
 *
 * Every tool that sends a request is `critical`, so the approval gate stops it and the user
 * sees the query before anything leaves the machine. On top of that, the code in
 * services/osint refuses out-of-scope hosts under an active program, refuses local, private
 * and metadata hosts, requires a stated purpose for a person-shaped subject, and writes an
 * audit entry with query, sources, timestamp and purpose on every run — allowed or refused.
 */

const reg = ToolRegistry.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

function depsFor(ctx: ToolContext): OsintRunDeps {
  return {
    // Call-time injection: the existing web.search tool, so public mentions use the one
    // search path the rest of Goga already has (and its abort signal reaches it).
    search: async (query, maxResults) => {
      const r = await reg.execute('web.search', { query, maxResults }, { abortSignal: ctx.abortSignal })
      if (!r.success) throw new Error(r.error || 'web search failed')
      return (r.data as { title: string; url: string; snippet: string }[]) ?? []
    },
  }
}

reg.register({
  name: 'osint.username',
  description:
    'Reverse-username lookup: check one username against a curated list of public sites and return only the profiles that actually answered. ' +
    'Each hit carries its URL and the time it was read; sites that said "no such user" are listed separately from sites that blocked the read. ' +
    'It does not sign in anywhere, does not solve challenges, and never reports "not found" as "does not exist".',
  parameters: {
    type: 'object',
    properties: {
      username: { type: 'string', description: 'The handle to check, e.g. "torvalds". No spaces or slashes.' },
      purpose: { type: 'string', description: 'Required for a person-shaped subject: what this research is for, in one line. Recorded in the audit log.' },
    },
    required: ['username'],
  },
  riskLevel: 'critical', reversible: true, category: 'web',
}, async (p, ctx) => {
  try {
    const out = await runOsint('username', p, depsFor(ctx))
    return { success: true, data: out.text }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'osint.email',
  description:
    'Reverse-email lookup: the address owner\'s public Gravatar profile and the accounts they linked themselves, whether the domain takes mail (MX) and who registered it (RDAP), ' +
    'breach status when the user has stored a breach-check API key, and public pages that mention the address. A stated purpose is always required. ' +
    'Removes passwords, financial account numbers, government identifiers and health data before returning anything.',
  parameters: {
    type: 'object',
    properties: {
      email: { type: 'string', description: 'The address to research.' },
      purpose: { type: 'string', description: 'Required: what this research is for, in one line. Recorded in the audit log.' },
    },
    required: ['email', 'purpose'],
  },
  riskLevel: 'critical', reversible: true, category: 'web',
}, async (p, ctx) => {
  try {
    const out = await runOsint('email', p, depsFor(ctx))
    return { success: true, data: out.text }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'osint.domain',
  description:
    'Domain reconnaissance from public records only: RDAP registration (registrar, dates, statuses, nameservers), DNS records, subdomain names from certificate-transparency logs, ' +
    'and network/ASN metadata for a few hosts. When a bug-bounty program is active it refuses any domain the imported scope does not cover; otherwise it labels the result unattributed public research. ' +
    'It reads no pages, scans no ports and tests nothing for vulnerabilities.',
  parameters: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'The domain, e.g. "example.com".' },
      purpose: { type: 'string', description: 'Optional outside a program, but recorded when given: what this research is for.' },
    },
    required: ['domain'],
  },
  riskLevel: 'critical', reversible: true, category: 'web',
}, async (p, ctx) => {
  try {
    const out = await runOsint('domain', p, depsFor(ctx))
    return { success: true, data: out.text }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'osint.profile',
  description:
    'Profile aggregation from one confirmed identity (a handle or an email address): collect only the profiles and facts the person published themselves — Gravatar, GitHub, Keybase proofs, Hacker News — ' +
    'each with the source and read time. A stated purpose is always required, and a bare person\'s name is not used to search data brokers.',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'A confirmed identity: a username, an email address, or a profile URL.' },
      purpose: { type: 'string', description: 'Required: what this research is for, in one line. Recorded in the audit log.' },
    },
    required: ['subject', 'purpose'],
  },
  riskLevel: 'critical', reversible: true, category: 'web',
}, async (p, ctx) => {
  try {
    const out = await runOsint('profile', p, depsFor(ctx))
    return { success: true, data: out.text }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'osint.history',
  description: 'The OSINT audit trail: every search that was run or refused, with the query, the stated purpose, the sources contacted and the time. Read-only, local.',
  parameters: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'How many recent entries (default 20).' } },
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const entries = readOsintAudit(Number(p.limit) || 20)
  if (!entries.length) return { success: true, data: 'The OSINT audit log is empty. No OSINT search has been run on this machine yet.' }
  return {
    success: true,
    data: entries.map(e =>
      `${e.time.slice(0, 19).replace('T', ' ')}Z [${e.tool}] "${e.query}" — purpose: ${e.purpose || '(none recorded)'} — ${e.mode === 'program' ? `program ${e.programName}` : 'unattributed'} — ${e.summary}\n   sources: ${e.sources.join(', ') || 'none contacted'}${e.skipped.length ? `\n   skipped: ${e.skipped.map(s => `${s.host} (${s.reason})`).join('; ')}` : ''}`,
    ).join('\n\n'),
  }
})

/** The site list, so the Security page and the tools agree on what is checked. */
export function osintSiteList() {
  return { checked: SITES.map(s => ({ site: s.site, about: s.about })), excluded: EXCLUDED }
}
