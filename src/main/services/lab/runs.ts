import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { LabFinding, LabRun, RunBudget, RunLogLine, RunState } from '../../../shared/lab'
import { nanoid } from '../../utils/nanoid'
import { audit } from '../security/store'

/**
 * Where Lab runs are kept.
 *
 * A run is written when it starts (so a crash mid-run still leaves a record of what was
 * started, and against what) and updated as it goes. Raw tool output is kept, because the
 * parsed findings are a convenience and the tool's own words are the evidence.
 */

const MAX_RUNS = 300
const MAX_RAW = 400_000

interface Store { runs: LabRun[] }

function file(): string { return path.join(app.getPath('userData'), 'goga-lab-runs.json') }

function load(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Store>
    return { runs: Array.isArray(raw.runs) ? raw.runs : [] }
  } catch { return { runs: [] } }
}

function save(store: Store): void {
  const target = file()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  // Runs hold no credentials: only hosts, commands and responses from a declared target.
  fs.writeFileSync(target, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export function listRuns(limit = 50): LabRun[] {
  return load().runs.slice(-limit).reverse()
}

export function getRun(id: string): LabRun | null {
  return load().runs.find(r => r.id === id) ?? null
}

export interface StartRunInput {
  tool: string
  targetId: string
  targetHost: string
  budget?: Partial<RunBudget>
}

/** Open a run record. Written before anything runs. */
export function startRun(input: StartRunInput): LabRun {
  const budget = {
    maxRequests: Number(input.budget?.maxRequests ?? 200),
    maxPerMinute: Number(input.budget?.maxPerMinute ?? 30),
  }
  const run: LabRun = {
    id: nanoid(),
    tool: input.tool,
    targetId: input.targetId,
    targetHost: input.targetHost,
    state: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    budget,
    requests: 0,
    log: [],
    rawOutput: '',
    findings: [],
    stopReason: null,
  }
  const store = load()
  store.runs = [...store.runs.slice(-(MAX_RUNS - 1)), run]
  save(store)
  audit('request', `lab run started: ${run.tool} against ${run.targetHost} (budget ${budget.maxRequests} requests, ${budget.maxPerMinute}/min)`)
  return run
}

/** Update a run in place. Called as the run progresses. */
export function updateRun(id: string, patch: Partial<Omit<LabRun, 'id' | 'startedAt' | 'tool'>>): LabRun | null {
  const store = load()
  const i = store.runs.findIndex(r => r.id === id)
  if (i < 0) return null
  const merged = { ...store.runs[i], ...patch }
  if (merged.rawOutput.length > MAX_RAW) merged.rawOutput = `${merged.rawOutput.slice(0, MAX_RAW)}\n…[truncated at ${MAX_RAW} characters]`
  store.runs[i] = merged
  save(store)
  return merged
}

export function appendLog(id: string, lines: RunLogLine[]): void {
  updateRun(id, { log: lines.slice(-2000) })
}

export function addFindings(id: string, findings: LabFinding[]): LabFinding[] {
  const run = getRun(id)
  if (!run) return []
  const merged = [...run.findings, ...findings]
  updateRun(id, { findings: merged })
  return merged
}

/** Close a run, with the state and the reason it ended. */
export function finishRun(id: string, state: RunState, stopReason: string | null, patch: Partial<LabRun> = {}): LabRun | null {
  const run = updateRun(id, { ...patch, state, stopReason, endedAt: new Date().toISOString() })
  if (!run) return null
  const kind = state === 'done' ? 'request' : state === 'refused' ? 'blocked' : 'note'
  audit(kind, `lab run ${state}: ${run.tool} against ${run.targetHost} — ${run.requests} request(s)${stopReason ? `, ${stopReason}` : ''}`)
  return run
}

/** Refuse a run before it starts: a host that is not declared. This is the loud path. */
export function refuseRun(tool: string, host: string, reason: string): LabRun {
  const run: LabRun = {
    id: nanoid(),
    tool,
    targetId: '',
    targetHost: host,
    state: 'refused',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    budget: { maxRequests: 0, maxPerMinute: 0 },
    requests: 0,
    log: [{ time: new Date().toISOString(), level: 'stop', text: reason }],
    rawOutput: '',
    findings: [],
    stopReason: reason,
  }
  const store = load()
  store.runs = [...store.runs.slice(-(MAX_RUNS - 1)), run]
  save(store)
  audit('blocked', `lab refused ${tool} against ${host}: ${reason}`)
  return run
}

/** Mark any run left 'running' by a crash as stopped, so the page does not lie. */
export function reconcileStaleRuns(): number {
  const store = load()
  let changed = 0
  for (const run of store.runs) {
    if (run.state === 'running') {
      run.state = 'stopped'
      run.endedAt = new Date().toISOString()
      run.stopReason = run.stopReason ?? 'the app closed while this run was open'
      changed++
    }
  }
  if (changed) save(store)
  return changed
}
