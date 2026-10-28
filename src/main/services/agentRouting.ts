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
  // Bare domains ("can you open google.com") — without this they fell through to chat,
  // which narrated a tool call instead of performing it.
  /\b(show|open|visit|go to|navigate to|browse to|pull up|bring up)\b.{0,40}\b[a-z0-9-]+\.(com|org|net|io|ai|dev|app|co|edu|gov|tv|me|us|uk)\b/i,
  /\b(go to|navigate to|browse to)\b/i,
  /\b(find|search for|look up|research)\b/i,
  /\b(organize|sort|move|rename|delete)\b.{0,30}\b(files?|folders?)\b/i,
  /\b(fix|debug|edit|update|modify)\b.{0,40}\b(code|file|project)\b/i,
  /\b(help|assist).{0,30}\b(bounty|bug\s*bounty|pentest|hack|ctf|exploit|vuln|recon|security)\b/i,
  /\b(help me with|work on|complete|finish|do)\b.{0,60}\b(task|project|bounty|workflow)\b/i,
  /\b(run|execute|install|build|compile)\b/i,
  /\b(fill|submit|complete)\b.{0,40}\b(form|field|input|fields|inputs)\b/i,
  /\bdo (this|that|it)\b/i,
  // Working in the user's Flux (circuit-board design) projects
  /\b(in|on|with|using|from|to) (flux|kicad|schematik)\b|\b(flux|schematik) (project|board|schematic|design)s?\b|\b(build|make|create) (the |a |an )?(circuit|schematic|netlist)\b/i,
  /\bschematik\.io\b|\b(upload|flash)\b.{0,40}\b(arduino|esp32|pico|board|sketch)\b|\b(make|create|build)\b.{0,30}\b(arduino|esp32|pico|microcontroller) project\b/i,
  /\b(what is|what are|how (do|does|to)|tell me about|explain|show me).{0,60}\b(hackerone|bugcrowd|intigriti|synack|bounty|cve|exploit|payload|xss|sqli|rce|ssrf|lfi|idor)\b/i,
]

export const CONFIRM_TRIGGERS = /^(yes|yeah|yep|sure|ok|okay|go ahead|do it|proceed|please|yup|affirmative|correct|right|exactly|absolutely)[.!]?$/i

// Agreement in everyday words: "yes please", "ok, go ahead", "sure do it", "go for it".
const AGREE_WORDS = /^(yes|yeah|yep|yup|sure|ok|okay|alright|all right|absolutely|definitely|of course|please|go ahead|go for it|do it|do that|proceed|let's do it|let's go|sounds good|perfect|great|start|carry on|continue)$/i

/** True for a short reply that agrees to what Goga proposed. Anything longer is a new request. */
export function isConfirmation(message: string): boolean {
  const parts = message.toLowerCase().replace(/[.!]+$/, '').split(/\s*[,.!]\s*|\s+(?:and|then)\s+/).map(p => p.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 3 || message.length > 40) return false
  return parts.every(part => AGREE_WORDS.test(part) || /^(yes|yeah|sure|ok|okay) (please|go ahead|do it)$/i.test(part))
}

/**
 * "Yes, please do that. And also make a list of parts" — agreement first, maybe with more
 * to add. A hedge in the first sentence ("yes, but first…", "ok wait") is not agreement.
 */
