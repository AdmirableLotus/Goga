/**
 * Deterministic chat routes for the work that used to need a page.
 *
 * The agent loop is good at open-ended work and bad at "answer this one question from the
 * record". A scope question, a local file review, a venue read and a market backtest all have
 * exactly one right tool and no planning to do, so they are parsed here and dispatched
 * directly. That is what makes chat the route that acts rather than the route that describes.
 *
 * Everything in this file is pure: text in, a tool call or null out. No Electron, no network,
 * no filesystem. The orchestrator does the dispatch; the tests do the parsing.
 */

export interface RouteCall {
  tool: string
  params: Record<string, unknown>
  /** What the user asked for, in their words, for the reply's first line. */
  intent: string
}

const DOMAIN = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|io|ai|dev|app|co|edu|gov|tv|me|us|uk|xyz|sh|so|gg|to|info|biz|cloud|site|tech|online|store|page|link|live|pro|one|run|world|zone|space|website|host|press|digital|agency|solutions|systems|network|tools|services|company|group|team|studio|design|works|media|labs|software|security|systems))\b/i

/**
 * "is status.coinbase.com in scope for coinbase" / "check api.example.com against the scope"
 * / "is that in scope?" (with a target named earlier — the caller supplies it).
 *
 * Returns the target and, when the sentence names one, the program to check it against.
 */
