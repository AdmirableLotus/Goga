import { ToolRegistry } from './registry'
import type { ScanStepId, TargetKind } from '../../shared/lab'
import {
  declareTarget, revokeTarget, listTargets, liveTargets,
} from '../services/lab/targets'
import { listRuns, getRun } from '../services/lab/runs'
import { killAll, isRunning, runningCount, killedTotal } from '../services/lab/runner'
import { portScan, runPipeline, toolAvailability, SCAN_TOOLS } from '../services/lab/scanner'
import { idorTest } from '../services/lab/idor'
import {
  generateWordlist, enumerateUsernames, prepareSpray, decideSpray, runSpray, listSprayProposals,
} from '../services/lab/credentials'
import { TARGET_KIND_LABEL } from '../../shared/lab'

/**
 * The Lab tools, for chat.
 *
 * These are the active half of the bug-bounty work: they reach a target, run external
 * scanners, compare responses, and — behind a second approval — spray passwords. Every one of
 * them is gated by a declaration first (targets.ts refuses any host the user has not written
 * down), and the ones that touch a target are `critical`, so Goga also forces an in-chat
 * approval of that exact run before it starts. The password spray has a third gate on top: its
 * own single-use proposal the user approves by itself.
 *
 * The boundary, in one sentence: a declaration is the user's statement that they own or are
 * authorised to test the host; Goga records it, holds every tool to it, and refuses cloud
 * metadata endpoints even when declared.
 */

const reg = ToolRegistry.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })
const abort = (ctx: { abortSignal: AbortSignal }) => ctx.abortSignal

// ── Declaring and listing scope ─────────────────────────────────────────────

reg.register({
  name: 'lab.declareTarget',
  description: 'Declare a target you own or are authorised to test, so the Lab tools will accept it. A declaration needs a host (hostname, IPv4, or CIDR), an optional port range, a kind, and a one-sentence note saying what authorises it. This is the gate: every active Lab tool refuses any host that is not covered by a live declaration. Cloud metadata endpoints are refused even when declared. Declaring a host does not scan it.',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: 'Hostname, IPv4 address, or CIDR block, e.g. 127.0.0.1, 192.168.56.10, 10.0.0.0/24, or lab.example.test.' },
      ports: { type: 'string', description: 'Optional port range, e.g. "80,443,8080" or "1-1024". Empty means every port.' },
      kind: { type: 'string', enum: ['local-vm', 'own-server', 'ctf', 'authorized-engagement', 'lab-container'], description: 'What the target is.' },
      note: { type: 'string', description: 'Required. One sentence on what authorises this, e.g. "my VirtualBox Ubuntu VM on the host-only network".' },
    },
    required: ['host', 'kind', 'note'],
  },
  riskLevel: 'medium', reversible: true, category: 'system',
}, async p => {
  const result = declareTarget({
    host: String(p.host ?? ''),
    ports: p.ports ? String(p.ports) : '',
    kind: String(p.kind ?? 'own-server') as TargetKind,
    note: String(p.note ?? ''),
  })
  if (!result.ok) return { success: false, error: result.message }
  return { success: true, data: `${result.message}\n\nTarget id: ${result.target?.id}` }
})

reg.register({
  name: 'lab.revokeTarget',
  description: 'Revoke a declared target by its id. Every Lab tool will refuse it from now on. The record is kept, marked revoked, so the audit trail still shows it was once declared.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The target id from lab.declareTarget or lab.listTargets.' },
      reason: { type: 'string', description: 'Optional reason, recorded in the audit trail.' },
    },
    required: ['id'],
  },
  riskLevel: 'low', reversible: false, category: 'system',
}, async p => {
  const result = revokeTarget(String(p.id ?? ''), String(p.reason ?? ''))
  return result.ok ? { success: true, data: result.message } : { success: false, error: result.message }
})

