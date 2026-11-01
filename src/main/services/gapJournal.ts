import fs from 'fs'

/**
 * Gap journal: what Goga couldn't do. Every failed task, missing tool, loop and "I can't"
 * answer is written down, and grouped into a short report of what to build next — the
 * raw material for Goga improving himself. Only the user's request (shortened) and the
 * failure are kept; never attachments, typed secrets or tool output.
 */

export type GapKind = 'missing-tool' | 'planning-failed' | 'looping' | 'tool-failed' | 'too-long' | 'cant-do'
export interface Gap { kind: GapKind; task: string; detail: string; tool?: string; time: string }

const MAX_GAPS = 500
const TASK_CHARS = 200

// "I can't…" / "I don't have a way to…" — the chat brain admitting a capability is missing.
const CANT_DO = /\bI (?:can(?:no|')t|am not able to|'m not able to|am unable to|'m unable to|don'?t have (?:a way|the ability|access|any way)|have no way)\b/i
// Refusals that are rules, not missing abilities — never worth "fixing".
const BY_DESIGN = /\b(password|api key|secret|two-factor|2fa|real money|live account|guarantee|predict the market|medical advice)\b/i

/** Shorten and scrub a request before it is kept. */
export function scrubTask(task: string): string {
  return task.replace(/\s+/g, ' ').replace(/\b(?:sk|pk|ghp|xox[bp])[-_][A-Za-z0-9_-]{8,}\b/g, '[key]').replace(/\b\d{6,}\b/g, '[number]').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').trim().slice(0, TASK_CHARS)
}

/** What an agent run that ended in an error says about a missing ability (null for success or a user stop). */
export function gapFromAgentEnd(task: string, status: string, error: string | undefined, reply: string): Omit<Gap, 'time'> | null {
  if (status !== 'error' || !error) return null
  const t = scrubTask(task.split('\n\nPlan agreed with')[0])
  const tool = /^(?:unknown_tool|duplicate_action): (\S+)/.exec(error)?.[1]
  if (error.startsWith('unknown_tool')) return { kind: 'missing-tool', task: t, tool, detail: `asked for a tool named "${tool}" that doesn't exist` }
  if (error.startsWith('planning_failed')) return { kind: 'planning-failed', task: t, detail: 'could not turn the request into tool steps' }
  if (error.startsWith('duplicate_action') || error === 'repeated_failure_cycle') return { kind: 'looping', task: t, tool, detail: reply.slice(0, 200) }
  if (error === 'task_timeout' || error === 'max_steps_reached') return { kind: 'too-long', task: t, detail: reply.slice(0, 200) }
  return { kind: 'tool-failed', task: t, detail: (error || reply).slice(0, 200) }
}

/** A chat answer that says Goga can't do what was asked (null when it's a rule, not a gap). */
export function gapFromChat(asked: string, answer: string): Omit<Gap, 'time'> | null {
  const sentence = answer.split(/(?<=[.!?])\s+/).find(s => CANT_DO.test(s))
  if (!sentence || BY_DESIGN.test(sentence) || BY_DESIGN.test(asked)) return null
  return { kind: 'cant-do', task: scrubTask(asked), detail: sentence.slice(0, 200) }
}

const STOP_WORDS = new Set('a an the to and or of for in on at my me you your i it is be can could would please just with this that from into hey goga'.split(' '))
/** Rough topic of a request, so similar requests group together. */
function topic(task: string): string {
  return task.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w)).slice(0, 3).join(' ') || 'other'
}

const ADVICE: Record<GapKind, string> = {
  'missing-tool': 'a new tool would close this gap',
  'planning-failed': 'my planner could not turn these into steps — a direct shortcut for this kind of request would fix it',
  'looping': 'I repeated the same action — the tool probably succeeded without me being able to tell, so it needs a better check',
  'tool-failed': 'the tool exists but failed — its error handling or inputs need work',
  'too-long': 'the task needed more steps than allowed — it should be broken into a dedicated tool',
  'cant-do': 'I told you I couldn\'t do it — maybe a tool I should have',
}

export interface GapGroup { kind: GapKind; key: string; count: number; examples: string[]; last: string }

