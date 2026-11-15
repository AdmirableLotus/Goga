import type { ToolReference } from '../../../shared/toolboxTypes'
import { SHEETS } from './toolboxSheets'

/**
 * A small, curated extension to the Toolbox.
 *
 * The source is the Awesome OSINT List (github.com/Astrosp/Awesome-OSINT-List, GPL-3.0). That
 * list is 4.7k stars of links across thirteen categories. What is taken here is a handful of
 * entries that are genuinely useful for two jobs this user actually has: reading a downloaded
 * WordPress source tree, and reading public information lawfully.
 *
 * GPL-3.0 is why nothing is copied. Every entry below is described in this file's own words,
 * and each links to the upstream list rather than reproducing its text.
 *
 * What is NOT here, and will not be: the list's breach/leak-lookup, darknet, people-tracking,
 * phone-number resolution, address-lookup and credential sections. Those are either unlawful
 * for a private individual to use against people who have not consented, or they are exactly
 * the "find a person" capability that turns research into stalking. Their absence is
 * deliberate.
 *
 * Every entry gets the same verdict the existing sixteen tools get. Nothing here executes.
 */

export const OSINT_REFERENCE_NOTE = [
  'These entries are drawn from the Awesome OSINT List (github.com/Astrosp/Awesome-OSINT-List, GPL-3.0). They are described here in Goga\'s own words and link to the source rather than copying its text.',
  'The list has thirteen categories. This adds entries from the ones that serve reading public information and reading source code, and deliberately excludes its breach/leak, darknet, people-tracking, phone resolution, address lookup and credential sections. Those are out of bounds for a private individual and are not in the Toolbox at all.',
  'Like the sixteen cheat sheets, these are reference text. Nothing here runs, and a tool being listed is not permission to point it at anyone.',
].join('\n\n')

