import fs from 'fs'
import path from 'path'
import type { Job } from '../../../shared/jobs'
import { isJobState } from './state'

/**
 * Where jobs live between runs.
 *
 * One JSON file holding every job, written atomically (temp file + rename) so a crash during
 * a write leaves the previous board intact rather than a truncated file. There is also an
 * append-only journal: one line whenever a job changes state. The journal is what lets the
 * board say "this job was interrupted" rather than "this job vanished".
 *
 * `dir` is injected so this can be tested against a temp folder.
 */

export interface FileStore {
  load(): Job[]
  saveAll(jobs: Job[]): void
  log(line: string): void
}

export class JobFileStore implements FileStore {
  constructor(private dir: string) {}

  private get file() { return path.join(this.dir, 'jobs.json') }
  private get journal() { return path.join(this.dir, 'jobs-journal.log') }

  load(): Job[] {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isStoredJob)
    } catch {
      return []
    }
  }

  saveAll(jobs: Job[]): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  log(line: string): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(this.journal, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
    } catch { /* the journal is a convenience; losing a line must not break a job */ }
  }
}

function isStoredJob(value: unknown): value is Job {
  if (!value || typeof value !== 'object') return false
  const j = value as Partial<Job>
  return typeof j.id === 'string' && typeof j.goal === 'string' && isJobState(j.state)
}

/** A store that keeps everything in memory — for tests, and for a run with no data folder. */
export class MemoryStore implements FileStore {
  private jobs: Job[] = []
  public lines: string[] = []
  load(): Job[] { return this.jobs.map(j => ({ ...j, steps: [...j.steps] })) }
  saveAll(jobs: Job[]): void { this.jobs = jobs.map(j => ({ ...j, steps: [...j.steps] })) }
  log(line: string): void { this.lines.push(line) }
}

/**
 * A job that was running when the app closed is not failed and is not done. Mark it
 * interrupted, so the board tells the truth and it can be resumed on purpose.
 */
export function reconcileOnStartup(jobs: Job[], now: number): Job[] {
  return jobs.map(job => {
    if (job.state !== 'running' && job.state !== 'waiting') return job
    return {
      ...job,
      state: 'interrupted' as const,
      interruptedAt: job.interruptedAt ?? now,
      progress: job.state === 'waiting'
        ? `interrupted while it was asking you: ${job.question?.text?.slice(0, 100) ?? 'a question'}`
        : 'interrupted — Goga closed while this was running',
    }
  })
}

/** One line per state change, for the journal. */
export function journalLine(job: Job, note?: string): string {
  const where = job.question && job.state === 'waiting' ? ` (waiting: ${job.question.text.slice(0, 80)})` : ''
  return `[${job.id}] ${job.state}${where} — ${job.title.slice(0, 60)}${note ? ` — ${note}` : ''}`
}
