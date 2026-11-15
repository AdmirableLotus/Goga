import type { Job, JobBounds, JobQuestion, JobQuestionKind, JobReport, JobState, JobStep, JobsView } from '../../../shared/jobs'
import { DEFAULT_JOB_BOUNDS, DEFAULT_JOB_CONCURRENCY, MAX_JOB_CONCURRENCY } from '../../../shared/jobs'

/**
 * The job state machine and the pure parts of the orchestration layer.
 *
 * Nothing here touches Electron, the filesystem or the model, so the rules a job lives by —
 * which transitions exist, when a job may be started, how a report is shaped — are all
 * testable on their own. The worker (worker.ts) and the manager (manager.ts) only move a job
 * from one of these states to another; they cannot invent a transition.
 */

export const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(['done', 'failed', 'canceled'])

export type JobEvent =
  | { type: 'start' }
  | { type: 'ask'; question: { kind: JobQuestionKind; text: string; detail?: string; options?: string[] } }
  | { type: 'answer'; answer: string }
  | { type: 'finish'; ok: boolean; error?: string }
  | { type: 'cancel' }
  | { type: 'interrupt' }
  | { type: 'resume' }

/** States each state may move to. A transition absent from this table is refused. */
const TRANSITIONS: Record<JobState, JobState[]> = {
  queued:      ['running', 'canceled'],
  running:     ['waiting', 'done', 'failed', 'canceled', 'interrupted'],
  // A waiting job leaves only through an answer (which the answer event handles) or a cancel.
  // It cannot be "started" again, so nothing can quietly skip the question.
  waiting:     ['canceled'],
  interrupted: ['running', 'canceled', 'failed'],
  done:        [],
  failed:      [],
  canceled:    [],
}

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to)
}

/** Kept only so an unknown state from an old file is reported rather than trusted. */
export function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TRANSITIONS, value)
}

export class JobTransitionError extends Error {
  constructor(from: JobState, event: JobEvent['type']) {
    super(`a job in state "${from}" cannot handle "${event}"`)
    this.name = 'JobTransitionError'
  }
}

export function newJob(input: { title: string; goal: string; id: string; now: number; bounds?: Partial<JobBounds> }): Job {
  const title = String(input.title ?? '').trim() || firstLine(input.goal)
  return {
    id: input.id,
    title: title.slice(0, 90),
    goal: String(input.goal ?? '').trim(),
    state: 'queued',
    createdAt: input.now,
    progress: 'waiting for a free slot',
    steps: [],
    bounds: { ...DEFAULT_JOB_BOUNDS, ...(input.bounds ?? {}) },
    resumedCount: 0,
  }
}

function firstLine(text: string): string {
  return String(text ?? '').split(/\n/)[0].trim().slice(0, 90) || 'untitled job'
}

/**
 * Apply one event. Returns a NEW job object; the argument is never mutated, so a caller that
 * fails to save cannot leave a half-changed job in memory.
 *
 * `answer` is the only event that resolves a question, and it requires a question to be open:
 * an answer with nothing asked is refused rather than stored, so nothing can be answered on
 * the user's behalf.
 */
export function applyEvent(job: Job, event: JobEvent, now: number): Job {
  const next: Job = { ...job, steps: [...job.steps] }
  switch (event.type) {
    case 'start': {
      if (!canTransition(job.state, 'running')) throw new JobTransitionError(job.state, 'start')
      next.state = 'running'
      next.startedAt = job.startedAt ?? now
      next.progress = 'starting'
      next.error = undefined
      return next
    }
    case 'resume': {
      if (!canTransition(job.state, 'running')) throw new JobTransitionError(job.state, 'resume')
      next.state = 'running'
      next.resumedCount = job.resumedCount + 1
      next.startedAt = job.startedAt ?? now
      next.interruptedAt = undefined
      next.progress = `picking up where it stopped (resume ${next.resumedCount})`
      return next
    }
    case 'ask': {
      if (job.question && !job.question.answeredAt) throw new Error('a job cannot ask a second question while one is unanswered')
      if (!canTransition(job.state, 'waiting')) throw new JobTransitionError(job.state, 'ask')
      const question: JobQuestion = {
        id: `${job.id}-q${job.steps.length + 1}`,
        kind: event.question.kind,
        text: String(event.question.text ?? '').trim().slice(0, 1200),
        detail: event.question.detail ? String(event.question.detail).slice(0, 1200) : undefined,
        options: event.question.options?.length ? event.question.options.slice(0, 8) : undefined,
        askedAt: now,
      }
      if (!question.text) throw new Error('a question needs text')
      next.state = 'waiting'
      next.question = question
      next.progress = `waiting on you: ${question.text.slice(0, 120)}`
      return next
    }
    case 'answer': {
      if (job.state !== 'waiting' || !job.question) throw new JobTransitionError(job.state, 'answer')
      const answer = String(event.answer ?? '').trim()
      if (!answer) throw new Error('an empty answer is not an answer')
      next.state = 'running'
      next.question = { ...job.question, answer: answer.slice(0, 4000), answeredAt: now }
      next.progress = 'you answered — carrying on'
      return next
    }
    case 'finish': {
      if (!canTransition(job.state, event.ok ? 'done' : 'failed')) throw new JobTransitionError(job.state, 'finish')
      next.state = event.ok ? 'done' : 'failed'
      next.finishedAt = now
      if (!event.ok) next.error = event.error?.slice(0, 2000) || 'the job did not finish'
      next.progress = event.ok ? 'finished' : 'failed'
      return next
    }
    case 'cancel': {
      if (TERMINAL.has(job.state)) throw new JobTransitionError(job.state, 'cancel')
      next.state = 'canceled'
      next.finishedAt = now
      next.progress = 'canceled by you'
      return next
    }
    case 'interrupt': {
      if (!canTransition(job.state, 'interrupted')) throw new JobTransitionError(job.state, 'interrupt')
      next.state = 'interrupted'
      next.interruptedAt = now
      next.progress = 'interrupted — Goga closed while this was running'
      return next
    }
  }
}

