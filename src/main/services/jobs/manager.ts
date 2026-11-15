import type { Job, JobBounds, JobQuestionKind, JobsView } from '../../../shared/jobs'
import { DEFAULT_JOB_BOUNDS } from '../../../shared/jobs'
import { addStep, applyEvent, buildReport, clampCap, newJob, pickStartable, queueNote, summarise } from './state'
import { journalLine, type FileStore } from './store'
import { runJob, type WorkerStepResult } from './worker'

/**
 * The job manager: the queue, the cap, and the wiring to the real tools.
 *
 * It owns at most `cap` workers at once. A job that stops to ask a question holds no slot —
 * it is not working — so the queue keeps moving while the user thinks. Everything a worker
 * can do goes through `execute`, and `execute` is where the existing authorization service
 * decides: blocked tools are refused, and a guarded tool becomes a question that must be
 * answered for that exact call before the registry is allowed to run it.
 *
 * Division of ownership, so one side never clobbers the other: the manager owns a job's
 * state and its question (it is the only thing the user talks to); the worker owns the steps,
 * the progress line and the report.
 */

export interface ToolGate {
  /** Null when the tool is not registered. */
  definition: (name: string) => { name: string; riskLevel: string } | null
  /** The existing authorization decision for this exact call. */
  decide: (name: string, params: Record<string, unknown>) => { allowed: boolean; requiresApproval: boolean; reason: string }
  run: (name: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<{ success: boolean; data?: unknown; error?: string }>
}

export interface ManagerDeps {
  store: FileStore
  tools: ToolGate
  /** The planner: raw JSON for one step. */
  plan: (messages: { role: 'system' | 'user' | 'assistant'; content: string }[], signal: AbortSignal) => Promise<string>
  /** The prompt block of tools for a goal. */
  toolBlock: (goal: string) => string
  /** Tell the user something happened, in chat and on their phone if they want it. */
  notify: (text: string, opts?: { alert?: boolean }) => void
  now?: () => number
  /** Where the board's changes are published to the window. */
  publish?: (view: JobsView) => void
}

const TRUTHY = /^(y|yes|yeah|yep|sure|ok|okay|approve|approved|allow|allowed|go ahead|do it|confirm|confirmed|proceed|correct|right)\b/i
const FALSY = /^(n|no|nope|deny|denied|reject|rejected|cancel|stop|don'?t|never)\b/i

/** Whether an answer to an approval question is a yes. Anything unclear counts as no. */
export function answerIsYes(answer: string): boolean {
  const a = String(answer ?? '').trim()
  if (!a) return false
  if (FALSY.test(a)) return false
  return TRUTHY.test(a)
}

/** One readable line from a tool's result, for the step record and the report. */
export function shortText(value: unknown, max = 400): string {
  if (value === null || value === undefined) return 'done'
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, max) || 'done'
  if (typeof value === 'object' && 'readable' in (value as Record<string, unknown>)) {
    return String((value as { readable: unknown }).readable).replace(/\s+/g, ' ').trim().slice(0, max)
  }
  try { return JSON.stringify(value).slice(0, max) } catch { return 'done' }
}

export class JobsManager {
  private jobs: Job[] = []
  private cap: number
  private active = new Map<string, { controller: AbortController; canceled: boolean }>()
  private pendingAsks = new Map<string, (answer: string | null) => void>()
  private started = false

  constructor(private deps: ManagerDeps, cap: number) {
    this.cap = clampCap(cap)
  }

  /** Load the board, and mark anything that was mid-run when the app closed. */
  start(): void {
    if (this.started) return
    this.started = true
    this.jobs = this.reconcile(this.deps.store.load(), this.now())
    this.save()
    this.pump()
  }

  private reconcile(jobs: Job[], now: number): Job[] {
    return jobs.map(job => {
      if (job.state !== 'running' && job.state !== 'waiting') return job
      this.deps.store.log(journalLine(job, 'interrupted on startup'))
      const note = job.state === 'waiting'
        ? 'interrupted while it was waiting on you — it will ask again if you resume it'
        : 'interrupted — Goga closed while this was running'
      return {
        ...job,
        state: 'interrupted' as const,
        interruptedAt: job.interruptedAt ?? now,
        // The question was never answered, so it is not carried forward as if it had been.
        question: job.question && !job.question.answeredAt ? undefined : job.question,
        progress: note,
      }
    })
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now() }

