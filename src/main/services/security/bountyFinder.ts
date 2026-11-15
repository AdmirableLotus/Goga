import type { ProgramSource } from '../../../shared/security'
import type { BountyFeed, BountyItem } from '../../../shared/bountyFinder'

export type { BountyFeed, BountyItem }

/**
 * The bounty finder: a read-only feed of open bounties, matched to what this user can actually
 * do, with a difficulty estimate and a "hidden gem" flag.
 *
 * The idea is PD-Hunter's (github.com/FuZoe/PD-Hunter): scan for bounty-labelled work, enrich
 * each item, and show a filterable list. What changed:
 *
 *   - It reads GitHub's PUBLIC search API for issues labelled as bounties. No target is
 *     contacted, no program's own host is touched, and nothing is joined.
 *   - The enrichment is DETERMINISTIC, not a GPT-4o call. PD-Hunter's AI pass is a hard
 *     dependency there; here, if no model is configured the list still works, because the
 *     difficulty estimate is computed from facts the API returns (labels, comments, age,
 *     whether a maintainer has replied). A feed that fails without an API key is a worse feed.
 *   - "Hidden gem" means low competition by a stated rule: few comments, recent, and a label
 *     that names a concrete area. It is a heuristic and the UI says so.
 *
 * There is no cron. The user presses refresh. A 6-hourly background job that quietly calls out
 * to GitHub is exactly the kind of thing this app should not do without being asked.
 */

const GITHUB_SEARCH = 'https://api.github.com/search/issues'
const MAX_ITEMS = 40
const TIMEOUT_MS = 20_000

/** Labels that mean "this is paid work", in the vocabulary repos actually use. */
const BOUNTY_LABELS = ['bounty', 'bounties', 'bug bounty', '💰 bounty', 'reward', 'paid', 'algora', 'opire', 'gitcoin']

/**
 * Read the public bounty feed.
 *
 * Unauthenticated GitHub search is rate-limited to a handful of requests a minute, which is
 * fine for a button the user presses. A token is not required and is not asked for.
 */
export async function fetchBountyFeed(opts: { query?: string; http?: typeof fetch } = {}): Promise<BountyFeed> {
  const http = opts.http ?? fetch
  const query = (opts.query ?? '').trim() || 'label:bounty state:open is:issue'
  const fetchedAt = new Date().toISOString()

  const url = `${GITHUB_SEARCH}?q=${encodeURIComponent(query)}&sort=created&order=desc&per_page=${MAX_ITEMS}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await http(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GogaBugBounty/1.0 (reading a public bounty feed)' },
    })
    if (res.status === 403 || res.status === 429) {
      return { fetchedAt, query, items: [], error: 'GitHub rate-limited the search. It allows a few unauthenticated searches a minute; wait a moment and press refresh again.', note: '', }
    }
    if (!res.ok) return { fetchedAt, query, items: [], error: `GitHub answered HTTP ${res.status}.`, note: '' }
    const doc = await res.json() as { items?: unknown[] }
    const items = (Array.isArray(doc.items) ? doc.items : []).map(toItem).filter((x): x is BountyItem => x !== null)
    return {
      fetchedAt,
      query,
      items,
      note: [
        `Read ${items.length} open issue(s) from GitHub's public search for "${query}".`,
        'This is a feed of work other people have posted, not a list of programs you may test. Each one still has its own rules, and a bounty label is not permission.',
        'Difficulty and "hidden gem" are computed from the issue\'s own facts — labels, comment count, age — not from a model, so they work with no key configured.',
      ].join(' '),
      error: null,
    }
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError' ? 'the search timed out' : err instanceof Error ? err.message : String(err)
    return { fetchedAt, query, items: [], error: `The bounty feed could not be read: ${message}`, note: '' }
  } finally { clearTimeout(timer) }
}

