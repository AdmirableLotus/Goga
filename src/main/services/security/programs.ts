import fs from 'fs'
import path from 'path'
import { app, safeStorage } from 'electron'
import type { ProgramImport, ProgramSource, ScopeAsset, ScopeExclusion } from '../../../shared/security'

/**
 * Program import from HackerOne and Bugcrowd.
 *
 * Both importers are GET-only against a fixed host, refuse redirects, cap the response
 * size and page count, and never include credentials in an error. The token is stored
 * through Electron safeStorage, one file per platform.
 */

const H1_ORIGIN = 'https://api.hackerone.com'
const BC_ORIGIN = 'https://api.bugcrowd.com'
const MAX_BYTES = 1_500_000
const PAGE_SIZE = 100
const MAX_PAGES = 60

interface Credentials { user: string; token: string }

function credFile(source: ProgramSource): string {
  return path.join(app.getPath('userData'), `goga-${source}-credentials.bin`)
}

export function credentialStatus(source: ProgramSource): { configured: boolean; encryptionAvailable: boolean } {
  return { configured: fs.existsSync(credFile(source)), encryptionAvailable: safeStorage.isEncryptionAvailable() }
}

export function saveCredentials(source: ProgramSource, user: string, token: string): void {
  const u = String(user ?? '').trim(), t = String(token ?? '').trim()
  if (!t) throw new Error('enter the API token for this platform')
  if (source === 'hackerone' && !u) throw new Error('enter your HackerOne username as well as the token')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('secure storage is unavailable on this PC, so the token was not saved')
  fs.writeFileSync(credFile(source), safeStorage.encryptString(JSON.stringify({ user: u, token: t })), { mode: 0o600 })
}

export function clearCredentials(source: ProgramSource): void {
  try { fs.unlinkSync(credFile(source)) } catch { /* none stored */ }
}

function credentials(source: ProgramSource): Credentials {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('secure storage is unavailable on this PC')
  const f = credFile(source)
  if (!fs.existsSync(f)) throw new Error(`no ${source} token is stored — add one in the Security page first`)
  const parsed = JSON.parse(safeStorage.decryptString(fs.readFileSync(f))) as Credentials
  if (!parsed.token) throw new Error(`the stored ${source} token is unusable — add it again`)
  return parsed
}

async function getJson(origin: string, pathname: string, headers: Record<string, string>, http: typeof fetch): Promise<unknown> {
  if (!pathname.startsWith('/') || pathname.includes('..') || pathname.startsWith('//')) throw new Error('invalid API path')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await http(`${origin}${pathname}`, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json', ...headers } })
    if (res.status >= 300 && res.status < 400) throw new Error('the API redirected the request, which was stopped for safety')
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('the API returned an unexpectedly large response')
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error('the API rejected the token, or it has no access to this program')
      if (res.status === 404) throw new Error('the API does not know that program handle')
      throw new Error(`the API returned ${res.status}`)
    }
    try { return JSON.parse(text) } catch { throw new Error('the API returned invalid JSON') }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('the API request timed out')
    throw err
  } finally { clearTimeout(timer) }
}

interface H1Doc { data?: { attributes?: Record<string, unknown> } | { attributes?: Record<string, unknown> }[]; attributes?: Record<string, unknown>; links?: { next?: string | null } }

/**
 * The HackerOne hacker API answers a single-resource request with the resource at the top
 * level (`{ id, type, attributes }`) and a collection request with `{ data: [...] }`.
 * Both shapes are accepted here so the importer works against the live API.
 */
function attributesOf(doc: H1Doc | null | undefined): Record<string, unknown> {
  if (!doc) return {}
  if (doc.attributes && typeof doc.attributes === 'object') return doc.attributes
  const data = doc.data
  if (Array.isArray(data)) return (data[0]?.attributes ?? {}) as Record<string, unknown>
  return (data?.attributes ?? {}) as Record<string, unknown>
}

function authHeader(): Record<string, string> {
  const c = credentials('hackerone')
  return { Authorization: `Basic ${Buffer.from(`${c.user}:${c.token}`).toString('base64')}` }
}

/** One program as the account sees it in the directory. No scope is read here. */
export interface HackerOneProgramSummary {
  handle: string
  name: string
  submissionState: string
  offersBounties: boolean
  /** Reports this account has submitted to the program. */
  reportsForUser: number
  validReportsForUser: number
  bountyEarnedForUser: number
  /** True when this account has actually taken part in the program. */
  participating: boolean
}

