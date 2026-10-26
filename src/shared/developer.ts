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

export interface DeveloperState {
  project: DeveloperProject | null
  available: boolean
  status: 'idle' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped'
  mode: 'plan' | 'build'
  task: string
  events: DeveloperEvent[]
  summary: string
}
