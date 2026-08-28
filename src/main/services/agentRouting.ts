/**
 * Agent-task routing heuristic (pure, dependency-free).
 *
 * Extracted so it can be unit-tested without instantiating the full
 * OrchestratorService (which pulls in native LLM modules).
 */

// Phrases that clearly signal an autonomous multi-step task
export const AGENT_TRIGGERS: RegExp[] = [
  /\b(open|launch|start)\b.{0,40}\b(and|then|to)\b/i,
  /\b(open|launch|start)\b.{0,40}\b(browser|brave|chrome|firefox|edge|app|terminal|notepad|explorer|spotify|discord|slack|vscode|code)\b/i,
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

export function looksLikeAgentTask(message: string, lastAssistantMsg?: string): boolean {
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