export interface HackerOneProgramList {
  programs: HackerOneProgramSummary[]
  pages: number
  /** Programs this account has submitted to or been invited to. */
  participating: number
}

/**
 * Every program the account can see, paged. This is the directory the hacker API exposes,
 * not a list of programs the account has joined — `participating` marks the ones it has.
 */
export async function listHackerOnePrograms(http: typeof fetch = fetch): Promise<HackerOneProgramList> {
  const auth = authHeader()
  const programs: HackerOneProgramSummary[] = []
  let pages = 0
  for (let page = 1; page <= MAX_PAGES; page++) {
    const doc = await getJson(H1_ORIGIN, `/v1/hackers/programs?page[number]=${page}&page[size]=${PAGE_SIZE}`, auth, http) as H1Doc
    const entries = Array.isArray(doc.data) ? doc.data : []
    pages = page
    for (const e of entries) {
      const a = (e.attributes ?? {}) as Record<string, unknown>
      const handle = typeof a.handle === 'string' ? a.handle : ''
      if (!handle) continue
      const reports = typeof a.number_of_reports_for_user === 'number' ? a.number_of_reports_for_user : 0
      programs.push({
        handle,
        name: typeof a.name === 'string' ? a.name : handle,
        submissionState: String(a.submission_state ?? a.state ?? ''),
        offersBounties: a.offers_bounties === true,
        reportsForUser: reports,
        validReportsForUser: typeof a.number_of_valid_reports_for_user === 'number' ? a.number_of_valid_reports_for_user : 0,
        bountyEarnedForUser: typeof a.bounty_earned_for_user === 'number' ? a.bounty_earned_for_user : 0,
        participating: reports > 0 || Boolean(a.last_invitation_accepted_at_for_user),
      })
    }
    if (entries.length < PAGE_SIZE) break
    if (page === MAX_PAGES) throw new Error('the program directory is larger than this importer will page through')
  }
  const unique = [...new Map(programs.map(p => [p.handle, p])).values()]
  return { programs: unique, pages, participating: unique.filter(p => p.participating).length }
}

/** What a live call to the API says about the stored credential. */
export interface HackerOneConnection {
  state: 'connected' | 'rejected' | 'expired' | 'not-connected' | 'error'
  detail: string
  /** The API username the token belongs to, when the call succeeded. */
  account: string | null
  checkedAt: string | null
  /** Where the user creates or replaces the token. */
  where: string
}

export const HACKERONE_TOKEN_PAGE = 'https://hackerone.com/settings/api_token/edit'

/**
 * The narrowest real call: one page of one item from the program directory. It proves the
 * credential works without reading any program's scope. The token is never included in the
 * returned detail, and a failure is reported by status, not by echoing the response body.
 */
export async function checkHackerOneConnection(http: typeof fetch = fetch): Promise<HackerOneConnection> {
  const checkedAt = new Date().toISOString()
  const base = { account: null, checkedAt, where: HACKERONE_TOKEN_PAGE }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ...base, state: 'error', detail: 'Secure storage is unavailable on this PC, so the stored token cannot be read.' }
  }
  if (!fs.existsSync(credFile('hackerone'))) {
    return { ...base, state: 'not-connected', detail: 'No HackerOne token is stored. Add your API username and token below.' }
  }
  let c: Credentials
  try { c = credentials('hackerone') } catch (err) {
    return { ...base, state: 'expired', detail: `The stored token can no longer be decrypted on this Windows account (${err instanceof Error ? err.message : String(err)}). Save it again.` }
  }
  const auth = { Authorization: `Basic ${Buffer.from(`${c.user}:${c.token}`).toString('base64')}` }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await http(`${H1_ORIGIN}/v1/hackers/programs?page[number]=1&page[size]=1`, {
      method: 'GET', redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json', ...auth },
    })
    if (res.status >= 300 && res.status < 400) return { ...base, state: 'error', detail: 'The API redirected the request, which was stopped for safety.' }
    if (res.status === 200) {
      return { ...base, state: 'connected', account: c.user, detail: `Connected as ${c.user}. HackerOne accepted the stored token.` }
    }
    if (res.status === 401) return { ...base, state: 'rejected', detail: 'HackerOne rejected the stored token (HTTP 401). It may have been revoked or replaced — create a new one and save it again.' }
    if (res.status === 403) return { ...base, state: 'rejected', detail: 'HackerOne accepted the request but refused this token access (HTTP 403). Check the token belongs to the right account.' }
    if (res.status === 429) return { ...base, state: 'error', detail: 'HackerOne rate-limited the check (HTTP 429). The token was not judged; try again later.' }
    return { ...base, state: 'error', detail: `HackerOne answered HTTP ${res.status}.` }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { ...base, state: 'error', detail: 'The check timed out after 20 seconds.' }
    return { ...base, state: 'error', detail: `The check could not reach HackerOne (${err instanceof Error ? err.message : String(err)}).` }
  } finally { clearTimeout(timer) }
}

