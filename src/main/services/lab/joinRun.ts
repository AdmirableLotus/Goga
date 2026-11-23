import { randomBytes } from 'crypto'
import { audit } from '../security/store'
import { activeProgram } from '../security/store'
import type { PayloadProposal } from './payload'
import { payloadGate } from './payload'
import { decideJoinTarget, type JoinDecision } from './joinScope'
import { checkJoinLimits, JoinBudget, JOIN_CEILING, JOIN_DEFAULT, type JoinLimits, type JoinRequestLine } from './joinBudget'
import { CONTEXT_LABEL, payloadFor, expectedTitle, readSinks, type SinkContext } from './wpXss'
import { publishEntry } from './liveRun'
import type { JoinAttemptView, JoinDraft, JoinSendResult } from '../../../shared/lab'

/**
 * Joining the two halves: a source finding promoted to a live attempt, on a host the user is
 * signed in to.
 *
 * What was separate before is one path here, and each link keeps the job it already had:
 *
 *   1. **The source half** (`wpXss.readSinks`) reads a file and says which line a specialist
 *      would argue about, in what context, and what the validator would accept as proof. That
 *      read is unchanged; this file only carries its answer forward.
 *   2. **The scope half** (`joinScope.decideJoinTarget`) decides whether a live host may be
 *      touched at all, on the program's word or the user's. It runs before a proposal exists,
 *      so a refusal leaves nothing behind and names the rule that decided it.
 *   3. **The approval** is the same `payloadGate` the payload dispatch uses: one approval, bound
 *      to the exact URL, method, payload and marker, spent once, expiring. Nothing new is
 *      trusted here.
 *   4. **The live half** runs in Goga's OWN persistent Brave window — the profile the user signed
 *      in to by hand. Goga navigates that page and reads `document.title`. It never reads a
 *      cookie, a token, a password or the profile's storage; it does not touch the user's own
 *      Brave window; and it cannot sign in, because there is no code here that could.
 *   5. **The verdict** is a fixed rule: the payload counts as EXECUTED only when `document.title`
 *      became the nonce that only the injected script could set. A marker in the response body is
 *      a reflection, and reflection is never reported as execution.
 *
 * The run's volume is capped in `joinBudget`, and every request is one line in the live log.
 */

/** What a promotion carries from the source half to the live attempt. */
export interface JoinPrepareInput {
  /** The folder and file the specialist read, and the line it argued about. */
  root: string
  file: string
  line?: number
  /** The live URL the payload will be sent to. `{payload}` is replaced; otherwise appended as `v`. */
  targetUrl: string
  /** The limits the user chose. Omitted means JOIN_DEFAULT; above JOIN_CEILING is refused. */
  limits?: Partial<JoinLimits>
  /** The method. GET only: a live XSS proof is a request a browser can be pointed at. */
  method?: 'GET'
}

export interface JoinPrepareResult {
  ok: boolean
  message: string
  /** The proposal the user approves. Null whenever nothing was prepared. */
  attempt: JoinAttemptView | null
}

/** The join-specific half of a prepared attempt, kept beside the gate's own record. */
interface JoinContext {
  source: {
    root: string
    file: string
    line: number
    excerpt: string
    context: SinkContext
    contextLabel: string
    observable: string | null
    wouldConfirm: string[]
    /** The exact line from the file, so the live attempt is traceable to the code. */
    evidenceLine: string
  }
  url: string
  payload: string
  marker: string
  nonce: string
  expectedTitle: string
  authority: { via: string | null; rule: string | null; reason: string }
  program: { id: string; name: string; source: string } | null
  limits: JoinLimits
  budget: JoinBudget
  /** Set once a send has been claimed, so the same attempt cannot be run twice. */
  sent: boolean
  lastResult: JoinSendResult | null
}

const contexts = new Map<string, JoinContext>()

/** Build the live URL: `{payload}` replaced, else the payload appended as `v`. */
function liveUrl(template: string, payload: string): string {
  const raw = String(template ?? '')
  if (raw.includes('{payload}')) return raw.split('{payload}').join(encodeURIComponent(payload))
  const u = new URL(raw)
  u.searchParams.set('v', payload)
  return u.toString()
}

