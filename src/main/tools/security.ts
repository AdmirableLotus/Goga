import { ToolRegistry } from './registry'
import { decideScope, forbiddenTarget, parseTarget } from '../services/security/scope'
import { activeProgram, addFinding, addProgram, audit, issueGrant, listFindings, listPrograms, readAudit, setActiveProgram } from '../services/security/store'
import { importBugcrowd, importHackerOne, listHackerOnePrograms } from '../services/security/programs'
import { probe, reflectionReport } from '../services/security/probe'
import { curriculum, lessonById } from '../services/security/curriculum'
import { toolboxCatalog } from '../services/security/toolbox'
import { findTool, searchToolbox } from '../services/security/toolboxQuery'
import { classifyRunRequest, refusalFor, VERDICT_LABEL } from '../services/security/toolboxVerdicts'
import { startXssLab } from '../services/security/xssLab'
import { runXssPractice, layerDriver } from '../services/security/xssPractice'
import { runXssLive, type LiveGet } from '../services/security/xssLive'
import { allowedTool, runSecurityTool, ALLOWED_TOOLS, type ExecResult } from '../services/security/toolRunner'
import { execFile } from 'child_process'
import { browserLayer } from '../services/browser/layer'
import { ensureAttached } from './browserFirefox'
import type { ToolReference } from '../../shared/toolboxTypes'

/**
 * Bug-bounty tools.
 *
 * The security model here is deliberately blunt:
 *   - reading scope, the curriculum, findings and the audit is free (read-only);
 *   - the ONE tool that sends a request at a target is `critical`, so the approval gate
 *     stops it every time: it runs only after the user approves that exact target in chat
 *     (or hands it a grant issued in the Security page), and even then it refuses anything
 *     outside the active program's eligible scope or any local/private/metadata address;
 *   - reports save as drafts only.
 */

const reg = ToolRegistry.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

/**
 * One tool's reference for the chat reply: what it is, the verdict and why, the useful half,
 * the banned half, what it needs, where its own docs live, and the sheet's commands.
 */
function renderTool(t: ToolReference): string {
  const commands = t.sections.flatMap(s => [
    `## ${s.heading}`,
    ...s.commands.map(c => `${c.command}${c.bannedPath ? '  [banned half]' : ''} — ${c.description}`),
  ])
  return [
    `${t.name} — ${VERDICT_LABEL[t.verdict]}`,
    t.what,
    '',
    `Why: ${t.verdictReason}`,
    '',
    `Useful on a bounty: ${t.usefulPart}`,
    `Gets the account banned or the person arrested: ${t.bannedPart}`,
    `Needs: ${t.needs.join(', ')}`,
    '',
    'Docs (the tool\'s own):',
    ...t.docs.map(d => `  ${d.title} — ${d.url}`),
    '',
    `Commands transcribed from the sheet ${t.sheet} (the sheet's wording, your material, not a vendor source):`,
    ...commands,
    '',
    'Goga has no executor for this tool. Nothing above can be run from here; the only request in the Security area is the single GET you approve for one in-scope URL.',
  ].join('\n')
}


