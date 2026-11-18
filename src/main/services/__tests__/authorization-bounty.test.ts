import { describe, expect, it, vi } from 'vitest'

vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
// Default threshold on purpose: 'medium' auto-approves medium risk, so these tests prove the
// bounty rules hold regardless of the threshold, not because of it.
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => ({ autoApproveBelow: 'medium', requireApprovalForAll: false }) }) } }))
import { AuthorizationService } from '../authorization'
import type { RiskLevel, ToolDefinition } from '../../../shared/types'

const tool = (name: string, riskLevel: RiskLevel = 'critical'): ToolDefinition =>
  ({ name, description: '', parameters: { type: 'object', properties: {} }, riskLevel, reversible: false, category: 'web' } as ToolDefinition)

describe('bounty-mode authorization', () => {
  const auth = AuthorizationService.getInstance()

  it('auto-approves the scope-checked security tools in a bounty run, but asks for them in a normal one', () => {
    for (const name of ['security.probe', 'lab.scan', 'lab.portScan', 'lab.idor', 'lab.enumerateUsers', 'setup.runInstall']) {
      expect(auth.evaluate(tool(name), {}, { mode: 'bounty' }), `${name} in bounty`).toMatchObject({ allowed: true, requiresApproval: false })
      // In a normal job the same critical tool still stops to ask.
      expect(auth.evaluate(tool(name), {}, { mode: 'normal' }).requiresApproval, `${name} in normal`).toBe(true)
    }
  })

  it('still asks before declaring a NEW target, even hands-off — declaring widens scope', () => {
    // 'medium' risk would pass the auto-approve threshold; the bounty rule must override that.
    expect(auth.evaluate(tool('lab.declareTarget', 'medium'), { host: 'evil.test' }, { mode: 'bounty' }))
      .toMatchObject({ allowed: true, requiresApproval: true })
  })

  it('never loosens the unbounded tools in a bounty run', () => {
    for (const name of ['shell.execute', 'broker.sendOrder', 'filesystem.delete', 'selfwork.apply', 'evolution.install']) {
      expect(auth.evaluate(tool(name), {}, { mode: 'bounty' }).requiresApproval, `${name} must stay gated`).toBe(true)
    }
  })

  it('leaves read-only observation auto-approved in both modes', () => {
    expect(auth.evaluate(tool('filesystem.read', 'low'), {}, { mode: 'bounty' }).requiresApproval).toBe(false)
    expect(auth.evaluate(tool('web.search', 'low'), {}, { mode: 'normal' }).requiresApproval).toBe(false)
  })
})