export function parseScopeQuestion(text: string, fallbackTarget?: string): { target: string; program: string | null } | null {
  const t = String(text ?? '').trim()
  if (!t || t.length > 400) return null

  // The question has to be about scope. "in scope", "out of scope", "covered by the program",
  // "allowed to test" — the words a person actually uses.
  const asksScope = /\b(in|out of|within|outside)\s+(the\s+)?scope\b|\bscope\s+(check|for|cover)|\b(is|are|was)\b[^?]{0,60}\b(in scope|covered|allowed to test|fair game|ok to test|okay to test)\b|\bcheck\b[^?]{0,40}\bagainst\b[^?]{0,20}\bscope\b|\bcan i test\b|\bam i allowed to test\b/i.test(t)
  if (!asksScope) return null

  // A URL wins over a bare host.
  const url = t.match(/https?:\/\/[^\s"'<>),]+/i)
  const host = url ? safeHost(url[0]) : (t.match(DOMAIN)?.[1] ?? null)
  const target = host ?? fallbackTarget ?? null
  if (!target) return null

  // "for coinbase", "against the coinbase program", "on hackerone's coinbase program".
  // The last such phrase wins, so "is status.coinbase.com in scope for coinbase" reads
  // "coinbase" as the program even though the host happens to contain the same word.
  const phrases = [...t.matchAll(/\b(?:for|against|under)\s+(?:the\s+)?([a-z0-9][a-z0-9-]{1,40})\b(?:'s)?\s*(?:program|bounty|scope)?/gi)]
  const candidate = phrases.length ? phrases[phrases.length - 1][1] : null
  // A word that is a filler, a hostname or the whole target is not a program name.
  const notProgram = /^(scope|program|bounty|it|that|this|them|me|us|my|the|a|an|yes|no|testing|now)$/i
  const named = candidate
    && !notProgram.test(candidate)
    && !/\./.test(candidate)
    && candidate.toLowerCase() !== target.toLowerCase()
    ? candidate.toLowerCase()
    : null

  return { target, program: named }
}

function safeHost(url: string): string | null {
  try { return new URL(url).hostname } catch { return null }
}

/**
 * "review wp-includes/class-wp-http.php in the local WordPress copy"
 * / "review C:\src\wordpress\wp-includes\class-wp-http.php"
 * / "look at wp-login.php in my local copy".
 *
 * The root is either given in the sentence or supplied by the caller from the remembered
 * local copy. A relative path with no root anywhere is not a route — the reply asks for the
 * folder rather than guessing one.
 */
/**
 * True when the message asks for a local code review and names a source file, whether or not
 * a folder is known. Used to answer "which folder?" instead of falling through to the planner.
 */
export function looksLikeLocalReview(text: string): boolean {
  const t = String(text ?? '').trim()
  if (!t || t.length > 600) return false
  if (!/\b(review|audit|look at|check|read|go over|examine|inspect|scan)\b/i.test(t)) return false
  return /[A-Za-z0-9_.\-\\/:]+\.(?:php|js|mjs|cjs|ts|tsx|jsx|py|rb|go|java|cs|c|h|cpp|hpp|rs|kt|swift|sql|sh|ps1|yml|yaml|json|xml|html|vue|svelte)\b/i.test(t)
}

export function parseLocalReview(text: string, rememberedRoot?: string | null): { root: string; path: string } | null {
  const t = String(text ?? '').trim()
  if (!t || t.length > 600) return null
  if (!/\b(review|audit|look at|check|read|go over|examine|inspect|scan)\b/i.test(t)) return null
  // A file has to be named, with an extension that is source code.
  const file = t.match(/([A-Za-z0-9_.\-\\/:]+\.(?:php|js|mjs|cjs|ts|tsx|jsx|py|rb|go|java|cs|c|h|cpp|hpp|rs|kt|swift|sql|sh|ps1|yml|yaml|json|xml|html|vue|svelte))\b/i)
  if (!file) return null
  const named = file[1].replace(/^[\\/]+/, '')

  // A full Windows or POSIX path in the sentence: split it into root and relative path.
  const absolute = named.match(/^([A-Za-z]:[\\/].*[\\/])([^\\/]+)$/) ?? named.match(/^(\/.*\/)([^/]+)$/)
  if (absolute) return { root: absolute[1].replace(/[\\/]+$/, ''), path: absolute[2] }

  // A relative path: the root has to come from somewhere real.
  if (!rememberedRoot) return null
  return { root: rememberedRoot, path: named.replace(/\\/g, '/') }
}

/**
 * "how is my pivex account doing" / "read my alpaca paper account" / "what are my practice
 * stats" / "show my practice trades" / "stop trading on pivex".
 *
 * The Practice page was entirely button-only: nothing in the tool registry could read a venue.
 */
export function parseVenueCommand(text: string): RouteCall | null {
  const t = String(text ?? '').trim()
  if (!t || t.length > 300) return null
  const lower = t.toLowerCase()
  const venue = /\bpivex\b/.test(lower) ? 'pivex'
    : /\b(alpaca|paper)\b/.test(lower) ? 'alpaca-paper'
    : null
  if (!venue) return null

  if (/\b(halt|stop trading|kill|pause)\b/.test(lower)) {
    return { tool: 'venue.halt', params: { venue, halted: true, reason: t.slice(0, 200) }, intent: `Halt ${venue}` }
  }
  if (/\b(resume|unhalt|clear the halt|start trading again)\b/.test(lower)) {
    return { tool: 'venue.halt', params: { venue, halted: false, reason: t.slice(0, 200) }, intent: `Clear the halt on ${venue}` }
  }
  if (/\b(stats|statistics|win rate|expectancy|how am i doing|performance|results)\b/.test(lower)) {
    return { tool: 'venue.stats', params: { venue }, intent: `Practice statistics for ${venue}` }
  }
  if (/\b(trades|journal|history|closed)\b/.test(lower)) {
    return { tool: 'venue.trades', params: { venue }, intent: `Practice trades on ${venue}` }
  }
  if (/\b(study|learn|curriculum|what should i practise|what to practise)\b/.test(lower)) {
    return { tool: 'venue.studyBase', params: {}, intent: 'The practice study base' }
  }
  if (/\b(account|balance|equity|positions?|holdings?|how is|how's|doing|read|show|check)\b/.test(lower)) {
    return { tool: 'venue.read', params: { venue }, intent: `Read the ${venue} account` }
  }
  return null
}

/**
 * "backtest my watchlist" / "what's in my markets data" / "import this CSV for AAPL".
 * The Markets page had no tool at all; only a `/markets` slash command reached its report.
 */
export function parseMarketsCommand(text: string): RouteCall | null {
  const t = String(text ?? '').trim()
  if (!t || t.length > 400) return null
  const lower = t.toLowerCase()
  if (!/\b(markets?|watchlist|dataset|historical data|csv)\b/.test(lower)) return null
  // "how do markets work" is a question about markets, not a request to read local data.
  if (/^\s*(how|what|why|when|where|who|which|does|do|is|are|can|could|should|would|explain|tell me)\b/i.test(t)
    && !/\b(my|i|mine|have|imported|backtest|run|show|read|check)\b/i.test(lower)) return null
  if (/\b(backtest|run the backtest|test the strategy)\b/.test(lower)) {
    return { tool: 'markets.backtest', params: {}, intent: 'Run the markets backtest' }
  }
  if (/\b(import|add|load)\b/.test(lower) && /\bcsv\b/.test(lower)) {
    return { tool: 'markets.import', params: {}, intent: 'Import market data' }
  }
  return { tool: 'markets.state', params: {}, intent: 'The markets data on this machine' }
}

/**
 * "draft an email to sam@example.com about the invoice" / "write a bluesky post about the
 * release" / "prepare a shopify listing for the print".
 *
 * The Business page could prepare these; chat could only read. Preparing sends nothing — the
 * user still approves the exact action on the page — so this is safe to reach from chat.
 */
export function parseBusinessPrepare(text: string): RouteCall | null {
  const t = String(text ?? '').trim()
  if (!t || t.length > 2000) return null
  const lower = t.toLowerCase()

  const mail = t.match(/\b(?:draft|prepare|write|compose)\s+(?:an?\s+)?(?:e-?mail|mail|message)\s+to\s+([^\s,;]+@[^\s,;]+)/i)
  if (mail) {
    const subject = t.match(/\b(?:about|re:|regarding|subject:?)\s+(.{3,120}?)(?:\.|$)/i)?.[1]?.trim() ?? ''
    return {
      tool: 'business.prepareMail',
      params: { to: mail[1], subject, body: t },
      intent: `Draft an email to ${mail[1]}`,
    }
  }

  const post = /\b(?:draft|prepare|write|compose)\s+(?:a\s+)?(bluesky|mastodon)\s+post\b/i.exec(t)
  if (post) {
    return {
      tool: 'business.preparePost',
      params: { platform: post[1].toLowerCase(), text: t, about: t },
      intent: `Draft a ${post[1]} post`,
    }
  }

  if (/\b(?:draft|prepare|create)\s+(?:a\s+)?(?:shopify|printful|storefront)?\s*listing\b/i.test(t)) {
    return { tool: 'business.prepareListing', params: { fromText: t }, intent: 'Draft a storefront listing' }
  }
  return null
}

/**
 * "check my apps" / "is my site up" — the monitoring half of the Business page, which was
 * button-only. `business.monitor` reads the last checks; this runs a fresh one.
 */
export function parseMonitorCommand(text: string): RouteCall | null {
  const t = String(text ?? '').trim()
  if (!t || t.length > 200) return null
  if (!/\b(check|probe|ping|is)\b/i.test(t)) return null
  if (!/\b(apps?|sites?|uptime|monitor\w*|is (it|my site|my app) (up|down|live))\b/i.test(t)) return null
  return { tool: 'business.checkApps', params: {}, intent: 'Check the monitored apps' }
}

/**
 * "install that improvement" / "discard the change" after a self-improvement run.
 * `evolution.start` existed; installing what it produced did not.
 */
export function parseEvolutionDecision(text: string): RouteCall | null {
  const t = String(text ?? '').trim()
  if (!t || t.length > 120) return null
  if (/^\s*(install|apply|keep|accept)\s+(it|that|the (change|improvement|patch|run))\s*[.!]?\s*$/i.test(t)) {
    return { tool: 'evolution.install', params: {}, intent: 'Install the self-improvement run' }
  }
  if (/^\s*(discard|reject|throw away|drop|revert)\s+(it|that|the (change|improvement|patch|run))\s*[.!]?\s*$/i.test(t)) {
    return { tool: 'evolution.discard', params: {}, intent: 'Discard the self-improvement run' }
  }
  return null
}

/**
 * "work on your own code: the browser retries a failing page" — the Developer page's job,
 * which had no tool. `developer.start` runs Codex against Goga's own source.
 */
export function parseDeveloperCommand(text: string): RouteCall | null {
  const t = String(text ?? '').trim()
  if (!t || t.length > 2000) return null
  const m = t.match(/^\s*(?:developer mode[:,]?\s*|work on your own code[:,]?\s*|improve your own code[:,]?\s*)(.{10,})$/i)
  if (!m) return null
  const mode = /\b(implement|build|fix it|make the change|write the fix)\b/i.test(m[1]) ? 'build' : 'plan'
  return { tool: 'developer.start', params: { task: m[1].trim(), mode }, intent: 'Start a developer run on Goga’s own source' }
}

/**
 * "use C:\src\wordpress as my local copy" — remembers the folder a review runs against, so
 * "review wp-includes/class-wp-http.php" does not have to repeat it every time.
 */
export function parseLocalRootCommand(text: string): { root: string } | null {
  const t = String(text ?? '').trim()
  if (!t || t.length > 500) return null
  if (!/\b(local copy|local target|source tree|codebase|checkout|wordpress copy)\b/i.test(t)) return null
  const p = t.match(/([A-Za-z]:[\\/][^\s"'<>]+|\/[^\s"'<>]+)/)
  if (!p) return null
  const path = p[1].replace(/[.,;:]+$/, '').replace(/[\\/]+$/, '')
  // A source file is not a folder. "review wp-includes/class-wp-http.php in the local copy"
  // names a file to review, not a root to remember.
  if (/\.(php|js|mjs|cjs|ts|tsx|jsx|py|rb|go|java|cs|c|h|cpp|hpp|rs|kt|swift|sql|sh|ps1|json|xml|html|vue|svelte)$/i.test(path)) return null
  // A remembered root is a real absolute path with more than one segment.
  if (!/^[A-Za-z]:[\\/]/.test(path) && !/^\/[^/]+\//.test(path)) return null
  return { root: path }
}
