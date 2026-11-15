/**
 * The Toolbox verdict rules — the part that matters more than the commands.
 *
 * Pure functions only, so they can be tested without Electron or a network. The rules exist
 * because a cheat sheet tells you how a command works, never whether you may point it at a
 * given machine. That second question is answered by the program's own scope and rules, and
 * for three families of tool the answer is no whatever the program says.
 */

import type { ToolReference, ToolVerdict } from '../../../shared/toolboxTypes'

export const VERDICT_LABEL: Record<ToolVerdict, string> = {
  ALLOWED_UNDER_SCOPE: 'Allowed under scope',
  NEEDS_PROGRAM_PERMISSION: 'Needs explicit program permission',
  NEVER: 'Never',
}

export const VERDICT_ORDER: Record<ToolVerdict, number> = {
  NEVER: 0,
  NEEDS_PROGRAM_PERMISSION: 1,
  ALLOWED_UNDER_SCOPE: 2,
}

/** The families that no program scope can authorise, keyed by tool id. */
const NEVER_FAMILIES: Record<string, string> = {
  hashcat: 'password and credential attacking',
  john: 'password and credential attacking',
  hydra: 'password and credential attacking',
  medusa: 'password and credential attacking',
  netexec: 'NetExec credential, SAM/NTDS-dump and pass-the-hash paths',
  aircrack: 'wireless attacks against networks the user does not own',
  ettercap: 'traffic interception or spoofing on a network that is not the user\'s own',
  kismet: 'wireless capture of networks the user does not own',
  mimikatz: 'credential dumping and pass-the-ticket',
}

/**
 * The refusal a request gets once its tool is classified. The wording is the answer the user
 * reads, so it says the verdict and the reason, then what is still allowed.
 */
export function refusalFor(tool: Pick<ToolReference, 'id' | 'name' | 'verdict' | 'verdictReason'>): string | null {
  if (tool.verdict === 'NEVER') {
    const family = NEVER_FAMILIES[tool.id] ?? 'a tool that no program scope can authorise'
    return [
      `${tool.name} is a NEVER tool. Goga will not run it — not at a program's target, not at the user's own network, not as a "test".`,
      `Why: ${tool.verdictReason}`,
      `This is ${family}. Pointed at anything that is not the user's own machine or network, it is a computer-crime tool, and no program's scope makes it legal.`,
      '',
      'What is still allowed, without running anything: read the sheet, ask for the verdict or the commands, and use the one approved GET the Security page issues for an in-scope URL.',
    ].join('\n')
  }
  if (tool.verdict === 'NEEDS_PROGRAM_PERMISSION') {
    return [
      `${tool.name} needs explicit program permission. Goga will not run it on the strength of an imported scope alone.`,
      `Why: ${tool.verdictReason}`,
      '',
      'Active scanning, fuzzing and exploitation frameworks are frequently prohibited by a program\'s rules outright, and several platforms ban accounts for automated scanning even on an in-scope asset. The permission has to be written in the program\'s rules or given by the program in writing; if it is not there, the answer is no.',
      'What to do instead: read the program\'s rules for scanning, then work by hand with the single approved GET the Security page issues.',
    ].join('\n')
  }
  return null
}

/**
 * The verdict for a tool asked to run without being one of the three forbidden families: it is
 * an active scanner or fuzzer, so it needs the program's written permission.
 */
export function bannedScanLine(name: string): string {
  return `On top of that, ${name || 'this tool'} is active scanning or fuzzing — the class programs usually forbid outright and sometimes ban accounts for. Even with a program's written permission it would still be run by hand, not by Goga.`
}

/**
 * Every reason a request to run a command is turned down. Kept as data so the refusals can be
 * tested, and so nothing downstream can quietly decide a tool is runnable because it is
 * "allowed under scope" — Goga has no executor at all.
 */