reg.register({
  name: 'security.scope',
  description: 'Show the imported bug-bounty programs and their authorized assets and exclusions, and say whether a specific target is in scope. Read-only. Use this before proposing any test.',
  parameters: { type: 'object', properties: { target: { type: 'string', description: 'Optional target (URL or hostname) to check.' } } },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const programs = listPrograms()
  if (!programs.length) return { success: true, data: 'No program has been imported. Nothing can be tested until a program\'s scope is imported in the Security page, and importing a program does not itself grant permission to test.' }
  const active = activeProgram()
  const lines = [`Active program: ${active ? `${active.name} (${active.source}, ${active.handle})` : 'NONE — every request will be refused'}`]
  for (const prog of programs) {
    const eligible = prog.assets.filter(a => a.eligibleForSubmission)
    lines.push(`\n${prog.name} (${prog.source}: ${prog.handle}) — ${eligible.length} eligible asset(s), ${prog.exclusions.length} exclusion(s), imported ${prog.importedAt.slice(0, 10)}`)
    lines.push(...eligible.slice(0, 40).map(a => `  • ${a.identifier} [${a.assetType}]${a.maxSeverity ? ` max ${a.maxSeverity}` : ''}${a.instruction ? ` — ${a.instruction}` : ''}`))
    if (eligible.length > 40) lines.push(`  … and ${eligible.length - 40} more`)
    if (prog.exclusions.length) lines.push(...prog.exclusions.map(e => `  excluded: ${e.category}${e.details ? ` — ${e.details}` : ''}`))
    if (prog.skipped.length) lines.push(`  deny rules (assets the program marks not eligible for submission): ${prog.skipped.map(s => s.replace(/ — .*$/, '')).join(', ')}`)
  }
  if (p.target) {
    const d = decideScope(active, String(p.target))
    let forbidden: string | null = null
    try { forbidden = forbiddenTarget(parseTarget(String(p.target)).host) } catch (err) { forbidden = err instanceof Error ? err.message : String(err) }
    lines.push(`\n${p.target}: ${d.inScope ? 'IN SCOPE' : 'OUT OF SCOPE'} — ${d.reason}${forbidden ? `\nBlocked regardless: ${forbidden}` : ''}`)
  }
  return { success: true, data: lines.join('\n') }
})

