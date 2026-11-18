/**
 * Jobs: the orchestration layer.
 *
 * A job is one large request handed to its own worker, with its own goal, its own step
 * record and its own report. It is not a chat turn: it survives the window closing, it can
 * wait for the user, and it ends with a report that separates what the user gets from what
 * happened operationally.
 */

export type JobState =
  | 'queued'      // waiting for a free slot
  | 'running'     // a worker is on it
  | 'waiting'     // stopped, asking the user something
  | 'done'        // finished, report written
  | 'failed'      // stopped on an error, report written
  | 'canceled'    // the user stopped it
  | 'interrupted' // the app closed mid-run; it can be resumed

export type JobQuestionKind =
  | 'decision'   // the worker needs a choice only the user can make
  | 'credential' // the worker needs a key or a sign-in
  | 'choice'     // pick one of a list
  | 'approval'   // a guarded tool is about to run and needs the user's word

export interface JobQuestion {
  id: string
  kind: JobQuestionKind
  /** The question, in the worker's own words. */
  text: string
  /** The exact thing being asked about — a tool call, a path, a value. */
  detail?: string
  options?: string[]
  askedAt: number
  answeredAt?: number
  /** The user's answer, verbatim. Never filled in by Goga. */
  answer?: string
}

export interface JobStep {
  index: number
  thought: string
  tool: string
  /** Redacted before it is stored: no tokens, keys or passwords. */
  params: Record<string, unknown>
  ok: boolean
  detail: string
  at: number
}

/** The two halves of an honest report, plus what was left undone. */
export interface JobReport {
  /** What the user should get: findings, results, files. */
  result: string[]
  /** What happened operationally, one line per step. */
  operations: string[]
  /** What the job did not do, said plainly. Empty only when everything worked. */
  notDone: string[]
  /** Files the job produced, as absolute paths. */
  files: string[]
}

export interface JobBounds {
  maxSteps: number
  maxMinutes: number
}

export interface Job {
  id: string
  title: string
  goal: string
  state: JobState
  createdAt: number
  startedAt?: number
  finishedAt?: number
  /** One line the board shows under the title. */
  progress: string
  steps: JobStep[]
  question?: JobQuestion
  report?: JobReport
  error?: string
  bounds: JobBounds
  /**
   * How this job's tool calls are gated. 'bounty' is a watched, hands-off bug-bounty run:
   * the scope-checked security tools run without a per-step approval (see AuthContext). Any
   * other job is 'normal' and nothing is loosened. Absent on old saved jobs, read as 'normal'.
   */
  mode?: 'normal' | 'bounty'
  /** When the app closed on this job, so the board can say so. */
  interruptedAt?: number
  /** How many times it has been picked up again after an interruption. */
  resumedCount: number
}

export interface JobsView {
  jobs: Job[]
  cap: number
  running: number
  queued: number
  waiting: number
}

export const DEFAULT_JOB_BOUNDS: JobBounds = { maxSteps: 12, maxMinutes: 30 }
export const DEFAULT_JOB_CONCURRENCY = 2
export const MAX_JOB_CONCURRENCY = 6
