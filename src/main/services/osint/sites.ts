/**
 * The curated list reverse-username checks against.
 *
 * Every entry here was picked because its *answer is unambiguous*: a 200 with the profile,
 * or a 404 for no such account. Sites that answer 200 for everyone (PyPI user pages,
 * Twitch, Bitbucket's HTML) or 403 to automated reads (Reddit, Medium) are NOT in the list
 * and NOT silently treated as "not found" — `EXCLUDED` records them with the reason, so the
 * UI can say what was not checked and why.
 *
 * `verdict` turns one response into an outcome:
 *   'status'     200/2xx => found, 404 => absent, 403/429/401 => blocked, else inconclusive
 *   'json-array' parse JSON; a non-empty array => found, empty => absent
 *   'json-null'  JSON; `null` => absent, an object => found
 *   'json-total' JSON with a `total` count; >0 => found, 0 => absent
 */

export type SiteVerdict = 'status' | 'json-array' | 'json-null' | 'json-total'

export interface SiteDefinition {
  /** Name shown in the UI. */
  site: string
  /** Build the URL to check for a username. */
  url: (username: string) => string
  verdict: SiteVerdict
  /** Where a person would see the profile, when that differs from the checked URL. */
  profileUrl?: (username: string) => string
  /** True when the checked endpoint is an API documented for machine use (robots not applied). */
  api?: boolean
  /** What this source can tell you, and what it cannot. */
  about: string
}

export const SITES: SiteDefinition[] = [
  {
    site: 'GitHub',
    url: u => `https://github.com/${encodeURIComponent(u)}`,
    verdict: 'status',
    about: 'Source code, commit history, sometimes a real name and email in commit metadata.',
  },
  {
    site: 'GitHub Gist',
    url: u => `https://gist.github.com/${encodeURIComponent(u)}`,
    verdict: 'status',
    about: 'Pasted snippets. Often where configuration or keys are accidentally published.',
  },
  {
    site: 'GitLab',
    url: u => `https://gitlab.com/api/v4/users?username=${encodeURIComponent(u)}`,
    verdict: 'json-array', api: true,
    profileUrl: u => `https://gitlab.com/${encodeURIComponent(u)}`,
    about: 'Account name and display name from GitLab\'s public user API.',
  },
  {
    site: 'Codeberg',
    url: u => `https://codeberg.org/${encodeURIComponent(u)}`,
    verdict: 'status',
    about: 'A Gitea instance: repositories and public activity.',
  },
  {
    site: 'Hugging Face',
    url: u => `https://huggingface.co/${encodeURIComponent(u)}`,
    verdict: 'status',
    about: 'Models, datasets and Spaces published under that name.',
  },
  {
    site: 'Kaggle',
    url: u => `https://www.kaggle.com/${encodeURIComponent(u)}`,
    verdict: 'status',
    about: 'Data-science notebooks and competitions.',
  },
  {
    site: 'Docker Hub',
    url: u => `https://hub.docker.com/v2/users/${encodeURIComponent(u)}/`,
    verdict: 'status', api: true,
    profileUrl: u => `https://hub.docker.com/u/${encodeURIComponent(u)}`,
    about: 'Published container images.',
  },
  {
    site: 'npm',
    url: u => `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`maintainer:${u}`)}&size=1`,
    verdict: 'json-total', api: true,
    profileUrl: u => `https://www.npmjs.com/~${encodeURIComponent(u)}`,
    about: 'Packages published under that npm account.',
  },
  {
    site: 'Hacker News',
    url: u => `https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(u)}.json`,
    verdict: 'json-null', api: true,
    profileUrl: u => `https://news.ycombinator.com/user?id=${encodeURIComponent(u)}`,
    about: 'Account age, karma and the public "about" text people often fill with contact details.',
  },
  {
    site: 'Keybase',
    url: u => `https://keybase.io/${encodeURIComponent(u)}`,
    verdict: 'status',
    about: 'Cryptographic proofs that link this name to other accounts — the strongest self-published link available.',
  },
  {
    site: 'DEV Community',
    url: u => `https://dev.to/${encodeURIComponent(u)}`,
    verdict: 'status',
    about: 'Blog posts and a short biography.',
  },
  {
    site: 'SoundCloud',
    url: u => `https://soundcloud.com/${encodeURIComponent(u)}`,
    verdict: 'status',
    about: 'Audio uploads; a display name and sometimes a city.',
  },
]

/** Sites deliberately not queried, and why. Shown in the UI as "could not be checked". */
export const EXCLUDED: { site: string; url: string; reason: string }[] = [
  { site: 'Reddit', url: 'https://www.reddit.com/user/{u}', reason: 'answers 403 to automated reads; skipped rather than reported as "not found"' },
  { site: 'Medium', url: 'https://medium.com/@{u}', reason: 'answers 403 to automated reads' },
  { site: 'Twitch', url: 'https://www.twitch.tv/{u}', reason: 'answers 200 for names that do not exist, so a hit would be meaningless' },
  { site: 'PyPI', url: 'https://pypi.org/user/{u}/', reason: 'answers 200 for names that do not exist' },
  { site: 'Bitbucket', url: 'https://bitbucket.org/{u}', reason: 'redirects every name to a login wall; cannot be read without signing in' },
  { site: 'Stack Overflow', url: 'https://stackoverflow.com/users/filter?search={u}', reason: 'no per-name URL that answers found/not-found without a search session' },
  { site: 'Mastodon (mastodon.social)', url: 'https://mastodon.social/@{u}', reason: 'answers 410/404 inconsistently and the fediverse is spread across thousands of servers' },
  { site: 'LinkedIn', url: 'https://www.linkedin.com/in/{u}', reason: 'requires a signed-in session; Goga does not sign in anywhere for OSINT' },
]

/** A username we will accept: no path separators, no spaces, bounded. */
export function validUsername(input: string): string | null {
  const u = String(input ?? '').trim().replace(/^@/, '')
  if (!u) return null
  if (u.length > 64) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(u)) return null
  return u
}

export function validDomain(input: string): string | null {
  const d = String(input ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '')
  if (d.length < 3 || d.length > 253) return null
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null
  return d
}

export function validEmail(input: string): string | null {
  const e = String(input ?? '').trim().toLowerCase()
  if (e.length < 6 || e.length > 254) return null
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e)) return null
  return e
}
