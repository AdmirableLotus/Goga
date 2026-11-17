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
  /\b(read|import|download|add|learn from|study)\b.{0,40}\b(book|pdf|epub|paper|guide)\b/i,
  /\b(calculate|compute|plot|chart|graph|simulate|solve)\b/i,
  /\b(read|import|download|add|learn from)\b.{0,40}https?:\/\//i,
  /\b(help me with|work on|complete|finish|do)\b.{0,60}\b(task|project|workflow)\b/i,
  /\b(run|execute|install|build|compile)\b/i,
  /\b(fill|submit|complete)\b.{0,40}\b(form|field|input|fields|inputs)\b/i,
  /\bdo (this|that|it)\b/i,
  // Working in the user's Flux (circuit-board design) projects
  /\b(in|on|with|using|from|to) (flux|kicad|schematik)\b|\b(flux|schematik) (project|board|schematic|design)s?\b|\b(build|make|create) (the |a |an )?(circuit|schematic|netlist)\b/i,
  // Trading with real data: prices, charts, backtests and the practice account
  /\b(backtest\w*|paper (account|trad\w+)|practice (account|trad\w+)|my (portfolio|positions|trading journal|trades))\b/i,
  /\b(buy|sell)\b.{0,30}\b(shares?|stocks?|crypto|bitcoin|btc|eth|ethereum|coins?|eur\/?usd|gbp\/?usd|usd\/?jpy|forex)\b/i,
  /\b(price|quote|chart|analy[sz]e|technical analysis|news)\b.{0,30}\b(stocks?|crypto|bitcoin|btc|eth|ethereum|solana|forex|eur\/?usd|gbp\/?usd|usd\/?jpy|spy|qqq|aapl|tsla|nvda|msft|amzn|[a-z]{2,5}\/usd)\b/i,
  /\b(bitcoin|btc|ethereum|eth|solana|the stock market|eur\/?usd)\b.{0,20}\b(price|doing|today|now|chart)\b/i,
  /\bschematik\.io\b|\b(upload|flash)\b.{0,40}\b(arduino|esp32|pico|board|sketch)\b|\b(make|create|build)\b.{0,30}\b(arduino|esp32|pico|microcontroller) project\b/i,
  // Public-source research about a person, a handle, an address or a domain.
  /\b(osint|reverse (username|email)|domain recon|subdomain enumeration|breach (check|status))\b/i,
]

export const CONFIRM_TRIGGERS = /^(yes|yeah|yep|sure|ok|okay|go ahead|do it|proceed|please|yup|affirmative|correct|right|exactly|absolutely)[.!]?$/i

// Agreement in everyday words: "yes please", "ok, go ahead", "sure do it", "go for it".
const AGREE_WORDS = /^(yes|yeah|yep|yup|sure|ok|okay|alright|all right|absolutely|definitely|of course|please|go ahead|go for it|do it|do that|proceed|let's do it|let's go|sounds good|perfect|great|start|carry on|continue|go on|(you|you can|you should|you may) (do|check|handle) (it|that)|(do|check|handle) (it|that) (for me|yourself|on your own))$/i

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
  return /\b(open|click|browser|website|web ?page|log ?in|sign ?in|navigate|go to|download|install|launch|folder|file explorer|desktop|notepad|screenshot|type (it|into)|search (the web|online|google)|run (a |the )?(command|script|program)|save (it|this|that|the \w+|them) (to|as|in)|close (the )?(app|window|program)|kicad|netlist|schematic|pcb|circuit board|flux|schematik|arduino|esp32|sketch|upload|backtest|paper trade|practice trade|practice account|live price|real price|place (the|a|an) (order|trade))\b|\b[a-z0-9-]+\.(com|org|net|io|gov|edu)\b/i.test(plan)
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
export const LIBRARY_TASK = /\b(book|pdf|epub|library|read\s+through|learn\s+from)\b|library\.(import|listRepo)|raw\.githubusercontent|github\.com\/[\w-]+\/[\w.-]+/i
const HARDWARE_TASK = /\b(flux|schematik|kicad|arduino|esp32|pico|microcontroller|circuit|schematic|netlist|pcb|isfet|sensor board|breadboard|solder)\b/i
const HARDWARE_TOOLS = /^(electronics\.|microcontroller\.|schematik\.)/
// Hardware work goes through Flux, the part libraries, the board tools and the web, not by
// driving the screen. Offering only these keeps the planner's prompt inside the brain's context.
// Looking at the user's own open window stays possible ("find it on my Alpaca tab").
const HARDWARE_SIDE_TOOLS = /^(web\.(search|fetch)$|memory\.|notepad\.saveText$|filesystem\.(read|write|list)$|browser\.openExternal$|clock\.now$|vision\.analyze$|computer\.(windowList|focus\.window)$)/
const FLUX_RARELY_NEEDED = /^flux\.(send_feedback|review_knowledge|list_organization_memberships|get_assets)$/

