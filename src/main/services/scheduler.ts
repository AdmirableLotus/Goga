import fs from 'fs'

/**
 * Goga's own recurring tasks: "every hour check alpaca", "remind me to stretch every 2 hours",
 * "every morning at 8 give me the market news". Each task is a chat request that runs on its
 * schedule exactly as if it had been typed, so every safety rule and approval still applies.
 * Saved to disk, so tasks survive restarts; a run missed while the PC was off happens once.
 */

export interface ScheduledTask {
  id: number
  request: string
  kind: 'task' | 'reminder'
  everyMinutes?: number
  dailyAt?: string // "HH:MM", local time
  nextRun: number
  createdBy: 'user' | 'goga'
  createdAt: number
  runs: number
  failures: number
  lastRun?: number
  lastResult?: string
  paused?: boolean
}

export interface ScheduleSpec { request: string; kind: 'task' | 'reminder'; everyMinutes?: number; dailyAt?: string }

export const MIN_EVERY_MINUTES = 15
export const MAX_TASKS = 20
const MAX_FAILURES = 3
const TICK_MS = 60_000

const UNIT_MINUTES: Record<string, number> = { minute: 1, min: 1, hour: 60, hr: 60, day: 1440, week: 10080 }
const TIME_OF_DAY: Record<string, string> = { morning: '08:00', afternoon: '13:00', evening: '18:00', night: '21:00' }

function clock(h: number, m: number, ampm?: string): string | null {
  let hour = h
  if (ampm) { const pm = /p/i.test(ampm); if (hour === 12) hour = pm ? 12 : 0; else if (pm) hour += 12 }
  if (hour > 23 || m > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// "every 2 hours", "every hour", "hourly", "every day at 9am", "every morning", "daily at 18:30"
const PERIOD = /\b(?:every\s+(\d+)\s*(minute|min|hour|hr|day|week)s?|every\s+(minute|hour|day|week)|(hourly|daily|weekly)|every\s+(morning|afternoon|evening|night))\b/i
const AT_TIME = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i
const LEAD_IN = /^(?:(?:hey\s+)?goga[,\s]+)?(?:please\s+)?(?:(?:can|could|will|would)\s+you\s+)?(?:(?:set\s+up|create|make|add|start)\s+(?:an?\s+)?(?:automated\s+|recurring\s+|scheduled\s+|daily\s+|hourly\s+)?(?:task|job|routine|schedule)\s+(?:to|that|for|which)\s+|schedule\s+(?:a\s+task\s+to\s+)?|automatically\s+|go\s+ahead\s+and\s+)?/i
const STATEMENT = /^(i|i'm|im|we|my|our|he|she|they|it's|its|there)\b/i

/** A message asking for something on a schedule, or null. `previous` resolves "do that every hour". */
export function parseSchedule(raw: string, previous?: string | (() => string | undefined)): ScheduleSpec | null {
  const text = raw.trim().replace(/\s+/g, ' ')
  if (!text || text.length > 250) return null
  const period = text.match(PERIOD)
  if (!period) return null
  // "I go to the gym every day" is a fact about the user, not a request.
  if (STATEMENT.test(text.replace(LEAD_IN, ''))) return null
  if (/\?\s*$/.test(text) && !/^(?:(?:hey\s+)?goga[,\s]+)?(?:please\s+)?(can|could|will|would)\s+you\b/i.test(text)) return null

  let everyMinutes: number | undefined
  let dailyAt: string | undefined
  if (period[1]) everyMinutes = Number(period[1]) * UNIT_MINUTES[period[2].toLowerCase()]
  else if (period[3]) everyMinutes = UNIT_MINUTES[period[3].toLowerCase()]
  else if (period[4]) everyMinutes = { hourly: 60, daily: 1440, weekly: 10080 }[period[4].toLowerCase() as 'hourly' | 'daily' | 'weekly']
  else if (period[5]) dailyAt = TIME_OF_DAY[period[5].toLowerCase()]

  const at = text.match(AT_TIME)
  if (at && (dailyAt || everyMinutes === 1440)) {
    const t = clock(Number(at[1]), Number(at[2] ?? 0), at[3])
    if (t) { dailyAt = t; everyMinutes = undefined }
  }

  let request = text.replace(period[0], ' ')
  if (at && dailyAt) request = request.replace(at[0], ' ')
  request = request.replace(/\b(on your own|by yourself|automatically|for me)\b/gi, ' ')
    .replace(LEAD_IN, '').replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;!?-]+$/g, '').trim()
  request = request.replace(LEAD_IN, '').trim()

  const remind = request.match(/^remind me (?:to |about |that )?(.+)$/i)
  if (remind) return { request: remind[1].trim(), kind: 'reminder', everyMinutes, dailyAt }

  // "do that every hour", "review it every hour": the thing just asked about.
  if (!request || (request.split(' ').length <= 3 && /\b(it|that|this|them|the same)\b/i.test(request) || /^(do|repeat|run)$/i.test(request))) {
    const earlier = (typeof previous === 'function' ? previous() : previous)?.trim()
    if (!earlier) return null
    request = earlier
  }
  return { request, kind: 'task', everyMinutes, dailyAt }
}