export function classifyRunRequest(identifier: string): {
  tool: ToolVerdict | null
  refusal: string
} {
  // Goga has no command executor for these tools and this is not a policy that can be
  // relaxed: the only thing in the Security area that touches a third party is one approved GET.
  const name = identifier.trim().toLowerCase()
  const known = NEVER_FAMILIES[name]
  const lines = [
    `Goga does not run ${name || 'security tools'}.`,
    'The Security area has exactly one way to reach a target: the single GET the user approves for one in-scope URL. There is no shell-out, scanner, fuzzer or payload list behind the Toolbox.',
  ]
  if (known) {
    lines.push(`On top of that, ${name} is a NEVER tool (${known}). Pointed at anything that is not the user's own machine or network, it is a computer-crime tool, and no program scope authorises it.`)
    return { tool: 'NEVER', refusal: lines.join('\n') }
  }
  lines.push(bannedScanLine(name))
  lines.push('Ask for its verdict and commands instead; those are reference material.')
  return { tool: null, refusal: lines.join('\n') }
}

/**
 * Replies that ask *about* a tool or a technique rather than asking for one to be run. A
 * question is never answered with a refusal, so both detectors below consult this first.
 */
const QUESTION_GUARD = /\b(how (do|does|can|would|should) (i|you|one)|how to|what is|what's|what does|what do|what are|explain|tell me about|show me|verdict|cheat.?sheet|toolbox|is it (allowed|legal|ok|fine)|should i|why)\b/

/** "Is port scanning allowed?" is a question about the rule, not a request to scan. */
const PERMISSION_QUESTION = /\b(is|are|was|were|am i)\b[^?]{0,60}\b(allowed|legal|permitted|ok|okay|fine|banned|prohibited|against the rules)\b/

/**
 * A request to *run* a security tool, as opposed to a question about one. "Run nmap at
 * shop.example.com" is a request; "how do I run nmap" and "what is nmap's verdict" are not.
 */
export function securityRunRequest(text: string): { tool: string } | null {
  const t = text.toLowerCase()
  if (!/\b(run|scan|execute|fire|launch|attack|crack|brute[- ]?force|use|sweep|probe|exploit|fuzz|enumerate|sniff|intercept)\b/.test(t)) return null
  if (QUESTION_GUARD.test(t)) return null
  const id = toolNamedIn(text)
  if (!id) return null
  return { tool: id }
}

/**
 * Scanning something ordinary — a receipt, a PDF, a folder — is not a security-tool run. These
 * words keep the everyday meaning of "scan" out of the refusal path.
 */
const NON_SECURITY_SCAN = /\b(documents?|docs?|pdfs?|files?|folders?|directori(es|y)|images?|photos?|pictures?|qr|qrcode|barcodes?|receipts?|invoices?|screenshots?|disks?|drives?|usb|memory cards?|pages? of)\b/

/** The things a security tool is pointed at. */
const SECURITY_OBJECT = /\b(hosts?|servers?|targets?|ips?|ip addresses?|ports?|urls?|domains?|subdomains?|endpoints?|services?|network|lan|wifi|wi-fi|wireless|routers?|logins?|login pages?|passwords?|hashes|hash|handshakes?|pcap|packets?|traffic|smb|active directory|windows hosts?|api endpoints?)\b/

/** What a request to run a security tool is phrased with, tool named or not. */
const RUN_VERB = /\b(scan|scanning|sweep|sweeping|probe|probing|enumerate|enumerating|brute[- ]?force|bruteforce|crack|cracking|exploit|exploiting|fuzz|fuzzing|attack|attacking|pentest|penetration test|deauth|deauthenticate|sniff|sniffing|intercept|intercepting|mitm|spoof|spoofing|dump|pass[- ]?the[- ]?hash|inject|injecting|check)\b/

/** Phrases that are a security technique however the sentence is built. */
const SECURITY_PHRASE = /\b(port ?scan(?:ner|ning|s)?|open ports?|vuln(?:erability)? ?scan(?:ner|ning|s)?|brute[- ]?forc(?:e|ing)|password spray(?:ing)?|pass[- ]?the[- ]?hash|sql ?injection|sqli|xss|subdomain enumeration|directory brute[- ]?forc(?:e|ing)|dir ?bust(?:ing)?|go ?buster|nikto|pentest(?:ing)?|penetration test(?:ing)?|deauth(?:entication)?|handshake capture|packet capture|mitm|man[- ]in[- ]the[- ]middle|arp spoof(?:ing)?|dns spoof(?:ing)?|rid bruting|ntlm relay)\b/

/** Something that reads as an address rather than a word. */
const TARGET_TOKEN = /(https?:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]{2,})+(?:\/\S*)?\b)/i

