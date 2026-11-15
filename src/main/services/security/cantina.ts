import type { ProgramImport, ScopeAsset, ScopeExclusion } from '../../../shared/security'

/**
 * Cantina as a scope source, read-only.
 *
 * Two programs matter to this user and they are not comparable:
 *
 *   cantina            the Cantina Bug Bounty Program itself. Two web assets, $5,000 top,
 *                      NO identity verification. This is where a first real finding is reachable.
 *   uniswap            the Uniswap Labs bounty. $15,500,000 top, but a $50 deposit, KYC required
 *                      to join, and over a thousand findings already submitted. The maximum
 *                      reward is the least useful number on that page for a beginner.
 *
 * So this module imports the SCOPE, and records the ENTRY BAR as fact next to it — deposit,
 * KYC, findings already in, asset count, whether the work is code-audit or web. The page shows
 * the bar beside the reward so nobody reads the maximum and mistakes it for an invitation.
 *
 * Reads are GET-only against a fixed host set, follow no redirects, cap the response, and send
 * nothing to the program's own assets. Nothing here joins a program, pays a deposit or submits
 * to KYC — those are the user's own steps on Cantina.
 */

const HOSTS = ['bounties.cantina.xyz', 'cantina.xyz']
const MAX_BYTES = 2_000_000
const TIMEOUT_MS = 20_000

export interface CantinaEntryBar {
  /** True when joining needs identity verification, per the program's own words. */
  kycRequired: boolean | null
  /** The sentence the KYC answer was read from, quoted. */
  kycQuote: string | null
  /** Deposit to join, in USD, when the program states one. */
  depositUsd: number | null
  /** Findings already submitted, when the program states a count. */
  findingsSubmitted: number | null
  /** Live since, when stated. */
  liveSince: string | null
  /** Number of in-scope assets the page lists. */
  assetCount: number | null
  /** What kind of work the scope is. */
  scopeKind: 'web' | 'code-audit' | 'mixed' | 'unknown'
  /** The program's own rule about automated testing, quoted. */
  automatedTestingRule: string | null
  /** Top reward as stated, e.g. "$5,000". */
  topReward: string | null
  /** Per-severity maximum rewards as stated. */
  rewards: { severity: string; amount: string }[]
  /**
   * A plain assessment of how hard this is to enter, derived from the facts above.
   * Labelled as an assessment, never presented as the program's own statement.
   */
  entry: { level: 'open' | 'moderate' | 'crowded' | 'professional'; why: string }
}

export interface CantinaImport {
  handle: string
  name: string
  url: string
  /** The page the scope was read from. */
  sourceUrl: string
  policy: string
  bar: CantinaEntryBar
  assets: ScopeAsset[]
  exclusions: ScopeExclusion[]
  notes: string
}

/* ─────────────────────────── fetching ─────────────────────────── */

async function getText(url: string, http: typeof fetch): Promise<string> {
  const parsed = new URL(url)
  if (!HOSTS.includes(parsed.hostname.toLowerCase())) throw new Error(`${parsed.hostname} is not a Cantina host this importer reads`)
  if (parsed.protocol !== 'https:') throw new Error('only https is read')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await http(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': 'GogaBugBounty/1.0 (reading a public bounty page)' },
    })
    if (res.status >= 300 && res.status < 400) throw new Error('the page redirected, which was stopped rather than followed')
    if (!res.ok) throw new Error(`Cantina answered HTTP ${res.status}`)
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('the page was larger than this importer reads')
    return text
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('the page took too long to answer')
    throw err
  } finally { clearTimeout(timer) }
}

/**
 * Strip a Next.js page down to readable text.
 *
 * The bounty pages stream their content as RSC payloads, so the useful sentences are inside
 * script blocks as escaped strings. Turning tags into newlines and unescaping the common
 * entities gives text the parsers below can read; it is not a general HTML parser and does not
 * pretend to be.
 */
export function pageText(html: string): string {
  let t = String(html ?? '')
  // Drop script and style CONTENT but keep any human sentences inside them, which is where
  // RSC payloads put page text. Extract string literals first, then append.
  const strings: string[] = []
  const lit = /"((?:[^"\\]|\\.){12,400})"/g
  let m: RegExpExecArray | null
  while ((m = lit.exec(t)) !== null) {
    const s = m[1]
    // Keep only literal-looking prose: has spaces or a currency or a URL, no code punctuation storm.
    if (!/\s/.test(s) && !/https?:/.test(s) && !/\$/.test(s)) continue
    if (/[{}<>=;]/.test(s) && !/^[A-Z]/.test(s)) continue
    strings.push(s.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\u0026/g, '&').replace(/\\\\/g, '\\'))
  }
  t = t
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\\u0026/g, '&').replace(/\\n/g, ' ')
  const all = `${t}\n${strings.join('\n')}`
  return all
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
}

