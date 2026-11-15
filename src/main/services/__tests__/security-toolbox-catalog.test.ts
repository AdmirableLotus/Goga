import { describe, expect, it } from 'vitest'
import { toolboxCatalog } from '../security/toolbox'
import { findTool, searchToolbox } from '../security/toolboxQuery'

describe('the toolbox catalog', () => {
  it('lists every tool once', () => {
    const ids = toolboxCatalog().tools.map(t => t.id)
    expect(ids).toEqual([...new Set(ids)])
    expect(ids.sort()).toEqual([
      'aircrack', 'crtsh', 'ettercap', 'exiftool', 'hashcat', 'hydra', 'invid', 'john', 'kismet',
      'medusa', 'metasploit', 'mimikatz', 'netexec', 'nmap', 'nuclei', 'osint-learning',
      'public-records', 'sqlmap', 'subfinder', 'wireshark', 'wpscan',
    ])
  })

  it('says plainly that a cheat sheet is not authorisation and the sheets are the user\'s material', () => {
    const note = toolboxCatalog().note
    expect(note).toMatch(/cheat sheet is a memory aid, not authorisation/)
    expect(note).toMatch(/your material, not a vendor/)
    expect(note).toMatch(/single GET/)
  })

  it('finds a tool by alias and returns null for anything else', () => {
    expect(findTool('nxc')?.id).toBe('netexec')
    expect(findTool('tshark')?.id).toBe('wireshark')
    expect(findTool('aireplay-ng')?.id).toBe('aircrack')
    expect(findTool('kerberoaster')).toBeNull()
  })
})

describe('search', () => {
  it('finds a tool by name, by command text and by need', () => {
    expect(searchToolbox('subfinder').map(h => h.id)).toContain('subfinder')
    expect(searchToolbox('pass-the-hash').map(h => h.id)).toEqual(['netexec'])
    expect(searchToolbox('deauth').map(h => h.id)).toContain('aircrack')
    expect(searchToolbox('wordlist').map(h => h.id)).toContain('hashcat')
    expect(searchToolbox('hash.txt').map(h => h.id)).toContain('hashcat')
    expect(searchToolbox('--ntds').map(h => h.id)).toContain('netexec')
  })

  it('lists the never-allowed tools first so the verdict is read first', () => {
    const all = searchToolbox('')
    expect(all.length).toBe(toolboxCatalog().tools.length)
    expect(all[0].verdict).toBe('NEVER')
    expect(all[all.length - 1].verdict).toBe('ALLOWED_UNDER_SCOPE')
  })

  it('returns nothing for a word the sheets never use, rather than a guess', () => {
    expect(searchToolbox('kerberoastz')).toHaveLength(0)
  })
})
