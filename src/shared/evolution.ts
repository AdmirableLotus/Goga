/**
 * Self-improvement types.
 *
 * "Self-improving" here means: a supervised loop that reads Goga's own source, writes a
 * change on a private copy, proves it with the typechecker and the test suite, and only
 * touches the running code when the user approves — with a snapshot kept so a break can be
 * undone. It is not unrestricted self-modification, and the guard list in
 * services/evolution/guard.ts is enforced in code, not suggested in a prompt.
 */

export type RunStage =
  | 'review'        // reading its own source read-only
  | 'propose'       // writing up weaknesses and a change
  | 'apply'         // applying to a private copy (workspace-write)
  | 'verify'        // typecheck + tests
  | 'awaiting'      // change proved, waiting for the user's approval to become the running version
  | 'install'       // applying to the real tree, rebuild, retest
  | 'done'          // installed, not reloaded
  | 'rolled-back'   // broke the build or the tests; snapshot restored
  | 'refused'       // a guardrail stopped it
  | 'failed'

export interface EvolutionEvent {
  id: number
  time: string
  stage: RunStage
  text: string
}

export interface Weakness {
  title: string
  area: string
  problem: string
  /** Files the model actually read when it noticed this. */
  files: string[]
}

export interface EvolutionRun {
  id: string
  goal: string
  startedAt: string
  finishedAt: string | null
  stage: RunStage
  /** Weaknesses written up during the read-only review. */
  weaknesses: Weakness[]
  summary: string
  files: string[]
  diff: string
  /** Ref, so the exact starting tree can be recovered. */
  snapshotRef: string | null
  /** Guards a change would have crossed (empty when it did not touch them). */
  guardHits: { path: string; why: string }[]
  buildPassed: boolean | null
  testsPassed: boolean | null
  installNote: string | null
  error: string | null
  events: EvolutionEvent[]
}

export interface LearningNote {
  id: string
  kind: 'taught' | 'worked' | 'failed' | 'code'
  text: string
  /** Where it came from: a chat message, a run id, a file. */
  source: string
  createdAt: string
  /** How many times this note has been used in a prompt. */
  used: number
}

export interface SkillRecord {
  id: string
  name: string
  whenToUse: string
  steps: string[]
  /** The run or conversation that produced it. */
  origin: string
  createdAt: string
  used: number
  /** Tools the skill is built on, so it can be checked for stale names. */
  tools: string[]
}

export interface EvolutionState {
  running: boolean
  /** True when a proved change is waiting for approval. */
  pendingApproval: boolean
  stage: RunStage
  current: EvolutionRun | null
  history: EvolutionRun[]
  learning: LearningNote[]
  skills: SkillRecord[]
  /** Tools registered at runtime by a self-improvement run. */
  dynamicTools: { name: string; description: string; registeredAt: string }[]
}