/** The tools a phrase points at, so the reply carries their verdicts and not just a refusal. */
const PHRASE_TOOLS: { re: RegExp; tools: string[] }[] = [
  { re: /port ?scan|port ?scanner|open ports?|host discovery/, tools: ['nmap'] },
  { re: /vuln(erability)? ?scan/, tools: ['nuclei', 'nmap'] },
  { re: /sql ?injection|sqli|sql inject/, tools: ['sqlmap'] },
  { re: /subdomain/, tools: ['subfinder'] },
  { re: /wordpress|wp-admin|wp-login/, tools: ['wpscan'] },
  { re: /brute[- ]?force|password spray|credential|login pages?/, tools: ['hydra', 'medusa'] },
  { re: /crack|cracked|hashes|hashcat|password hash/, tools: ['hashcat', 'john'] },
  { re: /(?<!pass[- ]?the[- ]?)\bhash(es)?\b/, tools: ['hashcat', 'john'] },
  { re: /wifi handshake|handshake capture|wpa|wep/, tools: ['aircrack'] },
  { re: /exploit|pentest|penetration test|payload/, tools: ['metasploit'] },
  { re: /wifi|wi-fi|wireless|deauth|router/, tools: ['aircrack', 'kismet'] },
  { re: /mitm|man[- ]in[- ]the[- ]middle|arp spoof|dns spoof|sniff|intercept/, tools: ['ettercap'] },
  { re: /smb|active directory|pass[- ]?the[- ]?hash|ntlm|domain controller/, tools: ['netexec', 'mimikatz'] },
  { re: /\bsam\b|ntds|lsass|lsa secrets|dcsync|credential dump|dump (the )?(sam|ntds|lsass)/, tools: ['netexec', 'mimikatz'] },
  { re: /packet capture|pcap|traffic/, tools: ['wireshark'] },
]

/**
 * A request to point a security tool at a target *without naming one*: "scan a host", "run a
 * port scan on shop.example.com", "port scan 10.0.0.5". These used to fall through to the agent
 * loop, which spent steps hunting for a tool to call; the verdict belongs in the answer instead.
 */
export function securityUnnamedRunRequest(text: string): { phrase: string; tools: string[] } | null {
  const t = text.toLowerCase()
  if (QUESTION_GUARD.test(t) || PERMISSION_QUESTION.test(t)) return null
  if (!RUN_VERB.test(t)) return null
  if (NON_SECURITY_SCAN.test(t)) return null
  // A named tool is handled by securityRunRequest, with that tool's own verdict.
  if (toolNamedIn(text)) return null
  const phrase = t.match(SECURITY_PHRASE)?.[0] ?? t.match(RUN_VERB)?.[0] ?? null
  const addressed = SECURITY_OBJECT.test(t) || TARGET_TOKEN.test(t)
  if (!phrase && !addressed) return null
  const tools = new Set<string>()
  for (const { re, tools: ids } of PHRASE_TOOLS) if (re.test(t)) ids.forEach(id => tools.add(id))
  if (!tools.size && /\b(scan|sweep|probe|enumerate)\b/.test(phrase ?? '')) tools.add('nmap')
  return { phrase: phrase ?? 'scan', tools: [...tools] }
}

/**
 * The answer to "scan a host" when no tool was named: the verdicts of the tools that phrase
 * points at, then the refusal. Same rule as a named request — Goga has no executor — but the
 * user still gets the reference material that makes the answer useful.
 */