/** "every hour", "every 30 minutes", "every day at 9:00 AM". */
export function describeSchedule(t: Pick<ScheduledTask, 'everyMinutes' | 'dailyAt'>): string {
  if (t.dailyAt) {
    const [h, m] = t.dailyAt.split(':').map(Number)
    return `every day at ${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
  }
  const n = t.everyMinutes ?? 60
  if (n % 10080 === 0) return n === 10080 ? 'every week' : `every ${n / 10080} weeks`
  if (n % 1440 === 0) return n === 1440 ? 'every day' : `every ${n / 1440} days`
  if (n % 60 === 0) return n === 60 ? 'every hour' : `every ${n / 60} hours`
  return `every ${n} minutes`
}

export function nextRunAfter(t: Pick<ScheduledTask, 'everyMinutes' | 'dailyAt'>, from: number): number {
  if (t.dailyAt) {
    const [h, m] = t.dailyAt.split(':').map(Number)
    const next = new Date(from)
    next.setHours(h, m, 0, 0)
    if (next.getTime() <= from) next.setDate(next.getDate() + 1)
    return next.getTime()
  }
  return from + (t.everyMinutes ?? 60) * 60_000
}

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

export interface SchedulerDeps {
  /** Run one task's request as a chat message; `text` is the reply to show. */
  run: (task: ScheduledTask) => Promise<{ ok: boolean; text: string }>
  /** Something to tell the user (in chat, and as a desktop notification when `notify`). */
  report: (text: string, notify: boolean) => void
  /** True while the user is mid-conversation or another task is running: wait a minute. */
  busy: () => boolean
  now?: () => number
}

export class Scheduler {
  private tasks: ScheduledTask[] = []
  private timer?: ReturnType<typeof setInterval>
  private running = false
  private now: () => number

  constructor(private file: string, private deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (Array.isArray(saved)) this.tasks = saved
    } catch { /* first run */ }
  }

  list(): ScheduledTask[] { return [...this.tasks] }

  add(spec: ScheduleSpec, createdBy: 'user' | 'goga'): ScheduledTask {
    if (!spec.request.trim()) throw new Error('There is nothing to schedule.')
    if (!spec.dailyAt && (spec.everyMinutes ?? 0) < MIN_EVERY_MINUTES)
      throw new Error(`The shortest schedule is every ${MIN_EVERY_MINUTES} minutes, so I don't crowd out everything else.`)
    if (this.tasks.length >= MAX_TASKS) throw new Error(`I already have ${MAX_TASKS} scheduled tasks. Remove one first ("stop task 3").`)
    const same = this.tasks.find(t => t.request.toLowerCase() === spec.request.toLowerCase() && t.everyMinutes === spec.everyMinutes && t.dailyAt === spec.dailyAt)
    if (same) return same
    const now = this.now()
    const task: ScheduledTask = {
      id: Math.max(0, ...this.tasks.map(t => t.id)) + 1,
      request: spec.request.slice(0, 500), kind: spec.kind, everyMinutes: spec.dailyAt ? undefined : spec.everyMinutes, dailyAt: spec.dailyAt,
      nextRun: nextRunAfter(spec, now), createdBy, createdAt: now, runs: 0, failures: 0,
    }
    this.tasks.push(task)
    this.save()
    return task
  }

  remove(id: number): ScheduledTask | undefined {
    const task = this.tasks.find(t => t.id === id)
    if (task) { this.tasks = this.tasks.filter(t => t.id !== id); this.save() }
    return task
  }

  removeAll(): number {
    const n = this.tasks.length
    this.tasks = []
    this.save()
    return n
  }

  setPaused(id: number, paused: boolean): ScheduledTask | undefined {
    const task = this.tasks.find(t => t.id === id)
    if (task) {
      task.paused = paused
      if (!paused) { task.failures = 0; task.nextRun = nextRunAfter(task, this.now()) }
      this.save()
    }
    return task
  }

  /** The tasks in plain words, for chat. */
  summary(): string {
    if (this.tasks.length === 0) return 'I have no scheduled tasks. Ask me with a schedule, for example "every hour check alpaca" or "remind me to stretch every 2 hours".'
    const lines = this.tasks.map(t => `${t.id}. ${t.kind === 'reminder' ? `Remind you: ${t.request}` : t.request} — ${describeSchedule(t)}${t.paused ? ' (paused)' : `, next at ${timeOf(t.nextRun)}`}${t.createdBy === 'goga' ? ' (I set this up myself)' : ''}${t.runs ? `, ran ${t.runs}×` : ''}`)
    return `My scheduled tasks:\n${lines.join('\n')}\n\nSay "stop task 2" to remove one, "pause task 2" / "resume task 2", or "stop all scheduled tasks".`
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Run the most overdue task, if any is due and nothing else is happening. */
  async tick(): Promise<void> {
    if (this.running) return
    const now = this.now()
    const due = this.tasks.filter(t => !t.paused && t.nextRun <= now).sort((a, b) => a.nextRun - b.nextRun)[0]
    if (!due || this.deps.busy()) return
    this.running = true
    try {
      if (due.kind === 'reminder') {
        this.deps.report(`⏰ Reminder: ${due.request}`, true)
        due.failures = 0
        due.lastResult = 'reminded'
      } else {
        const result = await this.deps.run(due).catch((err): { ok: boolean; text: string } => ({ ok: false, text: err instanceof Error ? err.message : String(err) }))
        due.lastResult = result.text.slice(0, 300)
        due.failures = result.ok ? 0 : due.failures + 1
        if (due.failures >= MAX_FAILURES) {
          due.paused = true
          this.deps.report(`I paused scheduled task ${due.id} ("${due.request}") after it failed ${MAX_FAILURES} times in a row. Last error: ${due.lastResult}\nSay "resume task ${due.id}" to try again, or "stop task ${due.id}" to remove it.`, true)
        }
      }
      due.runs++
      due.lastRun = now
      // Missed runs (the PC was off) are not replayed one by one: the next run is from now.
      due.nextRun = nextRunAfter(due, now)
      this.save()
    } finally {
      this.running = false
    }
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.tasks, null, 2))
      fs.renameSync(tmp, this.file)
    } catch { /* best effort: the tasks stay in memory */ }
  }
}

let instance: Scheduler | undefined
export function initScheduler(file: string, deps: SchedulerDeps): Scheduler { return instance = new Scheduler(file, deps) }
export function scheduler(): Scheduler | undefined { return instance }

// Chat commands about the schedule itself.
export const SCHEDULE_LIST = /\b((my|your) (scheduled|automated|recurring) (tasks|jobs)|what (tasks|jobs) (do you have|are|have you) (scheduled|set up|automated)|(list|show)( me)? (the |your |my )?(scheduled|automated|recurring) (tasks|jobs)|what('s| is) (on )?your schedule)\b/i
export const SCHEDULE_STOP_ALL = /^\s*(stop|cancel|delete|remove|clear) all (?:the |your |my )?(scheduled|automated|recurring) (tasks|jobs)\s*[.!]?\s*$/i
export const SCHEDULE_TASK_COMMAND = /^\s*(stop|cancel|delete|remove|pause|resume|unpause) (?:scheduled |automated )?(?:task|job) #?(\d+)\s*[.!]?\s*$/i
