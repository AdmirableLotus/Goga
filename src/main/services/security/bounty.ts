import type { ProgramImport, ScopeAsset, ScopeExclusion } from '../../../shared/security'
import type { JobBounds } from '../../../shared/jobs'
import { decideScope } from './scope'

/**
 * Turning a selected program into one watched, hands-off bounty run.
 *
 * Pure. It reads a program's imported scope and produces two things: the exact list of hosts
 * that are provably in scope (so the handler can declare only those to the Lab), and the goal
 * prompt the worker runs. Nothing here touches the network, the Lab or the model, so the one
 * safety-critical decision — which hosts count as in scope — is decided by the same pure
 * `decideScope` the probe uses, and is testable on its own.
 *
 * The rule is the whole point: a host is offered for declaration ONLY when `decideScope` says
 * it is in scope. Anything uncertain — a wildcard in an odd position, a CIDR range, a path-
 * bearing asset whose apex is not itself covered — is left out, not guessed at. Under-declaring
 * is safe (Goga can still probe those per-URL, each request scope-checked); over-declaring is
 * the one thing that could let a hands-off scan reach something the program never authorized.
 */

/** A host proven in scope, ready to declare to the Lab. */
export interface BountyHost {
  host: string
  /** The asset identifier it came from, for the declaration note and the audit trail. */
  asset: string
}

/**
 * The declarable host for one asset, or null when it is not a single hostname/IPv4 we can
 * both declare and verify. Wildcards are reduced to their apex; CIDRs and odd wildcards are
 * skipped on purpose.
 */
export function declarableHost(asset: ScopeAsset): string | null {
  const type = String(asset.assetType ?? '').toLowerCase()
  if (type === 'cidr' || /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(String(asset.identifier ?? '').trim())) {
    // A range can be in scope, but we cannot verify a whole CIDR host-by-host here, and the
    // Lab declaration gate is per-host. Leave it for an explicit in-run declaration instead.
    return null
  }

  let raw = String(asset.identifier ?? '').trim()
  if (!raw) return null

  // URL → host; a bare "host/path" → host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try { raw = new URL(raw).hostname } catch { return null }
  } else {
    const slash = raw.indexOf('/')
    if (slash > 0) raw = raw.slice(0, slash)
  }

  raw = raw.toLowerCase().replace(/\.$/, '')
  if (raw.startsWith('*.')) raw = raw.slice(2) // "*.example.com" → "example.com" (the apex the wildcard covers)
  if (!raw || raw.includes('*')) return null // a star left anywhere else is too broad to auto-declare
  if (!/^[a-z0-9.-]+$/.test(raw)) return null // not a plain hostname or IPv4
  if (!raw.includes('.')) return null // a single label is never a real target
  return raw
}

/**
 * Every host in a program that `decideScope` confirms is in scope, de-duplicated. The same
 * deterministic gate the probe enforces at request time decides here, so the declaration list
 * can never be wider than what a live request would be allowed to reach.
 */
export function inScopeHosts(program: ProgramImport): BountyHost[] {
  const seen = new Set<string>()
  const out: BountyHost[] = []
  for (const asset of program.assets) {
    if (!asset.eligibleForSubmission) continue
    const host = declarableHost(asset)
    if (!host || seen.has(host)) continue
    let decision
    try { decision = decideScope(program, host) } catch { continue }
    if (!decision.inScope) continue
    seen.add(host)
    out.push({ host, asset: asset.identifier })
  }
  return out
}

/**
 * The program's own rule about automated testing, when it states one, else null.
 *
 * Some programs — Cantina's own bug bounty among them — ask testers to be careful with
 * automated, multi-request scans. A run against such a program must not start until the user
 * has seen that rule and acknowledged it, and the goal must carry it. This is read straight
 * from the imported entry bar; nothing is inferred.
 */
export function automationRule(program: ProgramImport): string | null {
  const rule = program.entryBar?.automatedTestingRule
  return rule && rule.trim() ? rule.trim() : null
}

/** The effective, server-validated scope a run WOULD use, for the user to confirm before launch. */
export interface BountyScopePreview {
  program: { id: string; name: string; source: string }
  /** Hosts decideScope proves in scope — exactly what the run will declare. */
  hosts: BountyHost[]
  /** Assets the program lists but marks not eligible — deny rules, never touched. */
  outOfScope: string[]
  exclusions: ScopeExclusion[]
  /** The program's automated-testing rule, quoted, when it states one. */
  automatedTestingRule: string | null
  /** True when the program restricts automation, so launch needs an explicit acknowledgement. */
  requiresAck: boolean
}

