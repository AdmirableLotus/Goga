import type { JobListing, JobMatch, JobProfile, MatchReason, SavedSearch } from '../../../shared/business'

/**
 * Freelance work: finding it, ranking it, and drafting an application.
 *
 * Sources are the ones that publish a feed or an API for this:
 *   - Remotive        https://remotive.com/api/remote-jobs
 *   - Arbeitnow       https://www.arbeitnow.com/api/job-board-api
 *   - RemoteOK        https://remoteok.com/api
 *   - Hacker News     the Algolia API over "Who is hiring" comments
 *   - We Work Remotely  its public RSS feed
 *
 * The marketplaces that forbid scraping and have no public API — Upwork, Fiverr, Freelancer,
 * Toptal — are NOT read. For those, Goga prepares the search URL and a brief, and the user
 * runs it in their own signed-in browser. That is `savedSearchFor` below.
 *
 * Nothing here submits an application. A draft is text the user reviews and sends.
 */

export interface JobSource {
  id: string
  name: string
  url: string
  /** What the source is, in one line. */
  about: string
  /** True when Goga reads it directly. */
  automated: boolean
}

export const SOURCES: JobSource[] = [
  { id: 'remotive', name: 'Remotive', url: 'https://remotive.com/api/remote-jobs', about: 'Remote job board with a public JSON API.', automated: true },
  { id: 'arbeitnow', name: 'Arbeitnow', url: 'https://www.arbeitnow.com/api/job-board-api', about: 'Public job-board API, mostly Europe, remote-friendly.', automated: true },
  { id: 'remoteok', name: 'RemoteOK', url: 'https://remoteok.com/api', about: 'Public JSON feed of remote roles.', automated: true },
  { id: 'hn', name: 'Hacker News "Who is hiring"', url: 'https://hn.algolia.com/api/v1/search', about: 'The monthly hiring thread, read through Algolia\'s public API.', automated: true },
  { id: 'wwr', name: 'We Work Remotely', url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss', about: 'Public RSS feed of remote roles.', automated: true },
]

/** Marketplaces with no public API that prohibit scraping. Goga prepares, the user runs. */
export const MANUAL_MARKETPLACES: { id: string; name: string; searchUrl: (q: string) => string; note: string }[] = [
  {
    id: 'upwork', name: 'Upwork',
    searchUrl: q => `https://www.upwork.com/nx/search/jobs/?q=${encodeURIComponent(q)}`,
    note: 'Upwork has no public jobs API and its terms prohibit automated access. Goga builds the search and the proposal brief; you open it signed in and send the proposal yourself.',
  },
  {
    id: 'fiverr', name: 'Fiverr',
    searchUrl: q => `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(q)}`,
    note: 'Fiverr is a gig marketplace with no public API. Goga drafts your gig copy; you publish it in Fiverr.',
  },
  {
    id: 'freelancer', name: 'Freelancer.com',
    searchUrl: q => `https://www.freelancer.com/jobs/?q=${encodeURIComponent(q)}`,
    note: 'Freelancer.com has an API for approved partners only. Goga prepares the search; you bid in your own account.',
  },
  {
    id: 'toptal', name: 'Toptal',
    searchUrl: () => 'https://www.toptal.com/talent/apply',
    note: 'Toptal is an invitation-only network with no public job feed. Goga can draft your application to their screening process; the process itself is theirs.',
  },
]

// ── reading the sources ─────────────────────────────────────────────────────

const MAX_BYTES = 2_000_000

async function getText(url: string, http: typeof fetch, accept = 'application/json'): Promise<string> {
  const res = await http(url, {
    headers: { Accept: accept, 'User-Agent': 'Goga/0.1 (local desktop client)' },
    signal: AbortSignal.timeout(25_000),
  })
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`)
  const text = await res.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error(`${new URL(url).hostname} returned an unexpectedly large response`)
  return text
}

function stripHtml(html: string): string {
  return String(html ?? '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function asString(v: unknown): string { return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '' }

export async function readRemotive(http: typeof fetch = fetch): Promise<JobListing[]> {
  const text = await getText('https://remotive.com/api/remote-jobs?limit=60', http)
  const doc = JSON.parse(text) as { jobs?: Record<string, unknown>[] }
  const readAt = new Date().toISOString()
  return (doc.jobs ?? []).map(j => ({
    id: `remotive:${asString(j.id)}`,
    source: 'Remotive',
    title: asString(j.title),
    company: asString(j.company_name),
    url: asString(j.url),
    location: asString(j.candidate_required_location) || 'Remote',
    remote: true,
    tags: Array.isArray(j.tags) ? (j.tags as unknown[]).map(asString).filter(Boolean) : [],
    salary: asString(j.salary),
    postedAt: asString(j.publication_date) || null,
    readAt,
    description: stripHtml(asString(j.description)).slice(0, 6000),
  })).filter(l => l.title && l.url)
}

export async function readArbeitnow(http: typeof fetch = fetch): Promise<JobListing[]> {
  const text = await getText('https://www.arbeitnow.com/api/job-board-api', http)
  const doc = JSON.parse(text) as { data?: Record<string, unknown>[] }
  const readAt = new Date().toISOString()
  return (doc.data ?? []).map(j => ({
    id: `arbeitnow:${asString(j.slug)}`,
    source: 'Arbeitnow',
    title: asString(j.title),
    company: asString(j.company_name),
    url: asString(j.url),
    location: asString(j.location) || 'Not stated',
    remote: j.remote === true,
    tags: Array.isArray(j.tags) ? (j.tags as unknown[]).map(asString).filter(Boolean) : [],
    salary: '',
    postedAt: j.created_at ? new Date(Number(j.created_at) * 1000).toISOString() : null,
    readAt,
    description: stripHtml(asString(j.description)).slice(0, 6000),
  })).filter(l => l.title && l.url)
}

export async function readRemoteOk(http: typeof fetch = fetch): Promise<JobListing[]> {
  const text = await getText('https://remoteok.com/api', http)
  const doc = JSON.parse(text) as Record<string, unknown>[]
  const readAt = new Date().toISOString()
  // The first element of RemoteOK's feed is a legal notice, not a job.
  return doc.slice(1).map(j => ({
    id: `remoteok:${asString(j.id)}`,
    source: 'RemoteOK',
    title: asString(j.position) || asString(j.title),
    company: asString(j.company),
    url: asString(j.url) || (asString(j.slug) ? `https://remoteok.com/remote-jobs/${asString(j.slug)}` : ''),
    location: asString(j.location) || 'Remote',
    remote: true,
    tags: Array.isArray(j.tags) ? (j.tags as unknown[]).map(asString).filter(Boolean) : [],
    salary: j.salary_min ? `$${asString(j.salary_min)}–${asString(j.salary_max)}` : '',
    postedAt: asString(j.date) || null,
    readAt,
    description: stripHtml(asString(j.description)).slice(0, 6000),
  })).filter(l => l.title && l.url)
}