export function startsWithAgreement(message: string): boolean {
  const first = message.trim().split(/[.!?\n]/)[0] ?? ''
  if (!/^(yes|yeah|yep|yup|sure|ok|okay|alright|all right|absolutely|definitely|of course|go ahead|go for it|sounds good|let's do it|please do)\b/i.test(first)) return false
  return !/\b(but|wait|first|before|instead|not|don'?t|later|hold on|no)\b/i.test(first)
}

const WRITING_WORDS = /\b(draft|write|rewrite|summari[sz]e|organi[sz]e|outline|make a list|list (of|what|everything)|explain|brainstorm|prepare|compare|proofread|translate|executive summary|section|proposal|pitch|essay|letter|email|report)\b/i
const PC_OBJECTS = /\b(files?|folders?|\.txt|notepad|save|desktop|downloads|documents folder|browser|website|open|click|terminal|flux|schematik)\b|\b[a-z0-9-]+\.(com|org|net|io|gov|edu)\b/i

/**
 * Writing, organising and advice ("draft the summary and list what to buy to build it")
 * are answered in chat. Without this, a word like "build" sent them to the PC planner.
 */
export function isWritingRequest(message: string): boolean {
  return WRITING_WORDS.test(message) && !PC_OBJECTS.test(message)
}

/** Pasted documents and long write-ups are material to discuss, not commands for the PC. */
export const LONG_MESSAGE_CHARS = 2000

/** Whether an agreed plan means operating the PC, rather than writing or advising in chat. */
export function planNeedsComputer(plan: string): boolean {
  return /\b(open|click|browser|website|web ?page|log ?in|sign ?in|navigate|go to|download|install|launch|folder|file explorer|desktop|notepad|screenshot|type (it|into)|search (the web|online|google)|run (a |the )?(command|script|program)|save (it|this|that|the \w+|them) (to|as|in)|close (the )?(app|window|program)|kicad|netlist|schematic|pcb|circuit board|flux|schematik|arduino|esp32|sketch|upload)\b|\b[a-z0-9-]+\.(com|org|net|io|gov|edu)\b/i.test(plan)
}

/** Goga's reply described something it would do on the PC and asked for the go-ahead. */
export function isActionProposal(reply: string | undefined): boolean {
  if (!reply) return false
  return /\b(want me to|shall i|should i|would you like me to|do you want me to)\b[^?]{0,80}\?/i.test(reply)
}

/** A bounded observation route, separate from the general action planner. */
export function isReadOnlyObservationRequest(message: string): boolean {
  // Normalize only the routing view; callers retain the original request text.
  const normalized = message.replace(/\u2019/g, "'")
  if (/^\s*(explain\b|how\b|tell me about\b|what is an? active window\b)/i.test(normalized)) return false
  // Negative instructions are constraints, not requests to perform those actions.
  const positive = normalized.replace(/\b(do not|don't|never|without)\b[^.!?;\n]*/gi, '').split(/[.!?;\n]/).filter(part =>
    !/^\s*(do not|don't|never|without|no clicking)\b/i.test(part),
  ).join(' ')
  if (/\b(click|type|press|close|open|launch|focus|switch|move|drag|scroll|save|write|delete|change|modify|paste|fill|submit|make|create|run|execute)\b/i.test(positive)) return false
  return /\b(active|focused|foreground)\s+(window|app)\b|\b(which|what)\s+(window|app)\b.{0,50}\b(active|focused|foreground)\b|\b(what|describe|observe|read|inspect|see|look at)\b.{0,50}\b(screen|desktop|window)\b/i.test(positive)
}

/** Whether a task is about Flux, so its tools are worth the room in the planner's prompt. */
export const FLUX_TASK = /\bflux\b/i
const HARDWARE_TASK = /\b(flux|schematik|kicad|arduino|esp32|pico|microcontroller|circuit|schematic|netlist|pcb|isfet|sensor board|breadboard|solder)\b/i
const HARDWARE_TOOLS = /^(electronics\.|microcontroller\.|schematik\.)/
// Hardware work goes through Flux, the part libraries, the board tools and the web, not by
// driving the screen. Offering only these keeps the planner's prompt inside the brain's context.
const HARDWARE_SIDE_TOOLS = /^(web\.(search|fetch)$|memory\.|notepad\.saveText$|filesystem\.(read|write|list)$|browser\.openExternal$|clock\.now$)/
const FLUX_RARELY_NEEDED = /^flux\.(send_feedback|review_knowledge|list_organization_memberships|get_assets)$/

/** The tools the planner sees for a task: hardware tasks get a focused set, other tasks none of it. */
export function plannerOffers(task: string): (name: string) => boolean {
  if (!HARDWARE_TASK.test(task)) return name => !name.startsWith('flux.') && !HARDWARE_TOOLS.test(name)
  const flux = FLUX_TASK.test(task)
  return name => name.startsWith('flux.') ? flux && !FLUX_RARELY_NEEDED.test(name) : HARDWARE_TOOLS.test(name) || HARDWARE_SIDE_TOOLS.test(name)
}

// Phrases that open a question or request an explanation — these stay on the
// chat path even if they contain words that would otherwise trigger the agent.
const CONVERSATIONAL_PREFIX = /^\s*(explain|how (do|does|to|can|would|should)|what (is|are|was|were|does|would)|why (is|does|would)|when (is|does|would)|tell me (about|how|what|why)|what'?s the best|should i|can you explain|could you explain)/i

export function looksLikeAgentTask(message: string, lastAssistantMsg?: string): boolean {
  if (message.length > LONG_MESSAGE_CHARS) return false
  if (CONVERSATIONAL_PREFIX.test(message)) return false
  if (isWritingRequest(message)) return false
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
