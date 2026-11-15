import type { Job, JobQuestionKind, JobStep } from '../../../shared/jobs'
import { addStep, applyEvent, buildReport } from './state'
import { SIDE_EFFECTING_TOOLS } from '../agentResilience'

/**
 * One worker, one job.
 *
 * The worker plans a single step at a time, hands it to `execute`, and records it. It can stop
 * to ask the user something, and it ends by writing a report. It has no other power: every
 * tool call goes through the same registry and authorization service the chat path uses, and
 * a guarded tool that needs approval becomes a question rather than an action.
 *
 * Everything it depends on is injected, so the loop itself can be tested without a model.
 */

export interface WorkerDeps {
  /** Ask the model for the next step. Returns the planner's raw JSON text. */
  plan: (messages: { role: 'system' | 'user' | 'assistant'; content: string }[], signal: AbortSignal) => Promise<string>
  /** Run one tool through the real registry, authorization and approval gate. */
  execute: (tool: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<WorkerStepResult>
  /** The tools this job's planner may use, as the prompt block it reads. */
  toolBlock: () => string
  /** Put a question in front of the user and wait. Resolves null when the job was canceled. */
  ask: (question: { kind: JobQuestionKind; text: string; detail?: string; options?: string[] }, signal: AbortSignal) => Promise<string | null>
  /** Persist the job after every change. */
  save: (job: Job) => void
  /** Aborts when the job is canceled, stopped, or the app is closing. */
  signal: AbortSignal
  /** True once the user canceled this job while it was running. */
  canceled: () => boolean
  now?: () => number
  /** Called for each line worth showing live on the board. */
  progress?: (line: string) => void
}

export interface WorkerStepResult {
  ok: boolean
  detail: string
  files?: string[]
}

export interface PlannerStep {
  thought: string
  tool?: string
  params?: Record<string, unknown>
  done?: boolean
  reply?: string
  ask?: { kind?: JobQuestionKind; text: string; detail?: string; options?: string[] }
}

const REDACT_KEYS = /token|secret|password|passwd|apikey|api_key|authorization|credential|cookie/i

/** A tool's arguments with anything that looks like a secret taken out, before it is stored. */
export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params ?? {})) {
    if (REDACT_KEYS.test(k)) out[k] = '[redacted]'
    else if (typeof v === 'string' && v.length > 400) out[k] = `${v.slice(0, 400)}… (${v.length} chars)`
    else out[k] = v
  }
  return out
}