  view(): JobsView { return summarise(this.jobs, this.cap) }

  list(): Job[] { return this.view().jobs }

  get(id: string): Job | null { return this.jobs.find(j => j.id === id) ?? null }

  private save(): void {
    try { this.deps.store.saveAll(this.jobs) } catch { /* the board in memory is still right */ }
    try { this.deps.publish?.(this.view()) } catch { /* nothing listening yet */ }
  }

  private replace(job: Job): void {
    const i = this.jobs.findIndex(j => j.id === job.id)
    if (i >= 0) this.jobs[i] = job
    else this.jobs.push(job)
  }

  private commit(job: Job, note?: string): void {
    this.replace(job)
    this.deps.store.log(journalLine(job, note))
    this.save()
  }

  setCap(cap: number): JobsView {
    this.cap = clampCap(cap)
    this.save()
    this.pump()
    return this.view()
  }

  /** Create a job. It starts as soon as a slot is free. */
  create(input: { goal: string; title?: string; bounds?: Partial<JobBounds> }): Job {
    const now = this.now()
    const goal = String(input.goal ?? '').trim()
    if (goal.length < 4) throw new Error('a job needs a goal — say what it should achieve')
    const job = newJob({
      id: `job-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title: input.title ?? goal,
      goal,
      now,
      bounds: { ...DEFAULT_JOB_BOUNDS, ...(input.bounds ?? {}) },
    })
    this.commit(job, 'created')
    this.pump()
    const live = this.get(job.id) ?? job
    if (live.state === 'queued') {
      const note = queueNote(this.view())
      if (note) this.deps.notify(`• ${note}`)
    }
    return live
  }

  /** Start as many queued jobs as the cap allows, oldest first. */
  pump(): void {
    const startable = pickStartable(this.jobs, this.cap)
    for (const job of startable) void this.begin(job)
    if (startable.length === 0) this.save()
  }

  /**
   * Put a worker on a job. `mode` is the event that moves it to running: 'start' for a queued
   * job, 'resume' for an interrupted one, and null when the caller has already moved it (an
   * answered question, which the answer event itself puts back into running).
   */
  private async begin(job: Job, mode: 'start' | 'resume' | null = 'start'): Promise<void> {
    if (this.active.has(job.id)) return
    const controller = new AbortController()
    const entry = { controller, canceled: false }
    this.active.set(job.id, entry)
    let started: Job = job
    if (mode) {
      try {
        started = applyEvent(job, { type: mode }, this.now())
      } catch {
        this.active.delete(job.id)
        return
      }
      this.commit(started, mode)
    }
    this.pump()

    try {
      const finished = await this.runWorker(started, entry)
      const live = this.get(job.id) ?? finished
      if (live.state === 'done') {
        this.deps.notify(`✅ Job done: ${live.title}\n\n${(live.report?.result ?? []).join('\n').slice(0, 1200)}`)
      } else if (live.state === 'failed') {
        this.deps.notify(`❌ Job failed: ${live.title} — ${live.error ?? 'no reason recorded'}`)
      } else if (live.state === 'canceled') {
        this.deps.notify(`Job canceled: ${live.title}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.failRunning(job.id, msg)
      this.deps.notify(`❌ Job failed: ${job.title} — ${msg}`)
    } finally {
      this.active.delete(job.id)
      this.pump()
    }
  }

  private failRunning(id: string, error: string): void {
    const live = this.get(id)
    if (!live || live.state === 'done' || live.state === 'failed' || live.state === 'canceled') return
    // An interrupted job is not a failed one: it stopped because Goga closed, and it can be
    // picked up again. Turning it into a failure here would erase that.
    if (live.state === 'interrupted') return
    try {
      const failed = applyEvent(live, { type: 'finish', ok: false, error }, this.now())
      const report = live.report ?? buildReport({ finalReply: '', steps: failed.steps, files: [], declaredGaps: [error] })
      this.commit({ ...failed, report }, 'failed')
    } catch { /* already terminal */ }
  }

  private async runWorker(job: Job, entry: { controller: AbortController; canceled: boolean }): Promise<Job> {
    const result = await runJob(job, {
      plan: this.deps.plan,
      toolBlock: () => this.deps.toolBlock(job.goal),
      save: updated => this.absorbSteps(updated),
      signal: entry.controller.signal,
      canceled: () => entry.canceled,
      now: () => this.now(),
      progress: line => {
        const live = this.get(job.id)
        if (!live || live.state !== 'running') return
        this.replace({ ...live, progress: line })
        try { this.deps.publish?.(this.view()) } catch { /* ignore */ }
      },
      ask: (question, signal) => this.askUser(job.id, question, signal),
      execute: (tool, params, signal) => this.executeTool(tool, params, signal, job.id),
    })

    // The worker has ended. Its steps and report are the truth; the state is decided here,
    // against the live job, so a canceled or answered job keeps what actually happened.
    const live = this.get(job.id) ?? job
    this.replace({ ...live, steps: result.steps, report: result.report ?? live.report, error: result.error ?? live.error })
    const merged = this.get(job.id)!
    if (merged.state === 'interrupted') {
      // The app closed on this job. The worker's abort is only how it learned to stop; the
      // job stays interrupted so the board tells the truth and it can be resumed on purpose.
    } else if (result.state === 'canceled') {
      if (merged.state !== 'canceled') this.finishAs(merged, 'cancel')
    } else if (merged.state === 'waiting') {
      // It stopped on an approval question and never got an answer; that is a real end.
      this.finishAs(merged, 'fail', 'it stopped to ask a question that was never answered')
    } else if (result.state === 'done') {
      if (merged.state !== 'done') this.finishAs(merged, 'ok')
    } else if (result.state === 'failed') {
      if (merged.state !== 'failed') this.finishAs(merged, 'fail', result.error)
    }
    return this.get(job.id) ?? merged
  }

  private finishAs(job: Job, kind: 'ok' | 'fail' | 'cancel', error?: string): void {
    try {
      const next = kind === 'cancel'
        ? applyEvent(job, { type: 'cancel' }, this.now())
        : applyEvent(job, { type: 'finish', ok: kind === 'ok', error }, this.now())
      this.commit({ ...next, report: job.report ?? next.report }, kind)
    } catch { /* already terminal */ }
  }

  /** Take the worker's steps, progress and report; leave the state and the question alone. */
  private absorbSteps(updated: Job): void {
    const live = this.get(updated.id)
    if (!live) return
    this.commit({
      ...live,
      steps: updated.steps,
      progress: updated.state === 'running' ? (updated.progress || live.progress) : live.progress,
      report: updated.report ?? live.report,
      error: updated.error ?? live.error,
    })
  }

  // ── Questions ───────────────────────────────────────────────────────────────

  private askUser(
    jobId: string,
    question: { kind: JobQuestionKind; text: string; detail?: string; options?: string[] },
    signal: AbortSignal,
  ): Promise<string | null> {
    const live = this.get(jobId)
    if (live) {
      try {
        const asked = applyEvent(live, { type: 'ask', question }, this.now())
        this.commit(asked, 'asked the user')
      } catch { /* the job moved on while the question was being formed */ }
    }

    return new Promise<string | null>(resolve => {
      const settle = (value: string | null) => {
        if (!this.pendingAsks.has(jobId)) return
        this.pendingAsks.delete(jobId)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = () => settle(null)
      this.pendingAsks.set(jobId, settle)
      signal.addEventListener('abort', onAbort, { once: true })
      const job = this.get(jobId)
      const kind = question.kind === 'credential' ? 'needs something only you can supply' : 'needs a decision from you'
      const text = `❓ Job "${job?.title ?? jobId}" ${kind}:\n\n${question.text}${question.detail ? `\n\n${question.detail}` : ''}`
      this.deps.notify(text, { alert: true })
    })
  }

  /** The user's answer, routed back to the job that asked. Never called on their behalf. */
  answer(jobId: string, answer: string): Job {
    const job = this.get(jobId)
    if (!job) throw new Error('no such job')
    if (job.state !== 'waiting' || !job.question) throw new Error('that job is not waiting on an answer')
    const text = String(answer ?? '').trim()
    if (!text) throw new Error('an empty answer is not an answer')

    const settle = this.pendingAsks.get(jobId)
    if (settle) {
      // A live worker is waiting: record the answer, then hand it over.
      try {
        this.commit(applyEvent(job, { type: 'answer', answer: text }, this.now()), 'answered')
      } catch { /* if the state moved, the worker still gets the answer */ }
      settle(text)
      return this.get(jobId) ?? job
    }

    // No live worker (the app was restarted mid-question): record it, then resume.
    const answered = applyEvent(job, { type: 'answer', answer: text }, this.now())
    this.commit(answered, 'answered')
    if (answered.state === 'running') void this.begin(answered, null)
    return this.get(jobId) ?? answered
  }

  // ── Tools ───────────────────────────────────────────────────────────────────

  private async executeTool(tool: string, params: Record<string, unknown>, signal: AbortSignal, jobId: string): Promise<WorkerStepResult> {
    const def = this.deps.tools.definition(tool)
    if (!def) return { ok: false, detail: `there is no tool called "${tool}"` }

    const decision = this.deps.tools.decide(tool, params)
    if (!decision.allowed) return { ok: false, detail: `refused: ${decision.reason}` }

    if (decision.requiresApproval) {
      const live = this.get(jobId)
      if (!live) return { ok: false, detail: 'the job is no longer there' }
      const ask = {
        kind: 'approval' as JobQuestionKind,
        text: `Run ${tool}?`,
        detail: `${decision.reason}\n\n${tool} ${JSON.stringify(params).slice(0, 600)}`,
      }
      const answer = await this.askUser(jobId, ask, signal)
      if (answer === null) return { ok: false, detail: 'canceled while waiting for approval' }
      if (!answerIsYes(answer)) {
        return { ok: false, detail: `you did not approve ${tool} ("${answer.slice(0, 80)}"), so it was not run` }
      }
      this.deps.store.log(`[${jobId}] approved one run of ${tool}`)
    }

    if (signal.aborted) return { ok: false, detail: 'canceled before the tool ran' }
    const result = await this.deps.tools.run(tool, params, signal)
    const data = result.data as { filePath?: string; path?: string; bytes?: number; readable?: unknown } | undefined
    const files = [data?.filePath, data?.path].filter((p): p is string => typeof p === 'string')
    const wrote = files.length > 0 && typeof data?.bytes === 'number'
    const detail = result.success
      ? wrote
        ? `wrote ${data!.bytes} bytes to ${files[0]}`
        : shortText(data && 'readable' in (data as object) ? (data as { readable: unknown }).readable : (data ?? 'done'))
      : (result.error ?? 'no reason given')
    return { ok: result.success, detail, files }
  }

  // ── Control ─────────────────────────────────────────────────────────────────

  cancel(jobId: string, reason = 'canceled by you'): Job {
    const job = this.get(jobId)
    if (!job) throw new Error('no such job')
    if (job.state === 'done' || job.state === 'failed' || job.state === 'canceled') return job
    const entry = this.active.get(jobId)
    if (entry) {
      entry.canceled = true
      try { entry.controller.abort() } catch { /* already gone */ }
    }
    const settle = this.pendingAsks.get(jobId)
    if (settle) settle(null)
    const canceled = applyEvent(job, { type: 'cancel' }, this.now())
    const withReport: Job = {
      ...canceled,
      report: canceled.report ?? buildReport({
        finalReply: `You stopped this job (${reason}). Nothing further was done.`,
        steps: canceled.steps, files: [], declaredGaps: [],
      }),
    }
    this.commit(withReport, reason)
    this.pump()
    return withReport
  }

  /** Pick an interrupted job up again, keeping the steps it already recorded. */
  resume(jobId: string): Job {
    const job = this.get(jobId)
    if (!job) throw new Error('no such job')
    if (job.state !== 'interrupted') throw new Error('only an interrupted job can be resumed')
    const resumed = applyEvent({ ...job, question: undefined }, { type: 'resume' }, this.now())
    this.commit(resumed, 'resumed')
    void this.begin(resumed, null)
    return this.get(jobId) ?? resumed
  }

  /** Stop every running job, for shutdown. Jobs are left interrupted, not failed. */
  shutdown(reason = 'Goga is closing'): void {
    for (const [id, entry] of this.active) {
      entry.canceled = true
      try { entry.controller.abort() } catch { /* ignore */ }
      const job = this.get(id)
      if (job && job.state === 'running') {
        try { this.commit(applyEvent(job, { type: 'interrupt' }, this.now()), reason) } catch { /* ignore */ }
      }
    }
    for (const settle of this.pendingAsks.values()) settle(null)
    this.pendingAsks.clear()
    this.active.clear()
    this.save()
  }
}
