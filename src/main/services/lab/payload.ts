import { checkTarget, getTarget } from './targets'
import { labRequest } from './http'
import { Budget } from './runner'
import { startRun, updateRun, finishRun, refuseRun } from './runs'
import { audit } from '../security/store'
import { SingleUseGate } from '../approval/singleUse'
import { nanoid } from '../../utils/nanoid'
import type { LabFinding, PayloadResult, RunBudget } from '../../../shared/lab'
import { SPRAY_TTL_MS } from '../../../shared/lab'

/**
 * Payload dispatch: send ONE candidate payload at a target, and observe what came back.
 *
 * This is the missing middle of an XSS find. A specialist can argue that line 207 of a file
 * writes a request value into an attribute without escaping, and the validator can say what
 * evidence would settle it — but neither of them sends anything. This file sends the one
 * request that turns "there is a sink here" into "here is the sink taking my value".
 *
 * Three rules, and they are the whole design:
 *
 *   1. **Nothing is sent without its own approval.** A dispatch is a prepared proposal the
 *      user approves by itself, through the same `SingleUseGate` the password spray uses. The
 *      approval is bound to the exact URL, method, payload and marker: change any of them and
 *      the gate refuses rather than sending something the user did not see.
 *   2. **Nothing is sent to a host that is not the local lab or a declared target.** Loopback
 *      is the local lab by definition and needs no declaration; every other host is checked
 *      against the live declarations, and the refusal names the host before a socket opens.
 *      Cloud metadata is refused whatever is declared.
 *   3. **The result is an OBSERVATION, never a finding.** This file can see that a payload
 *      came back, and in what context. It cannot see whether a browser ran it — that is the
 *      validator's and the browser's job, and `confidence` is pinned to 'observation' here so
 *      a caller cannot accidentally promote it.
 */

// ── Loopback: the local lab ─────────────────────────────────────────────────

/** True for the loopback addresses the local lab binds to, and nothing else. */
export function isLoopbackHost(host: string): boolean {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === '127.0.0.1' || h === '::1' || h === 'localhost'
}

export interface PayloadTargetCheck {
  allowed: boolean
  host: string | null
  port: number | null
  /** The declaration that covered it, or null for the local lab. */
  targetId: string | null
  reason: string
}

/**
 * Is this URL something payload dispatch may send to?
 *
 * Loopback is allowed without a declaration because it is this machine and nothing else can
 * answer on it — that is the local lab, and requiring the user to declare their own loopback
 * would be a ceremony that protects nothing. Every other host must be covered by a live
 * declaration. The check runs before a run record exists, so a refusal leaves no half-run.
 */
export function checkPayloadTarget(rawUrl: string): PayloadTargetCheck {
  let parsed: URL
  try { parsed = new URL(String(rawUrl ?? '')) } catch {
    return { allowed: false, host: null, port: null, targetId: null, reason: `"${rawUrl}" is not a URL` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, host: null, port: null, targetId: null, reason: `only http and https are supported (got ${parsed.protocol})` }
  }
  const host = parsed.hostname.toLowerCase()
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80)

  if (isLoopbackHost(host)) {
    return { allowed: true, host: '127.0.0.1', port, targetId: null, reason: `${host}:${port} is this machine — the local lab` }
  }
  const check = checkTarget(host, port)
  if (!check.declared) {
    return { allowed: false, host, port, targetId: null, reason: check.reason }
  }
  return { allowed: true, host, port, targetId: check.target?.id ?? null, reason: check.reason }
}

// ── The proposal and its gate ───────────────────────────────────────────────

export interface PayloadProposal {
  id: string
  createdAt: string
  expiresAt: string
  /** The declaration, or null when the target is the local lab. */
  targetId: string | null
  targetHost: string
  /** The exact URL that will be requested, with the payload already substituted. */
  url: string
  method: 'GET' | 'POST'
  /** The exact payload text. */
  payload: string
  /** The unique marker inside the payload. */
  marker: string
  /** What the payload is for, in the caller's words. Shown back to the user. */
  why: string
  approved: boolean
  status: 'proposed' | 'approved' | 'sent' | 'refused' | 'failed' | 'discarded'
}

/**
 * The gate. The fingerprint is everything that makes the request what it is, so an approval
 * cannot be spent on a different URL, method, payload or marker.
 */
