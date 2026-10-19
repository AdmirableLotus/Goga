/**
 * Agent-task routing heuristic (pure, dependency-free).
 *
 * Extracted so it can be unit-tested without instantiating the full
 * OrchestratorService (which pulls in native LLM modules).
 */

// Phrases that clearly signal an autonomous multi-step task
export const AGENT_TRIGGERS: RegExp[] = [
  /\bnotepad\.saveText\b/i,
  /\bsave\b.{0,60}\b(text|content|file|document|notes?)\b/i,
  /\bsave\b.{0,80}\.txt\b/i,
  /\bwrite\b.{0,40}\b(to|into)\b.{0,40}\b(file|document|txt|notepad)\b/i,
  /\b(make|create|put)\b.{0,60}\b(file|document|\.txt)\b/i,
  /\b(open|launch|start|show)\b.{0,40}\b(and|then|to)\b/i,
  /\b(open|launch|start|show)\b.{0,40}\b(browser|brave|chrome|firefox|edge|app|terminal|notepad|explorer|spotify|discord|slack|vscode|code)\b/i,
  /\b(show|open|visit|go to|navigate to|browse to)\b.{0,60}https?:\/\//i,
  /\b(show|open|visit|go to|navigate to|browse to)\b.{0,60}www\./i,
  /\b(go to|navigate to|browse to)\b/i,
  /\b(find|search for|look up|research)\b/i,
  /\b(organize|sort|move|rename|delete)\b.{0,30}\b(files?|folders?)\b/i,
  /\b(fix|debug|edit|update|modify)\b.{0,40}\b(code|file|project)\b/i,
  /\b(help|assist).{0,30}\b(bounty|bug\s*bounty|pentest|hack|ctf|exploit|vuln|recon|security)\b/i,
  /\b(help me with|work on|complete|finish|do)\b.{0,60}\b(task|project|bounty|workflow)\b/i,
  /\b(run|execute|install|build|compile)\b/i,
  /\b(fill|submit|complete)\b.{0,40}\b(form|field|input|fields|inputs)\b/i,
  /\bdo (this|that|it)\b/i,
  /\b(what is|what are|how (do|does|to)|tell me about|explain|show me).{0,60}\b(hackerone|bugcrowd|intigriti|synack|bounty|cve|exploit|payload|xss|sqli|rce|ssrf|lfi|idor)\b/i,
]

export const CONFIRM_TRIGGERS = /^(yes|yeah|yep|sure|ok|okay|go ahead|do it|proceed|please|yup|affirmative|correct|right|exactly|absolutely)[.!]?$/i

/** A bounded observation route, separate from the general action planner. */
export function getObservationRoute(message: string): 'observation' | 'clarify' | null {
  // Normalize only the routing view; callers retain the original request text.
  const normalized = message.replace(/\u2019/g, "'")
  if (/^\s*(explain\b|how\b|tell me about\b|what is an? active window\b)/i.test(normalized)) return null
  // Split contrast/sequence clauses before classifying negative constraints.
  // In particular, "don't scroll, but open Notepad" retains "open Notepad".
  const negative = /^\s*(do not|don't|never|without|no clicking)\b/i
  const clauses = normalized.split(/[.!?;\n]|\b(?:but|then|instead)\b/i)
    .flatMap(clause => clause.split(/(?=\b(?:do not|don't|never|without|no clicking)\b)/i))
  const positive = clauses.filter(clause => !negative.test(clause)).join(' ')
  const observationIndex = positive.search(/\b(active|focused|foreground)\s+(window|app)\b|\b(which|what)\s+(window|app)\b.{0,50}\b(active|focused|foreground)\b|\b(what|describe|observe|read|inspect|see|look at)\b.{0,50}\b(screen|desktop|window)\b/i)
  if (observationIndex < 0) return null
  const action = /\b(click|type|press|close|open|launch|focus|switch|move|drag|scroll|save|write|delete|change|modify|paste|fill|submit|make|create|run|execute)\b/i
  const actionIndex = positive.search(action)
  // An action-led request keeps the existing action route and its safeguards.
  // Observation-led mixed requests require clarification, never silent omission.
  if (actionIndex >= 0) return actionIndex < observationIndex ? null : 'clarify'
  const ambiguousConstraint = clauses.filter(clause => negative.test(clause)).some(clause => {
    const remainder = clause.replace(/^\s*(?:do not|don't|never|without|no)\b/i, '')
      .replace(new RegExp(action.source, 'gi'), '')
      .replace(/\b(?:clicking|typing|changing|scrolling|interact(?:ing)?|touch(?:ing)?)\b/gi, '')
      .replace(/\b(?:anything|else|or|and|with|at|all|it)\b/gi, '').replace(/[\s,]/g, '')
    return remainder.length > 0
  })
  return ambiguousConstraint ? 'clarify' : 'observation'
}

export function isReadOnlyObservationRequest(message: string): boolean {
  return getObservationRoute(message) === 'observation'
}

// Phrases that open a question or request an explanation — these stay on the
// chat path even if they contain words that would otherwise trigger the agent.
const CONVERSATIONAL_PREFIX = /^\s*(explain|how (do|does|to|can|would|should)|what (is|are|was|were|does|would)|why (is|does|would)|when (is|does|would)|tell me (about|how|what|why)|what'?s the best|should i|can you explain|could you explain)/i

export function looksLikeAgentTask(message: string, lastAssistantMsg?: string): boolean {
  if (CONVERSATIONAL_PREFIX.test(message)) return false
  if (AGENT_TRIGGERS.some(r => r.test(message))) return true
  if (CONFIRM_TRIGGERS.test(message.trim()) && lastAssistantMsg) {
    return /\b(search|look|find|open|navigate|run|execute|install|shall i|want me|would you like|should i|can i)\b/i.test(lastAssistantMsg)
  }
  return false
}

/**
 * Detects a vague "open a website / go to a website" request that names no
 * concrete site or URL. Such requests should NOT start an agent loop — Goga
 * should ask which website instead. Returns true only when a website/site is
 * referenced generically with no domain, URL, or specific site name.
 */
export function isVagueOpenWebsite(message: string): boolean {
  const m = message.trim().toLowerCase()
  // Must mention opening/going to a "website"/"site"/"web page" generically.
  const mentionsGenericSite = /\b(open|go to|navigate to|browse to|visit|launch)\b[^.]*\b(a |the |some )?(web ?site|web ?page|site|page|internet|web)\b/.test(m)
  if (!mentionsGenericSite) return false
  // If a concrete target is present, it's NOT vague.
  const hasUrl = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|gov|edu|co|dev|ai|app)\b/.test(m)
  // A known site/app name makes it concrete enough for the agent.
  const hasNamedSite = /\b(google|youtube|gmail|amazon|facebook|twitter|x\.com|reddit|github|hackerone|bugcrowd|wikipedia|stackoverflow|linkedin|instagram|netflix|spotify|chatgpt|bing|yahoo)\b/.test(m)
  return !hasUrl && !hasNamedSite
}