/* ─────────────────────────── parsing ─────────────────────────── */

/** The first money amount after a label, allowing the label and value to be on separate lines. */
function amountAfter(text: string, label: RegExp): string | null {
  const window = text.slice(0, 200_000)
  const m = label.exec(window)
  if (!m) return null
  const after = window.slice(m.index + m[0].length, m.index + m[0].length + 120)
  const money = /\$\s?([0-9][0-9,]{2,})/.exec(after)
  if (money) return `$${money[1]}`
  if (/amount not specified|not specified/i.test(after)) return 'amount not specified'
  return null
}

function countAfter(text: string, label: RegExp): number | null {
  const m = label.exec(text)
  if (!m) return null
  const after = text.slice(m.index + m[0].length, m.index + m[0].length + 120)
  const n = /([0-9][0-9,]{0,9})/.exec(after)
  if (!n) return null
  const value = Number(n[1].replace(/,/g, ''))
  return Number.isFinite(value) ? value : null
}

/** The sentence containing a phrase, so a quote in the UI is the source's own words. */
function sentenceWith(text: string, phrase: RegExp): string | null {
  const m = phrase.exec(text)
  if (!m) return null
  const start = Math.max(0, text.lastIndexOf('\n', m.index) + 1)
  const endRaw = text.indexOf('\n', m.index)
  const end = endRaw === -1 ? Math.min(text.length, m.index + 400) : endRaw
  return text.slice(start, end).trim().slice(0, 500)
}

