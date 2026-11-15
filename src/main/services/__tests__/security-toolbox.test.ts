import { describe, expect, it } from 'vitest'
import { toolboxCatalog } from '../security/toolbox'
import { classifyRunRequest, toolNamedIn } from '../security/toolboxVerdicts'

/**
 * The verdict mapping — which tool a program can authorise, which needs its written
 * permission, which no program can authorise — and the refusal that follows a request to run
 * one. Pinned in small, readable tests so a later edit cannot quietly move a tool's verdict.
 */

describe('the verdict mapping', () => {
  const byId = (id: string) => toolboxCatalog().tools.find(t => t.id === id)

  it('covers all twenty-one tools, each with a verdict, a reason, both halves and docs', () => {
    const tools = toolboxCatalog().tools
    // Sixteen cheat-sheet tools plus five reference entries drawn from the public OSINT list.
    expect(tools.length).toBe(21)
    for (const t of tools) {
      expect(t.verdictReason.length, t.id).toBeGreaterThan(40)
      expect(t.usefulPart.length, t.id).toBeGreaterThan(20)
      expect(t.bannedPart.length, t.id).toBeGreaterThan(20)
      expect(t.docs.length, t.id).toBeGreaterThan(0)
    }
  })

  it('puts credential attacking, wireless attacks and interception in NEVER', () => {
    for (const id of ['hashcat', 'john', 'hydra', 'medusa', 'netexec', 'mimikatz', 'aircrack', 'ettercap', 'kismet']) {
      expect(byId(id)?.verdict, id).toBe('NEVER')
    }
  })

  it('puts active scanning and exploitation frameworks in NEEDS_PROGRAM_PERMISSION', () => {
    for (const id of ['nmap', 'nuclei', 'sqlmap', 'wpscan', 'metasploit']) {
      expect(byId(id)?.verdict, id).toBe('NEEDS_PROGRAM_PERMISSION')
    }
  })

  it('puts passive recon and reading a capture file in ALLOWED_UNDER_SCOPE', () => {
    expect(byId('subfinder')?.verdict).toBe('ALLOWED_UNDER_SCOPE')
    expect(byId('wireshark')?.verdict).toBe('ALLOWED_UNDER_SCOPE')
  })

  it('marks the banned half of NetExec and of Subfinder, line by line', () => {
    const nxcBanned = byId('netexec')!.sections.flatMap(s => s.commands).filter(c => c.bannedPath).map(c => c.flag)
    for (const f of ['-H', '--sam', '--ntds', '--sam-dump', '--ntds-dump', '--dc-sync']) expect(nxcBanned).toContain(f)
    const sfBanned = byId('subfinder')!.sections.flatMap(s => s.commands).filter(c => c.bannedPath).map(c => c.flag)
    expect(sfBanned.sort()).toEqual(['-active', '-ports'])
  })
})

describe('the refusal path', () => {
  it('names the tool a request is about, through its aliases', () => {
    expect(toolNamedIn('please run nmap at shop.example.com')).toBe('nmap')
    expect(toolNamedIn('use tshark on this')).toBe('wireshark')
    expect(toolNamedIn('toolbox')).toBeNull()
    expect(toolNamedIn('what is a subdomain')).toBeNull()
    expect(toolNamedIn('open the cheat sheet for subfinder')).toBe('subfinder')
  })

  it('refuses a NEVER tool as a computer-crime tool', () => {
    const r = classifyRunRequest('hydra')
    expect(r.tool).toBe('NEVER')
    expect(r.refusal).toContain('computer-crime tool')
  })

  it('refuses every tool, allowed or not, because Goga has no executor', () => {
    for (const id of ['nmap', 'subfinder', 'wireshark', 'sqlmap']) {
      expect(classifyRunRequest(id).refusal).toContain('Goga does not run')
    }
  })
})