/** Read the planner's JSON, tolerating a fenced block and trailing prose. */
export function parseStep(text: string): PlannerStep | null {
  const raw = String(text ?? '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  const ask = o.ask as Record<string, unknown> | undefined
  if (ask && typeof ask === 'object' && typeof ask.text === 'string' && ask.text.trim()) {
    const kind = String(ask.kind ?? 'decision')
    return {
      thought: typeof o.thought === 'string' ? o.thought : 'asking the user',
      ask: {
        kind: (['decision', 'credential', 'choice', 'approval'].includes(kind) ? kind : 'decision') as JobQuestionKind,
        text: ask.text.trim(),
        detail: typeof ask.detail === 'string' ? ask.detail : undefined,
        options: Array.isArray(ask.options) ? ask.options.map(String).slice(0, 8) : undefined,
      },
    }
  }
  if (o.done === true) {
    return { thought: typeof o.thought === 'string' ? o.thought : '', done: true, reply: typeof o.reply === 'string' ? o.reply : '' }
  }
  if (typeof o.tool !== 'string' || !o.tool.trim()) return null
  return {
    thought: typeof o.thought === 'string' ? o.thought : '',
    tool: o.tool.trim(),
    params: o.params && typeof o.params === 'object' && !Array.isArray(o.params) ? o.params as Record<string, unknown> : {},
  }
}

export const WORKER_SYSTEM = (goal: string, toolBlock: string) =>
  `You are one worker carrying out ONE job for the user, step by step. You are not in a chat: the job keeps running after the window closes.

THE JOB: ${goal}

TOOLS YOU MAY USE:
${toolBlock}

Reply with ONLY a JSON object, one step at a time. Exactly one of these shapes:

To do something:   {"thought":"why","tool":"tool.name","params":{...}}
When it is done:   {"thought":"why","done":true,"reply":"what you actually did and found, in plain words"}
To ask the user:   {"thought":"why","ask":{"kind":"decision|credential|choice|approval","text":"the question, one sentence","detail":"exactly what and why","options":["…"]}}

Rules:
- One step per reply. Never describe several actions in one object.
- Ask the user instead of guessing when you need a decision, a credential, a file or a choice only they can make. Never invent an answer, a password or an API key.
- A tool that is blocked or that fails is a fact: record it and try something else, or finish and say plainly it did not work.
- Only claim in "reply" what the step results actually show. If part of the job did not work, say which part.
- Never repeat a step that already succeeded. When the last thing the job needed has worked, finish.
- If nothing you can do advances the job, finish with done:true and an honest reply saying what you could not do and why.`

/** How many times one side effect may hit the same target before the job stops it. */
export const SAME_TARGET_LIMIT = 2

/**
 * What a side effect is aimed at, ignoring the content it carries: the file it writes, the
 * page it opens, the command it runs. Null for a tool with no real-world effect, which may
 * legitimately be called as often as the job likes.
 */
export function sideEffectKey(tool: string, params: Record<string, unknown>): string | null {
  if (!SIDE_EFFECTING_TOOLS.has(tool)) return null
  const target = params.path ?? params.url ?? params.command ?? params.executable ?? params.text ?? ''
  return `${tool}|${String(target).slice(0, 300)}`
}

/** Steps so far, newest last, and short enough for a small model's context. */
export function stepHistory(steps: JobStep[], keep = 10): string {
  if (steps.length === 0) return '(nothing yet)'
  return steps.slice(-keep).map(s =>
    `${s.index + 1}. ${s.tool}(${JSON.stringify(s.params).slice(0, 180)}) → ${s.ok ? 'ok' : 'FAILED'}: ${s.detail.slice(0, 260)}`
  ).join('\n')
}

/**
 * Run a job to its end. Cancellation is cooperative: the signal aborts, and the job is left
 * in `canceled` with whatever was recorded, never silently dropped.
 */
export async function runJob(job: Job, deps: WorkerDeps): Promise<Job> {
  const now = deps.now ?? (() => Date.now())
  let current = job
  const files: string[] = []
  const gaps: string[] = []
  const startedAt = job.startedAt ?? now()

  const save = (j: Job) => { current = j; deps.save(j) }

  for (let i = 0; i < current.bounds.maxSteps; i++) {
    if (deps.canceled() || deps.signal.aborted) return cancelJob(current, save, now())
    if (now() - startedAt > current.bounds.maxMinutes * 60_000) {
      gaps.push(`It ran past the ${current.bounds.maxMinutes}-minute limit for one job and was stopped.`)
      const finished = applyEvent(current, { type: 'finish', ok: false, error: `time limit (${current.bounds.maxMinutes} minutes)` }, now())
      return withReport(finished, undefined, files, gaps, save)
    }

    const messages = [
      { role: 'system' as const, content: WORKER_SYSTEM(current.goal, deps.toolBlock()) },
      {
        role: 'user' as const,
        content: [
          `STEP ${i + 1} of at most ${current.bounds.maxSteps}.`,
          `STEPS SO FAR:\n${stepHistory(current.steps)}`,
          current.question?.answer ? `YOU ASKED: ${current.question.text}\nTHE USER ANSWERED: ${current.question.answer}` : '',
          current.question && !current.question.answeredAt ? `A QUESTION IS STILL WAITING: ${current.question.text}` : '',
          'What is the single next step?',
        ].filter(Boolean).join('\n\n'),
      },
    ]

    deps.progress?.(`thinking about step ${i + 1}`)
    let raw = ''
    try {
      raw = await deps.plan(messages, deps.signal)
    } catch (err) {
      if (deps.canceled() || deps.signal.aborted) return cancelJob(current, save, now())
      const msg = err instanceof Error ? err.message : String(err)
      gaps.push(`The planner could not be reached for step ${i + 1}: ${msg}`)
      const finished = applyEvent(current, { type: 'finish', ok: false, error: msg }, now())
      return withReport(finished, undefined, files, gaps, save)
    }

    const step = parseStep(raw)
    if (!step) {
      save(addStep(current, {
        thought: 'the planner reply was not usable',
        tool: '(planner)', params: {}, ok: false,
        detail: `the model did not return a usable JSON step: ${raw.slice(0, 180)}`, at: now(),
      }))
      continue
    }

    if (step.ask) {
      const question = { kind: step.ask.kind ?? 'decision' as JobQuestionKind, text: step.ask.text, detail: step.ask.detail, options: step.ask.options }
      deps.progress?.(`asking you: ${question.text.slice(0, 80)}`)
      const asked = applyEvent(current, { type: 'ask', question }, now())
      save(addStep(asked, {
        thought: step.thought, tool: 'ask the user', params: { question: question.text },
        ok: true, detail: `asked: ${question.text}`, at: now(),
      }))
      const answer = await deps.ask(question, deps.signal)
      if (answer === null) return cancelJob(current, save, now())
      const answered = applyEvent(current, { type: 'answer', answer }, now())
      save(addStep(answered, {
        thought: 'recorded your answer', tool: 'user answered', params: { answer: answer.slice(0, 200) },
        ok: true, detail: `you answered: ${answer.slice(0, 300)}`, at: now(),
      }))
      continue
    }

    if (step.done) {
      const finished = applyEvent(current, { type: 'finish', ok: true }, now())
      return withReport(finished, step.reply ?? '', files, gaps, save)
    }

    if (!step.tool) continue

    // ── REPEAT GUARD ──────────────────────────────────────────────────────────
    // Small models burn a job's whole budget doing the same thing again: the same write to
    // the same file, the same page opened, over and over. Two goes at one target is allowed
    // (the first may legitimately be replaced); the third is stopped and said plainly.
    const repeatKey = sideEffectKey(step.tool, step.params ?? {})
    if (repeatKey) {
      const done = current.steps.filter(s => s.ok && sideEffectKey(s.tool, s.params) === repeatKey)
      if (done.length >= SAME_TARGET_LIMIT) {
        gaps.push(`It kept repeating ${step.tool} on the same target, so it was stopped instead of doing that a third time.`)
        const finished = applyEvent(current, { type: 'finish', ok: true }, now())
        return withReport(
          finished,
          `I had already done this ${done.length} times (${done[done.length - 1].detail}). I stopped instead of doing it again.`,
          files, gaps, save,
        )
      }
    }

    deps.progress?.(`running ${step.tool}`)
    let result: WorkerStepResult
    try {
      result = await deps.execute(step.tool, step.params ?? {}, deps.signal)
    } catch (err) {
      result = { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
    if (result.files?.length) files.push(...result.files)
    save(addStep(current, {
      thought: step.thought, tool: step.tool, params: redactParams(step.params ?? {}),
      ok: result.ok, detail: result.detail, at: now(),
    }))
  }

  gaps.push(`It used all ${current.bounds.maxSteps} steps without finishing.`)
  const finished = applyEvent(current, { type: 'finish', ok: false, error: 'step limit reached' }, now())
  return withReport(finished, '', files, gaps, save)
}

function cancelJob(job: Job, save: (j: Job) => void, now: number): Job {
  try {
    const canceled = applyEvent(job, { type: 'cancel' }, now)
    save(canceled)
    return canceled
  } catch {
    return job
  }
}

function withReport(job: Job, reply: string | undefined, files: string[], gaps: string[], save: (j: Job) => void): Job {
  const report = buildReport({ finalReply: reply ?? '', steps: job.steps, files, declaredGaps: gaps })
  const out: Job = { ...job, report }
  save(out)
  return out
}