export const TRADING_TASK = /\b(trad(e|es|ing|er)|stocks?|shares|etfs?|crypto|bitcoin|btc|eth|ethereum|solana|forex|currency pair|portfolio|backtest\w*|rsi|macd|candlesticks?|paper (account|trad\w+)|practice (account|trad\w+)|alpaca|broker|kill switch|positions?|open orders?|eur\/?usd|gbp\/?usd|usd\/?jpy|[a-z]{2,5}\/usd)\b/i

/** Tasks about bug bounty work: scope, a target, a finding, a report, or the curriculum. */
export const SECURITY_TASK = /\b(bug ?bounty|bount(y|ies)|hackerone|bugcrowd|scope|in.scope|out.of.scope|probe|xss|cross.site scripting|vulnerabilit(y|ies)|pentest|penetration test|reconnaissance|recon|triager|disclosure|submission|owasp|nmap|subfinder|nuclei|sqlmap|wpscan|toolbox|cheat.?sheet|metasploit|msfconsole|hashcat|john the ripper|hydra|medusa|netexec|nxc|aircrack|ettercap|kismet|mimikatz|wireshark|tshark|idor|ffuf|katana|httpx|port ?scan|password ?spray|credential ?spray|username enumeration|declared? target|the lab)\b/i

/** Tasks about designing or debugging hardware, or the ring project's sensing chain. */
export const ENGINEERING_TASK = /\b(ads12\d\d|afe|op ?amp|datasheet|bill of materials|bom|power budget|battery life|electrode|impedance|isfet|bioimpedance|filter (cutoff|response)|decoupling|regulator|pcb|schematic|netlist|kicad|solder|bench|oscilloscope|multimeter|viora|alma)\b/i

/**
 * Tasks about the user's own accounts and business: mail, social, storefronts, testers,
 * releases, monitoring, freelance work. Kept separate from trading so a mail task is not
 * handed the broker tools.
 */
export const BUSINESS_TASK = /\b(inbox|gmail|e-?mail|mail|bluesky|mastodon|social (post|media)|shopify|printful|storefront|listing|testers?|play console|release|deploy|uptime|monitor|freelance|upwork|fiverr|proposal|invoice|my (shop|store|app|site|website))\b/i