function view(id: string, proposal: PayloadProposal, ctx: JoinContext, approved: boolean): JoinAttemptView {
  return {
    id,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    url: proposal.url,
    host: proposal.targetHost,
    method: proposal.method,
    payload: proposal.payload,
    marker: proposal.marker,
    expectedTitle: ctx.expectedTitle,
    approved,
    status: proposal.status,
    authority: ctx.authority,
    program: ctx.program,
    source: {
      file: ctx.source.file,
      line: ctx.source.line,
      excerpt: ctx.source.excerpt,
      context: ctx.source.contextLabel,
      observable: ctx.source.observable,
      wouldConfirm: ctx.source.wouldConfirm,
      evidenceLine: ctx.source.evidenceLine,
    },
    limits: ctx.limits,
    sent: ctx.sent,
    result: ctx.lastResult,
  }
}

/**
 * Promote one source finding to a proposed live attempt. SENDS NOTHING.
 *
 * Order, and nothing is reordered: read the source and take the specialist's own sink and
 * payload → validate the limits → decide the host (which refuses before anything exists) →
 * offer the proposal to the single-use gate. A refusal at any step returns before the next,
 * so an out-of-scope host, a deny rule, a missing program and an over-ceiling limit all leave
 * no proposal behind.
 */
export function prepareJoin(input: JoinPrepareInput): JoinPrepareResult {
  const root = String(input?.root ?? '')
  const file = String(input?.file ?? '')
  const targetUrl = String(input?.targetUrl ?? '').trim()

  let reading: ReturnType<typeof readSinks>
  try { reading = readSinks(root, file) } catch (err) {
    return { ok: false, attempt: null, message: `The source could not be read: ${err instanceof Error ? err.message : String(err)}. Nothing was prepared.` }
  }
  const pool = input?.line !== undefined
    ? [...reading.candidates, ...reading.dropped].filter(c => c.line === Number(input.line))
    : reading.candidates
  const chosen = pool[0] ?? null
  if (!chosen) {
    return {
      ok: false, attempt: null,
      message: reading.dropped.length
        ? `The validator kept nothing in ${reading.file}${input?.line ? ` at line ${input.line}` : ''}, so there is no source finding to promote. Nothing was prepared.`
        : `The XSS specialist found no sink worth arguing about in ${reading.file}, so there is nothing to promote. Nothing was prepared.`,
    }
  }
  if (chosen.outcome !== 'confirmed-observable') {
    return {
      ok: false, attempt: null,
      message: `The validator dismissed line ${chosen.line} (${chosen.outcome}): ${chosen.why}. A hypothesis only a reproduction confirmed is reproduction-only; it is not promoted to a live attempt.`,
    }
  }

  const limitsCheck = checkJoinLimits(input?.limits)
  if (!limitsCheck.ok) {
    audit('blocked', `joining run refused: ${limitsCheck.reason}`)
    return { ok: false, attempt: null, message: limitsCheck.reason }
  }

  // The unique string inside the payload. It is the same value the script sets as the title, so
  // "the marker appeared" and "the title changed" are two observations of one string — which is
  // what makes "reflected" and "executed" tell apart cleanly instead of ambiguously.
  const nonce = randomBytes(5).toString('hex')
  const payload = payloadFor(chosen.context, nonce)
  const expected = expectedTitle(nonce)
  const marker = expected

  let url: string
  try { url = liveUrl(targetUrl, payload) } catch {
    return { ok: false, attempt: null, message: `"${targetUrl}" is not a URL. Nothing was prepared.` }
  }

  // The scope decision. Before this line there is no URL object, no proposal and no request.
  const decision: JoinDecision = decideJoinTarget(url)
  if (!decision.allowed) {
    audit('blocked', `joining run refused against ${decision.host ?? url}: ${decision.reason}`)
    const named = decision.refusal === 'deny-rule'
      ? `The program's deny rule decided it: ${decision.rule ?? '(rule not named)'}. ${decision.reason}`
      : decision.refusal === 'no-program'
        ? 'No program is imported, so nothing authorises a request to a public host.'
        : decision.reason
    return { ok: false, attempt: null, message: `${named} Nothing was prepared and nothing was sent.` }
  }

  const proposal: PayloadProposal = {
    id: `join-${randomBytes(8).toString('hex')}`,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    targetId: decision.targetId,
    targetHost: decision.host ?? '',
    url,
    method: 'GET',
    payload,
    marker,
    why: `promoted from ${chosen.file}:${chosen.line}`,
    approved: false,
    status: 'proposed',
  }

  const program = activeProgram()
  const ctx: JoinContext = {
    source: {
      root, file: reading.file, line: chosen.line, excerpt: chosen.excerpt,
      context: chosen.context, contextLabel: CONTEXT_LABEL[chosen.context],
      observable: chosen.observable, wouldConfirm: chosen.wouldConfirm,
      evidenceLine: `${reading.file}:${chosen.line}: ${chosen.excerpt}`,
    },
    url, payload, marker, nonce, expectedTitle: expected,
    authority: { via: decision.via, rule: decision.rule, reason: decision.reason },
    program: program ? { id: program.id, name: program.name, source: program.source } : null,
    limits: limitsCheck.limits,
    budget: new JoinBudget(limitsCheck.limits),
    sent: false,
    lastResult: null,
  }
  contexts.set(proposal.id, ctx)
  // Offered to the same gate the payload dispatch uses. One approval, one exact request.
  payloadGate.offer(proposal)
  audit('note', `joining attempt prepared for ${proposal.targetHost} from ${chosen.file}:${chosen.line} (${limitsCheck.reason}) — nothing sent`)

  return {
    ok: true,
    attempt: view(proposal.id, proposal, ctx, false),
    message: [
      'A live attempt is prepared — nothing has been sent.',
      `From source: ${reading.file}:${chosen.line} — ${CONTEXT_LABEL[chosen.context]}`,
      `The line: ${chosen.excerpt}`,
      chosen.observable ? `The validator's observable: ${chosen.observable}` : 'The validator named no observable.',
      '',
      `Target: ${proposal.targetHost} (allowed by ${decision.via === 'program' ? `the program's scope: ${decision.rule ?? 'eligible asset'}` : decision.via === 'declaration' ? 'your declaration' : decision.via})`,
      `URL: ${proposal.url}`,
      `Payload: ${payload}`,
      '',
      `Limits: ${limitsCheck.reason} The ceiling is ${JOIN_CEILING.maxRequests} requests at ${JOIN_CEILING.maxPerMinute} a minute.`,
      'Approve this exact request before it can be sent. Any change to the URL, method, payload or marker invalidates the approval.',
    ].join('\n'),
  }
}