export function parseCantinaBountyPage(html: string, sourceUrl: string): CantinaImport {
  const text = pageText(html)
  const lower = text.toLowerCase()

  const isUniswap = /uniswap/i.test(text) && /f9df94db/i.test(sourceUrl)
  const handle = isUniswap ? 'uniswap' : 'cantina'
  const name = isUniswap ? 'Uniswap Labs / Uniswap bounty' : 'Cantina Bug Bounty Program'

  /* KYC — read the program's own sentence in both directions. */
  const noKyc = sentenceWith(text, /does not require identity verification/i)
  const kycRequiredLine = sentenceWith(text, /kyc\s*\n\s*required|required to join/i)
  const kycRequired = noKyc ? false : kycRequiredLine ? true : null

  const deposit = countAfter(text, /deposit required/i)
  const findings = countAfter(text, /findings submitted/i)
  const liveSince = (() => {
    const m = /start date\s*\n\s*([0-9]{1,2}\s+[A-Za-z]{3}\s+[0-9]{4})/i.exec(text)
    return m ? m[1] : null
  })()

  const topReward = amountAfter(text, /top reward|maximum reward/i)
  const rewards: { severity: string; amount: string }[] = []
  for (const sev of ['Critical', 'High', 'Medium', 'Low']) {
    const m = new RegExp(`${sev}\\s*\\n?\\s*(\\$\\s?[0-9][0-9,]{2,}|up to \\$\\s?[0-9][0-9,]{2,}|amount not specified)`, 'i').exec(text)
    if (m) rewards.push({ severity: sev, amount: m[1].replace(/up to /i, '').replace(/\s+/g, '') })
  }

  /* Scope assets — only real URLs from the program's own hosts, deduplicated. */
  const assetUrls = new Set<string>()
  const urlRe = /(https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/[A-Za-z0-9._~%\/-]*)?)/gi
  let u: RegExpExecArray | null
  while ((u = urlRe.exec(text)) !== null) {
    const raw = u[1].replace(/[.,;)'"]+$/, '')
    const host = (() => { try { return new URL(raw).hostname.toLowerCase() } catch { return '' } })()
    if (!host) continue
    // The bounties/cantina site chrome is not scope; the program's own assets are.
    if (host === 'bounties.cantina.xyz') continue
    if (isUniswap) {
      if (['uniswap.org', 'app.uniswap.org', 'github.com', 'x.com'].includes(host)) assetUrls.add(`https://${host}`)
    } else {
      if (host === 'cantina.xyz' || host === 'www.cantina.xyz' || host === 'cantina.security' || host === 'www.cantina.security') {
        assetUrls.add(`https://${host.replace(/^www\./, '')}`)
      }
    }
  }

  const assets: ScopeAsset[] = [...assetUrls].map(identifier => {
    // Cantina's own program says "and its subdomains are eligible"; the Uniswap page lists
    // repositories and the app as separate surfaces. Both are recorded as URL assets with the
    // program's own instruction attached, so the scope checker compares hosts, not intent.
    const instruction = (() => {
      try {
        const host = new URL(identifier).hostname
        const line = sentenceWith(text, new RegExp(host.replace(/\./g, '\\.') + '[^\\n]{0,120}eligible', 'i'))
        return line ? line.slice(0, 300) : null
      } catch { return null }
    })()
    return {
      identifier,
      assetType: 'URL',
      eligibleForSubmission: true,
      eligibleForBounty: true,
      maxSeverity: 'critical',
      instruction,
    }
  })

  /* Exclusions — read the out-of-scope list as sentences. */
  const exclusions: ScopeExclusion[] = []
  const outBlock = /out of scope/i.exec(text)
  if (outBlock) {
    const tail = text.slice(outBlock.index, outBlock.index + 3000)
    for (const line of tail.split('\n')) {
      const clean = line.replace(/^\s*(?:[-•*]|\d+\.)\s*/, '').trim()
      if (clean.length < 15 || clean.length > 300) continue
      if (/^(out of scope|severity|testing|disclosure|submission|critical|high|medium|low)/i.test(clean)) continue
      if (!/[a-z]{3}/i.test(clean)) continue
      if (exclusions.some(e => e.details === clean)) continue
      exclusions.push({ category: classifyExclusion(clean), details: clean })
      if (exclusions.length >= 12) break
    }
  }

  /* The automated-testing rule, quoted, because it is the on-screen reason nothing here fires. */
  const automatedTestingRule = sentenceWith(text, /automated scans?|multiple requests|excessive traffic/i)
    ?? sentenceWith(text, /disrupt our services/i)

  const scopeKind: CantinaEntryBar['scopeKind'] = isUniswap ? 'mixed' : assets.length ? 'web' : 'unknown'

  const bar: CantinaEntryBar = {
    kycRequired,
    kycQuote: noKyc ?? kycRequiredLine,
    depositUsd: deposit,
    findingsSubmitted: findings,
    liveSince,
    assetCount: assets.length || countAfter(text, /in-scope assets/i),
    scopeKind,
    automatedTestingRule,
    topReward,
    rewards,
    entry: entryAssessment({ kycRequired, depositUsd: deposit, findingsSubmitted: findings, scopeKind, assetCount: assets.length }),
  }

  const policyLines = [
    noKyc ? `"${noKyc}"` : kycRequiredLine ? `"${kycRequiredLine}"` : null,
    automatedTestingRule ? `"${automatedTestingRule}"` : null,
  ].filter(Boolean) as string[]

  const notes = [
    `Read from ${sourceUrl} on ${new Date().toISOString().slice(0, 10)}.`,
    entryBarLine(bar),
    policyLines.length ? `The program's own words: ${policyLines.join(' ')}` : 'The page did not state an entry bar this importer could read; nothing is assumed about it.',
    'Importing a program reads its published page. It does not join the program, pay a deposit, complete KYC, or grant permission to test anything.',
  ].join(' ')

  return {
    handle,
    name,
    url: sourceUrl,
    sourceUrl,
    policy: policyLines.join('\n\n'),
    bar,
    assets,
    exclusions,
    notes,
  }
}

function classifyExclusion(detail: string): string {
  const d = detail.toLowerCase()
  if (/physical/.test(d)) return 'Physical'
  if (/social engineering|phishing/.test(d)) return 'Social engineering'
  if (/third.party|not owned/.test(d)) return 'Third-party systems'
  if (/0-day|zero.day|recently disclosed/.test(d)) return 'Recent 0-days'
  if (/gas|theoretical|mev|ui\/ux|phishing/.test(d)) return 'Not a security issue'
  return 'Out of scope'
}

/**
 * How hard is this to enter, from the facts only.
 *
 * This is an assessment and it says so. It is not the program's opinion of itself. Its worth is
 * that it puts the deposit, the KYC requirement and the existing finding count next to the
 * reward, so a beginner reading a headline number also reads what stands in front of it.
 */
