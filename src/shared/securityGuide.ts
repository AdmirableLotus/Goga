import type { SecurityWorkspace } from './types'

export const POLICY_TOPICS = ['Eligible assets', 'Exclusions', 'Permitted techniques', 'Automation restrictions', 'Rate limits', 'Account requirements', 'Disclosure rules'] as const
export interface PolicyReview {
  fingerprint: string
  refreshedAt: number
  reviewedAt?: number
  changed: boolean
  answers: string[]
}
export interface ResearchSource { url: string; retrievedAt: string; content: string }
export interface ToolInventoryEntry { name: string; location: string | null; officialSource: string; version: 'Not executed'; status: 'Found on PATH' | 'Not found on PATH' }
export const LEARNING_PATH = [
  { title: '1. Learn web basics and report writing', url: 'https://www.hacker101.com/start-here', advice: 'Start with the Newcomers Playlist, then practice in Hacker101 CTF.' },
  { title: '2. Select a program and read its rules', url: 'https://www.hackerone.com/hackers/how-to-start-hacking', advice: 'Read the program security page, policy and scope before testing.' },
  { title: '3. Study public disclosures', url: 'https://hackerone.com/hacktivity', advice: 'Use disclosed reports to study impact and reproducible reports. A disclosure is not authorization to repeat a test.' },
  { title: '4. Find a program', url: 'https://hackerone.com/directory/programs', advice: 'Choose a program, import its handle below, refresh policy and complete every checklist topic.' },
]

export function policyChecklist(ws: SecurityWorkspace): Array<{ topic: string; detail: string }> {
  let exclusions = ws.excludedAssets.join('\n')
  if (ws.hackerOne) {
    try {
      const imported = JSON.parse(ws.programRules)
      exclusions = JSON.stringify(imported.exclusions ?? [], null, 2)
    } catch { exclusions = 'Consult full imported policy for exclusions.' }
  }
  return POLICY_TOPICS.map((topic, i) => ({ topic, detail: i === 0 ? ws.authorizedAssets.join('\n') : i === 1 ? exclusions : i === 2 ? ws.allowedTechniques.join('\n') : i === 4 ? ws.rateLimit : '' }))
}