/** Approve or discard one prepared attempt. The same gate and the same binding as a dispatch. */
export function decideJoin(id: string, approved: boolean): { ok: boolean; message: string; attempt: JoinAttemptView | null } {
  const ctx = contexts.get(String(id ?? ''))
  if (!ctx) return { ok: false, message: 'That is not a joining attempt Goga is holding. Prepare it again.', attempt: null }
  const result = payloadGate.decide(String(id ?? ''), !!approved, {
    unknown: 'That is not a joining attempt Goga is holding. Prepare it again.',
    spent: 'That attempt has already been sent once. Prepare a new one if you want another.',
    expired: 'That attempt expired before it was approved. Nothing was sent. Prepare it again.',
    approved: 'Approved. This exact request, once.',
    denied: 'Discarded. Nothing was sent.',
  })
  const proposal = result.item as PayloadProposal | null
  if (!result.ok || !proposal) return { ok: result.ok, message: result.message, attempt: null }
  proposal.approved = true
  proposal.status = 'approved'
  return { ok: true, message: result.message, attempt: view(proposal.id, proposal, ctx, true) }
}

/** What the page shows for the attempts being held. Read-only. */
export function listJoins(): JoinAttemptView[] {
  const out: JoinAttemptView[] = []
  for (const peek of payloadGate.list()) {
    const ctx = contexts.get(peek.item.id)
    if (!ctx) continue
    out.push(view(peek.item.id, peek.item, ctx, peek.approved))
  }
  return out
}

// ── The live send, in the Brave session ─────────────────────────────────────

/** The slice of Goga's Brave session a send needs. Injected, so the rule is testable. */
export interface BraveJoinDriver {
  /** The session's own state. 'open' is the only state a live attempt may run in. */
  state(): string
  /**
   * Navigate Goga's own Brave page to one URL and report what the page did.
   * This reads the DOM only: no cookies, no storage, no credentials.
   */
  visit(url: string): Promise<{
    status: number | null
    title: string
    /** The visible text, so a reflected marker can be reported as a reflection. */
    bodyText: string
  }>
}

export interface JoinSendOptions {
  driver?: BraveJoinDriver
  /** Published once per request: host, outcome, elapsed. The live log line. */
  onRequest?: (line: JoinRequestLine) => void
}

