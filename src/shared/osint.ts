/**
 * OSINT (open-source intelligence) types.
 *
 * The rule these types encode: every fact carries the source it came from and the moment
 * Goga read it, and "we did not find it" is never written as "it does not exist". A search
 * that was blocked, rate-limited, refused by scope or skipped by robots.txt says so.
 *
 * This is public-source research only. Nothing here logs in anywhere, solves a CAPTCHA,
 * or holds a session.
 */

/** Where the request stood against a bug-bounty program when it ran. */
export type OsintMode = 'program' | 'unattributed'

/** One source that answered, with the time it was read. */
export interface OsintSource {
  /** Human name of the source, e.g. "GitHub profile page" or "RDAP (rdap.org)". */
  source: string
  url: string
  /** ISO timestamp of the read. */
  readAt: string
  /** HTTP status, when the source has one. */
  status: number | null
  /** True when the answer came from the local cache rather than the network. */
  cached: boolean
}

export type OsintOutcome =
  | 'found'          // the source answered and the thing is there
  | 'absent'         // the source answered "no such thing" — a fact about that source only
  | 'blocked'        // 403/429/robots.txt/CAPTCHA wall: we do not know either way
  | 'error'          // the request failed: we do not know either way
  | 'not_checked'    // deliberately skipped (scope, no key, no support)

/** A single line of a result: a value, where it came from, and what we could not settle. */
export interface OsintItem {
  label: string
  value: string
  source: OsintSource | null
  /** Why this line is uncertain, when it is. Never an invented value. */
  note?: string
}

export interface OsintSiteCheck {
  site: string
  url: string
  outcome: OsintOutcome
  status: number | null
  readAt: string | null
  /** Short reason for a blocked/error/not_checked outcome. */
  detail?: string
}

export interface OsintNote {
  kind: 'not-checked' | 'inconclusive' | 'refused' | 'redacted' | 'scope' | 'purpose'
  detail: string
}

export interface OsintRedaction {
  kind: string
  count: number
}

export interface UsernameResult {
  query: string
  mode: OsintMode
  programName: string | null
  purpose: string
  checked: OsintSiteCheck[]
  /** Sites that answered with a live profile. */
  found: OsintSiteCheck[]
  /** Sites that answered "no such user" — a statement about those sites only. */
  absent: OsintSiteCheck[]
  blocked: OsintSiteCheck[]
  notChecked: OsintSiteCheck[]
  notes: OsintNote[]
  redactions: OsintRedaction[]
  startedAt: string
  finishedAt: string
}

export interface EmailResult {
  query: string
  mode: OsintMode
  programName: string | null
  purpose: string
  /** Gravatar's public profile for the address, if one exists. */
  gravatar: {
    outcome: OsintOutcome
    displayName: string | null
    aboutMe: string | null
    /** Accounts the owner linked themselves — the strongest self-published evidence. */
    linkedAccounts: { label: string; url: string; verified: boolean }[]
    urls: string[]
    source: OsintSource | null
    detail?: string
  }
  /** The domain half of the address: mail routing and registration context. */
  domainContext: {
    domain: string
    mx: string[]
    hasMailRoute: boolean | null
    rdapSummary: string[]
    registrar: string | null
    registeredAt: string | null
    expiresAt: string | null
    sources: OsintSource[]
  }
  /** Breach status — only when the user supplied a breach-check API key. */
  breach: {
    checked: boolean
    outcome: OsintOutcome
    breaches: { name: string; domain: string; date: string; dataClasses: string[] }[]
    detail: string
  }
  /** Public pages that mention the address, from a general web search. */
  mentions: { title: string; url: string; snippet: string; readAt: string }[]
  notes: OsintNote[]
  redactions: OsintRedaction[]
  startedAt: string
  finishedAt: string
}

export interface DomainResult {
  query: string
  domain: string
  mode: OsintMode
  programName: string | null
  purpose: string
  registration: {
    outcome: OsintOutcome
    registrar: string | null
    registeredAt: string | null
    expiresAt: string | null
    updatedAt: string | null
    statuses: string[]
    nameservers: string[]
    summary: string[]
    source: OsintSource | null
    detail?: string
  }
  dns: {
    type: string
    values: string[]
    source: OsintSource | null
    note?: string
  }[]
  /** Names that appeared in certificate-transparency logs for this domain. */
  subdomains: {
    names: string[]
    total: number
    source: OsintSource | null
    detail?: string
    note: string
  }
  /** Address and network context for a few of the hosts we saw. */
  hosts: {
    host: string
    addresses: string[]
    network: string | null
    asn: string | null
    source: OsintSource | null
    detail?: string
  }[]
  notes: OsintNote[]
  redactions: OsintRedaction[]
  startedAt: string
  finishedAt: string
}

export interface ProfileResult {
  subject: string
  purpose: string
  mode: OsintMode
  programName: string | null
  /** Profiles the subject published themselves, each with the source and read time. */
  selfPublished: { site: string; url: string; source: OsintSource }[]
  /** Facts gathered about the identity, each with its source. */
  facts: OsintItem[]
  /** What was looked at but could not be settled. */
  notes: OsintNote[]
  redactions: OsintRedaction[]
  startedAt: string
  finishedAt: string
}

export interface OsintAuditEntry {
  id: string
  time: string
  tool: 'osint.username' | 'osint.email' | 'osint.domain' | 'osint.profile'
  /** Exactly what was asked for — the username, address or domain. */
  query: string
  /** The stated legitimate purpose the run was made under. */
  purpose: string
  mode: OsintMode
  programName: string | null
  /** Hosts that were contacted. */
  sources: string[]
  /** Hosts deliberately not contacted, with the reason. */
  skipped: { host: string; reason: string }[]
  /** Outcome counts, so a run can be read back without the full result. */
  summary: string
}

export interface OsintBreachKeyState {
  configured: boolean
  encryptionAvailable: boolean
}

export type OsintKind = 'username' | 'email' | 'domain' | 'profile'

export interface OsintPageState {
  activeProgram: { name: string; source: string; handle: string } | null
  breachKey: OsintBreachKeyState
  sites: { site: string; about: string }[]
  excluded: { site: string; url: string; reason: string }[]
  recent: OsintAuditEntry[]
}