export async function readHackerNews(http: typeof fetch = fetch): Promise<JobListing[]> {
  // The most recent "Ask HN: Who is hiring?" story, then its top-level comments.
  const search = await getText(
    'https://hn.algolia.com/api/v1/search?query=%22Ask%20HN%3A%20Who%20is%20hiring%3F%22&tags=story&hitsPerPage=1',
    http,
  )
  const found = JSON.parse(search) as { hits?: { objectID?: string; title?: string }[] }
  const story = found.hits?.[0]
  if (!story?.objectID) throw new Error('the hiring thread could not be found')
  const thread = await getText(`https://hn.algolia.com/api/v1/items/${encodeURIComponent(story.objectID)}`, http)
  const doc = JSON.parse(thread) as { children?: { id: number; text?: string; created_at?: string; author?: string }[] }
  const readAt = new Date().toISOString()
  return (doc.children ?? []).slice(0, 60).map(c => {
    const text = stripHtml(c.text ?? '')
    const firstLine = text.split('\n')[0] ?? ''
    // The convention in that thread is "Company | Role | Location | ..." on the first line.
    const parts = firstLine.split('|').map(p => p.trim())
    return {
      id: `hn:${c.id}`,
      source: 'Hacker News',
      title: parts[1] || firstLine.slice(0, 120) || 'Hiring post',
      company: parts[0] || c.author || 'Unknown',
      url: `https://news.ycombinator.com/item?id=${c.id}`,
      location: parts[2] || 'See post',
      remote: /remote/i.test(text),
      tags: [],
      salary: '',
      postedAt: c.created_at ?? null,
      readAt,
      description: text.slice(0, 6000),
    }
  }).filter(l => l.title && l.description)
}

