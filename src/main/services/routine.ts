import fs from 'fs'

/**
 * Learns the user's routine: once a minute, while they are at the PC, which app is in
 * front and its window title. Only app names and titles: never keystrokes, screen contents
 * or anything typed. Private browser windows and password managers are recorded by app
 * name only. Kept on this PC, titles for a week and app times for a month.
 */

interface DayRecord { apps: Record<string, number>; titles: string[] }
interface RoutineData { days: Record<string, DayRecord>; hours: Record<string, number[]> }

export interface ActiveWindowInfo { owner: string; title: string }

export interface RoutineDeps {
  activeWindow: () => Promise<ActiveWindowInfo>
  /** Seconds since the last keyboard or mouse input. */
  idleSeconds: () => number
  enabled: () => boolean
  log: { info: (m: string) => void; warn: (m: string) => void }
  now?: () => number
}

const SAMPLE_EVERY_MS = 60_000
// Away from the keyboard this long: the minute is not counted.
const AWAY_SECONDS = 180
const TITLE_CHARS = 80
const TITLES_PER_DAY = 40
const KEEP_TITLES_DAYS = 7
const KEEP_DAYS = 31
const PRIVATE = /\b(inprivate|incognito|private browsing|keepass|bitwarden|1password|lastpass|dashlane|password)\b/i
// Goga's own window says nothing about the user's day.
const OWN_APPS = /^(electron|goga)(\.exe)?$/i

/** A question about the user's day, habits or what they were doing. */
export const ROUTINE_QUESTION = /\b(today|this morning|routine|usually|habits?|was i (doing|working)|did i (do|work)|my day|how long|spent|time on|screen time|what have i been)\b/i

export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function appName(owner: string): string {
  return owner.replace(/\.exe$/i, '').trim()
}

function duration(minutes: number): string {
  const h = Math.floor(minutes / 60), m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export class RoutineTracker {
  private data: RoutineData = { days: {}, hours: {} }
  private timer: ReturnType<typeof setInterval> | undefined
  private now: () => number

  constructor(private deps: RoutineDeps, private file?: string) {
    this.now = deps.now ?? Date.now
    try {
      if (file && fs.existsSync(file)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
    } catch (err) {
      deps.log.warn(`Routine file unreadable, starting fresh: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.sample() }, SAMPLE_EVERY_MS)
    this.timer.unref?.()
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined }

  /** Note what is in front right now. Never throws. */
  async sample(): Promise<void> {
    if (!this.deps.enabled() || this.deps.idleSeconds() > AWAY_SECONDS) return
    try {
      const win = await this.deps.activeWindow()
      const app = appName(win.owner)
      if (!app || OWN_APPS.test(app)) return
      const now = this.now()
      const day = (this.data.days[dayKey(now)] ??= { apps: {}, titles: [] })
      day.apps[app] = (day.apps[app] ?? 0) + 1
      const title = win.title.trim().slice(0, TITLE_CHARS)
      if (title && !PRIVATE.test(title) && !PRIVATE.test(app)) {
        const entry = `${app}: ${title}`
        day.titles = [...day.titles.filter(t => t !== entry), entry].slice(-TITLES_PER_DAY)
      }
      const hours = (this.data.hours[app] ??= Array(24).fill(0))
      hours[new Date(now).getHours()]++
      this.prune(now)
      this.save()
    } catch (err) {
      this.deps.log.warn(`Routine sample skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** What the user has been doing, for the brain's context. */
  summary(userName: string): string {
    const now = this.now()
    const today = this.data.days[dayKey(now)]
    const lines: string[] = []
    if (today) {
      const apps = Object.entries(today.apps).sort((a, b) => b[1] - a[1]).slice(0, 6)
      if (apps.length > 0) lines.push(`Today on this PC: ${apps.map(([a, m]) => `${a} ${duration(m)}`).join(', ')}.`)
      if (today.titles.length > 0) lines.push(`Recent windows today: ${today.titles.slice(-8).join('; ')}.`)
    }
    const hour = new Date(now).getHours()
    const usual = Object.entries(this.data.hours)
      .map(([app, counts]) => [app, counts[hour] ?? 0] as const)
      .filter(([, n]) => n >= 5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([app]) => app)
    if (usual.length > 0) lines.push(`Around this hour ${userName} usually uses: ${usual.join(', ')}.`)
    if (lines.length === 0) return ''
    return `What you have noticed about ${userName}'s day (apps and window titles only, kept on this PC):\n${lines.join('\n')}`
  }

  private prune(now: number): void {
    for (const key of Object.keys(this.data.days)) {
      const age = (now - new Date(`${key}T12:00:00`).getTime()) / 86_400_000
      if (age > KEEP_DAYS) delete this.data.days[key]
      else if (age > KEEP_TITLES_DAYS) this.data.days[key].titles = []
    }
  }

  private save(): void {
    if (!this.file) return
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 })
    } catch (err) {
      this.deps.log.warn(`Could not save routine: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
