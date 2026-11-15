export interface DeveloperProject {
  path: string
  name: string
  branch: string
  git: boolean
  scripts: string[]
  changedFiles: string
}

export interface DeveloperEvent {
  id: number
  kind: 'status' | 'message' | 'command' | 'files' | 'error'
  text: string
}

/**
 * What this run changed, as opposed to what was already uncommitted when it started.
 * `baseline` is the tree snapshot taken before the coding agent ran; the patch is the
 * difference between that snapshot and the tree afterwards.
 */
export interface DeveloperRunDiff {
  /** True when the project is a Git repo and a baseline could be taken. */
  available: boolean
  /** `git diff --stat` for the run only. */
  stat: string
  /** Unified diff for the run only, capped at `maxChars`. */
  patch: string
  /** Files the run created that Git does not track. */
  newFiles: string[]
  /** Files the run deleted. */
  deletedFiles: string[]
  /** True when the patch was cut short. */
  truncated: boolean
  /** Why no diff is available, when it is not. */
  reason?: string
}

export interface DeveloperState {
  project: DeveloperProject | null
  available: boolean
  status: 'idle' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped'
  mode: 'plan' | 'build'
  task: string
  events: DeveloperEvent[]
  summary: string
  /** Diff of what the last run changed. Null before the first run. */
  runDiff: DeveloperRunDiff | null
}
