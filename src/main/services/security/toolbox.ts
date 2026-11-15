/**
 * The Toolbox catalog: sixteen transcribed cheat sheets, each with a verdict and the reason.
 *
 * The verdicts are the point. A command list tells you how a tool works; the verdict says
 * whether pointing it at someone else's machine is legal and allowed by the program, and for
 * three families the answer is no whatever the program says:
 *   - password and credential attacking (hashcat, Hydra, Medusa, NetExec's credential,
 *     SAM/NTDS-dump and pass-the-hash paths);
 *   - wireless attacks against networks the user does not own (aircrack-ng, aireplay-ng,
 *     Kismet's capture modes);
 *   - traffic interception or spoofing on a network that is not the user's own (Ettercap's
 *     ARP, DNS-spoof and MITM modes).
 * Those are computer-crime tools when pointed at anything that is not the owner's, and a
 * program's scope does not reach them.
 *
 * Nothing here executes. There is no scanner, fuzzer, payload list or credential attack
 * behind this file; it is text, typed by hand from the sheets, plus the tool's own docs links.
 */

import type { ToolboxCatalog, ToolReference } from '../../../shared/toolboxTypes'
import { SHEETS } from './toolboxSheets'
import { OSINT_REFERENCE_TOOLS } from './toolboxOsint'