reg.register({
  name: 'lab.listTargets',
  description: 'List the declared targets: which hosts the Lab will accept, their port ranges, their kind, and what the user said authorises each. Read-only.',
  parameters: { type: 'object', properties: { all: { type: 'boolean', description: 'Include revoked declarations too.' } } },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  const targets = p.all ? listTargets() : liveTargets()
  if (!targets.length) return { success: true, data: 'No targets are declared. Use lab.declareTarget before any active tool will run.' }
  return { success: true, data: targets.map(t => [
    `${t.host}${t.ports ? ` ports ${t.ports}` : ' (all ports)'}${t.revokedAt ? '  [REVOKED]' : ''}`,
    `  id: ${t.id}`,
    `  ${TARGET_KIND_LABEL[t.kind]} — "${t.note}"`,
    `  declared ${t.declaredAt.slice(0, 10)}${t.revokedAt ? `, revoked ${t.revokedAt.slice(0, 10)} (${t.revokedReason})` : ''}`,
  ].join('\n')).join('\n\n') }
})

reg.register({
  name: 'lab.tools',
  description: 'Which external scanner binaries (subfinder, httpx, nuclei, katana, ffuf, nmap) are on PATH right now, and which are missing. Read-only. Missing ones can be installed from the Setup area.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'system',
}, async () => {
  try {
    const avail = await toolAvailability()
    const known = SCAN_TOOLS.map(t => t.id)
    return { success: true, data: [
      'External tools the Lab can drive:',
      ...avail.map(a => `  ${a.installed ? '✓' : '✗'} ${a.name}${a.installed && a.path ? ` — ${a.path}` : a.installed ? '' : ' — not installed'}`),
      '',
      `The built-in port scan needs none of these. Steps: ${known.join(', ')}.`,
    ].join('\n') }
  } catch (err) { return failure(err) }
})

// ── Runs and the kill switch ────────────────────────────────────────────────

reg.register({
  name: 'lab.runs',
  description: 'List recent Lab runs — tool, target, state (running, done, stopped, refused, failed), requests made, and findings. Pass an id for one run in full, including its raw tool output. Read-only.',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'Optional run id for the full record.' }, limit: { type: 'number', description: 'How many to list (default 20).' } } },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  if (p.id) {
    const run = getRun(String(p.id))
    if (!run) return { success: false, error: `no run ${p.id}` }
    return { success: true, data: [
      `${run.tool} against ${run.targetHost} — ${run.state}`,
      `started ${run.startedAt}${run.endedAt ? `, ended ${run.endedAt}` : ''}`,
      `requests: ${run.requests} / ${run.budget.maxRequests} budget${run.stopReason ? `\nstop reason: ${run.stopReason}` : ''}`,
      '',
      `Findings (${run.findings.length}):`,
      ...(run.findings.length ? run.findings.map(f => `  • [${f.confidence}] ${f.kind}: ${f.title}\n    ${f.detail}\n    evidence: ${f.evidence}`) : ['  none']),
      '',
      run.rawOutput ? `Raw output:\n${run.rawOutput.slice(0, 4000)}` : '',
    ].filter(Boolean).join('\n') }
  }
  const limit = Number(p.limit ?? 20)
  const runs = listRuns(limit)
  if (!runs.length) return { success: true, data: 'No Lab runs yet.' }
  return { success: true, data: runs.map(r => `[${r.state}] ${r.tool} → ${r.targetHost} · ${r.requests} req · ${r.findings.length} finding(s) · ${r.startedAt.slice(0, 19)}  (id ${r.id})`).join('\n') }
})

reg.register({
  name: 'lab.stop',
  description: 'The kill switch: stop every Lab process that is running right now. Safe to call at any time; it is what the emergency stop calls. Returns how many were stopped.',
  parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Optional reason for the log.' } } },
  riskLevel: 'low', reversible: false, category: 'system',
}, async p => {
  const before = runningCount()
  const result = killAll(String(p.reason ?? 'stopped from chat'))
  return { success: true, data: `${result.killed} process(es) stopped${before ? '' : ' (none were running)'}. Total stopped so far: ${killedTotal()}. Running now: ${isRunning() ? 'yes' : 'no'}.` }
})

// ── Active tools: target-touching, so critical (second gate is the in-chat approval) ──