function entryAssessment(f: {
  kycRequired: boolean | null
  depositUsd: number | null
  findingsSubmitted: number | null
  scopeKind: CantinaEntryBar['scopeKind']
  assetCount: number
}): CantinaEntryBar['entry'] {
  const reasons: string[] = []
  let level: CantinaEntryBar['entry']['level'] = 'open'

  if (f.scopeKind === 'code-audit' || f.scopeKind === 'mixed') {
    level = 'professional'
    reasons.push('the scope includes smart contracts, which professionals audit for a living')
  }
  if (f.kycRequired === true) {
    level = level === 'professional' ? 'professional' : 'moderate'
    reasons.push('joining needs identity verification')
  }
  if (f.depositUsd && f.depositUsd > 0) {
    level = level === 'professional' ? 'professional' : 'moderate'
    reasons.push(`joining costs a $${f.depositUsd} deposit, which is money at risk before any finding`)
  }
  if (f.findingsSubmitted !== null && f.findingsSubmitted >= 500) {
    level = level === 'professional' ? 'professional' : 'crowded'
    reasons.push(`${f.findingsSubmitted.toLocaleString()} findings are already submitted, so the obvious ones are long gone`)
  }

  if (!reasons.length) {
    return {
      level: 'open',
      why: 'No identity check, no deposit and no large existing finding count were stated on the page, and the scope is web rather than smart contracts. That does not make it easy — it makes it enterable.',
    }
  }
  return { level, why: `Harder to enter than it looks: ${reasons.join('; ')}.` }
}

/** One line for the program card, so the bar is never separated from the reward. */
export function entryBarLine(bar: CantinaEntryBar): string {
  const parts: string[] = []
  parts.push(bar.topReward ? `top reward ${bar.topReward}` : 'top reward not stated')
  parts.push(bar.kycRequired === false ? 'no identity verification' : bar.kycRequired === true ? 'KYC required to join' : 'KYC not stated')
  parts.push(bar.depositUsd ? `$${bar.depositUsd} deposit to join` : 'no deposit stated')
  if (bar.findingsSubmitted !== null) parts.push(`${bar.findingsSubmitted.toLocaleString()} findings already submitted`)
  if (bar.assetCount) parts.push(`${bar.assetCount} in-scope asset(s)`)
  parts.push(bar.scopeKind === 'web' ? 'web assets' : bar.scopeKind === 'code-audit' ? 'code audit' : bar.scopeKind === 'mixed' ? 'contracts, web and repositories' : 'scope kind not stated')
  return parts.join(' · ')
}

/* ─────────────────────────── entry point ─────────────────────────── */

/**
 * Read one Cantina bounty page and return the importable program.
 *
 * Accepts either form the user is likely to paste:
 *   https://bounties.cantina.xyz/cantina/bug-bounty
 *   https://cantina.xyz/bounties/f9df94db-c7b1-434b-bb06-d1360abdd1be
 */
export async function importCantina(targetInput: string, http: typeof fetch = fetch): Promise<Omit<ProgramImport, 'id' | 'importedAt'> & { bar: CantinaEntryBar }> {
  const raw = String(targetInput ?? '').trim()
  if (!raw) throw new Error('give a Cantina bounty URL')
  let url: URL
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`) } catch { throw new Error(`"${raw}" is not a URL`) }
  if (!HOSTS.includes(url.hostname.toLowerCase())) {
    throw new Error(`this importer reads cantina.xyz and bounties.cantina.xyz only — "${url.hostname}" is not a Cantina host`)
  }
  // Normalise the two known shapes; refuse anything that is not a bounty page.
  if (url.hostname === 'bounties.cantina.xyz' && !/^\/[a-z0-9]+\/[a-z0-9-]+$/i.test(url.pathname)) {
    throw new Error('that bounties.cantina.xyz address is not a bounty page (expected /<org>/<program>)')
  }
  if (url.hostname === 'cantina.xyz' && !/^\/bounties\/[a-z0-9-]{8,}$/i.test(url.pathname)) {
    throw new Error('that cantina.xyz address is not a bounty page (expected /bounties/<id>)')
  }

  const html = await getText(url.toString(), http)
  const parsed = parseCantinaBountyPage(html, url.toString())

  if (!parsed.assets.length) {
    throw new Error('no in-scope asset could be read from that page. Nothing was imported rather than importing a program with an empty scope, which would refuse every target.')
  }

  return {
    source: 'cantina',
    handle: parsed.handle,
    name: parsed.name,
    url: parsed.url,
    policy: parsed.policy,
    submissionState: 'open',
    offersBounties: true,
    assets: parsed.assets,
    exclusions: parsed.exclusions,
    skipped: [],
    notes: parsed.notes,
    bar: parsed.bar,
  }
}
