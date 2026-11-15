/**
 * Toolbox lookup: one tool by name, or a search across the catalog.
 *
 * Pure and synchronous. No network, no child process, nothing that could run a command — the
 * catalog is text and the search is a filter over it.
 */

import type { ToolboxCatalog, ToolboxSearchResult, ToolReference } from '../../../shared/toolboxTypes'
import { toolboxCatalog } from './toolbox'
import { VERDICT_ORDER } from './toolboxVerdicts'

const ALIASES: Record<string, string> = {
  nmap: 'nmap',
  netexec: 'netexec',
  nxc: 'netexec',
  crackmapexec: 'netexec',
  hashcat: 'hashcat',
  john: 'john',
  'john-the-ripper': 'john',
  jtr: 'john',
  hydra: 'hydra',
  medusa: 'medusa',
  aircrack: 'aircrack',
  'aircrack-ng': 'aircrack',
  'airmon-ng': 'aircrack',
  'airodump-ng': 'aircrack',
  'aireplay-ng': 'aircrack',
  kismet: 'kismet',
  ettercap: 'ettercap',
  mimikatz: 'mimikatz',
  metasploit: 'metasploit',
  msf: 'metasploit',
  msfconsole: 'metasploit',
  nuclei: 'nuclei',
  sqlmap: 'sqlmap',
  wpscan: 'wpscan',
  subfinder: 'subfinder',
  wireshark: 'wireshark',
  tshark: 'wireshark',
}

export function findTool(identifier: string): ToolReference | null {
  const key = identifier.trim().toLowerCase().replace(/\.(exe|py|rb)$/, '')
  const id = ALIASES[key] ?? key
  return toolboxCatalog().tools.find(t => t.id === id) ?? null
}

/** Order: never-allowed first, then permission-needed, then allowed — the verdict read first. */
function order(a: ToolboxSearchResult, b: ToolboxSearchResult): number {
  return VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.name.localeCompare(b.name)
}

export function searchToolbox(query: string, catalog: ToolboxCatalog = toolboxCatalog()): ToolboxSearchResult[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    return catalog.tools
      .map(t => ({ id: t.id, name: t.name, verdict: t.verdict, matchedIn: 'name', excerpt: t.what }))
      .sort(order)
  }
  const terms = q.split(/\s+/).filter(Boolean)
  const results: ToolboxSearchResult[] = []
  for (const t of catalog.tools) {
    let matchedIn: string | null = null
    let excerpt = t.what
    const fields: [string, string][] = [
      ['name', `${t.name} ${t.id}`],
      ['verdict', `${t.verdict} ${t.verdictReason}`],
      ['what', t.what],
      ['needs', t.needs.join(' ')],
      ['useful part', t.usefulPart],
      ['banned part', t.bannedPart],
    ]
    for (const term of terms) {
      let hit = false
      for (const [field, text] of fields) {
        if (text.toLowerCase().includes(term)) {
          matchedIn = field
          if (field !== 'name' && field !== 'needs') excerpt = text
          hit = true
          break
        }
      }
      if (!hit) {
        for (const section of t.sections) {
          const line = section.commands.find(c => `${c.flag ?? ""} ${c.command} ${c.description}`.toLowerCase().includes(term))
          if (line) { matchedIn = 'command'; excerpt = `${line.command} — ${line.description}`; hit = true; break }
        }
      }
      if (!hit) { matchedIn = null; break }
    }
    if (matchedIn) results.push({ id: t.id, name: t.name, verdict: t.verdict, matchedIn, excerpt })
  }
  return results.sort(order)
}

/** The verdict in one paragraph, for the chat reply. */
export function verdictLine(t: ToolReference): string {
  return `${t.name}: ${t.verdict} — ${t.verdictReason}`
}