/** Tasks about public-source people and domain research. */
/** Tasks about handing work to a background job, or checking on one. */
export const JOBS_TASK = /\b(jobs?|background (job|task|worker)|worker|in the background|job board|what'?s running)\b/i

export const OSINT_TASK = /\b(osint|reverse (username|email)|username search|people search|domain recon|subdomain enumeration|whois|breach (check|status)|public mentions)\b/i

/** Tasks about Goga improving his own code, or about what he has learned. */
export const EVOLUTION_TASK = /\b(improve (yourself|your ?self|your (own )?code)|evolve|self.improv\w*|your own code|learn(ed)? (that|from)|remember (that|this)|record (a |this )?skill|what did you learn)\b/i

/** Tasks about installing a program, or setting up a virtual machine to work in. */
export const SETUP_TASK = /\b(install|uninstall|set ?up|provision|virtual ?machine|\bvm\b|hyper-?v|virtualbox|vmware|wsl2?|sandbox|winget|package manager|what'?s installed|is .{0,20} installed|do you have .{0,20} installed)\b/i

/** Tasks about Goga himself — his code, his tools, what he couldn't do. */
export const SELF_TASK = /\b(your|goga'?s) (own )?(code|source|codebase|tools|gaps?|failures)\b|\byour ?self\b|\bwhat (tools?|abilities) (do )?you need\b/i

/**
 * The tools the planner sees for a task. Hardware and trading tasks get a focused set (their
 * own tools plus web, memory and notes); other tasks get everything but those.
 */
const SCHEDULE_TASK = /\b(every (\d+ )?(minute|hour|day|week|morning|evening|night)s?|hourly|daily|weekly|schedul\w*|recurring|automat\w*|remind\w*|on your own)\b/i

/** The browser tools every task may use: they drive Goga's own Firefox. */
const GENERAL_BROWSER_TOOLS = /^browser\.(goto|readPage|listTabs|selectTab|click|type|find|waitForText|screenshot|learnSite|recallSite|correctSite)$/

export function plannerOffers(task: string): (name: string) => boolean {
  const offers = baseOffers(task)
  // The self-reading tools only take room in the prompt when the task is about Goga himself.
  const self = SELF_TASK.test(task) || EVOLUTION_TASK.test(task)
  const schedule = SCHEDULE_TASK.test(task)
  const evolution = EVOLUTION_TASK.test(task)
  const osint = OSINT_TASK.test(task)
  // Starting, listing or stopping a background job is its own kind of request. A worker
  // inside a job is never offered these, so a job cannot quietly multiply itself.
  const jobsTask = JOBS_TASK.test(task)
  const setupTask = SETUP_TASK.test(task)
  return name => name.startsWith('setup.') ? setupTask
    : name.startsWith('jobs.') ? jobsTask
    : name.startsWith('osint.') ? osint
    : name.startsWith('self.') ? self
    : name.startsWith('schedule.') ? schedule
    : name.startsWith('evolution.') ? evolution
    : offers(name)
}

function baseOffers(task: string): (name: string) => boolean {
  const hardware = HARDWARE_TASK.test(task), trading = TRADING_TASK.test(task)
  const security = SECURITY_TASK.test(task), engineering = ENGINEERING_TASK.test(task)
  const business = BUSINESS_TASK.test(task)
  const focused = hardware || trading || security || engineering || business
  if (!focused) {
    // Everything except the focused families and the self/evolution tools (offered separately).
    return name => !name.startsWith('flux.') && !HARDWARE_TOOLS.test(name) && !name.startsWith('trading.')
      && !name.startsWith('broker.') && !name.startsWith('security.') && !name.startsWith('lab.') && !name.startsWith('ee.') && !name.startsWith('evolution.')
      && !name.startsWith('osint.') && !name.startsWith('strategy.') && !name.startsWith('business.')
      && !name.startsWith('jobs.') && !name.startsWith('setup.')
  }
  const flux = FLUX_TASK.test(task)
  return name => {
    if (name.startsWith('flux.')) return flux && !FLUX_RARELY_NEEDED.test(name)
    if (name.startsWith('trading.')) return trading
    if (name.startsWith('broker.')) return trading
    if (name.startsWith('security.')) return security
    if (name.startsWith('lab.')) return security
    if (name.startsWith('strategy.')) return trading
    if (name.startsWith('business.')) return business
    if (name.startsWith('persona.')) return true
    // Driving its own Firefox and working on its own source are general abilities, not one
    // area's tools: a bounty task, a trading task and a setup task all need them. Only the
    // Firefox-backed family is added here — the older Playwright name stays where it was,
    // because a focused task gets a short list on purpose.
    if (GENERAL_BROWSER_TOOLS.test(name)) return true
    if (name.startsWith('selfwork.')) return true
    if (name.startsWith('ee.')) return engineering || hardware
    if (name.startsWith('evolution.')) return false
    if (hardware && HARDWARE_TOOLS.test(name)) return true
    if (engineering && /^(ee\.|electronics\.)/.test(name)) return true
    return HARDWARE_SIDE_TOOLS.test(name)
  }
}

// Phrases that open a question or request an explanation — these stay on the
// chat path even if they contain words that would otherwise trigger the agent.
const CONVERSATIONAL_PREFIX = /^\s*(explain|how (do|does|to|can|would|should)|what (is|are|was|were|does|would)|why (is|does|would)|when (is|does|would)|tell me (about|how|what|why)|what'?s the best|should i|can you explain|could you explain)/i

// Answers to a waiting approval. Kept to plain, whole replies so a sentence that merely
// contains "yes" never approves an action.
export const APPROVE_REPLY = /^(approve|approved|yes|yes please|yes approve|ok|okay|allow|allowed|go ahead|do it)[.!]?$/i
export const DENY_REPLY = /^(deny|denied|no|no thanks|reject|rejected|don'?t|cancel|stop)[.!]?$/i

/** A plain question or request for an explanation, not a request to act. */
export function isConversationalQuestion(message: string): boolean {
  return CONVERSATIONAL_PREFIX.test(message)
}

/**
 * An "open/close an app" request, resolved to a process action — or null.
 *
 * "close brave", "quit spotify", "open notepad" are the Rabbit-OS-style PC-control requests the
 * chat path used to narrate instead of doing ("Done, Brave is closed" while it was still open).
 * Resolving them to a concrete process action lets the agent run process.kill / process.start
 * rather than talk about it. Closing is force-killing a process, so it stays approval-gated.
 */
const APP_ALIASES: Record<string, string> = {
  edge: 'msedge', 'microsoft edge': 'msedge', word: 'winword', 'microsoft word': 'winword',
  excel: 'excel', powerpoint: 'powerpnt', outlook: 'outlook', 'vs code': 'Code', vscode: 'Code',
  'visual studio code': 'Code', chrome: 'chrome', 'google chrome': 'chrome', brave: 'brave',
  firefox: 'firefox', spotify: 'spotify', discord: 'discord', slack: 'slack', teams: 'ms-teams',
  telegram: 'telegram', steam: 'steam', notepad: 'notepad', calculator: 'Calculator',
  terminal: 'WindowsTerminal', cmd: 'cmd', powershell: 'powershell', explorer: 'explorer',
  'file explorer': 'explorer', paint: 'mspaint', obs: 'obs64', zoom: 'Zoom',
}
/** What can launch each known app, when the bare name is not on PATH. */
const APP_LAUNCH: Record<string, string> = {
  msedge: 'msedge', winword: 'winword', powerpnt: 'powerpnt', Code: 'code', chrome: 'chrome',
  brave: 'brave', firefox: 'firefox', spotify: 'spotify', discord: 'discord', notepad: 'notepad',
  Calculator: 'calc', WindowsTerminal: 'wt', cmd: 'cmd', powershell: 'powershell',
  explorer: 'explorer', mspaint: 'mspaint',
}
const NOT_AN_APP = /^(the|a|an|my|it|this|that|them|app|application|window|windows|tab|tabs|file|files|folder|program|programs|process|everything|all|computer|pc|laptop|machine|system|desktop|screen|session|down|up|out|off)$/i

export interface AppControl { action: 'open' | 'close'; name: string; launch?: string; raw: string }

export function parseAppControl(message: string): AppControl | null {
  const t = String(message ?? '').trim()
  if (!t || t.length > 120) return null
  // "shut down the computer / restart the pc" is an OS action, never a process to kill here.
  if (/\b(shut\s*down|turn\s*off|restart|reboot|log\s*off|sign\s*out|put\s+to\s+sleep)\b[^.!?\n]{0,30}\b(computer|pc|laptop|machine|system|windows|everything)\b/i.test(t)) return null
  const close = t.match(/^(?:please\s+|hey\s+goga,?\s+|goga,?\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+)?(?:close|quit|kill|exit|terminate|force\s*quit|shut\s*down|end)\s+(?:the\s+|my\s+)?([a-z0-9][\w .+-]{0,40}?)(?:\s+(?:browser|app|application|window|program|process))?\s*(?:please|now|for\s+me|thanks?|thank\s+you)?\s*[.!?]*$/i)
  const open = t.match(/^(?:please\s+|hey\s+goga,?\s+|goga,?\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+)?(?:open|launch|start|fire\s*up|boot\s*up|bring\s*up)\s+(?:the\s+|my\s+)?([a-z0-9][\w .+-]{0,40}?)(?:\s+(?:browser|app|application|program|for\s+me))?\s*(?:please|now|for\s+me|thanks?)?\s*[.!?]*$/i)
  const m = close ?? open
  if (!m) return null
  const action: 'open' | 'close' = close ? 'close' : 'open'
  const name = m[1].trim().toLowerCase().replace(/\.exe$/i, '').replace(/[.!?]+$/, '').trim()
  if (!name || NOT_AN_APP.test(name)) return null
  // A URL or domain is a browser navigation, not a desktop app — leave it to siteToOpen.
  if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|org|net|io|ai|dev|app|co|edu|gov|xyz)\b/i.test(name)) return null
  // A multi-word target that is not a known app is almost always ordinary prose
  // ("close the deal with john"), not an app — don't turn it into a kill.
  const known = name in APP_ALIASES
  if (!known && /\s/.test(name)) return null
  const resolved = APP_ALIASES[name] ?? name
  // Opening is only reliable for apps we know how to launch (bare names rarely resolve on PATH).
  if (action === 'open' && !(resolved in APP_LAUNCH)) return null
  return { action, name: resolved, launch: APP_LAUNCH[resolved], raw: name }
}

export function looksLikeAgentTask(message: string, lastAssistantMsg?: string): boolean {
  if (message.length > LONG_MESSAGE_CHARS) return false
  if (CONVERSATIONAL_PREFIX.test(message)) return false
  if (isWritingRequest(message)) return false
  if (parseAppControl(message)) return true
  if (isImperativeRequest(message)) return true
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
  const hasNamedSite = /\b(google|youtube|gmail|amazon|facebook|twitter|x\.com|reddit|github|hackerone|bugcrowd|cantina|intigriti|yeswehack|synack|wikipedia|stackoverflow|linkedin|instagram|netflix|spotify|chatgpt|bing|yahoo|alpaca|pivex|coinbase)\b/.test(m)
  return !hasUrl && !hasNamedSite
}

// "go to sleep", "sleep mode", "good night" — short, so "the good night routine for my kid" is not one.
export const SLEEP_REQUEST = /^\s*(?:(?:ok(?:ay)?|goga|hey goga|alright)[,\s]+)*(?:please\s+)?(?:go to sleep(?: mode)?|sleep mode|sleep now|go sleep|good ?night)(?:[,\s]+(?:goga|go to sleep(?: mode)?|good ?night|sleep well|ace))*\s*[.!]*\s*$/i
/** Several questions in one message ("why…? second did you…, third how…"). */
export const isCompoundQuestion = (text: string): boolean => (text.match(/\?/g) ?? []).length > 1 || /\b(second(ly)?|third(ly)?|also|and (how|what|why|did|are|is))\b/i.test(text)

// ── An imperative is an instruction to act ──────────────────────────────────
//
// "lets do bounty" and "I would like to do coinbase one" are not conversation topics. They
// fell through to the chat path, which then narrated an action it had not taken. The rules
// below treat a stated intention to do something as dispatch, so the agent loop gets it and
// the browser tools actually move.
//
// Two things keep this from swallowing ordinary conversation:
//   - a question about how or why is still a question (CONVERSATIONAL_PREFIX, checked first)
//   - a bare "do it" with nothing to do it to is handled by the confirmation path, not here

/** Verbs that, at the start of a request, mean "go and do this". */
const ACTION_VERBS = String.raw`open|go\s+to|visit|navigate|browse|pull\s+up|bring\s+up|check|read|search|look\s+up|find|research|do|run|try|start|launch|click|type|fill|log\s*in|sign\s*in|download|install|set\s+up|prepare|place|book|buy|sell|send|draft|write|save|create|make|build|scan|test|apply|submit|register|enroll|compare|review|work(?:\s+on)?|hunt|probe|import|look\s+at|show\s+me|walk\s+me|help\s+me\s+with`

/** "let's …", "lets …", "let us …" — a stated intention to do something. */
const LETS = /^\s*(?:ok(?:ay)?[,\s]+)?(?:let'?s|lets|let\s+us)\s+(?:\w+\s+){0,2}?(?:do|go|try|start|begin|check|look|open|work|run|get|have|tackle|take|handle|dive|start\s+on)\b/i

/** "I would like to …", "I want to …", "can you …", "please …" followed by a real verb. */
const WANTS = new RegExp(
  String.raw`^\s*(?:please[,\s]+|hey\s+goga[,\s]+|goga[,\s]+)?(?:i(?:'d|\s+would)?\s+(?:like|want|need)\s+to|i(?:'d|\s+would)\s+like\s+(?:you\s+)?to|can\s+you|could\s+you|would\s+you|will\s+you|go\s+ahead\s+and|(?:please|kindly))\s+(?:${ACTION_VERBS})\b`,
  'i',
)

/** Starts with a bare action verb in the imperative: "open the Coinbase page", "scan it". */
const BARE_IMPERATIVE = new RegExp(String.raw`^\s*(?:${ACTION_VERBS})\b`, 'i')

/** Things that look like an imperative start but are not: "show me how", "look at this differently". */
const NOT_IMPERATIVE = /^\s*(?:show\s+me\s+how|help\s+me\s+understand|walk\s+me\s+through|look\s+at\s+(?:this|the)\s+(?:differently)|do\s+you|can\s+you\s+tell|let\s+me\s+know|can\s+you\s+fill\s+me\s+in|fill\s+me\s+in|please\s+fill\s+(?:in\s+|out\s+)?your|fill\s+(?:in\s+|out\s+)?your\s+(?:details|info|name|email))\b/i

/** A phrase addressed back at the user ("fill in your details") is not an order to Goga. */
const ADDRESSED_AT_USER = /\b(?:fill|enter|type)\s+(?:in\s+|out\s+)?your\s+\w+/i

/**
 * True when the message is an order to do something on the computer or online.
 *
 * Deliberately generous about *intent* and strict about *form*: a message that opens with a
 * verb, or states an intention to act, or asks Goga to act, is dispatched. A question about
 * the same subject is not — `isConversationalQuestion` is checked before this runs.
 */
export function isImperativeRequest(message: string): boolean {
  const m = String(message ?? '').trim()
  if (!m) return false
  if (NOT_IMPERATIVE.test(m)) return false
  // "please fill in your details" asks the user to do something, not Goga.
  if (ADDRESSED_AT_USER.test(m) && /^\s*(?:please|can\s+you|could\s+you)?\s*(?:fill|enter|type)/i.test(m)) return false
  if (LETS.test(m)) return true
  if (WANTS.test(m)) return true
  // A bare imperative must also be about something, not a single word like "run".
  // A bare imperative must also be about something: not a single word like "run", and not an
  // order with no target at all ("read this and tell me how it sounds" is a request for an
  // opinion, and dispatching it would open a browser at nothing).
  if (BARE_IMPERATIVE.test(m) && m.split(/\s+/).length >= 2 && namesAnActionTarget(m)) return true
  // "do a bounty for me on hacker one" — a doing-verb in the middle, addressed to Goga.
  if (/\b(?:do|run|work|take|carry\s+out|handle)\b[^.!?]{0,60}\b(?:for\s+me|on\s+my\s+behalf|yourself|on\s+your\s+own)\b/i.test(m)) return true
  return false
}

/**
 * True when the request names something to act on, so the agent has a target rather than a
 * topic. Used to decide between "go and do it" and "ask what you mean".
 */
export function namesAnActionTarget(message: string): boolean {
  return /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|io|ai|dev|app|co|edu|gov)\b/i.test(message)
    || /\b(?:hackerone|bugcrowd|coinbase|github|alpaca|pivex|firefox|chrome|edge|brave|notepad|explorer)\b/i.test(message)
    || /\b(?:this|that|the)\s+(?:page|site|website|tab|window|file|folder|program|app)\b/i.test(message)
    || /\b(?:bounty|bounties|scope|program|report|invoice|install|package|vm|virtual machine)\b/i.test(message)
}
