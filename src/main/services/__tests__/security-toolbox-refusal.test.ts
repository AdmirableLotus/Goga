import { describe, expect, it, vi } from 'vitest'

// The tool registry is the real one the agent loop dispatches through; the security tools
// import the local store, which asks Electron for the user-data folder. Nothing here touches
// the network or the disk beyond that path lookup.
vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\fake\\userData', getAppPath: () => 'C:\\fake' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}))

const { ToolRegistry } = await import('../../tools/registry')
await import('../../tools/security')

const run = (name: string, params: Record<string, unknown>) =>
  ToolRegistry.getInstance().execute(name, params, { abortSignal: new AbortController().signal })

/**
 * The refusal path, exercised through the tool the agent actually calls. A request to run a
 * security tool must come back as a refusal that names the verdict — never as a command that
 * ran, and never as a silent success.
 */
describe('security.runTool refuses, through the real registry', () => {
  it('is registered, and so is the reference tool', () => {
    const reg = ToolRegistry.getInstance()
    expect(reg.has('security.runTool')).toBe(true)
    expect(reg.has('security.toolbox')).toBe(true)
  })

  it('refuses nmap at a host and says it needs the program\'s written permission', async () => {
    const r = await run('security.runTool', { tool: 'nmap', target: 'shop.example.com' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('Goga will not run Nmap at shop.example.com')
    expect(r.error).toContain('needs explicit program permission')
    expect(r.error).toContain('Verdict: NEEDS_PROGRAM_PERMISSION')
  })

  it('refuses a credential tool as a computer-crime tool, whatever the scope says', async () => {
    for (const tool of ['hydra', 'hashcat', 'john', 'medusa', 'netexec', 'mimikatz']) {
      const r = await run('security.runTool', { tool, target: '10.0.0.5' })
      expect(r.success, tool).toBe(false)
      expect(r.error, tool).toContain('NEVER tool')
      expect(r.error, tool).toContain('computer-crime tool')
    }
  })

  it('refuses a wireless or interception tool the same way', async () => {
    for (const tool of ['aircrack-ng', 'aireplay-ng', 'kismet', 'ettercap']) {
      const r = await run('security.runTool', { tool, target: 'the cafe wifi' })
      expect(r.success, tool).toBe(false)
      expect(r.error, tool).toContain('NEVER tool')
    }
  })

  it('refuses even the tools it calls allowed under scope, because there is no executor', async () => {
    for (const tool of ['subfinder', 'wireshark']) {
      const r = await run('security.runTool', { tool, target: 'example.com' })
      expect(r.success, tool).toBe(false)
      expect(r.error, tool).toContain('Goga does not run')
    }
  })

  it('answers a reference question with the verdict and the commands, and runs nothing', async () => {
    const r = await run('security.toolbox', { tool: 'subfinder' })
    expect(r.success).toBe(true)
    const text = String(r.data)
    expect(text).toContain('Subfinder — Allowed under scope')
    expect(text).toContain('subfinder -d <domain>')
    expect(text).toContain('Useful on a bounty')
    expect(text).toContain('Gets the account banned or the person arrested')
  })

  it('searches the catalog by command text and by need', async () => {
    const byCommand = await run('security.toolbox', { search: 'pass-the-hash' })
    expect(String(byCommand.data)).toContain('NetExec')
    const byNeed = await run('security.toolbox', { search: 'capture file' })
    expect(String(byNeed.data)).toContain('Wireshark')
  })
})