export const payloadGate = new SingleUseGate<PayloadProposal>(
  p => [p.url, p.method, p.payload, p.marker].join('\u0000'),
  () => Date.now(),
  SPRAY_TTL_MS,
)

/** Put the payload into the URL. `{payload}` is replaced; without it the payload is appended as `v`. */
export function buildPayloadUrl(urlTemplate: string, payload: string): string {
  const raw = String(urlTemplate ?? '')
  if (raw.includes('{payload}')) return raw.split('{payload}').join(encodeURIComponent(payload))
  const u = new URL(raw)
  u.searchParams.set('v', payload)
  return u.toString()
}

export interface PreparePayloadInput {
  urlTemplate: string
  payload: string
  marker: string
  method?: 'GET' | 'POST'
  why?: string
}

export interface PreparePayloadResult {
  ok: boolean
  message: string
  proposal: PayloadProposal | null
}

/**
 * Prepare a dispatch. This SENDS NOTHING: it checks the host, then offers the exact request
 * for the user to approve. An undeclared host is refused here, so a proposal can never even
 * exist for a target the user has not written down.
 */
export function preparePayload(input: PreparePayloadInput): PreparePayloadResult {
  const payload = String(input.payload ?? '')
  const marker = String(input.marker ?? '').trim()
  if (!payload.trim()) return { ok: false, proposal: null, message: 'A payload is required.' }
  if (marker.length < 4) return { ok: false, proposal: null, message: 'Use a marker of at least four characters, so it cannot match by accident.' }
  const method: 'GET' | 'POST' = input.method === 'POST' ? 'POST' : 'GET'
  const url = buildPayloadUrl(String(input.urlTemplate ?? ''), payload)

  const check = checkPayloadTarget(url)
  if (!check.allowed) {
    audit('blocked', `payload dispatch refused against ${check.host ?? url}: ${check.reason}`)
    return { ok: false, proposal: null, message: `${check.reason} Nothing was prepared and nothing was sent.` }
  }

  const proposal: PayloadProposal = {
    id: nanoid(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SPRAY_TTL_MS).toISOString(),
    targetId: check.targetId,
    targetHost: check.host ?? '',
    url,
    method,
    payload,
    marker,
    why: String(input.why ?? '').trim(),
    approved: false,
    status: 'proposed',
  }
  payloadGate.offer(proposal)
  audit('note', `payload prepared for ${proposal.targetHost} (${method}, ${proposal.url.length} chars) — nothing sent`)
  return {
    ok: true,
    proposal,
    message: [
      'Payload prepared — nothing has been sent.',
      `Target: ${proposal.targetHost}${check.targetId ? '' : ' (this machine — the local lab)'}`,
      `Method: ${method}`,
      `URL: ${proposal.url}`,
      `Payload: ${payload}`,
      '',
      'Approve this exact request before it can be sent. Any change to the URL, method, payload or marker invalidates the approval.',
    ].join('\n'),
  }
}

export function decidePayload(id: string, approved: boolean): { ok: boolean; message: string; proposal: PayloadProposal | null } {
  const result = payloadGate.decide(String(id ?? ''), !!approved, {
    unknown: 'That is not a payload Goga is holding. Prepare it again.',
    spent: 'That payload has already been sent once. Prepare it again if you want another.',
    expired: 'That payload proposal expired before it was approved. Nothing was sent. Prepare it again.',
    approved: 'Approved. This exact request, once.',
    denied: 'Discarded. Nothing was sent.',
  })
  if (result.item && result.ok) {
    result.item.approved = true
    result.item.status = 'approved'
  }
  return { ok: result.ok, message: result.message, proposal: result.item }
}

export function listPayloadProposals(): PayloadProposal[] {
  return payloadGate.list().map(p => p.item)
}

export function getPayloadProposal(id: string): PayloadProposal | null {
  return payloadGate.peek(String(id ?? ''))?.item ?? null
}

// ── Dispatching ─────────────────────────────────────────────────────────────

/** The context a value landed in, read from the response around it. */
export interface PayloadObservation {
  found: boolean
  occurrences: number
  context: string | null
  excerpt: string
  /** True when the payload came back as live markup rather than as escaped text. */
  unescaped: boolean
}

