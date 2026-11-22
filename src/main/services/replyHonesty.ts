// A chat answer has not touched the computer. The local brain still writes "I've opened it",
// "I'm downloading it" — so such claims are caught in code, not left to the prompt.

const DONE = /\bI(?:['’]ve| have| just| already)?\s+(?:now\s+|just\s+|already\s+)?(opened|closed|clicked|typed|navigated|launched|quit|killed|shut down|terminated|restarted|rebooted|turned (?:off|on)|minimi[sz]ed|maximi[sz]ed|downloaded|installed|uninstalled|uploaded|sent|emailed|saved|deleted|removed|moved|renamed|fetched|cloned|scanned|browsed|executed|submitted|posted|logged in|signed in|pulled up|went to|looked it up|searched (?:the web|online|for)|checked|added|authori[sz]ed|blocked|allowed|whitelisted|approved|configured|scheduled|set up|verified|updated|registered|enabled|disabled)\b/i
// "I'll keep checking the account hourly" — a promise of a schedule the chat reply can't create.
const RECURRING_PROMISE = /\bI(?:['’]ll| will)\s+(?:keep|continue to|be)\s+\w+ing\b[^.!?\n]{0,80}\b(hourly|every (?:hour|day|morning|night|\d+ ?(?:minutes?|hours?))|daily|each (?:hour|day))\b/i
const DOING = /\bI(?:['’]m| am)\s+(?:now\s+)?(opening|closing|clicking|typing|navigating|launching|quitting|killing|downloading|installing|uploading|sending|saving|deleting|removing|fetching|cloning|scanning|searching|running|executing|initiating|pulling up)\b/i
// The passive completion claim: "The Brave browser window is now closed." No "I", so the two
// patterns above miss it, which is exactly how a false "done" reached the user. Requires a
// now/already/successfully, so a conditional description ("the file is saved to Downloads") is
// not swept in.
const PASSIVE_DONE = /\b(?:the|that|your|it|this|everything|all)\b[^.!?\n]{0,50}\b(?:is|are|was|were|has been|have been|['’]s been)\s+(?:now|already|successfully)\s+(closed|opened|killed|stopped|deleted|removed|installed|uninstalled|saved|downloaded|uploaded|sent|submitted|launched|terminated|disabled|enabled|done)\b/i

/** True when a reply says it did, or is doing, something on the computer. */
export function claimsAction(reply: string): boolean {
  return DONE.test(reply) || DOING.test(reply) || PASSIVE_DONE.test(reply)
}

/** The note added to a chat answer that claims an action no tool performed, or ''. */
export function chatHonestyNote(reply: string): string {
  if (claimsAction(reply)) return '\n\n⚠️ Goga\'s check: nothing was done on the computer for this answer; it was only a chat reply. Ask me to do it ("open …", "search for …") and I will actually do it.'
  const promise = reply.match(RECURRING_PROMISE)
  if (promise) return `\n\n⚠️ Goga's check: nothing is scheduled by this reply. To make it real, say something like "every hour check alpaca" and I'll set up a task.`
  return ''
}

// ── Enforcing the claim, not annotating it ───────────────────────────────────
//
// The note above told the user the truth *underneath* a false sentence. That is not
// enough: the false sentence is what they read. These functions remove it instead.

/**
 * General helplessness about abilities Goga actually has.
 *
 * Deliberately narrow. "I can't sign in as you" and "I can't submit the report for you"
 * are the *correct* specific limits and must survive untouched — only a blanket denial
 * of acting, browsing or reaching the web is caught here.
 */
const DISCLAIMS_CAPABILITY = [
  /\bI\s+(?:can(?:no|')?t|cannot|am\s+unable\s+to|'m\s+unable\s+to|am\s+not\s+able\s+to|'m\s+not\s+able\s+to)\s+(?:actually\s+|really\s+|directly\s+)?(?:perform|take|carry\s+out|do|execute)\s+(?:any\s+)?actions?\b/i,
  /\bI(?:'m|\s+am)\s+unable\s+to\s+(?:actually\s+|really\s+|directly\s+)?(?:browse|access|reach|open|visit|navigate|search)\s+(?:the\s+)?(?:web|internet|websites?|web\s?pages?|sites?|online)\b/i,
  /\bI\s+(?:can(?:no|')?t|cannot)\s+(?:actually\s+|really\s+|directly\s+)?(?:browse|access|reach|open|visit|navigate|search)\s+(?:the\s+)?(?:web|internet|websites?|web\s?pages?|sites?|online)\b/i,
  /\bI\s+(?:don'?t|do\s+not)\s+have\s+(?:the\s+)?(?:ability|capability|access|means)\s+to\s+(?:browse|access|open|visit|navigate|perform\s+actions?|take\s+actions?|interact\s+with\s+(?:websites?|the\s+web|pages?))\b/i,
  /\bI(?:'m|\s+am)\s+(?:just\s+|only\s+)?(?:a\s+)?(?:language\s+model|AI\s+assistant|chat\s?bot)\b[^.!?\n]{0,80}\b(?:can(?:no|')?t|cannot|unable)\b/i,
  /\bI\s+(?:can(?:no|')?t|cannot)\s+(?:log|sign)\s*(?:in|into)\s+(?:to\s+)?(?:any\s+)?(?:websites?|sites?|accounts?|services?)\s+(?:for|on\s+behalf\s+of)\s+you\b/i,
]

/** True when a reply denies a capability Goga actually has. */
export function disclaimsCapability(reply: string): boolean {
  return DISCLAIMS_CAPABILITY.some(r => r.test(reply))
}

/** What Goga can do, and the specific things it will not do — in place of a blanket denial. */
export const CAPABILITY_STATEMENT =
  'I can drive a browser: open a page, read what it says, find and click things, type, and learn a site. '
  + 'What I won\'t do is sign in as you, accept terms for you, move money, or send something you haven\'t approved — '
  + 'those are the only limits, and I\'ll name the one that applies when it comes up.'

/** Said when a chat reply claimed an action that no tool performed. */
export const NOTHING_DONE_STATEMENT =
  'I haven\'t done that — that reply was only text, and nothing ran on your computer. '
  + 'Tell me the site and what to look for, for example "open hackerone.com/coinbase and read the scope", '
  + 'and I\'ll go and do it and tell you what the page actually says.'

export interface HonestReply {
  content: string
  /** True when the reply was replaced or trimmed because it was not true. */
  corrected: boolean
  reason: 'claim' | 'disclaimer' | 'page-unread' | null
}

/** Split into sentences, keeping the punctuation, so a claim can be dropped whole. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0)
}

/**
 * Hold a chat reply to what actually happened.
 *
 * `acted` is true only when a tool really ran in this turn. When it is false, a reply
 * that says it opened, searched, clicked or ran something loses those sentences; a reply
 * that denies a capability Goga has is replaced with the real capability and its limits.
 */
export function enforceHonestReply(reply: string, opts: { acted: boolean }): HonestReply {
  if (opts.acted) return { content: reply, corrected: false, reason: null }

  let text = reply
  let corrected = false
  let reason: 'claim' | 'disclaimer' | null = null

  if (claimsAction(text)) {
    const kept = sentences(text).filter(s => !claimsAction(s))
    const rest = kept.join(' ').trim()
    // Keep whatever the reply said that was not a claim, as long as something useful is left.
    text = rest.length >= 40 ? `${rest}\n\n${NOTHING_DONE_STATEMENT}` : NOTHING_DONE_STATEMENT
    corrected = true
    reason = 'claim'
  }

  if (disclaimsCapability(text)) {
    const kept = sentences(text).filter(s => !disclaimsCapability(s))
    const rest = kept.join(' ').trim()
    text = rest.length >= 40 ? `${rest}\n\n${CAPABILITY_STATEMENT}` : CAPABILITY_STATEMENT
    corrected = true
    reason = reason ?? 'disclaimer'
  }

  return { content: text, corrected, reason }
}

// ── Holding an *agent* reply to its own step history ────────────────────────
//
// In the agent loop the answer is written by the same local model, after the tools ran.
// It still says things like "I've opened the page" when the navigation failed, and it
// still writes a summary of a page it never read. So the reply is checked against the
// steps that actually ran, and the page's own words are quoted underneath.

/** The smallest shape of a step this needs, so it is testable without the agent. */
export interface StepLike {
  tool: string
  result: { success: boolean; data?: unknown; error?: string }
}

const BROWSER_READ_TOOLS = new Set(['browser.readPage', 'browser.read', 'browser.snapshot'])
const BROWSER_NAV_TOOLS = new Set(['browser.goto', 'browser.navigate', 'browser.open', 'browser.openExternal'])

/** The most recent page read that worked, as text the user can check against. */
export function pageEvidence(steps: StepLike[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (!step.result.success || !BROWSER_READ_TOOLS.has(step.tool)) continue
    const data = step.result.data
    if (typeof data === 'string' && data.trim()) return data.trim()
    if (data && typeof data === 'object') {
      const d = data as { url?: string; title?: string; text?: string }
      if (d.text?.trim()) return [`URL: ${d.url ?? ''}`, `Title: ${d.title ?? ''}`, '', d.text.trim()].join('\n')
    }
  }
  return ''
}

/**
 * Correct one agent reply against the steps that ran.
 *
 * `acted` is true when any step succeeded — a failed navigation is not an action, so a reply
 * that says "I opened it" after a failed navigation is corrected, not trusted. When the
 * turn did read a page, the page's own opening lines are appended so the answer carries
 * something the user could not have got from the model alone.
 */
export function groundAgentReply(reply: string, steps: StepLike[]): HonestReply {
  const acted = steps.some(s => s.result.success)
  const enforced = enforceHonestReply(reply, { acted })
  let content = enforced.content

  // A claim of navigation when the only navigation failed is still a false claim.
  const navAttempted = steps.filter(s => BROWSER_NAV_TOOLS.has(s.tool))
  const navSucceeded = navAttempted.some(s => s.result.success)
  // Check the reply as written, not as corrected: `enforceHonestReply` has already replaced a
  // false claim with the nothing-done statement, so testing `content` here would never fire.
  if (navAttempted.length && !navSucceeded && claimsAction(reply)) {
    const failures = navAttempted.filter(s => !s.result.success).map(s => s.result.error ?? 'it failed')
    const kept = sentences(content).filter(s => !claimsAction(s)).join(' ').trim()
    const statement = `I could not open that page — ${failures[0]}. Nothing was read from it.`
    content = kept.length >= 40 ? `${kept}\n\n${statement}` : statement
    return { content, corrected: true, reason: 'claim' }
  }

  const evidence = pageEvidence(steps)

  // A page was opened but never read, and the reply quotes it anyway. This is the failure the
  // run caught: "open the Cantina bug bounty page and tell me what it says" wrote out a
  // heading, a welcome paragraph and three numbered rules that no tool had seen. The quote is
  // removed and replaced with what is actually true.
  if (!evidence && reportsPageContent(reply)) {
    const kept = sentences(content).filter(s => !quotesPageContent(s)).join(' ').trim()
    const statement = 'Nothing was read from that page: the navigation happened, but no page '
      + 'read succeeded, so I have no text from it to quote. The site may draw itself with '
      + 'script, or the read may have failed. Say "read the page" and I will try again and tell '
      + 'you exactly what it returned.'
    return {
      content: kept.length >= 40 ? `${kept}\n\n${statement}` : statement,
      corrected: true,
      reason: 'page-unread',
    }
  }

  if (evidence && !content.includes(evidence.slice(0, 80))) {
    content = `${content}\n\nWhat the page itself showed:\n\n${evidence.slice(0, 2500)}`
  }
  return { content, corrected: enforced.corrected, reason: enforced.reason }
}

/**
 * True when a reply presents text as the page's, in the shapes a model uses for it:
 * "The page states:", "The page says:", "The page shows:", "Welcome to …", a bolded heading
 * followed by a quote, or "According to the page".
 */
export function reportsPageContent(reply: string): boolean {
  // "the page states", "the Cantina bug bounty page states", "this program page says" — the
  // page can be named between the article and the noun, which is how the live reply read.
  return /\b(?:the|this|that)\b[^.!?\n]{0,60}?\bpage\s+(?:states|says|shows|reads|contains|explains|lists|tells|makes clear)\b/i.test(reply)
    || /\baccording to (?:the|that|this)\b[^.!?\n]{0,40}?\bpage\b/i.test(reply)
    || /\b(?:the|this)\b[^.!?\n]{0,40}?\b(?:web ?site|site)\s+(?:states|says|shows|reads)\b/i.test(reply)
    || /\b(?:I|I've|I have)\s+(?:just\s+)?(?:read|looked at|checked)\s+(?:the|that)\b[^.!?\n]{0,40}?\bpage\b[^.!?\n]{0,60}\b(?:says|states|shows)\b/i.test(reply)
}

/** One sentence that is quoting page content rather than describing what happened. */
function quotesPageContent(sentence: string): boolean {
  return reportsPageContent(sentence)
    || /^\s*(?:welcome to|here (?:is|are) (?:what|the)|the page (?:states|says|shows|reads|contains))/i.test(sentence)
}

// One brain decides between talking and acting. When the phrase rules don't recognise a
// request, the local brain is asked this narrow question before a chat answer is written.
// ── Claims about a precondition ─────────────────────────────────────────────
//
// A live run produced this sentence inside an approval prompt: "Now that the target has been
// successfully declared, the next step is to run the…" — with no declaration in existence, and
// the very next tool call refused with "no such declaration". The sentence asserted a state
// nothing had established.
//
// These helpers hold a sentence that asserts a precondition (declared, imported, approved,
// attached, saved) to the step history of the same turn. A claim with no successful step behind
// it is removed rather than softened, because the user reads the claim, not a note under it.

/** The precondition states a reply may assert, and the tools that would establish each. */
const PRECONDITION_CLAIMS: { pattern: RegExp; tools: string[]; state: string }[] = [
  { pattern: /\b(?:target|host|domain|asset)\b[^.!?\n]{0,60}?\b(?:has|have|is|was|are)\s+(?:now\s+|already\s+|successfully\s+|been\s+)*(?:declared|registered|authorised|authorized)\b/i, tools: ['lab.declareTarget', 'lab.listTargets'], state: 'declared' },
  { pattern: /\b(?:has|have|is|was|are)\s+(?:now\s+|already\s+|successfully\s+)+declared\b/i, tools: ['lab.declareTarget', 'lab.listTargets'], state: 'declared' },
  { pattern: /\b(?:program|policy|scope)\b[^.!?\n]{0,60}?\b(?:has|have|is|was|been)\s+(?:now\s+|already\s+|successfully\s+)*(?:imported|loaded)\b/i, tools: ['security.importProgram', 'security.listPrograms'], state: 'imported' },
  { pattern: /\b(?:request|dispatch|payload|spray)\b[^.!?\n]{0,60}?\b(?:has|have|is|was|been)\s+(?:now\s+|already\s+|successfully\s+)+(?:approved|authorised|authorized)\b/i, tools: ['lab.decidePayload', 'lab.decideSpray'], state: 'approved' },
  { pattern: /\b(?:browser|firefox|brave)\b[^.!?\n]{0,40}?\b(?:is|was|has been)\s+(?:now\s+|already\s+|successfully\s+)*(?:attached|connected)\b/i, tools: ['browser.attach', 'browser.start', 'brave.openForCantina', 'brave:openForCantina'], state: 'attached' },
]

/** The precondition state this sentence claims, or null when it claims none. */
export function preconditionClaimed(sentence: string): { state: string; tools: string[] } | null {
  for (const claim of PRECONDITION_CLAIMS) {
    if (claim.pattern.test(sentence)) return { state: claim.state, tools: claim.tools }
  }
  return null
}

/**
 * Drop every sentence that asserts a precondition no successful step in this turn established.
 *
 * `steps` is the turn's own history, so this cannot be satisfied by wording — only by a tool
 * having actually returned success for the thing claimed.
 */
export function dropUnbackedPreconditionClaims(reply: string, steps: StepLike[]): { content: string; dropped: string[] } {
  const backed = new Set(steps.filter(s => s.result.success).map(s => s.tool))
  const dropped: string[] = []
  const kept = sentences(reply).filter(sentence => {
    const claim = preconditionClaimed(sentence)
    if (!claim) return true
    if (claim.tools.some(tool => backed.has(tool))) return true
    dropped.push(sentence.trim())
    return false
  })
  return { content: kept.join(' ').trim(), dropped }
}

// ── A cause the tool result did not give ────────────────────────────────────
//
// "It seems there's a typo or missing closing quotation mark in the previous target" was
// offered as a reason inside an approval prompt. The tool had said only "no such declaration".
// When the result names a cause the reply may use it; when it does not, the reply may not
// invent one. These are the shapes a model uses to present a guess as a diagnosis.

const CAUSE_SHAPES = [
  /\bit seems (?:that |like )?(?:there(?:'s| is| are)|the )/i,
  /\b(?:it|this) (?:looks|seems) like\b/i,
  /\bprobably\b/i,
  /\bmight be (?:because|caused|due)\b/i,
  /\bmost likely\b/i,
  /\bI (?:suspect|guess|think) (?:that )?(?:the |there )/i,
  /\b(?:there(?:'s| is)) (?:probably )?(?:a )?(?:typo|missing|unclosed|stray)\b/i,
]

/** True when the sentence offers a diagnosis rather than reporting what the result said. */
export function inventsCause(sentence: string): boolean {
  return CAUSE_SHAPES.some(r => r.test(sentence))
}

/**
 * Remove invented diagnoses from a reply about a failure.
 *
 * `actual` is the error text the tool returned. A diagnosis survives only when its distinctive
 * words appear in that text. When the result said nothing about a cause, every diagnosis-shaped
 * sentence goes, and what remains is what the result actually said.
 */
export function dropInventedCause(reply: string, actual: string): { content: string; dropped: string[] } {
  const source = String(actual ?? '').toLowerCase()
  const STOP = /^(there|seems|looks|probably|because|about|which|should|previous|system|something|wrong|issue)$/
  const dropped: string[] = []
  const kept = sentences(reply).filter(sentence => {
    if (!inventsCause(sentence)) return true
    const words = sentence.toLowerCase().match(/[a-z]{4,}/g) ?? []
    if (words.some(w => !STOP.test(w) && source.includes(w))) return true
    dropped.push(sentence.trim())
    return false
  })
  return { content: kept.join(' ').trim(), dropped }
}

// One brain decides between talking and acting. When the phrase rules don't recognise a
// request, the local brain is asked this narrow question before a chat answer is written.
export function routeQuestion(message: string, lastAssistant = ''): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: 'Decide what the user\'s latest message asks for. ACT: carry out something on the computer or online right now (open or use an app or website, click or type, search the web, read or change files, download, send, run or check something). TALK: a question, opinion, advice, explanation, plan, writing text, feelings or small talk. Answer with exactly one word: ACT or TALK.' },
    { role: 'user', content: `${lastAssistant ? `Assistant's previous message: ${lastAssistant.slice(0, 400)}\n` : ''}User's message: ${message.slice(0, 600)}` },
  ]
}

export function parseRoute(answer: string): 'act' | 'talk' | null {
  // Words inside (even unfinished) thinking are not the answer.
  const m = answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').match(/\b(ACT|TALK)\b/i)
  return m ? (m[1].toUpperCase() === 'ACT' ? 'act' : 'talk') : null
}
