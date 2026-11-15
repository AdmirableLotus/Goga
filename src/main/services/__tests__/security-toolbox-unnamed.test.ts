import { describe, expect, it } from 'vitest'
import { toolboxCatalog } from '../security/toolbox'
import { findTool } from '../security/toolboxQuery'
import {
  securityRunRequest,
  securityToolQuestion,
  securityUnnamedRunRequest,
  unnamedRunRefusal,
} from '../security/toolboxVerdicts'

/**
 * The unnamed-tool phrasing. "Run nmap at X" was already caught; "scan a host" was not, and fell
 * through to the agent loop, which spent steps looking for a tool to call. These are the
 * phrasings that must reach the verdict-and-refusal path instead.
 */
describe('a request to scan without naming a tool', () => {
  it('catches the plain phrasings', () => {
    for (const said of [
      'scan a host',
      'scan this host',
      'scan the target',
      'scan the network for hosts',
      'please scan 192.168.1.1',
      'can you scan example.com for open ports',
      'check if example.com has open ports',
    ]) {
      expect(securityUnnamedRunRequest(said), said).not.toBeNull()
    }
  })

  it('catches the technique phrasings and points them at the right tools', () => {
    expect(securityUnnamedRunRequest('run a port scan on shop.example.com')?.tools).toEqual(['nmap'])
    expect(securityUnnamedRunRequest('port scan 10.0.0.5')?.tools).toEqual(['nmap'])
    expect(securityUnnamedRunRequest('do a vulnerability scan on example.com')?.tools).toContain('nuclei')
    expect(securityUnnamedRunRequest('brute force the login on 10.0.0.5')?.tools).toEqual(['hydra', 'medusa'])
    expect(securityUnnamedRunRequest('crack this hash')?.tools).toEqual(['hashcat', 'john'])
    expect(securityUnnamedRunRequest('pass the hash on 10.0.0.5')?.tools).toEqual(['netexec', 'mimikatz'])
    expect(securityUnnamedRunRequest('deauth everyone on the network')?.tools).toContain('aircrack')
    expect(securityUnnamedRunRequest('sniff the wifi at the cafe')?.tools).toContain('ettercap')
    expect(securityUnnamedRunRequest('sql inject example.com')?.tools).toEqual(['sqlmap'])
    expect(securityUnnamedRunRequest('enumerate subdomains for example.com')?.tools).toEqual(['subfinder'])
    expect(securityUnnamedRunRequest('do a pentest on example.com')?.tools).toEqual(['metasploit'])
  })

  it('leaves an ordinary scan of a document alone', () => {
    for (const said of [
      'scan my documents folder',
      'scan this pdf',
      'scan a receipt',
      'scan the invoice into the folder',
      'scan a qr code',
    ]) {
      expect(securityUnnamedRunRequest(said), said).toBeNull()
    }
  })

  it('leaves a question alone, so a question is never answered with a refusal', () => {
    for (const said of [
      'how do I scan a host',
      'what is a port scan',
      'is port scanning allowed?',
      'are port scans allowed?',
      'is pentesting legal',
      'explain a port scan',
      'tell me about brute forcing',
    ]) {
      expect(securityUnnamedRunRequest(said), said).toBeNull()
    }
  })

  it('leaves a named tool to the named-tool path, so the verdict is that tool\'s own', () => {
    expect(securityUnnamedRunRequest('run nmap at shop.example.com')).toBeNull()
    expect(securityRunRequest('run nmap at shop.example.com')).toEqual({ tool: 'nmap' })
  })

  it('leaves ordinary chat alone', () => {
    for (const said of ['hello there', 'what is a subdomain', 'open the toolbox', 'write me a poem']) {
      expect(securityUnnamedRunRequest(said), said).toBeNull()
    }
  })
})

describe('a question about a technique, with no tool named', () => {
  it('is answered from the tools that technique belongs to', () => {
    expect(securityToolQuestion('is port scanning allowed?')).toEqual({ tool: 'nmap', tools: ['nmap'] })
    expect(securityToolQuestion('what is a port scan')).toEqual({ tool: 'nmap', tools: ['nmap'] })
    expect(securityToolQuestion('is pentesting legal')?.tools).toEqual(['metasploit'])
  })

  it('answers a how-to from the catalog rather than leaving it to the model', () => {
    expect(securityToolQuestion('how do I scan a host')?.tools).toEqual(['nmap'])
    expect(securityToolQuestion('how to scan a host')?.tools).toEqual(['nmap'])
    expect(securityToolQuestion('how do I crack a hash')?.tools).toEqual(['hashcat', 'john'])
    expect(securityToolQuestion('how do I brute force a login')?.tools).toEqual(['hydra', 'medusa'])
    expect(securityToolQuestion('how do I exploit a server')?.tools).toEqual(['metasploit'])
  })

  it('leaves a how-to about something ordinary alone', () => {
    for (const said of ['how do I scan a pdf', 'how do I check my email', 'how do I scan my documents folder']) {
      expect(securityToolQuestion(said), said).toBeNull()
    }
  })

  it('still answers a named tool the same way it always did', () => {
    expect(securityToolQuestion('what is the verdict for subfinder?')).toEqual({ tool: 'subfinder' })
    expect(securityToolQuestion('hello there')).toBeNull()
  })
})

describe('the unnamed refusal', () => {
  const tools = ['nmap', 'nuclei'].map(id => findTool(id)!)

  it('says it will not run anything, and names each tool\'s verdict and reason', () => {
    const text = unnamedRunRefusal('port scan', tools)
    expect(text).toContain('Goga will not port scan anything')
    expect(text).toContain('Nmap — Needs explicit program permission')
    expect(text).toContain('Nuclei — Needs explicit program permission')
    expect(text).toContain('Useful on a bounty')
    expect(text).toContain('Gets the account banned or the person arrested')
  })

  it('says a cheat sheet is not authorisation, and what is still allowed', () => {
    const text = unnamedRunRefusal('scan', tools)
    expect(text).toContain('A cheat sheet is a memory aid, not authorisation')
    expect(text).toContain('Goga can teach the commands; it cannot give permission')
    expect(text).toContain('single GET')
  })

  it('carries the NEVER verdict for a credential or wireless phrase', () => {
    const never = ['hydra', 'aircrack'].map(id => findTool(id)!)
    const text = unnamedRunRefusal('brute force', never)
    expect(text).toContain('Hydra — Never')
    expect(text).toContain('aircrack-ng suite')
    expect(text).toContain('Never')
  })

  it('never claims a command ran', () => {
    const text = unnamedRunRefusal('scan', tools)
    expect(text).not.toMatch(/\b(ran|executed|started|launched|sent)\b/i)
  })
})

describe('the catalog the refusal reads from', () => {
  it('has every tool the phrase map can name', () => {
    const ids = new Set(toolboxCatalog().tools.map(t => t.id))
    for (const id of ['nmap', 'nuclei', 'sqlmap', 'subfinder', 'wpscan', 'hydra', 'medusa', 'hashcat', 'john', 'metasploit', 'aircrack', 'kismet', 'ettercap', 'netexec', 'mimikatz', 'wireshark']) {
      expect(ids.has(id), id).toBe(true)
    }
  })
})
