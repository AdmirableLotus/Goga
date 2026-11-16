import type {
  EnumerationHit, EnumerationRequest, EnumerationResult, LabFinding, SprayProposal, SprayResult,
  WordlistRequest,
} from '../../../shared/lab'
import { SPRAY_TTL_MS } from '../../../shared/lab'
import { SingleUseGate } from '../approval/singleUse'
import { checkTarget, getTarget } from './targets'
import { Budget, RunLog } from './runner'
import { finishRun, refuseRun, startRun, updateRun } from './runs'
import { bodySimilarity, labRequest } from './http'
import { audit } from '../security/store'
import { nanoid } from '../../utils/nanoid'

/**
 * Credential attack: wordlist generation, username enumeration, and a password spray.
 *
 * The spray is the one capability here with a hard stop that is not negotiable, and the stop
 * is the same one Agentic-Bug-Hunter has: a spray cannot be *prepared and run* in one step.
 * The preparation produces a proposal naming the exact target, the exact username list, the
 * exact password list and the exact rate. That proposal then goes through the single-use
 * approval gate, bound to a fingerprint of all four. Only an approved, unspent proposal whose
 * fingerprint still matches can spray, and only once.
 *
 * That matters because a spray is the single fastest way to lose a bug-bounty account, lock
 * out real users, or commit an offence. Against a VM the user declared, it is ordinary
 * security work. Against anything else it is neither, and this file refuses anything else.
 */

const ENUM_CAVEAT = 'A difference between responses is a lead. Many sites return the same page for every username, and a "user not found" message can be a soft 200 that looks like a hit. Confirm by hand on the account you own before believing it.'

export const SPRAY_CAVEAT = 'A successful-looking login response is an observation, not a finding. Lockouts, rate limits, CAPTCHAs and "invalid password" pages that return 200 are all ways this reads wrong. Use it on accounts you own in a lab, and re-check each hit by hand.'

// ── Wordlist generation ─────────────────────────────────────────────────────

const BASE_WORDS = [
  'admin', 'administrator', 'root', 'user', 'test', 'guest', 'demo', 'support', 'info',
  'webmaster', 'postmaster', 'sales', 'service', 'operator', 'sysadmin', 'backup',
  'dev', 'developer', 'qa', 'staging', 'api', 'system', 'manager', 'office', 'help',
]

const BASE_PASSWORDS = [
  'password', 'Password1', 'Password123', 'admin', 'admin123', 'administrator',
  'letmein', 'welcome', 'welcome1', 'changeme', 'qwerty', 'qwerty123', '123456',
  '12345678', '123456789', 'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess',
  'football', 'baseball', 'shadow', 'master', 'trustno1', 'passw0rd', 'P@ssw0rd',
  'P@ssw0rd!', 'Summer2024', 'Summer2025', 'Winter2024', 'Spring2025', 'Autumn2024',
]

/**
 * Generate a wordlist from a base string.
 *
 * This is a wordlist for the user's own lab: the base name plus the mutations an auditor
 * would try (case, digits, years, common suffixes). It is not scraped from anywhere and it
 * contains no data about any person.
 */
export function generateWordlist(req: WordlistRequest): { words: string[]; note: string } {
  const base = String(req.base ?? '').trim()
  if (!base) return { words: [], note: 'Give a base word — a username, a company name, a hostname.' }
  const limit = Math.max(1, Math.min(Number(req.limit ?? 200), 5000))
  const out: string[] = []
  const push = (w: string) => { if (w && !out.includes(w) && out.length < limit) out.push(w) }

  push(base)
  push(base.toLowerCase())
  push(base.toUpperCase())
  push(base.charAt(0).toUpperCase() + base.slice(1).toLowerCase())
  for (const extra of req.extra ?? []) push(String(extra).trim())

  if (req.mutate !== false) {
    const years = ['2023', '2024', '2025', '2026']
    const suffixes = ['1', '12', '123', '1234', '12345', '!', '!!', '@123', '#1', '2024!', '2025!']
    const prefixes = ['', 'the', 'my']
    for (const p of prefixes) {
      const stem = `${p}${base}`
      push(stem)
      for (const y of years) { push(`${stem}${y}`); push(`${stem}@${y}`); push(`${stem}${y}!`) }
      for (const s of suffixes) push(`${stem}${s}`)
      push(`${stem[0]?.toUpperCase() ?? ''}${stem.slice(1)}${years[1]}`)
    }
    // A leet variant of the base, which is the mutation auditors actually find.
    push(base.replace(/a/gi, '@').replace(/o/gi, '0').replace(/i/gi, '1').replace(/e/gi, '3'))
  }

  return {
    words: out,
    note: `${out.length} candidate(s) generated from "${base}"${req.mutate !== false ? ' with case, year and suffix mutations' : ''}. This is a lab wordlist: it contains nothing about any real person.`,
  }
}