/** A step appended to a job's record. Params are redacted by the caller before they arrive. */
export function addStep(job: Job, step: Omit<JobStep, 'index'>): Job {
  return {
    ...job,
    steps: [...job.steps, { ...step, index: job.steps.length }],
    progress: step.ok ? `${step.tool}: ok` : `${step.tool}: ${step.detail.slice(0, 110)}`,
  }
}

/**
 * Fold a worker's copy of a job back into the live one.
 *
 * The manager owns the state and the question (it is the only thing the user talks to); the
 * worker owns the steps, the progress line and the report. The state is taken from the worker
 * only when it moves forward — a worker never drags a job back out of "waiting", and never
 * revives one the user canceled.
 */
export function mergeWorkerUpdate(live: Job, updated: Job): Job {
  // The worker may only move a job forward along a legal edge. It cannot pull a job back out
  // of "waiting" (only the user's answer does that), and cannot revive a canceled one.
  const state: JobState = updated.state !== live.state && canTransition(live.state, updated.state)
    ? updated.state
    : live.state

  // Keep the question that was actually asked, and the answer once it exists.
  const question = updated.question ?? live.question

  return {
    ...live,
    state,
    steps: updated.steps,
    progress: updated.progress || live.progress,
    question,
    report: updated.report ?? live.report,
    error: updated.error ?? live.error,
    finishedAt: updated.finishedAt ?? live.finishedAt,
    resumedCount: Math.max(live.resumedCount, updated.resumedCount),
  }
}

// ── Queue ─────────────────────────────────────────────────────────────────────

export function clampCap(cap: number | undefined): number {
  const n = Math.floor(Number(cap))
  if (!Number.isFinite(n) || n < 1) return DEFAULT_JOB_CONCURRENCY
  return Math.min(n, MAX_JOB_CONCURRENCY)
}

/**
 * Which queued jobs may start now. Oldest first, and only up to the free slots.
 * A job that is waiting on the user holds no slot: it is not consuming a worker.
 */
export function pickStartable(jobs: Job[], cap: number): Job[] {
  const running = jobs.filter(j => j.state === 'running').length
  const free = clampCap(cap) - running
  if (free <= 0) return []
  return jobs
    .filter(j => j.state === 'queued')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, free)
}

/** The board's header numbers. */
export function summarise(jobs: Job[], cap: number): JobsView {
  const count = (s: JobState) => jobs.filter(j => j.state === s).length
  return {
    jobs: [...jobs].sort((a, b) => b.createdAt - a.createdAt),
    cap: clampCap(cap),
    running: count('running'),
    queued: count('queued'),
    waiting: count('waiting'),
  }
}

/** Why a new job cannot start right now, in the words the board shows. Empty when it can. */
export function queueNote(view: JobsView): string {
  if (view.queued === 0) return ''
  const free = view.cap - view.running
  if (free > 0) return `${view.queued} queued — ${free} slot${free === 1 ? '' : 's'} free`
  return `${view.queued} queued — the ${view.cap}-job limit is full, so ${view.queued === 1 ? 'it starts' : 'they start'} when a running job finishes`
}

// ── Report ────────────────────────────────────────────────────────────────────

export interface ReportInput {
  /** What the worker said at the end, in its own words. */
  finalReply: string
  steps: JobStep[]
  /** Absolute paths the job wrote. */
  files: string[]
  /** Anything the worker itself flagged as not done. */
  declaredGaps?: string[]
}

/**
 * Split an ending into the two halves a report needs, and say plainly what did not happen.
 *
 * The rules that matter:
 *  - a failed step is never counted as a result, and it appears in `notDone` with its error;
 *  - a job whose every step failed cannot claim a result from the model's prose;
 *  - an empty `notDone` means every step it attempted succeeded — not that nothing was skipped.
 */
export function buildReport(input: ReportInput): JobReport {
  const steps = input.steps
  const okSteps = steps.filter(s => s.ok)
  const failedSteps = steps.filter(s => !s.ok)
  const reply = String(input.finalReply ?? '').trim()
  const files = [...new Set(input.files.map(f => String(f)).filter(Boolean))]

  const result: string[] = []
  if (reply) result.push(...reply.split(/\n{2,}/).map(p => p.trim()).filter(Boolean))
  for (const f of files) result.push(`File: ${f}`)
  if (result.length === 0 && okSteps.length === 0) {
    result.push('Nothing was produced. This job ended without a result.')
  }

  const operations = steps.map(s => `${s.ok ? 'ok' : 'failed'} — ${s.tool}: ${s.detail || s.thought}`.slice(0, 400))

  const notDone: string[] = []
  for (const s of failedSteps) {
    notDone.push(`${s.tool} did not work: ${s.detail || 'no detail was recorded'}`)
  }
  for (const gap of input.declaredGaps ?? []) {
    const text = String(gap ?? '').trim()
    if (text) notDone.push(text)
  }
  if (steps.length === 0) notDone.push('Nothing was attempted — no step ran.')

  return { result, operations, notDone, files }
}