export async function readWeWorkRemotely(http: typeof fetch = fetch): Promise<JobListing[]> {
  const xml = await getText('https://weworkremotely.com/categories/remote-programming-jobs.rss', http, 'application/rss+xml')
  const readAt = new Date().toISOString()
  const items = xml.split(/<item>/i).slice(1)
  return items.map((raw, i) => {
    const pick = (tag: string): string => {
      const m = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
      if (!m) return ''
      return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim()
    }
    const title = pick('title')
    const link = pick('link')
    const [company, role] = title.includes(':') ? title.split(':').map(s => s.trim()) : ['', title]
    return {
      id: `wwr:${link || i}`,
      source: 'We Work Remotely',
      title: role || title,
      company: company || 'See post',
      url: link,
      location: 'Remote',
      remote: true,
      tags: [],
      salary: '',
      postedAt: pick('pubDate') ? new Date(pick('pubDate')).toISOString() : null,
      readAt,
      description: stripHtml(pick('description')).slice(0, 6000),
    }
  }).filter(l => l.title && l.url)
}

export interface DiscoveryResult {
  listings: JobListing[]
  /** Per-source outcome, so a failed source is visible rather than silently empty. */
  sources: { id: string; name: string; count: number; error: string | null }[]
}

export async function discoverJobs(
  opts: { sources?: string[]; http?: typeof fetch } = {},
): Promise<DiscoveryResult> {
  const http = opts.http ?? fetch
  const wanted = new Set(opts.sources?.length ? opts.sources : SOURCES.map(s => s.id))
  const readers: Record<string, () => Promise<JobListing[]>> = {
    remotive: () => readRemotive(http),
    arbeitnow: () => readArbeitnow(http),
    remoteok: () => readRemoteOk(http),
    hn: () => readHackerNews(http),
    wwr: () => readWeWorkRemotely(http),
  }
  const listings: JobListing[] = []
  const sources: DiscoveryResult['sources'] = []
  for (const source of SOURCES) {
    if (!wanted.has(source.id)) continue
    try {
      const found = await readers[source.id]()
      listings.push(...found)
      sources.push({ id: source.id, name: source.name, count: found.length, error: null })
    } catch (err) {
      sources.push({ id: source.id, name: source.name, count: 0, error: err instanceof Error ? err.message : String(err) })
    }
  }
  // De-duplicate by URL, keeping the first read.
  const seen = new Set<string>()
  const unique = listings.filter(l => {
    const key = l.url.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { listings: unique, sources }
}

// ── ranking ─────────────────────────────────────────────────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'our', 'are', 'will', 'that', 'this', 'from', 'have', 'has', 'not', 'but', 'all', 'can', 'who', 'job', 'role', 'work', 'team'])

function words(text: string): string[] {
  return String(text ?? '').toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}/g)?.filter(w => !STOP.has(w)) ?? []
}

/**
 * Score one listing against the profile, and say why. The score is a sum of named parts so
 * the UI can show the arithmetic rather than a bare number. Nothing is scored on a fact
 * that is not in the profile or the listing.
 */
export function scoreListing(listing: JobListing, profile: JobProfile): JobMatch {
  const reasons: MatchReason[] = []
  const haystack = `${listing.title} ${listing.description} ${listing.tags.join(' ')}`.toLowerCase()

  // Skills: each skill found in the listing is worth up to 8 points, capped at 40.
  const skills = profile.skills.map(s => s.trim().toLowerCase()).filter(Boolean)
  const hitSkills = skills.filter(s => haystack.includes(s))
  if (skills.length) {
    const points = Math.min(hitSkills.length * 8, 40)
    reasons.push({
      label: 'Skills',
      points,
      detail: hitSkills.length
        ? `${hitSkills.length} of your ${skills.length} skills appear: ${hitSkills.slice(0, 6).join(', ')}`
        : 'none of your listed skills appear in the listing',
    })
  } else {
    reasons.push({ label: 'Skills', points: 0, detail: 'your profile lists no skills yet, so nothing could be matched' })
  }

  // Kinds of work: a title that names one of them is a strong signal.
  const kinds = profile.kinds.map(k => k.trim().toLowerCase()).filter(Boolean)
  const hitKinds = kinds.filter(k => listing.title.toLowerCase().includes(k))
  if (kinds.length) {
    reasons.push({
      label: 'Kind of work',
      points: Math.min(hitKinds.length * 12, 24),
      detail: hitKinds.length ? `the title names ${hitKinds.join(', ')}` : 'the title does not name a kind of work you asked for',
    })
  }

  // Remote: the user's availability line decides whether remote matters.
  const wantsRemote = /remote|anywhere|home/i.test(profile.availability)
  if (wantsRemote) {
    reasons.push({
      label: 'Remote',
      points: listing.remote ? 10 : 0,
      detail: listing.remote ? 'the listing is remote' : 'the listing does not say it is remote',
    })
  }

  // Rate: only when the listing states a number we can read.
  const numbers = (listing.salary.match(/\d[\d,.]*/g) ?? []).map(n => Number(n.replace(/[,]/g, ''))).filter(n => Number.isFinite(n) && n > 0)
  if (profile.rateFloor > 0 && numbers.length) {
    const top = Math.max(...numbers)
    const meets = top >= profile.rateFloor
    reasons.push({
      label: 'Rate',
      points: meets ? 10 : 0,
      detail: meets
        ? `the listing mentions up to ${top}, at or above your floor of ${profile.rateFloor}`
        : `the listing mentions up to ${top}, below your floor of ${profile.rateFloor}`,
    })
  } else if (profile.rateFloor > 0) {
    reasons.push({ label: 'Rate', points: 0, detail: 'the listing states no rate, so it could not be compared with your floor' })
  }

  // Freshness: a listing read today is worth more than one from a month ago.
  if (listing.postedAt) {
    const ageDays = (Date.now() - Date.parse(listing.postedAt)) / 86_400_000
    if (Number.isFinite(ageDays)) {
      const points = ageDays <= 3 ? 8 : ageDays <= 14 ? 4 : 0
      reasons.push({
        label: 'Freshness',
        points,
        detail: `posted ${ageDays < 1 ? 'today' : `${Math.round(ageDays)} day(s) ago`}`,
      })
    }
  }

  const score = reasons.reduce((sum, r) => sum + r.points, 0)
  return { listing, score, reasons }
}

