import { describe, expect, it, vi } from 'vitest'

vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => ({ autoApproveBelow: 'high', requireApprovalForAll: false }) }) } }))
vi.mock('../securityWorkspace', () => ({ SecurityWorkspaceService: { getInstance: () => ({ getActive: () => null }) } }))
import { AuthorizationService } from '../authorization'
import type { ToolDefinition } from '../../../shared/types'

const tool = (name: string): ToolDefinition => ({ name, description: '', parameters: { type: 'object', properties: {} }, riskLevel: 'medium', reversible: false, category: 'shell' } as ToolDefinition)

describe('shell commands', () => {
  it('always ask first, even when medium-risk actions are auto-approved', () => {
    const auth = AuthorizationService.getInstance()
    expect(auth.evaluate(tool('shell.execute'), { command: 'Get-ChildItem' }, { mode: 'normal' })).toMatchObject({ allowed: true, requiresApproval: true })
    expect(auth.evaluate(tool('notepad.saveText'), {}, { mode: 'normal' }).requiresApproval).toBe(false)
  })
})