reg.register({
  name: 'security.checkTarget',
  description: 'Check one target against the active program scope without touching the network. Says in, out, or undetermined, and quotes the rule that decided it.',
  parameters: { type: 'object', properties: { target: { type: 'string', description: 'URL or hostname.' }, technique: { type: 'string', description: 'Optional technique, e.g. "automated scanner", to test against the program\'s exclusions.' } }, required: ['target'] },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  try {
    const active = activeProgram()
    const d = decideScope(active, String(p.target), p.technique ? String(p.technique) : undefined)
    let forbidden: string | null = null
    try { forbidden = forbiddenTarget(parseTarget(String(p.target)).host) } catch (err) { forbidden = err instanceof Error ? err.message : String(err) }
    return { success: true, data: `${p.target}\n  ${d.inScope ? 'IN SCOPE' : 'OUT OF SCOPE'}${d.undetermined ? ' (not covered by any rule — deny)' : ''}\n  Rule: ${d.matchedRule ?? 'none'}\n  Why: ${d.reason}${forbidden ? `\n  Blocked regardless of scope: ${forbidden}` : ''}` }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.probe',
  description: 'Send ONE in-scope GET to a target and return its status, headers and a body excerpt — the single active request Goga can make. It is critical, so it runs only after you approve this exact target; approving it here IS the authorization, so no separate Security-page grant is needed. It refuses anything outside the active program\'s eligible scope and any local/private/metadata address, does not follow redirects, and cannot post data. Optionally pass a unique marker you injected to get the reflection context back in the same step.',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Full URL, e.g. https://shop.example.com/search?q=goga7f3a91.' },
      marker: { type: 'string', description: 'Optional unique string you injected into the request, to check where it comes back in the response.' },
      grantId: { type: 'string', description: 'Optional. A grant id from the Security page; when omitted, your approval of this request authorizes the single GET.' },
    },
    required: ['target'],
  },
  riskLevel: 'critical', reversible: false, category: 'web',
}, async p => {
  try {
    const target = String(p.target ?? '').trim()
    if (!target) return { success: false, error: 'give the full URL to request' }
    let grantId = p.grantId ? String(p.grantId) : ''
    if (!grantId) {
      // No page-issued grant. This call is already behind the critical-approval gate, which
      // showed you this exact target, so your approval is the authorization. Enforce scope and
      // the forbidden-host rule here too (probe() re-checks both), then mint a single-use grant
      // for exactly this GET and consume it below. Nothing is sent until all of that passes.
      const program = activeProgram()
      if (!program) {
        audit('blocked', `probe refused — no active program for ${target}`)
        return { success: false, error: 'no program is active — import and activate one first, so the request is checked against a known scope. Nothing was sent.' }
      }
      try {
        const forbidden = forbiddenTarget(parseTarget(target).host)
        if (forbidden) { audit('blocked', `probe refused — ${forbidden} (${target})`); return { success: false, error: `${forbidden} Nothing was sent.` } }
      } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
      const decision = decideScope(program, target)
      if (!decision.inScope) {
        audit('blocked', `probe refused — out of scope: ${target} (${decision.reason})`)
        return { success: false, error: `out of scope — ${decision.reason}. Nothing was sent.` }
      }
      grantId = issueGrant(target, 'GET')
      audit('approve', `chat-authorized GET ${target} — in scope by ${decision.matchedRule ?? 'program rule'}`)
    }
    const result = await probe({ target, grantId })
    if (!result.ok) {
      audit('blocked', `probe blocked — ${result.blockedReason} (${target})`)
      return { success: false, error: result.blockedReason ?? 'the request was refused' }
    }
    audit('request', `GET ${result.url} → ${result.status}, ${result.bytes} bytes`)
    const lines = [
      `${result.status} ${result.url} (${result.bytes} bytes)`,
      ...Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`),
      '',
      result.bodyExcerpt.slice(0, 6000),
    ]
    if (p.marker) {
      const r = reflectionReport(result.bodyExcerpt, String(p.marker))
      lines.push('', '— reflection check —', r.verdict, ...r.contexts.map(c => `  [${c.context}] …${c.excerpt}…`))
    }
    return { success: true, data: lines.join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.reflectionCheck',
  description: 'Given a response body and a unique marker you injected, say whether the marker came back and in what context (element text, an attribute, inside a script block, a URL). This is the mechanical half of XSS confirmation — it does not by itself prove script execution.',
  parameters: {
    type: 'object',
    properties: {
      body: { type: 'string', description: 'The response body (or the part you care about).' },
      marker: { type: 'string', description: 'The unique string you sent, e.g. goga7f3a91.' },
    },
    required: ['body', 'marker'],
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const r = reflectionReport(String(p.body ?? ''), String(p.marker ?? ''))
  return { success: true, data: [
    r.verdict,
    ...r.contexts.map(c => `  [${c.context}] …${c.excerpt}…`),
    r.found ? 'Next: decide whether that context can execute script. Being reflected is not the same as being executable — the encoding has to be wrong for where it lands.' : '',
  ].filter(Boolean).join('\n') }
})

reg.register({
  name: 'security.saveReport',
  description: 'Save a vulnerability report as a LOCAL DRAFT. Provide title, asset, severity, summary, steps to reproduce, impact, remediation and evidence. Nothing is submitted anywhere — the user submits it themselves.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Vulnerability class plus exact asset.' },
      asset: { type: 'string', description: 'The affected in-scope asset.' },
      severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'], description: 'Severity.' },
      summary: { type: 'string', description: 'Two or three sentences: what, where, what it allows.' },
      steps: { type: 'string', description: 'Numbered reproduction steps with the exact request.' },
      impact: { type: 'string', description: 'What an attacker gains.' },
      remediation: { type: 'string', description: 'How to fix it.' },
      evidence: { type: 'string', description: 'Requests, responses, proof of execution. Redact other people\'s data.' },
    },
    required: ['title', 'asset', 'severity', 'summary', 'steps', 'impact'],
  },
  riskLevel: 'medium', reversible: true, category: 'filesystem',
}, async p => {
  try {
    const active = activeProgram()
    if (!active) return { success: false, error: 'import and activate a program first, so the report is filed against a known scope' }
    const finding = addFinding({
      programId: active.id,
      title: String(p.title ?? '').slice(0, 200),
      severity: String(p.severity ?? 'medium') as 'info' | 'low' | 'medium' | 'high' | 'critical',
      asset: String(p.asset ?? ''),
      summary: String(p.summary ?? ''),
      steps: String(p.steps ?? ''),
      impact: String(p.impact ?? ''),
      remediation: String(p.remediation ?? ''),
      evidence: String(p.evidence ?? ''),
    })
    return { success: true, data: `Draft saved locally (${finding.id}): "${finding.title}". Nothing was sent to ${active.source}. Read it over in the Security page and submit it yourself when you are ready.` }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.findings',
  description: 'List the draft findings saved on this machine.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => {
  const findings = listFindings()
  if (!findings.length) return { success: true, data: 'No findings saved yet.' }
  return { success: true, data: findings.map(f => `${f.id} [${f.severity}] ${f.title} — ${f.asset} (draft, ${f.createdAt.slice(0, 10)})`).join('\n') }
})

reg.register({
  name: 'security.learn',
  description: 'The study curriculum for bug bounty: lessons on web fundamentals, the OWASP Top 10, finding and confirming XSS, writing a report a triager will accept, and program rules and ethics — each section citing the page it came from. Call with a lesson id for the full text, or with no arguments for the index.',
  parameters: {
    type: 'object',
    properties: {
      lessonId: { type: 'string', description: 'Lesson id, e.g. "xss", "report-writing", "program-rules", "web-fundamentals", "owasp-top-10", "recon", "ethics-in-practice".' },
    },
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  if (!p.lessonId) {
    const c = curriculum()
    return { success: true, data: `${c.note}\n\n${c.lessons.map(l => `${l.id} (${l.track}, ${l.minutes} min): ${l.title}\n   Check: ${l.check}`).join('\n')}` }
  }
  const lesson = lessonById(String(p.lessonId))
  if (!lesson) return { success: false, error: `no lesson "${p.lessonId}". Lessons: ${curriculum().lessons.map(l => l.id).join(', ')}` }
  return { success: true, data: [
    `${lesson.title} (${lesson.track}, ${lesson.minutes} min)`,
    '',
    ...lesson.sections.flatMap(s => [`## ${s.heading}`, s.body, '', ...s.sources.map(src => `  source: ${src.title} — ${src.url}`), '']),
    `Before you move on: ${lesson.check}`,
  ].join('\n') }
})