const ESCAPED_TAG = /&lt;(img|svg|script|iframe|details|body|math)\b|&quot;|&#0?39;|&#x27;/i
const LIVE_TAG = /<(img|svg|script|iframe|details|body|math)\b[^>]*>/i

/**
 * Look for the payload in a response and say how it came back.
 *
 * The distinction this draws is the one that matters: the payload was *echoed* (the bytes are
 * there), or it was echoed *as markup* (a tag the browser will parse). Escaped bytes are a
 * reflection and nothing more.
 */
export function observePayloadResponse(body: string, payload: string, marker: string): PayloadObservation {
  const text = String(body ?? '')
  const needle = String(payload ?? '').trim()
  const exact = needle ? countOf(text, needle) : 0
  const markerCount = countOf(text, String(marker ?? ''))
  const occurrences = Math.max(exact, markerCount)
  if (!occurrences) {
    return { found: false, occurrences: 0, context: null, excerpt: '', unescaped: false }
  }
  const at = text.indexOf(needle) >= 0 ? text.indexOf(needle) : text.indexOf(String(marker))
  const before = text.slice(Math.max(0, at - 160), at)
  const after = text.slice(at + (needle && text.indexOf(needle) >= 0 ? needle.length : String(marker).length), at + 260)
  const excerpt = `${before}[${needle || marker}]${after}`.slice(0, 420)
  const context = describeContext(before, after)
  const unescaped = exact > 0 && LIVE_TAG.test(`${needle}${after}`) && !ESCAPED_TAG.test(needle)
  return { found: true, occurrences, context, excerpt, unescaped }
}

function countOf(haystack: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  let at = haystack.indexOf(needle)
  while (at >= 0 && n < 50) { n++; at = haystack.indexOf(needle, at + 1) }
  return n
}

function describeContext(before: string, after: string): string {
  const lastOpen = before.lastIndexOf('<')
  const lastClose = before.lastIndexOf('>')
  if (/<script[^>]*>/i.test(before.slice(-400)) && !/<\/script>/i.test(before.slice(-400))) return 'inside a <script> block'
  if (lastOpen > lastClose) {
    const tag = /<([a-z0-9-]+)/i.exec(before.slice(lastOpen))?.[1] ?? 'a tag'
    return after.includes('>') ? `inside an attribute of <${tag}>` : `inside an attribute value of <${tag}>`
  }
  return 'in element text'
}

export interface DispatchOptions {
  /** Called before the claim, so a caller can surface the exact request first. */
  signal?: AbortSignal
  budget?: Partial<RunBudget>
}

/**
 * Send an approved payload once, and record what came back.
 *
 * Order, and nothing is reordered: claim the approval (which checks it is approved, unspent,
 * unexpired and unchanged) → re-check the host is still allowed → open a run record → spend
 * budget → send one request with redirects not followed → record the observation → close the
 * run. A refusal at any step returns before the next.
 */