/** The message a not-signed-in session gets. It says exactly what is wrong and whose job it is. */
export const NOT_SIGNED_IN =
  'Goga\'s Brave window is not signed in. A sign-in is yours — do it by hand in that window, then tell me you are signed in. Nothing was sent.'

/**
 * Send an approved attempt once, in Goga's own Brave session, and record what happened.
 *
 * The order is the guarantee: claim the approval (approved, unspent, unexpired, unchanged) →
 * re-check the host is still allowed → require a signed-in session → spend one unit of the
 * run's cap → visit the exact URL → read the title and the body → record an observation and,
 * only when the title became the nonce, a confirmed finding.
 *
 * A refusal at any step returns before the next, and nothing is sent.
 */
export async function sendJoin(id: string, opts: JoinSendOptions = {}): Promise<JoinSendResult> {
  const key = String(id ?? '')
  const ctx = contexts.get(key)
  if (!ctx) {
    return refusal('That is not a joining attempt Goga is holding. Prepare it again.')
  }

  const claim = payloadGate.claim(key, {
    afterExpiry: item => {
      const check = decideJoinTarget((item as PayloadProposal).url)
      return check.allowed ? null : { reason: 'out-of-scope', message: `${check.reason} Nothing was sent.` }
    },
  }, {
    unknown: 'That is not a joining attempt Goga is holding. Prepare it again.',
    spent: 'That attempt has already been sent once.',
    notApproved: 'This attempt has not been approved. Nothing was sent.',
    expired: 'That attempt expired. Nothing was sent.',
    changed: 'That attempt changed after it was approved, so nothing was sent.',
  })
  if (!claim.ok || !claim.item) {
    audit('blocked', `joining send refused: ${claim.message}`)
    return refusal(claim.message)
  }
  const proposal = claim.item as PayloadProposal

  // Re-check after the claim: a program import can be removed, or a declaration revoked,
  // between approving and sending, and the claim's own hook only ran the expiry path.
  const decision = decideJoinTarget(proposal.url)
  if (!decision.allowed) {
    proposal.status = 'refused'
    audit('blocked', `joining send refused against ${proposal.targetHost}: ${decision.reason}`)
    return refusal(`${decision.reason} Nothing was sent.`)
  }

  const driver = opts.driver
  if (!driver) {
    proposal.status = 'refused'
    return refusal('No Brave session is attached, so nothing was sent. Open Brave for Cantina first.')
  }
  if (driver.state() !== 'open') {
    proposal.status = 'refused'
    audit('blocked', `joining send refused: ${proposal.targetHost} — the Brave session is not signed in`)
    publishEntry('stop', 'Not signed in', NOT_SIGNED_IN)
    return refusal(NOT_SIGNED_IN)
  }

  const spent = await ctx.budget.spend()
  if (spent === 'cap') {
    proposal.status = 'refused'
    const msg = `This run's cap of ${ctx.budget.maxRequests} request(s) is reached. Nothing more was sent; start a new attempt if you need another request.`
    publishEntry('stop', 'Cap reached', msg)
    return refusal(msg)
  }
  if (spent === 'stopped') {
    proposal.status = 'refused'
    const msg = 'The run was stopped, so nothing more was sent.'
    publishEntry('stop', 'Stopped', msg)
    return refusal(msg)
  }

  proposal.status = 'sent'
  ctx.sent = true
  const started = Date.now()
  const index = ctx.budget.requests

  let visit: Awaited<ReturnType<BraveJoinDriver['visit']>>
  try {
    visit = await driver.visit(proposal.url)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.lastResult = refusal(`The page could not be visited: ${message}. Nothing was observed.`)
    const line: JoinRequestLine = { host: proposal.targetHost, outcome: `failed — ${message}`, elapsedMs: Date.now() - started, index }
    opts.onRequest?.(line)
    publishEntry('response', `GET ${proposal.targetHost} — failed`, `${message} · ${line.elapsedMs} ms`)
    return ctx.lastResult
  }

  const elapsed = Date.now() - started
  // The one rule that turns an observation into a finding: the title is a value ONLY running
  // script could have set. Presence of the marker in the body is a reflection, nothing more.
  const executed = visit.title.trim() === ctx.expectedTitle
  const markerInBody = visit.bodyText.includes(ctx.marker) || visit.bodyText.includes(ctx.expectedTitle)
  const observationContext = executed
    ? 'the page title, set by the running script'
    : markerInBody
      ? 'in the page text — reflected, not executed'
      : 'not present in the page'

  const outcome = executed
    ? `executed — document.title became "${ctx.expectedTitle}"`
    : markerInBody
      ? `reflected, not executed (HTTP ${visit.status ?? '—'})`
      : `no marker came back (HTTP ${visit.status ?? '—'})`

  const line: JoinRequestLine = { host: proposal.targetHost, outcome, elapsedMs: elapsed, index }
  opts.onRequest?.(line)
  publishEntry('response', `GET ${proposal.targetHost} — ${executed ? 'executed' : markerInBody ? 'reflected' : 'no marker'}`, `${outcome} · ${elapsed} ms · request ${index} of at most ${ctx.budget.maxRequests}`)

  const result: JoinSendResult = {
    sent: true,
    url: proposal.url,
    host: proposal.targetHost,
    status: visit.status,
    title: visit.title,
    expectedTitle: ctx.expectedTitle,
    executed,
    reflected: markerInBody,
    markerInBody,
    observationContext,
    elapsedMs: elapsed,
    // A finding needs the observable actually met. Nothing else promotes it.
    confidence: executed ? 'confirmed' : 'observation',
    caveat: executed
      ? 'The payload ran in Goga\'s own Brave window: the page title became a value only the injected script could set. This is execution on a host the program\'s scope (or your declaration) allowed.'
      : markerInBody
        ? 'The marker came back in the page, but the payload did not run. That is a reflection, and a reflection is never reported as execution.'
        : 'The request completed and nothing came back. That is not a clean result — it is no result.',
  }
  ctx.lastResult = result
  proposal.status = 'sent'
  audit('request', `joining send to ${proposal.targetHost}: HTTP ${visit.status ?? '—'}, executed=${executed}, reflected=${markerInBody}, ${elapsed}ms`)
  return result
}