reg.register({
  name: 'security.toolbox',
  description: 'The security-tool reference (Toolbox): for one tool, what it is for, its verdict (ALLOWED_UNDER_SCOPE, NEEDS_PROGRAM_PERMISSION or NEVER) with the reason, the useful part, the banned part, what it needs and where its own docs live, plus the commands transcribed from the user\'s cheat sheets. Read-only reference: Goga has no executor for these tools. With no tool name, lists the catalog or searches it.',
  parameters: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: 'Tool name or id, e.g. "nmap", "subfinder", "hashcat", "nxc", "wireshark". Alias names are accepted.' },
      search: { type: 'string', description: 'Optional words to search the toolbox for (name, verdict, need, or command text).' },
    },
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  try {
    if (p.tool) {
      const tool = findTool(String(p.tool))
      if (!tool) {
        const names = toolboxCatalog().tools.map(t => t.id).join(', ')
        return { success: false, error: `no tool "${p.tool}" in the Toolbox. Known: ${names}` }
      }
      return { success: true, data: renderTool(tool) }
    }
    if (p.search) {
      const hits = searchToolbox(String(p.search))
      if (!hits.length) return { success: true, data: `Nothing in the Toolbox matches "${p.search}". Known tools: ${toolboxCatalog().tools.map(t => t.id).join(', ')}` }
      return { success: true, data: hits.map(h => `${h.name} — ${h.verdict} (matched in ${h.matchedIn}): ${h.excerpt}`).join('\n') }
    }
    const c = toolboxCatalog()
    return { success: true, data: [c.note, '', ...c.tools.map(t => `${t.id} — ${t.name}: ${t.verdict}`)].join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.runTool',
  description: 'Refused by design. Goga has no executor for security tools: this tool explains the verdict and never runs a command. Callable so a request to scan or attack a target is answered with the tool\'s verdict rather than a guess.',
  parameters: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: 'The tool the user asked to run, e.g. "nmap".' },
      target: { type: 'string', description: 'The target as the user gave it. Recorded in the refusal, never contacted.' },
    },
    required: ['tool'],
  },
  riskLevel: 'high', reversible: true, category: 'memory',
}, async p => {
  const identifier = String(p.tool ?? '')
  const tool = findTool(identifier)
  const target = p.target ? ` at ${String(p.target)}` : ''
  const refusal = tool ? refusalFor(tool) : null
  const lines = [
    `Goga will not run ${tool ? tool.name : identifier}${target}.`,
    refusal ?? classifyRunRequest(identifier).refusal,
    '',
    'What it can do instead: explain the commands from the Toolbox, check a URL against an imported program\'s scope, and — if you approve that exact request — send one GET through the Security page.',
  ]
  if (tool) lines.push('', `Verdict: ${tool.verdict}`, `Useful part: ${tool.usefulPart}`, `Banned part: ${tool.bannedPart}`)
  return { success: false, error: lines.join('\n') }
})

