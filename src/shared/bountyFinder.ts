/**
 * The bounty finder's types.
 *
 * Kept in shared so the renderer can render a feed without importing from the main process.
 * The feed itself is read-only: GitHub's public search API, no target contacted, nothing joined.
 */

export interface BountyItem {
  id: string
  title: string
  url: string
  repo: string
  /** The labels that made this look like bounty work. */
  labels: string[]
  comments: number
  createdAt: string
  updatedAt: string
  /** Days since it was opened, for the age signal. */
  ageDays: number
  /** A difficulty estimate, computed from the facts above. */
  difficulty: 'starter' | 'moderate' | 'hard'
  /** Why that estimate, in the user's words. */
  difficultyWhy: string
  /** True when competition looks low by the stated rule. */
  hiddenGem: boolean
  /** The technical hint: what the labels and title suggest the work is. */
  hint: string
  platform: 'github'
}

export interface BountyFeed {
  fetchedAt: string
  /** The query that produced this list, so the user can see what was asked. */
  query: string
  items: BountyItem[]
  /** What was searched and what was not. */
  note: string
  /** Set when the feed could not be read, with the reason. */
  error: string | null
}
