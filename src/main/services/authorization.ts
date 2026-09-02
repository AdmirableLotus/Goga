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
  mode: 'normal' | 'security-research'
  securityWorkspaceId?: string
}

// Tools that are ALWAYS auto-approved regardless of settings — purely observational, read-only
const ALWAYS_AUTO: Set<string> = new Set([
  'computer.screenshot',
  'computer.activeWindow',
  'computer.windowList',
  'computer.uiElements',
  'computer.clipboard.read',
  'browser.read',
  'browser.screenshot',
  'filesystem.read',
  'filesystem.list',
  'filesystem.search',
  'process.list',
  'vision.analyze',
  'vision.findElement',
  'web.search',
  'web.fetch',
  'memory.search',
])

// Tools that ALWAYS require approval regardless of settings — truly destructive
const ALWAYS_APPROVAL: Set<string> = new Set([
  'filesystem.delete',
  'process.kill',
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