export async function dispatchPayload(proposalId: string, opts: DispatchOptions = {}): Promise<PayloadResult> {
  const id = String(proposalId ?? '')
  const claim = payloadGate.claim(id, {
    afterExpiry: item => {
      const check = checkPayloadTarget(item.url)
      return check.allowed ? null : { reason: 'undeclared', message: `${check.reason} Nothing was sent.` }
    },
  }, {
    unknown: 'That is not a payload Goga is holding. Prepare it again.',
    spent: 'That payload has already been sent once.',
    notApproved: 'This payload has not been approved. Nothing was sent.',
    expired: 'That payload proposal expired. Nothing was sent.',
    changed: 'That payload changed after it was approved, so nothing was sent.',
  })
  if (!claim.ok || !claim.item) {
    audit('blocked', `payload dispatch refused: ${claim.message}`)
    return refusedResult(claim.message)
  }

  const proposal = claim.item
  proposal.status = 'sent'
  const check = checkPayloadTarget(proposal.url)
  if (!check.allowed) {
    proposal.status = 'refused'
    audit('blocked', `payload dispatch refused against ${check.host}: ${check.reason}`)
    return refusedResult(`${check.reason} Nothing was sent.`)
  }

  const run = startRun({
    tool: 'payload',
    targetId: proposal.targetId ?? 'local-lab',
    targetHost: proposal.targetHost,
    budget: opts.budget,
  })
  const budget = new Budget(run.budget)
  const log: string[] = [`payload dispatch to ${proposal.targetHost} (${proposal.method})`, `url: ${proposal.url}`]

  const res = await labRequest({
    url: proposal.url,
    method: proposal.method,
    body: proposal.method === 'POST' ? `v=${encodeURIComponent(proposal.payload)}` : undefined,
    headers: proposal.method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
    budget,
    signal: opts.signal,
    // Only ever turns on for loopback; checkPayloadTarget already approved the host above.
    allowLocalLab: isLoopbackHost(proposal.targetHost),
  })

  if (!res.ok) {
    proposal.status = 'refused'
    const finding: LabFinding = {
      id: nanoid(), kind: 'note', title: `Payload dispatch stopped: ${proposal.targetHost}`,
      detail: res.refusedReason ?? 'the request did not complete', confidence: 'lead',
      evidence: `url: ${proposal.url}`,
    }
    finishRun(run.id, res.undeclared ? 'refused' : 'failed', res.refusedReason, {
      requests: budget.requests, rawOutput: res.refusedReason ?? '', findings: [finding], log: log.map(text => ({ time: new Date().toISOString(), level: 'warn' as const, text })),
    })
    audit('blocked', `payload dispatch to ${proposal.targetHost} did not send: ${res.refusedReason}`)
    return {
      run, status: null, bytes: 0,
      reflection: { found: false, occurrences: 0, contexts: [], verdict: res.refusedReason ?? 'the request did not complete' },
      confidence: 'observation',
      caveat: 'Nothing was observed because the request was refused or failed. That is not a clean result — it is no result.',
      unescaped: false,
      context: null,
      payloadEchoed: false,
    }
  }

  const observation = observePayloadResponse(res.body, proposal.payload, proposal.marker)
  log.push(
    observation.found
      ? `the payload came back ${observation.context ?? ''} — ${observation.unescaped ? 'as live markup, not escaped text' : 'as text: escaped or altered, so it would not run'}`
      : 'the payload did not come back in the response body',
  )

  const finding: LabFinding = {
    id: nanoid(),
    kind: 'payload',
    title: observation.found
      ? `Payload ${observation.unescaped ? 'returned as markup' : 'returned escaped'} ${observation.context ?? ''}`
      : 'Payload not reflected in the response',
    detail: observation.found
      ? `HTTP ${res.status}, ${res.bytes} bytes. ${observation.occurrences} occurrence(s). ${observation.unescaped ? 'The markup survived — a browser would parse it.' : 'The value came back in a form a browser would not execute.'} This is an observation; only a browser run can confirm execution.`
      : `HTTP ${res.status}, ${res.bytes} bytes. The marker was not in the response body.`,
    confidence: 'observation',
    evidence: observation.excerpt || `url: ${proposal.url}`,
  }

  const finished = finishRun(run.id, 'done', null, {
    requests: budget.requests,
    rawOutput: res.body.slice(0, 4000),
    findings: [finding],
    log: log.map(text => ({ time: new Date().toISOString(), level: 'info' as const, text })),
  })
  audit('request', `payload dispatch to ${proposal.targetHost}: HTTP ${res.status}, ${observation.occurrences} occurrence(s), unescaped=${observation.unescaped}`)

  return {
    run: finished ?? run,
    status: res.status,
    bytes: res.bytes,
    reflection: {
      found: observation.found,
      occurrences: observation.occurrences,
      contexts: observation.context ? [{ context: observation.context, excerpt: observation.excerpt }] : [],
      verdict: observation.found
        ? `${observation.occurrences} occurrence(s) ${observation.context ?? ''}. ${observation.unescaped ? 'The markup survived into the response.' : 'It came back escaped or altered, so reflection alone is not execution.'}`
        : 'the payload did not come back in the readable response',
    },
    confidence: 'observation',
    caveat: 'An observation is not a finding. It says the response carried the payload, and where. Only a browser that actually runs it, checked against a benign control, turns this into an executed bug.',
    unescaped: observation.unescaped,
    context: observation.context,
    payloadEchoed: observation.found,
  }
}

function refusedResult(reason: string): PayloadResult {
  return {
    run: refuseRun('payload', 'not sent', reason),
    status: null, bytes: 0,
    reflection: { found: false, occurrences: 0, contexts: [], verdict: reason },
    confidence: 'observation',
    caveat: reason,
    unescaped: false, context: null, payloadEchoed: false,
  }
}