reg.register({
  name: 'security.audit',
  description: 'The security audit trail: imports, approvals, denials, requests, blocked requests and drafts.',
  parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many recent entries (default 40).' } } },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const entries = readAudit(Number(p.limit) || 40)
  if (!entries.length) return { success: true, data: 'The security audit log is empty.' }
  return { success: true, data: entries.map(e => `${e.time.slice(0, 19).replace('T', ' ')} [${e.kind}] ${e.detail}`).join('\n') }
})

// ── Real, scope-gated tool execution for an allow-list ──────────────────────
//
// Goga builds the whole command; the caller supplies only an in-scope target. Everything is
// gated exactly like a probe: active program, in scope, not a forbidden host, and the critical
// approval. Installing is a separate opt-in. Non-allow-listed tools still hit security.runTool.

/** execFile with an arg array (no shell) → the runner's ExecResult. */
function realExec(bin: string, args: string[], opts: { timeoutMs: number }): Promise<ExecResult> {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
      const timedOut = !!(e && e.killed)
      const code = e && typeof e.code === 'number' ? e.code : e ? 1 : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut })
    })
  })
}

/** Locate a binary without a shell. Returns its path or null. */
function realWhich(bin: string): Promise<string | null> {
  return new Promise(resolve => {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    execFile(cmd, [bin], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const first = String(stdout).split(/\r?\n/).map(s => s.trim()).find(Boolean)
      resolve(first || null)
    })
  })
}