/** A small built-in username list, for enumeration when the user has none. */
export function defaultUsernames(): string[] { return [...BASE_WORDS] }

/** A small built-in password list. Deliberately small: a spray is about rate, not depth. */
export function defaultPasswords(): string[] { return [...BASE_PASSWORDS] }

// ── Username enumeration ────────────────────────────────────────────────────

export interface EnumerateOptions extends EnumerationRequest { baselineUser?: string }

/**
 * Enumerate usernames against a login or "forgot password" endpoint that echoes a difference.
 *
 * The comparison is against a username that certainly does not exist, so "same as a
 * non-existent user" reads as "not found" and anything else reads as a lead. That is a better
 * baseline than a real account, because it needs no account of the user's.
 */
export async function enumerateUsernames(opts: EnumerateOptions, signal?: AbortSignal): Promise<EnumerationResult> {
  const declared = getTarget(opts.targetId)
  if (!declared) {
    const run = refuseRun('enumeration', opts.targetId, 'no such declaration')
    return { run, baseline: null, hits: [], caveat: ENUM_CAVEAT }
  }
  const template = String(opts.urlTemplate ?? '').trim()
  if (!template.includes('{user}')) {
    const run = refuseRun('enumeration', declared.host, 'the URL template has no {user} placeholder')
    return { run, baseline: null, hits: [], caveat: ENUM_CAVEAT }
  }
  const check = checkTarget(template.replace('{user}', 'x'))
  if (!check.declared) {
    const run = refuseRun('enumeration', template, check.reason)
    return { run, baseline: null, hits: [], caveat: ENUM_CAVEAT }
  }
  const names = (Array.isArray(opts.usernames) && opts.usernames.length ? opts.usernames : defaultUsernames())
    .map(String).filter(Boolean).slice(0, 300)

  const run = startRun({ tool: 'enumeration', targetId: declared.id, targetHost: declared.host, budget: opts.budget })
  const budget = new Budget(run.budget)
  const log = new RunLog(lines => updateRun(run.id, { log: lines }))
  const onAbort = () => budget.stop()
  signal?.addEventListener('abort', onAbort)

  log.add('info', `username enumeration on ${template} — ${names.length} name(s)`)
  const hits: EnumerationHit[] = []
  let baseline: { status: number | null; bytes: number } | null = null
  let baselineBody = ''
  let stopReason: string | null = null
  let raw = ''

  try {
    // A name that certainly does not exist is the baseline: "not found" has a shape, and
    // anything that does not match it is what we want to see.
    const marker = `goga_no_such_user_${nanoid()}`
    const base = await labRequest({ url: template.replace('{user}', encodeURIComponent(marker)), budget, signal })
    raw += `GET baseline (${marker}) → ${base.status ?? base.refusedReason} (${base.bytes} bytes)\n`
    if (!base.ok) {
      stopReason = base.refusedReason ?? 'the baseline request failed'
      log.add('error', stopReason)
    } else {
      baseline = { status: base.status, bytes: base.bytes }
      baselineBody = base.body.slice(0, 600)
      for (const name of names) {
        if (signal?.aborted || budget.isStopped) { stopReason = 'stopped by the user'; break }
        if (budget.remaining <= 0) { stopReason = `request cap reached (${budget.maxRequests})`; break }
        const url = template.replace('{user}', encodeURIComponent(name))
        const res = await labRequest({ url, budget, signal })
        raw += `GET ${url} → ${res.status ?? res.refusedReason} (${res.bytes} bytes)\n`
        if (!res.ok) {
          if (res.undeclared) { stopReason = res.refusedReason ?? 'left the declared target'; break }
          continue
        }
        const similarity = bodySimilarity(baselineBody, res.body.slice(0, 600), [marker, name])
        const differs = res.status !== base.status || similarity < 0.98 || Math.abs(res.bytes - base.bytes) > Math.max(24, base.bytes * 0.1)
        hits.push({
          username: name, status: res.status, bytes: res.bytes,
          similarityToBaseline: Number(similarity.toFixed(3)), differs,
          why: differs ? 'the response differs from the non-existent-user baseline' : 'same as a non-existent user',
        })
        if (differs) log.add('result', `${name}: differs (${res.status}, ${res.bytes} bytes)`)
        updateRun(run.id, { requests: budget.requests })
      }
    }
  } catch (err) {
    stopReason = err instanceof Error ? err.message : String(err)
    log.add('error', stopReason)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  const differing = hits.filter(h => h.differs)
  const findings: LabFinding[] = differing.map(h => ({
    id: `user-${h.username}`, kind: 'username',
    title: `username lead: ${h.username} answered differently`,
    detail: `${h.why}. That is a lead about whether the account exists, not a confirmed finding.`,
    confidence: 'lead',
    evidence: `GET ${template.replace('{user}', h.username)} → ${h.status}, ${h.bytes} bytes, similarity ${h.similarityToBaseline}`,
  }))
  const finished = finishRun(run.id, stopReason ? (stopReason.includes('stopped') ? 'stopped' : 'failed') : 'done', stopReason, {
    requests: budget.requests, rawOutput: raw, findings, log: log.all(),
  })
  return { run: finished ?? run, baseline, hits, caveat: ENUM_CAVEAT }
}

// ── The spray ───────────────────────────────────────────────────────────────

/**
 * The spray gate. One gate, module-level, so a proposal prepared by one call can only be
 * claimed by a later call that presents its id — and only after the user approved it.
 */
export const sprayGate = new SingleUseGate<SprayProposal>(
  p => [p.targetId, p.url, [...p.usernames].sort().join(','), [...p.passwords].sort().join(','), String(p.ratePerMinute)].join('|'),
  () => Date.now(),
  SPRAY_TTL_MS,
)

export interface PrepareSprayInput {
  targetId: string
  url: string
  usernames?: string[]
  passwords?: string[]
  ratePerMinute?: number
}

/**
 * Prepare a spray. This sends NOTHING. It produces the proposal the user must approve, and it
 * refuses outright when the target is not declared, so a spray proposal cannot even be made
 * for a host the user has not written down.
 */
export function prepareSpray(input: PrepareSprayInput): { ok: boolean; message: string; proposal: SprayProposal | null } {
  const declared = getTarget(input.targetId)
  if (!declared) {
    audit('blocked', `spray refused: no declaration "${input.targetId}"`)
    return { ok: false, proposal: null, message: 'No such declaration. Declare the target in the Lab first.' }
  }
  const url = String(input.url ?? '').trim()
  const check = checkTarget(url)
  if (!check.declared) {
    audit('blocked', `spray refused against ${url}: ${check.reason}`)
    return { ok: false, proposal: null, message: check.reason }
  }
  const usernames = (input.usernames?.length ? input.usernames : defaultUsernames()).map(String).filter(Boolean).slice(0, 50)
  const passwords = (input.passwords?.length ? input.passwords : defaultPasswords()).map(String).filter(Boolean).slice(0, 50)
  if (!usernames.length || !passwords.length) {
    return { ok: false, proposal: null, message: 'A spray needs at least one username and one password.' }
  }
  const rate = Math.max(1, Math.min(Math.floor(Number(input.ratePerMinute ?? 1)), 30))

  const proposal: SprayProposal = {
    id: nanoid(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SPRAY_TTL_MS).toISOString(),
    targetId: declared.id,
    targetHost: declared.host,
    url,
    usernames,
    passwords,
    ratePerMinute: rate,
    totalRequests: usernames.length * passwords.length,
    approved: false,
    status: 'proposed',
  }
  sprayGate.offer(proposal)
  audit('note', `spray proposed: ${declared.host} ${url} — ${usernames.length} username(s) × ${passwords.length} password(s) at ${rate}/min. Nothing sent.`)
  return {
    ok: true,
    proposal,
    message: [
      `Spray prepared — nothing has been sent.`,
      `Target: ${declared.host} (declared: ${declared.note})`,
      `URL: ${url}`,
      `Usernames (${usernames.length}): ${usernames.join(', ')}`,
      `Passwords (${passwords.length}): ${passwords.length > 10 ? `${passwords.slice(0, 10).join(', ')} …` : passwords.join(', ')}`,
      `Rate: ${rate}/min. Total: ${proposal.totalRequests} request(s)${proposal.totalRequests > 60 ? ' — this will take more than an hour at that rate' : ''}.`,
      '',
      'This needs its own approval, naming this exact target, username list, password list and rate. Approve it here if that is what you mean.',
    ].join('\n'),
  }
}

/** The user's decision about one exact spray. */
export function decideSpray(id: string, approved: boolean): { ok: boolean; message: string; proposal: SprayProposal | null } {
  const result = sprayGate.decide(id, approved, {
    unknown: 'That is not a spray Goga prepared. Prepare it again.',
    spent: 'That spray has already run. It works once.',
    expired: 'That spray proposal expired before it was approved. Nothing was sent.',
    approved: 'Approved. This exact spray, once.',
    denied: 'Discarded. Nothing was sent.',
  })
  if (result.item) {
    result.item.approved = true
    result.item.status = 'approved'
    audit('approve', `spray approved: ${result.item.targetHost} ${result.item.url} — ${result.item.usernames.length} user(s) at ${result.item.ratePerMinute}/min`)
  } else if (!approved) {
    audit('deny', `spray proposal ${id} discarded`)
  }
  return { ok: result.ok, message: result.message, proposal: result.item }
}

/**
 * Run an approved spray.
 *
 * The gate is claimed first. An unapproved, expired, spent or changed proposal never reaches
 * a request. The rate is the one the user approved, not a default, and the total is capped at
 * what the proposal said.
 */
export async function runSpray(proposalId: string, signal?: AbortSignal): Promise<SprayResult | { ok: false; message: string }> {
  const claim = sprayGate.claim(proposalId, {
    afterExpiry: p => {
      const check = checkTarget(p.url)
      if (!check.declared) return { reason: 'undeclared', message: check.reason }
      return null
    },
  }, {
    unknown: 'That is not a spray Goga prepared.',
    spent: 'That spray has already run. Nothing was sent a second time.',
    notApproved: 'This spray has not been approved. Nothing was sent. Prepare it, read it, then approve it.',
    expired: 'That proposal expired. Nothing was sent.',
    changed: 'That proposal changed after it was approved, so nothing was sent.',
  })
  if (!claim.ok || !claim.item) {
    audit('blocked', `spray refused: ${claim.message}`)
    return { ok: false, message: claim.message }
  }
  const proposal = claim.item
  proposal.status = 'sprayed'

  const run = startRun({
    tool: 'spray', targetId: proposal.targetId, targetHost: proposal.targetHost,
    budget: { maxRequests: proposal.totalRequests + 1, maxPerMinute: proposal.ratePerMinute },
  })
  const budget = new Budget({ maxRequests: proposal.totalRequests + 1, maxPerMinute: proposal.ratePerMinute })
  const log = new RunLog(lines => updateRun(run.id, { log: lines }))
  const onAbort = () => budget.stop()
  signal?.addEventListener('abort', onAbort)

  log.add('info', `spray on ${proposal.url}: ${proposal.usernames.length} user(s), ${proposal.passwords.length} password(s), ${proposal.ratePerMinute}/min`)
  const hits: { username: string; password: string; status: number | null; why: string }[] = []
  let stopReason: string | null = null
  let raw = ''
  let failureStatus: number | null = null
  let failureBody = ''

  try {
    // One deliberately-wrong login first: its response is what "failed" looks like here.
    const probe = await labRequest({
      url: proposal.url, method: 'POST', budget, signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(proposal.usernames[0])}&password=${encodeURIComponent(`goga_wrong_${nanoid()}`)}`,
    })
    raw += `POST baseline (wrong password) → ${probe.status ?? probe.refusedReason} (${probe.bytes} bytes)\n`
    if (!probe.ok) {
      stopReason = probe.refusedReason ?? 'the baseline request failed'
    } else {
      failureStatus = probe.status
      failureBody = probe.body.slice(0, 600)

      outer: for (const password of proposal.passwords) {
        for (const username of proposal.usernames) {
          if (signal?.aborted || budget.isStopped) { stopReason = 'stopped by the user'; break outer }
          if (budget.remaining <= 0) { stopReason = `request cap reached (${budget.maxRequests})`; break outer }
          const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
          const res = await labRequest({
            url: proposal.url, method: 'POST', budget, signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
          })
          raw += `POST ${username}:${password.replace(/./g, '*')} → ${res.status ?? res.refusedReason} (${res.bytes} bytes)\n`
          if (!res.ok) { if (res.undeclared) { stopReason = res.refusedReason ?? 'left the declared target'; break outer } continue }
          const similarity = bodySimilarity(failureBody, res.body.slice(0, 600), [username, password])
          const looksDifferent = res.status !== failureStatus || similarity < 0.95
          if (looksDifferent) {
            hits.push({ username, password, status: res.status, why: `status ${res.status} vs ${failureStatus}, body similarity ${similarity.toFixed(2)}` })
            log.add('result', `${username} / ${password}: differs (${res.status})`)
          }
          updateRun(run.id, { requests: budget.requests })
        }
      }
    }
  } catch (err) {
    stopReason = err instanceof Error ? err.message : String(err)
    log.add('error', stopReason)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  const findings: LabFinding[] = hits.map((h, i) => ({
    id: `spray-${i}`, kind: 'note',
    title: `spray result: ${h.username} answered differently`,
    detail: `${h.why}. This is an observation — confirm it by hand on an account you own.`,
    confidence: 'observation',
    evidence: `POST ${proposal.url} username=${h.username} → ${h.status}`,
  }))
  const finished = finishRun(run.id, stopReason ? (stopReason.includes('stopped') ? 'stopped' : 'failed') : 'done', stopReason, {
    requests: budget.requests, rawOutput: raw, findings, log: log.all(),
  })
  audit('request', `spray finished on ${proposal.targetHost} — ${budget.requests} request(s), ${hits.length} differing response(s)`)
  return { run: finished ?? run, proposal, hits, caveat: SPRAY_CAVEAT }
}

export function listSprayProposals(): SprayProposal[] {
  return sprayGate.list().map(p => p.item)
}
