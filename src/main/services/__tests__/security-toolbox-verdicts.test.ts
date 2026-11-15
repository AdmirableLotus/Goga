import { describe, expect, it } from 'vitest'
import { toolboxCatalog } from '../security/toolbox'
import { classifyRunRequest, securityRunRequest, securityToolQuestion, toolNamedIn } from '../security/toolboxVerdicts'

describe('the verdict mapping', () => {
  const byId = (id: string) => toolboxCatalog().tools.find(t => t.id === id)

  it('covers all twenty-one tools with a verdict and a reason', () => {
    const tools = toolboxCatalog().tools
    expect(tools.length).toBe(21)
    for (const t of tools) {
      expect(t.verdictReason.length).toBeGreaterThan(40)
      expect(t.usefulPart.length).toBeGreaterThan(20)
      expect(t.bannedPart.length).toBeGreaterThan(20)
      expect(t.docs.length).toBeGreaterThan(0)
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

  it('puts passive recon and reading a capture in ALLOWED_UNDER_SCOPE', () => {
    expect(byId('subfinder')?.verdict).toBe('ALLOWED_UNDER_SCOPE')
    expect(byId('wireshark')?.verdict).toBe('ALLOWED_UNDER_SCOPE')
  })

  it('marks the banned half of NetExec and of Subfinder line by line', () => {
    const nxcBanned = byId('netexec')!.sections.flatMap(s => s.commands).filter(c => c.bannedPath).map(c => c.flag)
    for (const f of ['-H', '--sam', '--ntds', '--sam-dump', '--ntds-dump', '--dc-sync']) expect(nxcBanned).toContain(f)
    const sfBanned = byId('subfinder')!.sections.flatMap(s => s.commands).filter(c => c.bannedPath).map(c => c.flag)
    expect(sfBanned.sort()).toEqual(['-active', '-ports'])
  })

  it('marks every working command of a pure credential tool as the banned half', () => {
    const banned = (id: string) => byId(id)!.sections.flatMap(s => s.commands).filter(c => c.bannedPath)
      .map(c => c.command)
    // hashcat: 16 cracking lines marked, the benchmark/status/help lines left clean.
    expect(banned('hashcat')).toHaveLength(16)
    expect(banned('hashcat')).toContain('hashcat -m 1000 -a 0 hash.txt wordlist.txt')
    expect(byId('hashcat')!.sections.flatMap(s => s.commands).filter(c => !c.bannedPath).map(c => c.command))
      .toEqual(expect.arrayContaining(['hashcat --benchmark', 'hashcat -I', 'hashcat --help']))
    // John the Ripper: 16 cracking lines marked, the --test / --list documentation lines clean.
    expect(banned('john')).toHaveLength(16)
    expect(banned('john')).toContain('john --mask=?a?a?a?a hashes.txt')
    expect(byId('john')!.sections.flatMap(s => s.commands).filter(c => !c.bannedPath).map(c => c.command))
      .toEqual(expect.arrayContaining(['john --test', 'john --list=formats', 'john --help']))
    // Hydra and Medusa: the login-guessing half, including the module rows.
    expect(banned('hydra')).toContain('hydra -l admin -P pass.txt http-post-form')
    expect(banned('medusa')).toContain('medusa -M ssh')
    // sqlmap's extraction stage.
    expect(banned('sqlmap')).toContain('sqlmap -u <url> -D <database> -T <table> --dump')
  })
})

describe('the refusal path', () => {
  it('names the tool a request is about, through its aliases', () => {
    expect(toolNamedIn('please run nmap at shop.example.com')).toBe('nmap')
    expect(toolNamedIn('use tshark on this')).toBe('wireshark')
    expect(toolNamedIn('what is a subdomain')).toBeNull()
  })

  it('refuses a NEVER tool in the program\'s own terms', () => {
    const r = classifyRunRequest('hydra')
    expect(r.tool).toBe('NEVER')
    expect(r.refusal).toContain('computer-crime tool')
  })

  it('refuses every tool, allowed or not, because there is no executor', () => {
    for (const id of ['nmap', 'subfinder', 'wireshark', 'sqlmap']) {
      expect(classifyRunRequest(id).refusal).toContain('Goga does not run')
    }
  })

  it('tells a request to run a tool apart from a question about one', () => {
    expect(securityRunRequest('Run nmap against shop.example.com')).toEqual({ tool: 'nmap' })
    expect(securityRunRequest('use hydra to brute force the login on 10.0.0.5')).toEqual({ tool: 'hydra' })
    expect(securityRunRequest('scan this host with nuclei')).toEqual({ tool: 'nuclei' })
    // A question is not a request, and must not be answered with a refusal.
    expect(securityRunRequest('what is the verdict for subfinder?')).toBeNull()
    expect(securityRunRequest('how do I run nmap')).toBeNull()
    expect(securityRunRequest('show me the commands for hashcat')).toBeNull()
    expect(securityRunRequest('what is a subdomain')).toBeNull()
  })

  it('answers a question about a tool from the catalog', () => {
    expect(securityToolQuestion('what is the verdict for subfinder?')).toEqual({ tool: 'subfinder' })
    expect(securityToolQuestion('is hashcat allowed?')).toEqual({ tool: 'hashcat' })
    expect(securityToolQuestion('what does nmap need to run')).toEqual({ tool: 'nmap' })
    expect(securityToolQuestion('hello there')).toBeNull()
  })
})