/** HackerOne: program attributes, structured scopes (paged), scope exclusions. */
export async function importHackerOne(handleInput: string, http: typeof fetch = fetch): Promise<Omit<ProgramImport, 'id' | 'importedAt'>> {
  const handle = String(handleInput ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(handle)) throw new Error('enter a valid HackerOne program handle (letters, digits, hyphens, underscores)')
  const auth = authHeader()

  const programDoc = await getJson(H1_ORIGIN, `/v1/hackers/programs/${encodeURIComponent(handle)}`, auth, http) as H1Doc
  const attrs = attributesOf(programDoc)
  if (!attrs || Object.keys(attrs).length === 0) throw new Error('HackerOne returned no program details for that handle')

  const assets: ScopeAsset[] = []
  const skipped: string[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const doc = await getJson(H1_ORIGIN, `/v1/hackers/programs/${encodeURIComponent(handle)}/structured_scopes?page[number]=${page}&page[size]=${PAGE_SIZE}`, auth, http) as H1Doc
    const entries = Array.isArray(doc.data) ? doc.data : []
    for (const e of entries) {
      const a = (e.attributes ?? {}) as Record<string, unknown>
      const identifier = typeof a.asset_identifier === 'string' ? a.asset_identifier.trim() : ''
      if (!identifier) continue
      const eligibleForSubmission = a.eligible_for_submission === true
      // An asset the program lists but marks not eligible is kept as a DENY rule, not dropped.
      // Dropping it would let a wildcard elsewhere in the same program authorize it.
      if (!eligibleForSubmission) skipped.push(`${identifier} (${String(a.asset_type ?? 'unknown type')}) — not eligible for submission, kept as a deny rule`)
      assets.push({
        identifier,
        assetType: typeof a.asset_type === 'string' ? a.asset_type : 'unknown',
        eligibleForSubmission,
        eligibleForBounty: a.eligible_for_bounty === true,
        maxSeverity: typeof a.max_severity === 'string' ? a.max_severity : null,
        instruction: typeof a.instruction === 'string' && a.instruction.trim() ? a.instruction.trim() : null,
      })
    }
    if (entries.length < PAGE_SIZE) break
    if (page === MAX_PAGES) throw new Error('this program has too many scope entries to import safely')
  }

  let exclusions: ScopeExclusion[] = []
  let exclusionsIncomplete = false
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const ex = await getJson(H1_ORIGIN, `/v1/hackers/programs/${encodeURIComponent(handle)}/scope_exclusions?page[number]=${page}&page[size]=${PAGE_SIZE}`, auth, http) as H1Doc
      const list = Array.isArray(ex.data) ? ex.data : []
      for (const e of list) {
        const a = (e.attributes ?? {}) as Record<string, unknown>
        exclusions.push({ category: String(a.category ?? 'excluded'), details: String(a.details ?? '') })
      }
      if (list.length < PAGE_SIZE) break
      if (page === MAX_PAGES) exclusionsIncomplete = true
    }
  } catch { /* exclusions are an addition; the program import still stands without them */ exclusionsIncomplete = exclusions.length > 0 }

  // Deny wins on a duplicate identifier: if the program lists a host twice with different
  // eligibility, the restrictive reading is the safe one.
  const byIdentifier = new Map<string, ScopeAsset>()
  for (const a of assets) {
    const existing = byIdentifier.get(a.identifier)
    if (!existing || (existing.eligibleForSubmission && !a.eligibleForSubmission)) byIdentifier.set(a.identifier, a)
  }
  const unique = [...byIdentifier.values()]
  const eligibleCount = unique.filter(a => a.eligibleForSubmission).length
  const denyCount = unique.length - eligibleCount
  if (!eligibleCount) throw new Error('no submission-eligible assets came back, so no workspace was created')

  return {
    source: 'hackerone',
    handle,
    name: typeof attrs.name === 'string' ? attrs.name : handle,
    url: `https://hackerone.com/${handle}`,
    policy: typeof attrs.policy === 'string' ? attrs.policy : '',
    submissionState: String(attrs.submission_state ?? attrs.state ?? ''),
    offersBounties: attrs.offers_bounties === true,
    assets: unique,
    exclusions,
    skipped,
    notes: `Imported from the HackerOne Hacker API. Only assets flagged eligible for submission are authorized, and the ${denyCount} asset(s) the program marks not eligible are kept as deny rules that no wildcard can override. This import does not grant permission beyond those assets or beyond the program's own policy.${exclusionsIncomplete ? ' The exclusion list could not be read in full — check the program page before relying on it.' : ''}`,
  }
}