export function rankListings(listings: JobListing[], profile: JobProfile): JobMatch[] {
  return listings.map(l => scoreListing(l, profile)).sort((a, b) => b.score - a.score)
}

// ── saved searches for the marketplaces ─────────────────────────────────────

export function savedSearchFor(platformId: string, query: string, profile: JobProfile): SavedSearch {
  const platform = MANUAL_MARKETPLACES.find(p => p.id === platformId)
  if (!platform) throw new Error('no such marketplace')
  const q = String(query ?? '').trim() || profile.kinds.join(' ') || profile.headline
  if (!q) throw new Error('give a search phrase, or fill in your profile first')
  const brief = [
    `Search: ${q}`,
    profile.headline ? `You: ${profile.headline}` : '',
    profile.skills.length ? `Skills: ${profile.skills.join(', ')}` : '',
    profile.rateFloor > 0 ? `Rate floor: ${profile.currency} ${profile.rateFloor}` : '',
    profile.availability ? `Availability: ${profile.availability}` : '',
    profile.timezone ? `Timezone: ${profile.timezone}` : '',
    '',
    platform.note,
  ].filter(Boolean).join('\n')
  return {
    id: '',
    platform: platform.name,
    query: q,
    url: platform.searchUrl(q),
    brief,
    createdAt: new Date().toISOString(),
  }
}

// ── the application draft ───────────────────────────────────────────────────

/**
 * The prompt for a tailored proposal. It is given the profile and the listing's own text,
 * and told to use nothing else — no invented experience, no invented client name, no
 * invented rate.
 */
export function applicationPrompt(listing: JobListing, profile: JobProfile): string {
  return [
    'Write a short freelance proposal for the job below, in the first person, as the applicant.',
    'Use ONLY the applicant profile and the job text given here. Do not invent experience,',
    'clients, numbers, certifications or availability. If the profile does not say something,',
    'leave it out rather than guessing. Do not promise a rate the profile does not state.',
    'Keep it under 200 words. No headings, no bullet lists, no placeholders like [name].',
    '',
    'APPLICANT PROFILE',
    `Headline: ${profile.headline || '(not given)'}`,
    `Skills: ${profile.skills.join(', ') || '(not given)'}`,
    `Portfolio: ${profile.portfolio.join(', ') || '(not given)'}`,
    `Rate floor: ${profile.rateFloor > 0 ? `${profile.currency} ${profile.rateFloor}` : '(not given)'}`,
    `Availability: ${profile.availability || '(not given)'}`,
    `Timezone: ${profile.timezone || '(not given)'}`,
    `Summary: ${profile.summary || '(not given)'}`,
    '',
    'JOB',
    `Title: ${listing.title}`,
    `Company: ${listing.company}`,
    `Source: ${listing.source}`,
    `Location: ${listing.location}`,
    'Description:',
    listing.description.slice(0, 3000),
  ].join('\n')
}