function refusal(reason: string): JoinSendResult {
  return {
    sent: false, url: '', host: '', status: null, title: '', expectedTitle: '',
    executed: false, reflected: false, markerInBody: false, observationContext: '',
    elapsedMs: 0, confidence: 'observation', caveat: reason,
  }
}

/** The kill switch for a joining run: stop its budget and abort what is in flight. */
export function stopJoin(id: string): { ok: boolean; message: string } {
  const ctx = contexts.get(String(id ?? ''))
  if (!ctx) return { ok: false, message: 'No such joining attempt is held.' }
  ctx.budget.stop()
  publishEntry('stop', 'Run stopped', 'The kill switch was used. No further request will be sent.')
  audit('note', `joining run stopped by the kill switch (${ctx.budget.requests} request(s) had been made)`)
  return { ok: true, message: `Stopped. ${ctx.budget.requests} request(s) had been made; nothing more will be sent.` }
}

// ── The draft report ────────────────────────────────────────────────────────

/**
 * Severity, mapped to the program's own published definitions.
 *
 * This does not invent a rating. It reads the program's severity table (as imported) and says
 * which of its rows the finding falls under, quoting the row. When the program published no
 * usable table, it says so and offers the nearest category with the reason it could not be
 * matched — an opinion, labelled as one.
 */
export function severityFor(program: { entryBar?: { rewards: { severity: string; amount: string }[] } } | null, executed: boolean): { level: 'info' | 'low' | 'medium' | 'high' | 'critical'; basis: string } {
  const rows = program?.entryBar?.rewards ?? []
  const high = rows.find(r => /high/i.test(r.severity))
  const critical = rows.find(r => /critical/i.test(r.severity))
  if (executed && high) {
    return { level: 'high', basis: `The program's own table lists "${high.severity}" at ${high.amount}. A reflected XSS proven by execution is High in programs that publish this row for it.` }
  }
  if (executed && critical) {
    return { level: 'high', basis: `The program's table lists Critical at ${critical.amount}; this was rated High because the impact shown is script execution in a page context, not remote code execution or privileged account takeover. That is an assessment, not the program's.` }
  }
  if (executed) {
    return { level: 'high', basis: 'The program published no severity table this could read, so this is an assessment: reflected XSS proven by execution, rated High.' }
  }
  return { level: 'low', basis: 'Nothing was executed, so no severity is claimed. A reflection alone would be Low at most, and is not a finding.' }
}

