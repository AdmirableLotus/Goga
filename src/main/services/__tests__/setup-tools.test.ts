import { describe, expect, it, vi } from 'vitest'

// The setup tools register against the real registry the agent loop dispatches through.
// Reading the catalogue spawns PowerShell, so the runner is stubbed; the point of this file
// is that the tools exist, describe themselves honestly, and refuse to install without an
// approval that was actually given.
vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\fake\\userData', getAppPath: () => 'C:\\fake' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../setup/store', () => ({
  auditSetup: () => ({ id: 'a', time: new Date(0).toISOString(), kind: 'note', detail: '' }),
  readSetupAudit: () => [],
}))

// Every read answers "nothing here", so nothing is detected as installed and the commands
// never run against the real machine.
vi.mock('../setup/powershell', () => ({
  runPowerShell: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, needsElevation: false }),
  runPowerShellJson: async () => ({ data: null, result: { stdout: '', stderr: '', exitCode: 0, timedOut: false, needsElevation: false } }),
  psQuote: (v: string) => `'${String(v).replace(/'/g, "''")}'`,
}))

const { ToolRegistry } = await import('../../tools/registry')
await import('../../tools/setup')

const run = (name: string, params: Record<string, unknown>) =>
  ToolRegistry.getInstance().execute(name, params, { abortSignal: new AbortController().signal })

describe('the Setup tools are reachable from the agent loop', () => {
  it('registers every setup tool', () => {
    const reg = ToolRegistry.getInstance()
    for (const name of [
      'setup.catalogue', 'setup.proposeInstall', 'setup.approveInstall', 'setup.runInstall',
      'setup.installs', 'setup.virtualisation', 'setup.proposeVm', 'setup.approveVm',
      'setup.createVm', 'setup.vms', 'setup.audit',
    ]) {
      expect(reg.has(name), name).toBe(true)
    }
  })

  it('marks the two that change the machine as critical, so the loop always asks', () => {
    const reg = ToolRegistry.getInstance()
    expect(reg.get('setup.runInstall')!.definition.riskLevel).toBe('critical')
    expect(reg.get('setup.createVm')!.definition.riskLevel).toBe('critical')
    // Proposing changes nothing, so it is not gated.
    expect(reg.get('setup.proposeInstall')!.definition.riskLevel).toBe('low')
    expect(reg.get('setup.proposeVm')!.definition.riskLevel).toBe('low')
  })

  it('refuses to install through the tool when no approval was given', async () => {
    const r = await run('setup.runInstall', { proposalId: 'never-proposed' })
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('not an install Goga proposed')
  })

  it('refuses to create a VM through the tool when no approval was given', async () => {
    const r = await run('setup.createVm', { proposalId: 'never-proposed' })
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('not a VM Goga proposed')
  })

  it('refuses a "never" tool for installation, through the tool the model calls', async () => {
    const r = await run('setup.proposeInstall', { package: 'hashcat', task: 'a test' })
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('Goga will not install hashcat')
    expect(String(r.error)).toContain('NEVER tool')
  })

  it('reports the audit as empty rather than inventing entries', async () => {
    const r = await run('setup.audit', {})
    expect(r.success).toBe(true)
    expect(String(r.data)).toContain('empty')
  })
})
