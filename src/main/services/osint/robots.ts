/**
 * A small, honest robots.txt reader.
 *
 * It implements the part that matters for this feature: pick the group whose User-agent
 * matches us most specifically (a group naming us, else the `*` group), then test the path
 * against its Disallow/Allow lines, longest match winning, `*` and `$` wildcards included.
 *
 * Two deliberate choices:
 *   - anything we cannot read (404) means "not disallowed", which is what the standard says;
 *   - a robots.txt we could not fetch at all (network error, 5xx) returns `unknown`, and the
 *     caller treats that as a refusal to read pages on that host rather than assuming a yes.
 */

export interface RobotsRules {
  /** 'allowed' | 'disallowed' | 'unknown' */
  verdict: 'allowed' | 'disallowed' | 'unknown'
  /** The rule that decided it, or the reason we could not tell. */
  reason: string
}

export const OSINT_USER_AGENT = 'GogaOSINT/1.0 (public-source research; contact: local user)'

interface Group { agents: string[]; rules: { allow: boolean; path: string }[] }

function parseGroups(text: string): Group[] {
  const groups: Group[] = []
  let current: Group | null = null
  let expectingAgents = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const field = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (field === 'user-agent') {
      if (!current || !expectingAgents) { current = { agents: [], rules: [] }; groups.push(current); expectingAgents = true }
      current.agents.push(value.toLowerCase())
    } else if (field === 'disallow' || field === 'allow') {
      if (!current) { current = { agents: ['*'], rules: [] }; groups.push(current) }
      expectingAgents = false
      current.rules.push({ allow: field === 'allow', path: value })
    } else {
      expectingAgents = false
    }
  }
  return groups
}

function groupMatches(group: Group, token: string): boolean {
  return group.agents.some(a => a === '*' || (a.length > 1 && token.includes(a.replace(/\*/g, ''))))
}

function pathToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`)
}

/** Decide one path against robots.txt text. Pure, so it can be tested. */
export function decideRobots(text: string, pathAndQuery: string, token = 'gogaosint'): RobotsRules {
  const groups = parseGroups(text)
  const named = groups.filter(g => groupMatches(g, token) && !g.agents.includes('*'))
  const wildcard = groups.filter(g => g.agents.includes('*'))
  const chosen = named.length ? named : wildcard
  if (!chosen.length) return { verdict: 'allowed', reason: 'robots.txt has no rule for this agent' }

  const path = pathAndQuery || '/'
  let best: { allow: boolean; path: string; length: number } | null = null
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!r.path) continue // "Disallow:" with an empty path allows everything
      if (!pathToRegex(r.path).test(path)) continue
      const length = r.path.replace(/[*$]/g, '').length
      // Longest match wins; on an equal-length tie, Allow wins (the more specific permission).
      if (!best || length > best.length || (length === best.length && r.allow && !best.allow)) {
        best = { allow: r.allow, path: r.path, length }
      }
    }
  }
  if (!best) return { verdict: 'allowed', reason: 'no rule matched this path' }
  return best.allow
    ? { verdict: 'allowed', reason: `robots.txt allows it (${best.path})` }
    : { verdict: 'disallowed', reason: `robots.txt disallows ${path} (${best.path})` }
}