/**
 * Assemble a draft from a confirmed finding. Local only — there is no submission code anywhere
 * in Goga, and this function writes nothing that could be sent.
 */
export function buildJoinDraft(id: string, notes: { verifiedByUser: boolean; aiExtent?: string } = { verifiedByUser: false }): { ok: boolean; message: string; draft: JoinDraft | null } {
  const ctx = contexts.get(String(id ?? ''))
  if (!ctx) return { ok: false, message: 'No such joining attempt is held.', draft: null }
  const result = ctx.lastResult
  if (!result || !result.executed) {
    return {
      ok: false, draft: null,
      message: 'There is no confirmed finding to draft. A draft is only assembled from a live attempt whose payload actually ran — a reflection cannot become a report.',
    }
  }
  const program = activeProgram()
  const sev = severityFor(program as unknown as { entryBar?: { rewards: { severity: string; amount: string }[] } } | null, true)

  const draft: JoinDraft = {
    program: ctx.program ? `${ctx.program.name} (${ctx.program.source})` : 'No program is imported — a draft needs one',
    asset: ctx.url,
    inScopeRule: ctx.authority.rule ?? ctx.authority.reason,
    vulnerabilityClass: `Reflected Cross-Site Scripting (XSS) — ${ctx.source.contextLabel}`,
    sourceEvidence: [
      `File: ${ctx.source.file}, line ${ctx.source.line}`,
      `The line: ${ctx.source.excerpt}`,
      ctx.source.observable ? `The validator's observable: ${ctx.source.observable}` : 'The validator named no observable.',
      ctx.source.wouldConfirm.length ? `What the validator said would confirm it: ${ctx.source.wouldConfirm.join(' ')}` : '',
    ].filter(Boolean).join('\n'),
    liveEvidence: [
      `Request: GET ${ctx.url}`,
      `Response: HTTP ${result.status ?? '—'}; document.title became "${result.expectedTitle}" (a value only the injected script could set).`,
      `Payload: ${ctx.payload}`,
      `Marker: ${ctx.marker}`,
      `Elapsed: ${result.elapsedMs} ms; request ${ctx.budget.requests} of at most ${ctx.budget.maxRequests} for this run.`,
    ].join('\n'),
    steps: [
      `1. Open ${ctx.url} in a browser.`,
      `2. The response writes the parameter into ${ctx.source.contextLabel} without escaping, so the injected <img onerror> is parsed as markup.`,
      `3. The script runs and sets document.title to "${result.expectedTitle}".`,
      '4. That title is a value only the injected script produces, so it distinguishes execution from a reflection.',
    ].join('\n'),
    severity: sev.level,
    severityBasis: sev.basis,
    remediation: [
      `HTML-escape the value before it is written into ${ctx.source.contextLabel}, with the encoding that context requires.`,
      'Where a template layer exists, rely on its automatic contextual escaping rather than concatenating strings.',
      'Add a Content-Security-Policy that forbids inline script and event-handler attributes, as defence in depth.',
    ].join('\n'),
    aiDisclosure: [
      'AI assistance was used, and this is what it did: it read the source file, argued that the line is a sink, and proposed the payload; it prepared and sent the single approved request into the tester\'s own signed-in browser session, and it recorded the result.',
      notes.aiExtent ? `In the tester's own words: ${notes.aiExtent}` : '',
      notes.verifiedByUser
        ? 'The tester has confirmed by hand that the described behaviour reproduces, and takes responsibility for this report and for following the program\'s rules.'
        : 'This draft has not yet been verified by hand. Until the tester reproduces it themselves, it is a draft and nothing more.',
    ].filter(Boolean).join('\n'),
    caveat: 'This is a draft held in Goga\'s local store. A confirmed finding on a program\'s site is not a bounty — the program decides, and the submission is yours.',
    createdAt: new Date().toISOString(),
  }
  audit('finding', `joining draft assembled from ${ctx.source.file}:${ctx.source.line} — ${sev.level}, not submitted`)
  return { ok: true, message: `Draft assembled for ${draft.asset}. It stays here; nothing was submitted.`, draft }
}

/** Test hook: forget held attempts. Not used by the app. */
export function resetJoinsForTests(): void {
  for (const peek of payloadGate.list()) if (contexts.has(peek.item.id)) payloadGate.clear()
  contexts.clear()
}
