/**
 * The navigation model.
 *
 * Chat is the front door: work is asked for there, and Goga does it. A page exists for the
 * things a person has to *see* (what is running, what is waiting on them) or *configure*
 * (settings), plus one place to look at each area's state. It is not the only way to make
 * something happen — every capability behind these sections is also a tool the chat path can
 * call, and `src/main/tools/*` is where that is proven.
 *
 * This file is deliberately plain data with no React in it, so a test can assert that every
 * tab that used to exist still resolves to a real destination and section. Nothing may become
 * unreachable by being folded away.
 */

export type DestinationId =
  | 'chat'
  | 'security'
  | 'trading'
  | 'work'
  | 'machine'
  | 'memory'
  | 'activity'
  | 'approvals'
  | 'settings'

export interface NavSection {
  /** Stable id, used as the section key inside its destination. */
  id: string
  /** What the sub-tab says. */
  label: string
  /** The tab id this section used to be, so old links and tests keep working. */
  legacy: string
}

export interface NavDestination {
  id: DestinationId
  label: string
  /** One line saying what this destination is for. Shown under the sub-tabs. */
  purpose: string
  sections: NavSection[]
}

/**
 * Nine destinations, down from twenty tabs.
 *
 * The grouping is by the work, not by the code: a security-research surface, a trading
 * surface, a work surface, a machine surface, and a memory surface. Chat, Activity,
 * Approvals and Settings stand alone because they are not an area — they are the front door,
 * the two things a person must be able to see, and configuration.
 */
export const NAV: NavDestination[] = [
  {
    id: 'chat',
    label: 'Chat',
    purpose: 'Ask for the work. Goga does it and reports what actually happened.',
    sections: [{ id: 'chat', label: 'Chat', legacy: 'chat' }],
  },
  {
    id: 'security',
    label: 'Security',
    purpose: 'Bug bounty: scope, one approved request, the specialist review, and public-source research.',
    sections: [
      { id: 'security', label: 'Bounty', legacy: 'security' },
      { id: 'osint', label: 'OSINT', legacy: 'osint' },
      { id: 'engineering', label: 'Engineering', legacy: 'engineering' },
    ],
  },
  {
    id: 'trading',
    label: 'Trading',
    purpose: 'Two practice venues, the rule-based strategies, and the charts behind them.',
    sections: [
      { id: 'trading', label: 'Broker', legacy: 'trading' },
      { id: 'practice', label: 'Practice', legacy: 'practice' },
      { id: 'strategy', label: 'Strategy', legacy: 'strategy' },
      { id: 'markets', label: 'Markets', legacy: 'markets' },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    purpose: 'Your own accounts and storefronts, and the background jobs doing the long work.',
    sections: [
      { id: 'business', label: 'Business', legacy: 'business' },
      { id: 'jobs', label: 'Jobs', legacy: 'jobs' },
    ],
  },
  {
    id: 'machine',
    label: 'Machine',
    purpose: 'The browser Goga drives, and what is installed on this computer.',
    sections: [
      { id: 'browser', label: 'Browser', legacy: 'browser' },
      { id: 'setup', label: 'Setup', legacy: 'setup' },
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    purpose: 'What Goga knows, what he has read, and how he works on his own code.',
    sections: [
      { id: 'memory', label: 'Facts', legacy: 'memory' },
      { id: 'library', label: 'Library', legacy: 'library' },
      { id: 'evolution', label: 'Self-improve', legacy: 'evolution' },
      { id: 'developer', label: 'Developer', legacy: 'developer' },
    ],
  },
  {
    id: 'activity',
    label: 'Activity',
    purpose: 'What is running right now, and what it has done.',
    sections: [{ id: 'activity', label: 'Activity', legacy: 'activity' }],
  },
  {
    id: 'approvals',
    label: 'Approvals',
    purpose: 'What is waiting on you. Nothing here runs until you say so.',
    sections: [{ id: 'approvals', label: 'Approvals', legacy: 'approvals' }],
  },
  {
    id: 'settings',
    label: 'Settings',
    purpose: 'Models, keys, voice and the switches that change how Goga behaves.',
    sections: [{ id: 'settings', label: 'Settings', legacy: 'settings' }],
  },
]

/** Every section, flattened, with the destination it lives in. */
export const ALL_SECTIONS: { destination: DestinationId; section: NavSection }[] =
  NAV.flatMap(d => d.sections.map(section => ({ destination: d.id, section })))

/**
 * The tab ids that existed before the consolidation. Kept as a list so a test can prove each
 * one still resolves — a folded page that cannot be reached is a deleted page.
 */
export const LEGACY_TABS = [
  'chat',
  'jobs',
  'browser',
  'setup',
  'practice',
  'trading',
  'strategy',
  'business',
  'security',
  'engineering',
  'osint',
  'library',
  'evolution',
  'memory',
  'settings',
  'markets',
  'activity',
  'approvals',
  'developer',
] as const

export type LegacyTab = typeof LEGACY_TABS[number]

/** Where an old tab id lives now, or null when it was never a tab. */
export function resolveLegacy(tab: string): { destination: DestinationId; section: string } | null {
  const hit = ALL_SECTIONS.find(s => s.section.legacy === tab)
  return hit ? { destination: hit.destination, section: hit.section.id } : null
}

/** The destination a section belongs to. */
export function destinationOf(sectionId: string): DestinationId | null {
  return ALL_SECTIONS.find(s => s.section.id === sectionId)?.destination ?? null
}