reg.register({
  name: 'security.useTool',
  description: `Run ONE allow-listed security tool against a single in-scope target, and show its output. Allowed tools: ${ALLOWED_TOOLS.map(t => t.id).join(', ')}. Goga builds the whole command itself (you give only the tool and the target URL); it refuses unless a program is active, the target is covered by that program's eligible scope, and the host is not local/private/metadata. Tools run bounded (hard timeout, rate-limited where supported, one target). If the tool is missing it is only installed when you pass install:true. For anything NOT on the allow-list, use security.runTool (which explains why Goga will not run it). This is critical: it runs only after you approve this exact tool+target.`,
  parameters: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: `Which allow-listed tool: ${ALLOWED_TOOLS.map(t => t.id).join(', ')}.` },
      target: { type: 'string', description: 'Full in-scope URL, e.g. https://app.example.com/.' },
      install: { type: 'boolean', description: 'Allow Goga to install the tool if it is missing (default false).' },
    },
    required: ['tool', 'target'],
  },
  riskLevel: 'critical', reversible: false, category: 'web',
}, async p => {
  try {
    const toolId = String(p.tool ?? '').trim()
    const target = String(p.target ?? '').trim()
    if (!toolId || !target) return { success: false, error: 'give both the tool and the target URL' }

    const tool = allowedTool(toolId)
    if (!tool) {
      audit('blocked', `useTool refused — "${toolId}" is not on the allow-list`)
      return { success: false, error: `"${toolId}" is not on Goga's allow-list (${ALLOWED_TOOLS.map(t => t.id).join(', ')}). Use security.runTool for the verdict on it; nothing was run.` }
    }

    // Same authorization gate as a probe. Nothing runs until all of it passes.
    const program = activeProgram()
    if (!program) {
      audit('blocked', `useTool refused — no active program for ${target}`)
      return { success: false, error: 'no program is active — import and activate one first, so the target is checked against a known scope. Nothing was run.' }
    }
    let host: string
    try {
      host = parseTarget(target).host
      const forbidden = forbiddenTarget(host)
      if (forbidden) { audit('blocked', `useTool refused — ${forbidden} (${target})`); return { success: false, error: `${forbidden} Nothing was run.` } }
    } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
    const decision = decideScope(program, target)
    if (!decision.inScope) {
      audit('blocked', `useTool refused — out of scope: ${target} (${decision.reason})`)
      return { success: false, error: `out of scope — ${decision.reason}. Nothing was run.` }
    }

    const allowInstall = p.install === true
    audit('approve', `chat-authorized ${tool.id} on ${target} — in scope by ${decision.matchedRule ?? 'program rule'}${allowInstall ? ' (install permitted)' : ''}`)
    const outcome = await runSecurityTool({ tool, target, exec: realExec, which: realWhich, allowInstall })
    if (!outcome.ran) {
      audit('note', `${tool.id} did not run on ${host} — ${outcome.error ?? 'stopped'}`)
      return { success: false, error: [outcome.error, ...outcome.log].filter(Boolean).join('\n') }
    }
    audit('request', `ran ${tool.id} against ${host}${outcome.installed ? '' : ' (pre-installed)'}`)
    return { success: true, data: [...outcome.log, '', '— output —', outcome.output].join('\n') }
  } catch (err) { return failure(err) }
})

// Exposed so the Security page can hand the user a grant after they approve one request.
export function grantFor(target: string, method = 'GET'): string {
  return issueGrant(target, method)
}


// ── Importing a program, so the user does not have to go to the page ────────
//
// Reading scope was already free, but the scope had to be imported first, by hand, on the
// Security page. Importing reads a program's published policy from the platform and stores
// it locally; it sends nothing to the target and grants no permission to test anything.