const tools: ToolReference[] = [
  {
    id: 'nmap',
    name: 'Nmap',
    what: 'A port scanner and service/version detector. It maps which ports on a host answer, what software is listening, and (with scripts) what that software reports about itself.',
    sheet: 'mwd5gdbdfwd7.jpg',
    verdict: 'NEEDS_PROGRAM_PERMISSION',
    verdictReason: 'Nmap is active scanning: it sends packets the target did not ask for and an automated scan is often exactly what a program\'s rules prohibit. Many programs say in their policy "no automated scanning" or "no scanners", and several ban accounts for running them even on an in-scope asset. Scanning is allowed only when the program\'s rules permit it in writing; the imported scope alone is not that permission.',
    usefulPart: 'Reading a service banner a page already returns, and the --traceroute, --open and -oN/-oX/-oG output options as a way to organise what a permitted scan found.',
    bannedPart: '-p- (all 65,535 ports), -A, --script vuln and <target>/24 network sweeps: bulk scanning, service probing and vulnerability scripts fired at hosts that were never each approved. These are what get an account banned and, outside a program, what turns a scan into unauthorised access.',
    needs: ['target host'],
    docs: [
      { title: 'Nmap Reference Guide (official manual)', url: 'https://nmap.org/book/man.html' },
      { title: 'Nmap legal issues / authorisation (official book)', url: 'https://nmap.org/book/legal-issues.html' },
    ],
    sections: SHEETS.nmap,
  },
  {
    id: 'netexec',
    name: 'NetExec (nxc)',
    what: 'A network execution and enumeration framework for Active Directory and SMB: it logs in with credentials (or a stolen hash), lists shares, users and sessions, and runs commands or modules on Windows hosts.',
    sheet: 'mwd5gedbrmfo.jpg',
    verdict: 'NEVER',
    verdictReason: 'NetExec\'s core path is credential attacking: authenticating with a username and password list, pass-the-hash (-H), pass-the-ticket (-k), dumping SAM, LSA and NTDS, DCSync and remote command execution (-X, --wmi, --exec-method). Those are the mechanics of breaking into a Windows estate. Pointed at anything that is not the owner\'s, it is a computer-crime tool, and no program scope authorises credential attacks or dumping other people\'s secrets.',
    usefulPart: 'Reading what the client itself reports: --shares, --users, --groups, --sessions, --loggedon-users and --pass-pol against your own lab, and --help / --list-protocols as documentation.',
    bannedPart: '-u <user> -p <pass> with a list, -H <hash>, --sam, --sam-dump, --ntds, --ntds-dump, --lsa, --dc-sync, -X, --wmi and --exec-method. These are account-compromise paths, and most bounty programs forbid them outright even where the domain controller is in scope.',
    needs: ['target host', 'credentials or hash of someone else'],
    docs: [
      { title: 'NetExec wiki (official)', url: 'https://www.netexec.wiki/' },
      { title: 'NetExec module list (official)', url: 'https://www.netexec.wiki/smb-protocol/modules' },
    ],
    sections: SHEETS.netexec,
  },
  {
    id: 'hashcat',
    name: 'hashcat',
    what: 'A GPU password cracker. Given a hash file and a wordlist, mask or rule set, it finds the password behind the hash.',
    sheet: 'mwd5ge3xsrhs.jpg',
    verdict: 'NEVER',
    verdictReason: 'hashcat exists to recover someone\'s password from a hash. Even on your own capture, a recovered credential belongs to a real person, and using it anywhere is unauthorised access. Against a program\'s target it is a credential attack, which no program scope covers, and several programs treat cracked passwords as a serious violation rather than a finding.',
    usefulPart: 'The --benchmark, -I (devices) and --status commands, and -m 0 with a hash of your own data: useful for understanding how fast a password is broken so you can recommend a better policy.',
    bannedPart: '-a 0/-a 1/-a 3/6/7 against any hash obtained from a target, including a hash you took from a program\'s system. Cracking another person\'s password is the offence, not the tool, and the offence is what follows the crack.',
    needs: ['hash file', 'wordlist'],
    docs: [
      { title: 'hashcat wiki (official)', url: 'https://hashcat.net/wiki/' },
      { title: 'hashcat example hashes (official)', url: 'https://hashcat.net/wiki/doku.php?id=example_hashes' },
    ],
    sections: SHEETS.hashcat,
  },
  {
    id: 'hydra',
    name: 'Hydra',
    what: 'A fast online password guesser for logins: SSH, FTP, HTTP forms, SMB, RDP, databases and more. It tries usernames and passwords from lists against a live service.',
    sheet: 'mwd5gephe4yb.jpg',
    verdict: 'NEVER',
    verdictReason: 'Guessing logins against a live service is a credential attack. Even with a program\'s permission for the asset, password brute-forcing is normally prohibited outright, and against anyone else\'s service it is unauthorised access — the accounts being tried belong to real people. It is also account-lockout territory and the commonest reason a researcher is banned.',
    usefulPart: 'The -h help output, and the -e nsr check on your own test account, to show that a service accepts empty or username-equals-password logins in a demonstration you were invited to run.',
    bannedPart: '-l/-L with -p/-P against any service you do not own, and especially http-post-form against a program\'s login page. This is the part that gets the account banned and, outside a program, the person arrested.',
    needs: ['target host', 'wordlist'],
    docs: [
      { title: 'Hydra project page (official)', url: 'https://github.com/vanhauser-thc/thc-hydra' },
    ],
    sections: SHEETS.hydra,
  },
  {
    id: 'medusa',
    name: 'Medusa',
    what: 'A parallel, modular login guesser — the same job as Hydra, split into modules per service (ssh, ftp, smbnt, rdp, mysql and the rest).',
    sheet: 'mwd5gemju5ie.jpg',
    verdict: 'NEVER',
    verdictReason: 'Medusa\'s -u/-U with -p/-P is a credential attack on a live login, module by module. Programs do not authorise password guessing against their users\' accounts, and against anything that is not yours it is unauthorised access. -b even removes the interactive prompt so it can be fired unattended.',
    usefulPart: 'The -h output and the module list (-M <module>), which show what a service\'s login looks like, for a test account on a machine you own.',
    bannedPart: 'Any -h <target> -u/-U ... -p/-P ... run against a service you were not given in writing. This is the banned half.',
    needs: ['target host', 'wordlist'],
    docs: [
      { title: 'Medusa project page (official)', url: 'https://github.com/jmk-foofus/medusa' },
    ],
    sections: SHEETS.medusa,
  },
  {
    id: 'john',
    name: 'John the Ripper',
    what: 'A password cracker. Given a hash file and a wordlist, rule set or mask, it recovers the password behind the hash — the CPU counterpart to hashcat.',
    sheet: 'mwd5ge75xsi8.jpg',
    verdict: 'NEVER',
    verdictReason: 'Every working mode of John recovers a real person\'s password from a hash: --wordlist, --rules, --incremental, --mask and the --format=NT / md5crypt / sha256crypt modes. A recovered credential belongs to somebody, and using it anywhere is unauthorised access. Against a program\'s target it is a credential attack, which no program scope covers, and several programs treat a cracked password as a serious violation rather than a finding.',
    usefulPart: 'The --test self-test, --list=formats, --list=rules and --list=build-info output, and --status: they show how fast a password falls so you can argue for a better policy, without cracking anyone\'s.',
    bannedPart: '--wordlist / --rules / --incremental / --mask / --pot against any hash taken from a target, and --show to read back what was cracked. Cracking another person\'s password is the offence, not the tool.',
    needs: ['hash file', 'wordlist'],
    docs: [
      { title: 'John the Ripper documentation (official)', url: 'https://www.openwall.com/john/doc/' },
      { title: 'John the Ripper jumbo GitHub (official)', url: 'https://github.com/openwall/john' },
    ],
    sections: SHEETS.john,
  },
  {
    id: 'aircrack',
    name: 'aircrack-ng suite (airmon-ng, airodump-ng, aireplay-ng)',
    what: 'A wireless toolkit: it puts a card into monitor mode, captures nearby Wi-Fi traffic, deauthenticates clients to force a handshake, and cracks the captured key from a wordlist.',
    sheet: 'mwd5geafwtzu.jpg',
    verdict: 'NEVER',
    verdictReason: 'Capturing, deauthenticating and cracking a Wi-Fi network you do not own is an offence in most jurisdictions, and deauthentication knocks real people off their own network. A bounty program can give you a web scope; it cannot give you the radio around it, and it cannot give you a neighbour\'s Wi-Fi.',
    usefulPart: 'Almost none for a bounty. The only benign half is reading `airmon-ng check` and `--help` on your own adapter to understand what monitor mode is.',
    bannedPart: 'All of it against a network that is not yours: airodump-ng capture, aireplay-ng -0 deauth, -3 ARP replay, and aircrack-ng against the handshake. Wireless attacks against networks the user does not own are never allowed.',
    needs: ['interface', 'wordlist'],
    docs: [
      { title: 'Aircrack-ng documentation (official)', url: 'https://www.aircrack-ng.org/doku.php' },
    ],
    sections: SHEETS.aircrack,
  },
  {
    id: 'kismet',
    name: 'Kismet',
    what: 'A wireless detector, sniffer and intrusion-detection system: it finds access points and clients, captures packets, and can log them to pcapng.',
    sheet: 'mwd5gex5a0kt.jpg',
    verdict: 'NEVER',
    verdictReason: 'Kismet\'s capture modes listen to and record traffic on networks that are not the user\'s own — the same problem as airodump-ng, including Bluetooth and BLE neighbours. Passive sniffing of other people\'s wireless traffic is interception, and the pcap it writes is other people\'s data. A program scope does not reach the radio around its web assets.',
    usefulPart: 'The --help output and the option list, to understand what wireless IDS does. For your own network, kismet --kill and the web-interface options are ordinary administration.',
    bannedPart: 'The capture half: --writepcap with a --source pointing at a real interface, i.e. recording neighbours\' traffic to a file. Never on a network that is not the user\'s.',
    needs: ['interface'],
    docs: [
      { title: 'Kismet documentation (official)', url: 'https://www.kismetwireless.net/docs/' },
    ],
    sections: SHEETS.kismet,
  },
  {
    id: 'ettercap',
    name: 'Ettercap',
    what: 'A network interception tool: it sits between hosts on a LAN, poisons ARP so traffic flows through it, and can spoof DNS, rewrite URLs and capture credentials.',
    sheet: 'mwd5gegf5h1u.jpg',
    verdict: 'NEVER',
    verdictReason: 'The ARP, DNS-spoof and MITM modes redirect other people\'s traffic through the attacker\'s machine. On a network that is not the user\'s own — an office LAN, a café, a client\'s network — that is interception and spoofing, which are offences, and they capture other people\'s credentials. No program scope authorises interception on a network you do not own.',
    usefulPart: 'The --help output, -I to list interfaces, and reading `ettercap -T --read <file>` on a capture you were given, to understand what ARP poisoning looks like from the defender\'s side.',
    bannedPart: '-M arp:remote/arp:local, --sniff, --dns, -P dns_spoof and the filter plugins run against a live network that is not yours. That is the interception half and it is never allowed.',
    needs: ['interface'],
    docs: [
      { title: 'Ettercap documentation (official)', url: 'https://www.ettercap-project.org/documentation/' },
    ],
    sections: SHEETS.ettercap,
  },
  {
    id: 'mimikatz',
    name: 'Mimikatz',
    what: 'A Windows credential extractor: it reads logon passwords, NTLM hashes, Kerberos tickets and DPAPI secrets out of LSASS and the SAM, and can replay tickets.',
    sheet: 'mwd5gf07cczh.jpg',
    verdict: 'NEVER',
    verdictReason: 'Every useful path in Mimikatz is credential theft: sekurlsa::logonpasswords, lsadump::sam, lsadump::dcsync and kerberos::ptt steal other people\'s secrets or impersonate them. On a machine you do not own this is unauthorised access to a computer, and no program scope covers dumping a client\'s domain controller, however many credentials the program\'s page hands out for testing.',
    usefulPart: 'token::whoami, privilege::list and version, run on your own machine to see how tokens and privileges are arranged — the explanation, not the extraction.',
    bannedPart: 'sekurlsa::*, lsadump::*, kerberos::ptt/export, dpapi::*, vault::cred and misc::memssp. These are the banned half: they lift real credentials out of a live system.',
    needs: ['local Windows host'],
    docs: [
      { title: 'Mimikatz wiki (official)', url: 'https://github.com/gentilkiwi/mimikatz/wiki' },
    ],
    sections: SHEETS.mimikatz,
  },
  {
    id: 'metasploit',
    name: 'Metasploit',
    what: 'An exploitation framework: a catalogue of exploit modules, payloads and post-exploitation tools, driven from msfconsole.',
    sheet: 'mwd5gdyxyv8k.jpg',
    verdict: 'NEEDS_PROGRAM_PERMISSION',
    verdictReason: 'An exploitation framework is the definition of what most programs forbid by rule. Several programs say plainly that exploitation attempts — and especially running payloads or gaining a shell — are out of bounds even on an in-scope asset, and will ban the account. Where a program does permit proof-of-concept exploitation, it is on the specific target it named, with the payload it allows, in writing.',
    usefulPart: 'msfconsole search, show options, show payloads, show targets and msf6 check as documentation: they tell you what a known CVE looks like and whether a target claims to be vulnerable, without firing anything.',
    bannedPart: 'msf6 exploit / msf6 run with a payload set, and the session handling that follows. Firing an exploit at a host that did not approve it is unauthorised access; inside a program it is usually an instant ban even when the host is in scope.',
    needs: ['target host'],
    docs: [
      { title: 'Metasploit documentation (official)', url: 'https://docs.metasploit.com/' },
      { title: 'Metasploit Framework GitHub (official)', url: 'https://github.com/rapid7/metasploit-framework' },
    ],
    sections: SHEETS.metasploit,
  },
  {
    id: 'nuclei',
    name: 'Nuclei',
    what: 'A template-driven scanner. Each YAML template is a check for a known issue (a CVE, an exposed panel, a default credential), run against a list of URLs.',
    sheet: 'mwd5gf3e3tih.jpg',
    verdict: 'NEEDS_PROGRAM_PERMISSION',
    verdictReason: 'Nuclei is an automated scanner. A program that permits scanning may do so at a rate it names, with a User-Agent it can see, and many forbid it altogether — template scanners trip WAFs and rate limits, and a program that forbids scanning will count the flood as a rules violation and ban the account.',
    usefulPart: 'The help output, -severities to narrow to what matters, and -tags cve to run one named check against one URL you were given, after the program\'s rules say scanning is allowed.',
    bannedPart: '-l targets.txt and sweep runs across a whole in-scope wildcard. That is bulk scanning the program never agreed to, and it is the half that gets an account banned.',
    needs: ['target URL'],
    docs: [
      { title: 'Nuclei documentation (official)', url: 'https://docs.projectdiscovery.io/tools/nuclei/overview' },
      { title: 'Nuclei templates (official)', url: 'https://github.com/projectdiscovery/nuclei-templates' },
    ],
    sections: SHEETS.nuclei,
  },
  {
    id: 'sqlmap',
    name: 'sqlmap',
    what: 'An automated SQL-injection tool. It tests a URL or form for injection, then extracts database names, tables and rows.',
    sheet: 'mwd5gesumeyf.jpg',
    verdict: 'NEEDS_PROGRAM_PERMISSION',
    verdictReason: 'sqlmap is an automated fuzzer with an extraction stage: --risk and --level escalate the payloads it fires, and --dump pulls real rows out of the database. Extraction of other people\'s data is almost always excluded by a program; and automatic fuzzing is frequently prohibited. It needs the program\'s written permission, on the named parameter only.',
    usefulPart: 'The help output and --technique, to read what an injection class is; and -u on a parameter you were told to test, with the data extraction left off and the evidence taken by hand.',
    bannedPart: '--dump, --dbs, --tables, --columns and high --risk/--level runs. Dumping other people\'s database rows is a data breach you caused, even inside a program that allows testing.',
    needs: ['target URL'],
    docs: [
      { title: 'sqlmap usage (official)', url: 'https://github.com/sqlmapproject/sqlmap/wiki/Usage' },
    ],
    sections: SHEETS.sqlmap,
  },
  {
    id: 'wpscan',
    name: 'WPScan',
    what: 'A WordPress scanner: it enumerates users, plugins and themes, flags vulnerable versions, and can run a password attack against the login page.',
    sheet: 'mwd5gf9fw0hc.jpg',
    verdict: 'NEEDS_PROGRAM_PERMISSION',
    verdictReason: 'The enumeration modes (--enumerate u/p/t/vp) are automated scanning of a site, which programs frequently prohibit, and --plugins-detection aggressive is designed to be noisy. The password-attack flags are worse than that: they are a credential attack and fall under the NEVER rule for the tool as a whole.',
    usefulPart: 'Reading the site\'s own /readme.html, plugin pages and version numbers by hand, then testing a specific plugin\'s public page with the one approved GET. --api-token with the free WPScan API is a useful way to look up a version you found.',
    bannedPart: '--passwords / --usernames / --password-attack wp-login / --password-attack xmlrpc: brute-forcing other people\'s WordPress accounts. And aggressive plugin detection, which is scanning the program did not agree to.',
    needs: ['target URL', 'api key (optional)'],
    docs: [
      { title: 'WPScan documentation (official)', url: 'https://github.com/wpscanteam/wpscan/wiki' },
    ],
    sections: SHEETS.wpscan,
  },
  {
    id: 'subfinder',
    name: 'Subfinder',
    what: 'A passive subdomain enumerator. It queries public sources (certificate transparency, DNS datasets, search APIs) for subdomains of a domain, without sending traffic to the target.',
    sheet: 'mwd5gejcskor.jpg',
    verdict: 'ALLOWED_UNDER_SCOPE',
    verdictReason: 'Subdomain enumeration from public sources does not touch the target: it reads records others already published. That is the recon a program expects you to do before you touch anything, and it is fine as long as the domain you ask about is the one the program names and the results are only used to choose an in-scope target.',
    usefulPart: 'The whole passive half: -d <domain> with -silent, -o and -json to keep a list, and -sources to see where the names came from. This is the part that finds the interesting host.',
    bannedPart: 'Two flags reach the target and leave the passive lane: -active (which probes HTTP/HTTPS on every name it finds) and -ports (port scanning). With those, it becomes an automated scan and needs the program\'s permission.',
    needs: ['domain'],
    docs: [
      { title: 'Subfinder documentation (official)', url: 'https://docs.projectdiscovery.io/tools/subfinder/overview' },
      { title: 'certificate transparency (public source)', url: 'https://crt.sh/' },
    ],
    sections: SHEETS.subfinder,
  },
  {
    id: 'wireshark',
    name: 'Wireshark / tshark',
    what: 'A packet analyser. Wireshark captures and decodes traffic on an interface or reads a capture file; tshark is the command-line version that can filter and export fields.',
    sheet: 'mwd5gf6c1bb8.jpg',
    verdict: 'ALLOWED_UNDER_SCOPE',
    verdictReason: 'Reading a capture file that was taken on your own machine, or supplied with the task, is analysis, not attack. Live capture on a network that is not yours is interception, so the allowed part is the file half: -r, and tshark -r with display filters. Capturing off an interface you do not own is the same interception Ettercap does.',
    usefulPart: '-r <file.pcap> and the display filters (http, dns, ip.addr ==, tcp.port ==) to understand what a response actually contained — the defender\'s side of every finding.',
    bannedPart: 'wireshark -i <interface> / tshark -i <interface> in monitor mode on a network you do not own. Capturing other people\'s traffic without their consent is interception, and no program scope covers it.',
    needs: ['capture file'],
    docs: [
      { title: 'Wireshark User\'s Guide (official)', url: 'https://www.wireshark.org/docs/wsug_html_chunked/' },
      { title: 'tshark manual page (official)', url: 'https://www.wireshark.org/docs/man-pages/tshark.html' },
    ],
    sections: SHEETS.wireshark,
  },
]