/** Gaps grouped by kind and tool/topic, most frequent first. */
export function groupGaps(gaps: Gap[], since?: Date): GapGroup[] {
  const groups = new Map<string, GapGroup>()
  for (const g of gaps) {
    if (since && new Date(g.time) < since) continue
    const key = g.tool ?? topic(g.task)
    const id = `${g.kind}|${key}`
    const group = groups.get(id) ?? { kind: g.kind, key, count: 0, examples: [], last: g.time }
    group.count++
    if (group.examples.length < 3 && !group.examples.includes(g.task)) group.examples.push(g.task)
    if (g.time > group.last) group.last = g.time
    groups.set(id, group)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
}

/** Plain report of what Goga couldn't do and what would fix it. */
export function gapReport(gaps: Gap[], now = new Date(), days = 30): string {
  const groups = groupGaps(gaps, new Date(now.getTime() - days * 86_400_000))
  if (!groups.length) return `I haven't run into anything I couldn't do in the last ${days} days — or nothing has been asked that I failed at yet. Keep giving me real tasks; every failure is written down here.`
  const total = groups.reduce((s, g) => s + g.count, 0)
  const lines = groups.slice(0, 8).map((g, i) => {
    const what = g.kind === 'missing-tool' ? `I needed a "${g.key}" tool I don't have` : `${g.kind.replace('-', ' ')} on "${g.key}"`
    return `${i + 1}. ${what} — ${g.count}×. Asked: "${g.examples.join('"; "')}". ${ADVICE[g.kind][0].toUpperCase()}${ADVICE[g.kind].slice(1)}.`
  })
  return [`In the last ${days} days I hit ${total} thing${total === 1 ? '' : 's'} I couldn't do, in ${groups.length} group${groups.length === 1 ? '' : 's'}. Most useful to fix first:`, ...lines].join('\n')
}

/** Questions about Goga's own gaps: "what tools do you need", "what couldn't you do", "how can you improve". */
export const GAP_QUESTION = /\b(what (tools?|abilities|skills|features) (do |would )?you (need|want|lack|miss)|what (did|do|have) you (fail|struggle)|what (couldn'?t|can'?t) you do|what have you failed|your (gaps?|failures|weaknesses|limitations)|gap (journal|report)|how (can|could|should) (you|i) (improve|upgrade|evolve) (you|yourself)|what should (you|we|i) (build|add|fix) (next )?(for you|in you|to you)?)\b/i

export class GapJournal {
  constructor(private file: string, private now: () => Date = () => new Date()) {}

  all(): Gap[] {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return [] }
  }

  record(gap: Omit<Gap, 'time'> | null): void {
    if (!gap) return
    try {
      const gaps = [...this.all(), { ...gap, time: this.now().toISOString() }].slice(-MAX_GAPS)
      fs.writeFileSync(this.file, JSON.stringify(gaps, null, 2), { mode: 0o600 })
    } catch { /* the journal must never break a task */ }
  }

  report(days = 30): string { return gapReport(this.all(), this.now(), days) }

  /**
   * Once a week, the week's report — only when at least 3 new gaps came up (null otherwise).
   * The first call just starts the clock, so a fresh install doesn't report old history.
   */
  weeklyReport(): string | null {
    const stamp = `${this.file}.weekly`
    const now = this.now()
    let last: Date | undefined
    try { last = new Date(fs.readFileSync(stamp, 'utf8').trim()) } catch { /* never sent */ }
    const save = () => { try { fs.writeFileSync(stamp, now.toISOString()) } catch { /* try again next time */ } }
    if (!last || Number.isNaN(last.getTime())) { save(); return null }
    if (now.getTime() - last.getTime() < 7 * 86_400_000) return null
    const fresh = this.all().filter(g => new Date(g.time) >= last!)
    save()
    // The window spans back to the last report, even when it runs late.
    return fresh.length >= 3 ? gapReport(fresh, now, Math.ceil((now.getTime() - last.getTime()) / 86_400_000)) : null
  }
}

let journal: GapJournal | undefined
/** The journal in Goga's data folder (set once at startup). */
export function initGapJournal(file: string): GapJournal { return journal = new GapJournal(file) }
export function gapJournal(): GapJournal | undefined { return journal }