/**
 * Assemble the preview for a program, using the same deterministic scope check the launch and
 * every tool action use. Pure: tool/runner availability is attached by the caller, since that
 * is IO.
 */
export function bountyPreview(program: ProgramImport): BountyScopePreview {
  const rule = automationRule(program)
  return {
    program: { id: program.id, name: program.name, source: program.source },
    hosts: inScopeHosts(program),
    outOfScope: program.assets.filter(a => !a.eligibleForSubmission).map(a => a.identifier),
    exclusions: program.exclusions ?? [],
    automatedTestingRule: rule,
    requiresAck: rule !== null,
  }
}

/** A longer leash than a chat-born job: a real run recons, installs, scans and verifies. */
export const BOUNTY_BOUNDS: JobBounds = { maxSteps: 40, maxMinutes: 90 }

/**
 * The goal prompt for the run. It names the program, lists the hosts already declared in
 * scope, states the hard rules the gates enforce anyway (so the planner does not waste steps
 * discovering them), and tells Goga to use the bounty skill it was taught and to record every
 * real finding. The scope gates do not depend on this text — they refuse out-of-scope work
 * whatever the planner decides — but a clear goal keeps a small model on the authorized path.
 */
export function buildBountyGoal(program: ProgramImport, hosts: BountyHost[], focus?: string): string {
  const hostList = hosts.length
    ? hosts.map(h => `  • ${h.host}  (from ${h.asset})`).join('\n')
    : '  (none could be auto-declared — declare an in-scope target yourself before any active Lab tool will run)'
  const outOfScope = program.assets.filter(a => !a.eligibleForSubmission).map(a => a.identifier)
  const exclusions = (program.exclusions ?? []).map(e => `${e.category}: ${e.details}`)
  const rule = automationRule(program)

  return [
    `Carry out an authorized bug-bounty run on the program "${program.name}" (${program.source}). This is a real, watched engagement: work through it on your own and keep going without asking me to approve each step — I am watching the board.`,
    focus ? `Focus this run on: ${focus}` : '',
    rule ? `\nTHIS PROGRAM RESTRICTS AUTOMATED TESTING. Its own words: "${rule}"\nRespect it: go low and slow, prefer single targeted requests (security.probe) over high-volume scanners, and do NOT run broad automated scans (nuclei, ffuf, many-request pipelines) against its assets. If a check would mean heavy automated traffic, skip it and say so rather than risk being flagged.` : '',
    '',
    'ALREADY DECLARED IN SCOPE (the Lab will accept these hosts, and only these):',
    hostList,
    '',
    outOfScope.length ? `OUT OF SCOPE — never touch these, whatever you find:\n${outOfScope.map(a => `  • ${a}`).join('\n')}` : '',
    exclusions.length ? `PROHIBITED TECHNIQUES for this program:\n${exclusions.map(e => `  • ${e}`).join('\n')}` : '',
    '',
    'HOW TO WORK:',
    '- Use the bounty method you were taught: recon the declared hosts, map the attack surface, then test the likely issues for this kind of target.',
    '- security.probe sends one in-scope GET and re-checks scope itself — use it freely for recon and for checking reflections.',
    '- lab.scan / lab.portScan / lab.idor / lab.enumerateUsers run against a DECLARED target id (see lab.listTargets). They refuse any host not declared, so they can only reach the hosts above.',
    '- If you need a tool that is not installed, install it with setup.runInstall and carry on.',
    '- If you need to test a host that is NOT in the list above, STOP and ask me first — declaring a new target is the one thing you must not do on your own.',
    '- Every active request is already scope-checked by the tool. Out-of-scope or forbidden (local/private/metadata) targets are refused automatically — do not try to work around a refusal.',
    '',
    'WHAT TO PRODUCE:',
    '- Record each genuine issue with security.addFinding — title, severity, the exact asset, clear reproduction steps, impact, and the evidence. A difference or a lead is not a confirmed finding; say so honestly.',
    '- Finish with a plain summary of what you tested, what you found, and what you could not do. Never claim a result a step did not actually show.',
  ].filter(line => line !== '').join('\n')
}