export const UNREADABLE: ToolboxCatalog['unreadable'] = [
  { tool: 'Subfinder', detail: 'Two flags are printed in lowercase on the sheet while the rest of the flags print with a capital first letter: "-csv" (output results in CSV format) and "-nc" (quiet output without colours). They are written here as printed.' },
  { tool: 'Nmap', detail: 'On the -O line the sheet\'s letterform makes the flag look like "-0" in places; it is written here as -O (detect operating system), which is what the line describes.' },
  { tool: 'Medusa', detail: 'The sheet prints "-h" twice: once for the help menu and once for the target host. Both are written as printed; the second is the target.' },
  { tool: 'Kismet', detail: 'The sheet prints "--writepcap" where the tool\'s own documentation spells it "--write-pcap"; it is written here as the sheet prints it.' },
  { tool: 'Metasploit', detail: 'The header above "COMMANDS" reads as garbled text on the sheet; the tool name is Metasploit and the module commands are as transcribed.' },
  { tool: 'Mimikatz', detail: 'The dcsync line is hyphenated across the sheet; it is written here as one command.' },
]

export const TOOLBOX_NOTE = [
  'These commands are transcribed by hand from the sixteen cheat sheets you sent. The descriptions are the sheets\' own wording — your material, not a vendor\'s documentation. Each tool\'s official documentation is linked separately.',
  'A cheat sheet is a memory aid, not authorisation. Reading these commands is legal and useful. Running most of them against someone else\'s system is not, unless that owner said yes in writing through a program\'s scope and rules. Goga can teach the commands; it cannot give permission, and neither can a cheat sheet.',
  'Nothing on this page runs anything. The only thing in the Security area that reaches a target is the single GET you approve for one in-scope URL.',
].join('\n\n')

export function toolboxCatalog(): ToolboxCatalog {
  return { version: '2', note: TOOLBOX_NOTE, unreadable: UNREADABLE, tools: [...tools, ...OSINT_REFERENCE_TOOLS] }
}
