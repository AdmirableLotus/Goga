import type { RiskLevel, ToolDefinition } from '../../shared/types'
import { SettingsService } from './settings'
import { LogService } from './logs'
import { riskAtLeast } from '../tools/registry'

export interface AuthDecision {
  allowed: boolean
  requiresApproval: boolean
  reason: string
}

export interface AuthContext {
  /**
   * 'normal' is the everyday gate. 'bounty' is a watched, hands-off bug-bounty run the user
   * started for ONE selected program: the structured, scope-checked security tools below run
   * without a per-step approval, because the run itself was approved and every one of those
   * tools enforces the program's scope (or a live Lab declaration) inside itself. Nothing
   * else is loosened — a shell, an order, a file delete or a self-edit still asks, even in a
   * bounty run.
   */
  mode: 'normal' | 'bounty'
}

/**
 * The only tools a 'bounty' run may fire without asking. Each one is safe to auto-run ONLY
 * because it refuses out-of-scope work on its own, deterministically, whatever the planner
 * intended:
 *  - security.probe re-checks the active program's scope and the forbidden-host rule itself;
 *  - every active lab.* tool refuses any host not covered by a live declaration, and the
 *    bounty handler declares ONLY in-scope hosts at launch, so a scan can reach nothing else;
 *  - setup.runInstall is bound by the single-use gate to the exact package it offered.
 * lab.declareTarget is deliberately NOT here: declaring a new host is the one thing that could
 * widen scope, so even a hands-off run stops and asks before it declares anything new.
 */
const BOUNTY_AUTO: Set<string> = new Set([
  'security.probe',
  'lab.listTargets', 'lab.tools', 'lab.runs', 'lab.stop', 'lab.revokeTarget',
  'lab.portScan', 'lab.scan', 'lab.idor', 'lab.enumerateUsers',
  'setup.runInstall',
])

// Tools that are ALWAYS auto-approved regardless of settings — purely observational, read-only
const ALWAYS_AUTO: Set<string> = new Set([
  'computer.screenshot',
  'computer.activeWindow',
  'computer.windowList',
  'computer.uiElements',
  'computer.clipboard.read',
  'computer.snapshot',
  'computer.accessibilityTree',
  'computer.findElement',
  'computer.readScreenText',
  'computer.wait',
  'computer.focus.state',
  'computer.focus.ensure',
  'browser.read',
  'browser.screenshot',
  'browser.snapshot',
  'browser.ariaSnapshot',
  'browser.getByRole',
  'browser.getByLabel',
  'browser.getByText',
  'filesystem.read',
  'filesystem.list',
  'filesystem.search',
  'process.list',
  'vision.analyze',
  'vision.findElement',
  'web.search',
  'web.fetch',
  'research.search',
  'research.summarize',
  'research.brief',
  'memory.search',
])

// Tools that ALWAYS require approval regardless of settings — truly destructive
const ALWAYS_APPROVAL: Set<string> = new Set([
  'filesystem.delete',
  'process.kill',
  // A shell command can do anything, deleting included: the user agrees to each one.
  'shell.execute',
  // Money: an order is never sent without the user's say-so, on top of the broker's own
  // per-order confirmation.
  'broker.sendOrder', 'broker.killSwitch',
  // One active request against a bug-bounty target, even though it also needs a grant.
  'security.probe',
  // OSINT reaches third-party sites about a person or a domain: each run is approved by
  // the user first, so they see the exact query and the stated purpose.
  'osint.username', 'osint.email', 'osint.domain', 'osint.profile',
  // Writing to Goga's own source, and the run that produces such a change.
  'evolution.install', 'evolution.start',
  // Installing a program and creating a virtual machine change the machine: each one is
  // approved by the user, on top of the single-use gate's own binding to that exact install.
  'setup.runInstall', 'setup.createVm',
  // Writing Goga's own source: the single-use gate already holds the approval bound to
  // that exact file and diff, and this makes the loop ask as well, so neither alone is enough.
  'selfwork.apply',
])


export class AuthorizationService {
  private static instance: AuthorizationService
  private log = LogService.getInstance()

  static getInstance() {
    if (!AuthorizationService.instance) AuthorizationService.instance = new AuthorizationService()
    return AuthorizationService.instance
  }

  evaluate(tool: ToolDefinition, params: Record<string, unknown>, ctx: AuthContext): AuthDecision {
    const settings = SettingsService.getInstance().get()

    // 1. Always-auto tools (observational / read-only)
    if (ALWAYS_AUTO.has(tool.name) && tool.name !== 'computer.clipboard.read') {
      return { allowed: true, requiresApproval: false, reason: 'read-only observation' }
    }

    // 1b. A watched, hands-off bounty run.
    if (ctx.mode === 'bounty') {
      // Declaring a NEW target is the one act that can widen what a run may reach — a Lab
      // declaration is the Lab's own gate, not the program's scope. It is 'medium' risk, so
      // the auto-approve threshold below would otherwise pass it silently; in a bounty run it
      // must always stop and ask, whatever the threshold is.
      if (tool.name === 'lab.declareTarget') {
        return { allowed: true, requiresApproval: true, reason: 'a bounty run asks before declaring any new target' }
      }
      // The scope-checked security tools run without a per-step approval. This is the ONLY
      // place a critical tool is auto-approved, and it is limited to the BOUNTY_AUTO allowlist,
      // each member of which enforces scope (or a live, in-scope declaration) itself.
      if (BOUNTY_AUTO.has(tool.name)) {
        return { allowed: true, requiresApproval: false, reason: 'bounty run — scope-enforcing tool, authorized by the run' }
      }
    }

    // 2. Critical risk — always requires approval
    if (tool.riskLevel === 'critical') {
      return { allowed: true, requiresApproval: true, reason: 'critical risk level' }
    }

    // 3. Always-approval tools (truly destructive — no override)
    if (ALWAYS_APPROVAL.has(tool.name)) {
      return { allowed: true, requiresApproval: true, reason: `${tool.name} always requires approval` }
    }

    // 4. User setting: require approval for all
    if (settings.requireApprovalForAll) {
      return { allowed: true, requiresApproval: true, reason: 'requireApprovalForAll is enabled' }
    }

    // 5. Auto-approve if tool risk is at or below the user's threshold
    const threshold = settings.autoApproveBelow ?? 'medium'
    if (riskAtLeast(threshold, tool.riskLevel)) {
      return { allowed: true, requiresApproval: false, reason: `risk ${tool.riskLevel} within auto-approve threshold ${threshold}` }
    }

    // 6. High/critical risk — requires approval
    return { allowed: true, requiresApproval: true, reason: `risk level ${tool.riskLevel} requires approval` }
  }

  // Convenience: log the decision
  evaluateAndLog(tool: ToolDefinition, params: Record<string, unknown>, ctx: AuthContext): AuthDecision {
    const decision = this.evaluate(tool, params, ctx)
    if (!decision.allowed) {
      this.log.warn(`BLOCKED tool=${tool.name} reason=${decision.reason}`)
    } else if (decision.requiresApproval) {
      this.log.info(`APPROVAL REQUIRED tool=${tool.name} reason=${decision.reason}`)
    }
    return decision
  }
}