reg.register({
  name: 'lab.portScan',
  description: 'Run the built-in TCP port check against a declared target — no external binary needed. Refuses any host not covered by a live declaration, and any port outside the declaration\'s range. Critical: Goga will ask you to approve this exact run first.',
  parameters: {
    type: 'object',
    properties: {
      targetId: { type: 'string', description: 'The declared target id from lab.listTargets.' },
      ports: { type: 'string', description: 'Optional ports to check, e.g. "22,80,443". Still checked against the declaration. Default: the declaration\'s ports.' },
      maxRequests: { type: 'number', description: 'Optional cap on connections for this run (default 200).' },
    },
    required: ['targetId'],
  },
  riskLevel: 'critical', reversible: false, category: 'process',
}, async (p, ctx) => {
  try {
    const result = await portScan({
      targetId: String(p.targetId ?? ''),
      ports: p.ports ? String(p.ports) : undefined,
      budget: p.maxRequests ? { maxRequests: Number(p.maxRequests) } : undefined,
    }, abort(ctx))
    return { success: result.run.state !== 'refused', data: describeScan(result), error: result.run.state === 'refused' ? result.run.stopReason ?? 'refused' : undefined }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'lab.scan',
  description: 'Run the external scanner pipeline (subfinder, port scan, httpx, katana, nuclei, ffuf) against a declared target. Each step is re-checked against the declaration with the host it will actually use, and steps whose binary is missing are reported as skipped, not failed. Critical: Goga will ask you to approve this exact run first.',
  parameters: {
    type: 'object',
    properties: {
      targetId: { type: 'string', description: 'The declared target id.' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Optional subset/order of steps: subfinder, portscan, httpx, katana, nuclei, ffuf.' },
      url: { type: 'string', description: 'The URL the crawl and template steps start from. Must be on the declared host.' },
      wordlist: { type: 'string', description: 'Path to a wordlist file, required only for the ffuf step.' },
      maxRequests: { type: 'number', description: 'Optional request cap for the run (default 200).' },
    },
    required: ['targetId'],
  },
  riskLevel: 'critical', reversible: false, category: 'process',
}, async (p, ctx) => {
  try {
    const result = await runPipeline({
      targetId: String(p.targetId ?? ''),
      steps: Array.isArray(p.steps) ? p.steps as ScanStepId[] : undefined,
      url: p.url ? String(p.url) : undefined,
      wordlist: p.wordlist ? String(p.wordlist) : undefined,
      budget: p.maxRequests ? { maxRequests: Number(p.maxRequests) } : undefined,
    }, abort(ctx))
    return { success: result.run.state !== 'refused', data: describeScan(result), error: result.run.state === 'refused' ? result.run.stopReason ?? 'refused' : undefined }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'lab.idor',
  description: 'IDOR auto-test against a declared target: request a URL with an identifier you are entitled to see, then with other identifiers, and compare the responses. A difference is reported as a LEAD, never a confirmed finding — a shared page shell, a soft 404 or a login redirect all look like a difference. Critical: Goga will ask you to approve this exact run first.',
  parameters: {
    type: 'object',
    properties: {
      targetId: { type: 'string', description: 'The declared target id.' },
      urlTemplate: { type: 'string', description: 'A URL with {id} where the identifier goes, e.g. https://host/api/users/{id}. The host must be declared.' },
      baselineId: { type: 'string', description: 'The identifier you are entitled to see, used as the baseline.' },
      candidateIds: { type: 'array', items: { type: 'string' }, description: 'Identifiers to try.' },
      maxRequests: { type: 'number', description: 'Optional request cap (default 200).' },
    },
    required: ['targetId', 'urlTemplate', 'baselineId', 'candidateIds'],
  },
  riskLevel: 'critical', reversible: false, category: 'web',
}, async (p, ctx) => {
  try {
    const result = await idorTest({
      targetId: String(p.targetId ?? ''),
      urlTemplate: String(p.urlTemplate ?? ''),
      baselineId: String(p.baselineId ?? ''),
      candidateIds: Array.isArray(p.candidateIds) ? p.candidateIds.map(String) : [],
      budget: p.maxRequests ? { maxRequests: Number(p.maxRequests) } : undefined,
    }, abort(ctx))
    if (result.run.state === 'refused') return { success: false, error: result.run.stopReason ?? 'refused' }
    const leads = result.comparisons.filter(c => c.differs)
    return { success: true, data: [
      `IDOR test against ${result.run.targetHost}: ${result.comparisons.length} identifier(s) tried, ${leads.length} lead(s).`,
      ...leads.map(c => `  • id ${c.id}: status ${c.status}, ${c.bytes} bytes, similarity ${c.similarity.toFixed(2)} — ${c.why}`),
      '',
      result.caveat,
    ].join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'lab.enumerateUsers',
  description: 'Username enumeration against a declared target: send each username to a login/forgot-password endpoint and report which responses differ from the baseline. A difference is a lead, not proof. Critical: Goga will ask you to approve this exact run first.',
  parameters: {
    type: 'object',
    properties: {
      targetId: { type: 'string', description: 'The declared target id.' },
      urlTemplate: { type: 'string', description: 'A URL with {user} where the username goes. The host must be declared.' },
      usernames: { type: 'array', items: { type: 'string' }, description: 'Usernames to try.' },
      maxRequests: { type: 'number', description: 'Optional request cap (default 200).' },
    },
    required: ['targetId', 'urlTemplate', 'usernames'],
  },
  riskLevel: 'critical', reversible: false, category: 'web',
}, async (p, ctx) => {
  try {
    const result = await enumerateUsernames({
      targetId: String(p.targetId ?? ''),
      urlTemplate: String(p.urlTemplate ?? ''),
      usernames: Array.isArray(p.usernames) ? p.usernames.map(String) : [],
      budget: p.maxRequests ? { maxRequests: Number(p.maxRequests) } : undefined,
    }, abort(ctx))
    if (result.run.state === 'refused') return { success: false, error: result.run.stopReason ?? 'refused' }
    const hits = result.hits.filter(h => h.differs)
    return { success: true, data: [
      `Username enumeration against ${result.run.targetHost}: ${result.hits.length} tried, ${hits.length} that differ from baseline.`,
      ...hits.map(h => `  • ${h.username}: status ${h.status}, ${h.bytes} bytes — ${h.why}`),
      '',
      result.caveat,
    ].join('\n') }
  } catch (err) { return failure(err) }
})

// ── Credential spray: wordlist (offline) → prepare → decide → run ────────────

reg.register({
  name: 'lab.wordlist',
  description: 'Generate a password wordlist from a base word (optionally mutated with years, digits and common suffixes). Offline: nothing is sent anywhere. Use it to build the list a spray will later propose.',
  parameters: {
    type: 'object',
    properties: {
      base: { type: 'string', description: 'The base word, e.g. a company name.' },
      mutate: { type: 'boolean', description: 'Add years, digits and common suffixes.' },
      extra: { type: 'array', items: { type: 'string' }, description: 'Extra words to include verbatim.' },
      limit: { type: 'number', description: 'Max words (default sensible cap).' },
    },
    required: ['base'],
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const result = generateWordlist({
    base: String(p.base ?? ''),
    mutate: Boolean(p.mutate),
    extra: Array.isArray(p.extra) ? p.extra.map(String) : undefined,
    limit: p.limit ? Number(p.limit) : undefined,
  })
  return { success: true, data: `${result.note}\n\n${result.words.join('\n')}` }
})

reg.register({
  name: 'lab.prepareSpray',
  description: 'Prepare a password spray against a declared target. This SENDS NOTHING: it produces a proposal naming the exact target, username list, password list and rate, which you must then approve with lab.decideSpray before lab.runSpray can run it once. Refuses outright if the target is not declared.',
  parameters: {
    type: 'object',
    properties: {
      targetId: { type: 'string', description: 'The declared target id.' },
      url: { type: 'string', description: 'The exact URL the spray would post to. The host must be declared.' },
      usernames: { type: 'array', items: { type: 'string' }, description: 'Usernames, in order. Defaults to a small built-in list.' },
      passwords: { type: 'array', items: { type: 'string' }, description: 'Passwords, in order. Defaults to a small built-in list.' },
      ratePerMinute: { type: 'number', description: 'Requests per minute (capped at 30).' },
    },
    required: ['targetId', 'url'],
  },
  riskLevel: 'medium', reversible: true, category: 'web',
}, async p => {
  const result = prepareSpray({
    targetId: String(p.targetId ?? ''),
    url: String(p.url ?? ''),
    usernames: Array.isArray(p.usernames) ? p.usernames.map(String) : undefined,
    passwords: Array.isArray(p.passwords) ? p.passwords.map(String) : undefined,
    ratePerMinute: p.ratePerMinute ? Number(p.ratePerMinute) : undefined,
  })
  if (!result.ok) return { success: false, error: result.message }
  return { success: true, data: `${result.message}\n\nProposal id: ${result.proposal?.id}` }
})

reg.register({
  name: 'lab.decideSpray',
  description: 'Approve or discard a prepared spray by its proposal id. Approving binds to that exact target, username list, password list and rate — if any of them changed, it will no longer match and lab.runSpray refuses. This is the spray\'s own approval, separate from any other.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The proposal id from lab.prepareSpray.' },
      approved: { type: 'boolean', description: 'true to approve this exact spray, false to discard it.' },
    },
    required: ['id', 'approved'],
  },
  riskLevel: 'high', reversible: false, category: 'web',
}, async p => {
  const result = decideSpray(String(p.id ?? ''), Boolean(p.approved))
  return result.ok ? { success: true, data: result.message } : { success: false, error: result.message }
})

reg.register({
  name: 'lab.runSpray',
  description: 'Run a spray that you have already prepared and approved, by its proposal id. It runs once, within its approved rate and request budget, and reports which username/password pairs produced a response different from the failure baseline — a lead to re-check by hand, not a confirmed login. Critical, and it refuses unless the proposal is approved and unspent.',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'The approved proposal id.' } }, required: ['id'] },
  riskLevel: 'critical', reversible: false, category: 'web',
}, async (p, ctx) => {
  try {
    const result = await runSpray(String(p.id ?? ''), abort(ctx))
    if (!('run' in result)) return { success: false, error: result.message }
    return { success: true, data: [
      `Spray against ${result.run.targetHost}: ${result.run.requests} request(s), ${result.hits.length} hit(s).`,
      ...result.hits.map(h => `  • ${h.username} : ${h.password} — status ${h.status}, ${h.why}`),
      '',
      result.caveat,
    ].join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'lab.sprayProposals',
  description: 'List the spray proposals the Lab is currently holding, with whether each is approved, spent or expired. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'system',
}, async () => {
  const proposals = listSprayProposals()
  if (!proposals.length) return { success: true, data: 'No spray proposals are held right now.' }
  return { success: true, data: proposals.map(p => `${p.status} — ${p.targetHost} ${p.url} · ${p.usernames.length}×${p.passwords.length} at ${p.ratePerMinute}/min  (id ${p.id})`).join('\n') }
})

/** The shared shape for a scan or pipeline result, so both tools read the same way. */
function describeScan(result: Awaited<ReturnType<typeof portScan>>): string {
  const { run, steps } = result
  const lines = [
    `${run.tool} against ${run.targetHost} — ${run.state}. ${run.requests} request(s).`,
    run.stopReason ? `  ${run.stopReason}` : '',
  ]
  for (const s of steps) {
    lines.push('', `## ${s.step}${s.ran ? '' : ` — skipped: ${s.skippedReason}`}`)
    if (s.command) lines.push(`  command: ${s.command}`)
    for (const f of s.findings) lines.push(`  • [${f.confidence}] ${f.kind}: ${f.title} — ${f.detail}`)
  }
  if (run.findings.length) {
    lines.push('', `Findings (${run.findings.length}):`)
    for (const f of run.findings) lines.push(`  • [${f.confidence}] ${f.kind}: ${f.title}\n    evidence: ${f.evidence}`)
  }
  lines.push('', 'Leads and observations, not confirmed findings. Re-check each one by hand.')
  return lines.filter(Boolean).join('\n')
}