function toItem(raw: unknown): BountyItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title : ''
  const htmlUrl = typeof r.html_url === 'string' ? r.html_url : ''
  if (!title || !htmlUrl) return null
  const repoUrl = typeof r.repository_url === 'string' ? r.repository_url : ''
  const repo = repoUrl.replace(/^https?:\/\/api\.github\.com\/repos\//, '')
  const labels = Array.isArray(r.labels)
    ? (r.labels as Record<string, unknown>[]).map(l => String(l?.name ?? '')).filter(Boolean)
    : []
  const comments = typeof r.comments === 'number' ? r.comments : 0
  const createdAt = typeof r.created_at === 'string' ? r.created_at : ''
  const updatedAt = typeof r.updated_at === 'string' ? r.updated_at : ''
  const ageDays = createdAt ? Math.max(0, Math.round((Date.now() - Date.parse(createdAt)) / 86_400_000)) : 0

  const bountyLabel = labels.some(l => BOUNTY_LABELS.some(b => l.toLowerCase().includes(b)))
  if (!bountyLabel) return null

  const { difficulty, difficultyWhy } = estimate(labels, comments, ageDays, title)
  const hiddenGem = comments <= 3 && ageDays <= 45 && difficulty !== 'hard'

  return {
    id: String(r.id ?? htmlUrl),
    title,
    url: htmlUrl,
    repo,
    labels,
    comments,
    createdAt,
    updatedAt,
    ageDays,
    difficulty,
    difficultyWhy,
    hiddenGem,
    hint: hintFor(labels, title),
    platform: 'github',
  }
}

/**
 * A difficulty estimate from facts, not from a model.
 *
 * The reasoning is deliberately simple and stated, so the user can disagree with it: a labelled
 * area plus few comments plus a recent post is a starter; a security-shaped label with a lot of
 * discussion is hard, because the obvious approach has already been tried in public.
 */
function estimate(labels: string[], comments: number, ageDays: number, title: string): { difficulty: BountyItem['difficulty']; difficultyWhy: string } {
  const text = `${labels.join(' ')} ${title}`.toLowerCase()
  const securityShaped = /security|vulnerab|cve|xss|ssrf|injection|auth|exploit/.test(text)
  const docsOrTests = /docs?|documentation|test|typo|readme|translation/.test(text)

  if (docsOrTests) return { difficulty: 'starter', difficultyWhy: 'The labels or title point at documentation, tests or wording rather than code behaviour.' }
  if (securityShaped && comments >= 8) return { difficulty: 'hard', difficultyWhy: `${comments} comments on a security-shaped issue: the obvious approaches have been discussed in public already.` }
  if (securityShaped) return { difficulty: 'moderate', difficultyWhy: 'Security-shaped work with little public discussion. Read the code before you promise anything.' }
  if (comments <= 3 && ageDays <= 45) return { difficulty: 'starter', difficultyWhy: `Only ${comments} comment(s) and ${ageDays} day(s) old, so nobody has staked a claim in public.` }
  if (comments >= 15) return { difficulty: 'hard', difficultyWhy: `${comments} comments: a crowded issue, and the easy reading of it is taken.` }
  return { difficulty: 'moderate', difficultyWhy: `${comments} comment(s) over ${ageDays} day(s) — ordinary competition.` }
}

function hintFor(labels: string[], title: string): string {
  const text = `${labels.join(' ')} ${title}`.toLowerCase()
  if (/xss|cross.site/.test(text)) return 'Cross-site scripting. Read where the value is written out, and which escaper that context needs.'
  if (/ssrf/.test(text)) return 'Server-side request forgery. Read where a URL is fetched and whether the host is re-validated after resolution.'
  if (/sql|injection/.test(text)) return 'Injection. Read whether the value is bound as a placeholder or placed into the statement.'
  if (/auth|permission|access|idor/.test(text)) return 'Access control. Read the check that decides entitlement to the specific object.'
  if (/docs?|documentation|readme/.test(text)) return 'Documentation. Low risk, low reward, and a real way to learn a codebase.'
  if (/test/.test(text)) return 'Tests. Reading an existing test suite is the fastest way to learn what a project believes about itself.'
  return 'Read the issue and the code it points at before deciding anything.'
}

/** The platforms the finder knows about, and what it can and cannot read from each. */
export const FINDER_SOURCES: { id: ProgramSource | 'github'; name: string; what: string; readOnly: boolean }[] = [
  { id: 'github', name: 'GitHub bounty-labelled issues', what: 'Public search API. Read-only, no token needed, rate-limited.', readOnly: true },
  { id: 'hackerone', name: 'HackerOne programs', what: 'Imported through the Security page with your own token.', readOnly: true },
  { id: 'cantina', name: 'Cantina bounties', what: 'Imported from the public bounty page. Read-only.', readOnly: true },
]