export const OSINT_REFERENCE_TOOLS: ToolReference[] = [
  {
    id: 'exiftool',
    name: 'ExifTool',
    what: 'Reads and writes the metadata inside image, audio, video and document files: camera model, timestamps, GPS where present, editing history, and the software that produced the file.',
    sheet: 'osint-list (metadata extraction)',
    verdict: 'ALLOWED_UNDER_SCOPE',
    verdictReason: 'Reading metadata from a file you already hold is analysis of your own material. It touches no network and no third party. It becomes a different thing only if you use it to locate a private individual, which is outside what this Toolbox is for.',
    usefulPart: 'Reading the metadata of an image or document before publishing it, so you know what it discloses about you; and confirming whether a screenshot really came from the application it claims.',
    bannedPart: 'Stripping provenance from someone else\'s work, or geolocating a person from a photo they did not choose to publish with coordinates.',
    needs: ['a file on this machine'],
    docs: [
      { title: 'ExifTool documentation (official)', url: 'https://exiftool.org/' },
      { title: 'Awesome OSINT List — metadata category (source list)', url: 'https://github.com/Astrosp/Awesome-OSINT-List' },
    ],
    sections: [{
      heading: 'Reading metadata (file you already hold)',
      commands: [
        { command: 'exiftool <file>', description: 'Print every metadata field the file carries.' },
        { command: 'exiftool -a -G1 -s <file>', description: 'Group fields by where they came from, including duplicates.' },
        { command: 'exiftool -GPSPosition <file>', description: 'Show the GPS position, if the file has one at all.' },
        { command: 'exiftool -all= -o out.jpg in.jpg', description: 'Write a copy with metadata removed, leaving the original untouched.' },
      ],
    }],
  },
  {
    id: 'invid',
    name: 'InVID / WeVerify verification plugin',
    what: 'A browser extension for checking whether a video or image is what it claims: keyframe extraction, reverse image search across several engines, and a magnifier for detail.',
    sheet: 'osint-list (media verification)',
    verdict: 'ALLOWED_UNDER_SCOPE',
    verdictReason: 'It checks material that is already public, and the searches it performs go to public image indexes. It reads public information; it does not touch a target and it does not identify a private person.',
    usefulPart: 'Establishing whether a screenshot or clip in a bug report is authentic, and finding where a piece of media was first published.',
    bannedPart: 'Using reverse image search to identify a private individual from a photo. That is not verification, it is identification, and it is not in scope here.',
    needs: ['the media file or its public URL'],
    docs: [
      { title: 'InVID / WeVerify project (official)', url: 'https://weverify.eu/verification-plugin/' },
      { title: 'Awesome OSINT List — media verification category (source list)', url: 'https://github.com/Astrosp/Awesome-OSINT-List' },
    ],
    sections: [{
      heading: 'Verifying media',
      commands: [
        { command: 'Keyframes', description: 'Break a video into stills so each can be searched separately.' },
        { command: 'Reverse image search (multiple engines)', description: 'Find earlier appearances of the same image.' },
        { command: 'Magnifier / metadata view', description: 'Inspect detail and read out what the file says about itself.' },
      ],
    }],
  },
  {
    id: 'crtsh',
    name: 'crt.sh (certificate transparency)',
    what: 'A public search over certificate transparency logs: every certificate issued for a domain, and therefore every hostname that has appeared in one.',
    sheet: 'osint-list (reconnaissance)',
    verdict: 'ALLOWED_UNDER_SCOPE',
    verdictReason: 'Certificate transparency logs are public by design — that is their purpose. Querying crt.sh asks a third-party public archive about a domain, and sends nothing to the domain itself. This is the passive recon the existing Subfinder entry already describes, and the same limits apply.',
    usefulPart: 'Finding hostnames that belong to a program\'s domain, so you can choose an in-scope one to read. It is the cheapest way to see a surface without touching it.',
    bannedPart: 'Treating a discovered hostname as in-scope. A name in a certificate log is not permission; only the program\'s scope is. Also: using the results to enumerate a domain that is not in any program you have imported.',
    needs: ['a domain name'],
    docs: [
      { title: 'crt.sh (the service)', url: 'https://crt.sh/' },
      { title: 'Certificate Transparency (RFC 6962)', url: 'https://www.rfc-editor.org/rfc/rfc6962' },
    ],
    sections: [{
      heading: 'Passive hostname discovery',
      commands: [
        { command: 'https://crt.sh/?q=%25.<domain>&output=json', description: 'Every logged certificate whose name ends in the domain.' },
        { command: 'https://crt.sh/?q=<exact.host>', description: 'Certificates for one exact host.' },
      ],
    }],
  },
  {
    id: 'public-records',
    name: 'Public records and official registers',
    what: 'The category of government and corporate registers: company filings, licence registers, court lists and official gazettes. Public by statute, and the lawful way to check whether an organisation is who it says it is.',
    sheet: 'osint-list (corporate and public records)',
    verdict: 'ALLOWED_UNDER_SCOPE',
    verdictReason: 'These records are published by law for public inspection. Reading them is ordinary research. What is deliberately not here is anything that resolves a private individual — people-search aggregators, address lookups, phone resolution — because those turn a research question into surveillance of a person who did not ask for it.',
    usefulPart: 'Confirming that the company behind a program is a real registered entity, and who its officers are, when you are deciding whether a program is worth your time.',
    bannedPart: 'People-search aggregators, address resolution and phone lookup. Those are excluded from this Toolbox on purpose and are not listed anywhere in it.',
    needs: ['an organisation name or jurisdiction'],
    docs: [
      { title: 'Awesome OSINT List — corporate and public records category (source list)', url: 'https://github.com/Astrosp/Awesome-OSINT-List' },
      { title: 'OpenCorporates (public company register aggregator)', url: 'https://opencorporates.com/' },
    ],
    sections: [{
      heading: 'What this category is for',
      commands: [
        { command: 'company register search', description: 'Find the registered entity, its jurisdiction and its filing history.' },
        { command: 'licence / professional register', description: 'Check whether an organisation holds a licence it claims.' },
        { command: 'official gazette search', description: 'Find statutory notices published about an entity.' },
      ],
    }],
  },
  {
    id: 'osint-learning',
    name: 'Learning and practice ranges',
    what: 'The training side of the list: deliberately vulnerable applications and guided labs you run on your own machine or in the provider\'s sandbox, where breaking things is the point.',
    sheet: 'osint-list (learning and training)',
    verdict: 'ALLOWED_UNDER_SCOPE',
    verdictReason: 'A practice range you were given is the one place where testing needs no program scope, because the owner built it to be attacked. That is why this entry is allowed outright while almost everything else needs permission. It is also the honest answer to "how do I get good enough for a real bounty".',
    usefulPart: 'The whole entry. A beginner who has solved a hundred guided labs reads real code far better than one who has read a hundred write-ups. The local WordPress copy this app reviews is itself a lawful target on your own machine.',
    bannedPart: 'Nothing in the training half — with the one exception that a range\'s sandbox is not a launchpad: attacking the provider\'s own infrastructure or another player is out of bounds and is usually a crime.',
    needs: ['a machine you own, or the provider\'s sandbox'],
    docs: [
      { title: 'Awesome OSINT List — learning category (source list)', url: 'https://github.com/Astrosp/Awesome-OSINT-List' },
      { title: 'OWASP Web Security Testing Guide (free, official)', url: 'https://owasp.org/www-project-web-security-testing-guide/' },
      { title: 'PortSwigger Web Security Academy (free labs)', url: 'https://portswigger.net/web-security' },
    ],
    sections: [{
      heading: 'The honest on-ramp',
      commands: [
        { command: 'guided lab (your own machine or a sandbox)', description: 'A known vulnerability, a known fix, and no third party involved.' },
        { command: 'read a disclosed report, then reproduce the class locally', description: 'The knowledge base in this page cites real report ids for exactly this.' },
        { command: 'read source, argue, validate, then reproduce by hand', description: 'The loop this whole area is built around.' },
      ],
    }],
  },
]

export function osintReferenceCatalog(): ToolReference[] {
  return OSINT_REFERENCE_TOOLS
}

/** Exposed so a search over the Toolbox includes these entries with the rest. */
export const EXTRA_SHEETS = SHEETS