/**
 * Bugcrowd: the documented API is token-authenticated and its reference is versioned.
 * Program scope is read from the program resource and, when the API exposes it, the
 * program's targets. Anything the API does not return as in-scope is simply absent —
 * which in this app means denied.
 */
export async function importBugcrowd(handleInput: string, http: typeof fetch = fetch): Promise<Omit<ProgramImport, 'id' | 'importedAt'>> {
  const handle = String(handleInput ?? '').trim()
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(handle)) throw new Error('enter a Bugcrowd program code (letters, digits, hyphens or underscores)')
  const c = credentials('bugcrowd')
  const headers = {
    Authorization: `Token ${c.token}`,
    Accept: 'application/vnd.bugcrowd+json',
  }
  const doc = await getJson(BC_ORIGIN, `/programs/${encodeURIComponent(handle)}`, headers, http) as { data?: { attributes?: Record<string, unknown> } }
  const attrs = doc?.data?.attributes ?? {}
  if (!Object.keys(attrs).length) throw new Error('Bugcrowd returned no program details for that code')

  const assets: ScopeAsset[] = []
  const skipped: string[] = []
  // The program resource carries its targets as a relationship when the token may read them.
  const targets = (attrs.targets ?? attrs.scope ?? []) as unknown
  const list = Array.isArray(targets) ? targets : []
  for (const raw of list) {
    const t = raw as Record<string, unknown>
    const identifier = String(t.name ?? t.target ?? t.uri ?? '').trim()
    if (!identifier) continue
    const inScope = t.in_scope !== false && String(t.category ?? '').toLowerCase() !== 'out_of_scope'
    if (!inScope) {
      // Kept, not dropped: an out-of-scope target is a deny rule, so no wildcard in the same
      // program can authorize it later.
      skipped.push(`${identifier} — marked out of scope, kept as a deny rule`)
      assets.push({
        identifier,
        assetType: String(t.type ?? t.category ?? 'url'),
        eligibleForSubmission: false,
        eligibleForBounty: false,
        maxSeverity: null,
        instruction: t.description ? String(t.description) : null,
      })
      continue
    }
    assets.push({
      identifier,
      assetType: String(t.type ?? t.category ?? 'url'),
      eligibleForSubmission: true,
      eligibleForBounty: t.bounty !== false,
      maxSeverity: t.max_severity ? String(t.max_severity) : null,
      instruction: t.description ? String(t.description) : null,
    })
  }
  if (!assets.some(a => a.eligibleForSubmission)) {
    throw new Error('Bugcrowd returned no in-scope targets for this program with your token. Goga will not create an unrestricted workspace — check the program on Bugcrowd, or enter the scope by hand in the Security page.')
  }
  return {
    source: 'bugcrowd',
    handle,
    name: String(attrs.name ?? handle),
    url: `https://bugcrowd.com/${encodeURIComponent(handle)}`,
    policy: String(attrs.description ?? attrs.policy ?? ''),
    submissionState: String(attrs.state ?? ''),
    offersBounties: attrs.bounty !== false,
    assets,
    exclusions: [],
    skipped,
    notes: 'Imported from the Bugcrowd API. Only targets the API returned as in scope are authorized; out-of-scope targets were recorded and refused.',
  }
}