export function unnamedRunRefusal(
  phrase: string,
  tools: Pick<ToolReference, 'name' | 'verdict' | 'verdictReason' | 'usefulPart' | 'bannedPart'>[],
): string {
  const lines = [
    `Goga will not ${phrase} anything. There is no scanner behind the Toolbox — the only thing in the Security area that reaches a target is the single GET you approve for one in-scope URL.`,
    '',
  ]
  for (const t of tools) {
    lines.push(`${t.name} — ${VERDICT_LABEL[t.verdict]}`)
    lines.push(`  Why: ${t.verdictReason}`)
    lines.push(`  Useful on a bounty: ${t.usefulPart}`)
    lines.push(`  Gets the account banned or the person arrested: ${t.bannedPart}`)
    lines.push('')
  }
  lines.push('A cheat sheet is a memory aid, not authorisation. Reading these commands is legal and useful; running them against someone else\'s system is not, unless that owner said yes in writing through a program\'s scope and rules. Goga can teach the commands; it cannot give permission.')
  lines.push('')
  lines.push('What it can do instead: read out any tool\'s commands and verdict, check a URL against an imported program\'s scope, and — if you approve that exact request — send one GET through the Security page.')
  return lines.join('\n')
}

/**
 * A question *about* a tool — its verdict, its commands, what it needs. Answered from the
 * catalog rather than by the model, so the verdict a user reads is the one the catalog holds.
 * A question that names no tool but names a technique ("is port scanning allowed?") is answered
 * the same way, from the tools that technique belongs to.
 */
export function securityToolQuestion(text: string): { tool: string; tools?: string[] } | null {
  const t = text.toLowerCase()
  if (!/\b(verdict|allowed|legal|commands?|cheat.?sheet|toolbox|what is|what's|what does|tell me about|how do i use|needs? to run|what does it need|is it allowed|banned|why|how (do|can|would|should) i|how to)\b/.test(t)) return null
  const id = toolNamedIn(text)
  if (id) return { tool: id }
  const tools = new Set<string>()
  for (const { re, tools: ids } of PHRASE_TOOLS) if (re.test(t)) ids.forEach(x => tools.add(x))
  // "how do I scan a host" — a how-to about a technique the phrase list does not carry.
  // Answer it from the tool that does that job rather than from the model.
  if (!tools.size && RUN_VERB.test(t) && (SECURITY_OBJECT.test(t) || TARGET_TOKEN.test(t))) tools.add('nmap')
  if (!tools.size) return null
  return { tool: [...tools][0], tools: [...tools] }
}

/**
 * The tool a free-text request names, if any. Used so "run nmap at example.com" is answered
 * with nmap's verdict and refusal, rather than a generic apology.
 */
export function toolNamedIn(text: string): string | null {
  const t = text.toLowerCase()
  const aliases: [RegExp, string][] = [
    [/\bhashcat\b/, 'hashcat'],
    [/\bjohn\b(?!ny)|\bjohnny\b|\bjtr\b/, 'john'],
    [/\bhydra\b/, 'hydra'],
    [/\bmedusa\b/, 'medusa'],
    [/\bnetexec\b|\bnxc\b|\bcrackmapexec\b/, 'netexec'],
    [/\baircrack\b|\baireplay\b|\bairmon\b|\bairodump\b/, 'aircrack'],
    [/\bettercap\b/, 'ettercap'],
    [/\bkismet\b/, 'kismet'],
    [/\bmimikatz\b/, 'mimikatz'],
    [/\bnmap\b/, 'nmap'],
    [/\bnuclei\b/, 'nuclei'],
    [/\bsqlmap\b/, 'sqlmap'],
    [/\bwpscan\b/, 'wpscan'],
    [/\bmsfconsole\b|\bmetasploit\b/, 'metasploit'],
    [/\bsubfinder\b/, 'subfinder'],
    [/\bwireshark\b|\btshark\b/, 'wireshark'],
  ]
  for (const [re, id] of aliases) if (re.test(t)) return id
  return null
}