reg.register({
  name: 'security.listPrograms',
  description: 'List the bug-bounty programs available on HackerOne for the stored account, so one can be chosen and imported. Read-only, and it sends nothing to any target.',
  parameters: {
    type: 'object',
    properties: { search: { type: 'string', description: 'Optional text to filter the list by, e.g. "coinbase".' } },
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  try {
    const listing = await listHackerOnePrograms()
    const q = String(p.search ?? '').trim().toLowerCase()
    const matching = q
      ? listing.programs.filter(x => `${x.name} ${x.handle}`.toLowerCase().includes(q))
      : listing.programs
    if (!matching.length) {
      return {
        success: false,
        error: q
          ? `No program on HackerOne matches "${q}" among the ${listing.programs.length} this account can see. Nothing was imported.`
          : 'HackerOne returned no programs for the stored account. The token may not have access, or no programs are listed.',
      }
    }
    return {
      success: true,
      data: `Programs${q ? ` matching "${q}"` : ''}: ${matching.length}\n`
        + matching.slice(0, 60).map(x => `${x.handle} — ${x.name}`).join('\n')
        + '\n\nImport one with security.importProgram (handle). Importing reads its published policy only: '
        + 'it grants no permission to test anything, and sending a request still needs your approval of that exact URL.',
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.importProgram',
  description: 'Import one bug-bounty program\'s published scope and rules from HackerOne or Bugcrowd and make it the active program, so scope can then be checked against it. Reads the platform only — nothing is sent to the target, and importing does not grant permission to test.',
  parameters: {
    type: 'object',
    properties: {
      handle: { type: 'string', description: 'The program handle, e.g. "coinbase" or "security".' },
      source: { type: 'string', enum: ['hackerone', 'bugcrowd'], description: 'Which platform. Default hackerone.' },
    },
    required: ['handle'],
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  try {
    const handle = String(p.handle ?? '').trim().replace(/^https?:\/\/[^/]+\//, '').replace(/\/.*$/, '')
    if (!handle) return { success: false, error: 'No program handle was given.' }
    const source = String(p.source ?? 'hackerone') === 'bugcrowd' ? 'bugcrowd' : 'hackerone'
    const imported = source === 'bugcrowd' ? await importBugcrowd(handle) : await importHackerOne(handle)
    const stored = addProgram(imported)
    setActiveProgram(stored.id)
    const eligible = stored.assets.filter(a => a.eligibleForSubmission)
    return {
      success: true,
      data: [
        `Imported ${stored.name} (${source}, ${stored.handle}) and made it the active program.`,
        `${eligible.length} eligible asset(s), ${stored.exclusions.length} exclusion(s).`,
        ...eligible.slice(0, 25).map(a => `  - ${a.identifier} [${a.assetType}]${a.maxSeverity ? ` max ${a.maxSeverity}` : ''}`),
        ...stored.exclusions.slice(0, 10).map(e => `  excluded: ${e.category}${e.details ? ` — ${e.details}` : ''}`),
        '',
        'Nothing was sent to the program. That import is its published policy, not permission to test: '
          + 'any actual request still needs your approval of that exact URL.',
      ].join('\n'),
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.useProgram',
  description: 'Make an already-imported program the active one, so scope checks run against it.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Program name or handle, as shown by security.scope.' } },
    required: ['name'],
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const q = String(p.name ?? '').trim().toLowerCase()
  const match = listPrograms().find(x => x.handle.toLowerCase() === q || x.name.toLowerCase() === q)
    ?? listPrograms().find(x => `${x.name} ${x.handle}`.toLowerCase().includes(q))
  if (!match) {
    const have = listPrograms().map(x => `${x.handle} (${x.name})`).join(', ')
    return { success: false, error: `No imported program matches "${p.name}". Imported: ${have || 'none'}.` }
  }
  setActiveProgram(match.id)
  return { success: true, data: `${match.name} (${match.handle}) is now the active program. Scope checks use it.` }
})

reg.register({
  name: 'security.xssPractice',
  description: 'Do ONE complete reflected-XSS exercise, end to end, on Goga\'s own offline practice lab — and prove it honestly. It starts a deliberately-vulnerable page that runs only on this machine (127.0.0.1, never the internet), drives Goga\'s real browser to inject a payload, confirms the script ACTUALLY executed (not just reflected) by watching the page title change to a value only the running script could set, checks the same payload is defeated by the escaped control, and saves a draft finding when confirmed. It takes no target: it can only ever touch the local lab, so it cannot be aimed at a real site. Use this to practise or to demonstrate a working XSS without touching any real program.',
  parameters: { type: 'object', properties: {}, required: [] },
  riskLevel: 'medium', reversible: false, category: 'web',
}, async () => {
  const ready = await ensureAttached()
  if (!ready.ok) return { success: false, error: ready.message }
  const lab = await startXssLab()
  try {
    const result = await runXssPractice(layerDriver(browserLayer()), lab)
    const lines = [...result.log]
    if (result.confirmed && result.finding) {
      const saved = addFinding({ programId: 'xss-practice-lab', ...result.finding })
      audit('finding', `practice XSS confirmed on the offline lab — draft finding saved (${saved.id})`)
      lines.push('', `Saved a draft finding: "${saved.title}". It is marked [Practice] and is not a real program submission.`)
    } else {
      audit('note', `practice XSS run finished without a confirmed result (reflected=${result.reflected}, executed=${result.executedOnVulnerable})`)
    }
    return { success: true, data: lines.join('\n') }
  } catch (err) {
    return failure(err)
  } finally {
    await lab.stop()
  }
})

reg.register({
  name: 'security.xssAttempt',
  description: 'Attempt ONE reflected-XSS confirmation against a LIVE, in-scope target parameter, and report it honestly. Give the full URL (with the parameter) and the parameter name. It refuses unless a program is active, the target is covered by that program\'s eligible scope, and the host is not local/private/metadata. It sends the single scoped GETs to check reflection and encoding, then drives Goga\'s real browser to prove the payload ACTUALLY executes (the page title changes to a value only the injected script could set), checks a benign control, and saves a DRAFT finding only when execution is proven. It never submits anything. Reflected-but-escaped or non-reflected inputs are reported as such, never as a working exploit. This is critical: it runs only after you approve this exact target.',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Full URL including the parameter to test, e.g. https://app.example.com/search?q=TEST.' },
      param: { type: 'string', description: 'The query parameter to inject into, e.g. q.' },
    },
    required: ['target', 'param'],
  },
  riskLevel: 'critical', reversible: false, category: 'web',
}, async p => {
  try {
    const target = String(p.target ?? '').trim()
    const param = String(p.param ?? '').trim()
    if (!target || !param) return { success: false, error: 'give both the full URL and the parameter name to test' }

    // Authorization: active program, in scope, not a forbidden host. Enforced before anything is sent.
    const program = activeProgram()
    if (!program) {
      audit('blocked', `xssAttempt refused — no active program for ${target}`)
      return { success: false, error: 'no program is active — import and activate one first, so the target is checked against a known scope. Nothing was sent.' }
    }
    let host: string
    try {
      host = parseTarget(target).host
      const forbidden = forbiddenTarget(host)
      if (forbidden) { audit('blocked', `xssAttempt refused — ${forbidden} (${target})`); return { success: false, error: `${forbidden} Nothing was sent.` } }
    } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
    const decision = decideScope(program, target)
    if (!decision.inScope) {
      audit('blocked', `xssAttempt refused — out of scope: ${target} (${decision.reason})`)
      return { success: false, error: `out of scope — ${decision.reason}. Nothing was sent.` }
    }

    // The browser is about to render this live. Make sure it is attached before any request goes out.
    const ready = await ensureAttached()
    if (!ready.ok) return { success: false, error: ready.message }

    // A scoped GET: probe() re-checks scope and the forbidden-host rule for EVERY url it is given
    // (marker and payload are the same in-scope host), so no request can slip out of scope here.
    const get: LiveGet = async (url) => {
      const grantId = issueGrant(url, 'GET')
      const res = await probe({ target: url, grantId })
      if (!res.ok) throw new Error(res.blockedReason ?? 'the request was refused')
      audit('request', `GET ${res.url} → ${res.status}, ${res.bytes} bytes`)
      return { status: res.status ?? 0, body: res.bodyExcerpt ?? '' }
    }

    audit('approve', `chat-authorized live XSS attempt on ${target} ("${param}") — in scope by ${decision.matchedRule ?? 'program rule'}`)
    const result = await runXssLive({ target, param, get, driver: layerDriver(browserLayer()) })
    const lines = [...result.log]
    if (result.confirmed && result.finding) {
      const saved = addFinding({ programId: program.id, ...result.finding })
      audit('finding', `live reflected XSS confirmed on ${host} ("${param}") — draft finding saved (${saved.id})`)
      lines.push('', `Saved a DRAFT finding: "${saved.title}". Nothing was submitted — review and submit it yourself.`)
    } else {
      audit('note', `live XSS attempt on ${host} finished without a confirmed result (reflected=${result.reflected}, unescaped=${result.unescapedInResponse}, executed=${result.executed})`)
    }
    return { success: true, data: lines.join('\n') }
  } catch (err) { return failure(err) }
})
