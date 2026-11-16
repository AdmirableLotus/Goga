import { spawn, type ChildProcess } from 'child_process'
import type { RunBudget, RunLogLine } from '../../../shared/lab'
import { DEFAULT_BUDGET } from '../../../shared/lab'

/**
 * Running an external offensive tool, and stopping it.
 *
 * Three things this file owns, and they are the reason it exists rather than each tool
 * spawning its own process:
 *
 *   1. **The kill switch.** Every child process is registered here the moment it starts and
 *      removed when it exits. `killAll()` terminates all of them, and it is what the Lab's
 *      stop button and the app's emergency stop call. A process that is not registered cannot
 *      be started by any Lab tool.
 *   2. **The request budget.** A run gets a `Budget` object. Every request it makes goes
 *      through `spend()`, which refuses past the cap and paces to the per-minute rate. A tool
 *      that ignores the refusal cannot make the request, because the request is made by this
 *      file.
 *   3. **The log.** Lines are appended as they happen, so the page can show a run in progress
 *      rather than a result that appears at the end.
 *
 * Nothing here decides whether a target is allowed. That is `targets.ts`, and every caller
 * checks it before it gets this far.
 */

/** One live child process, with what it is and how to stop it. */
interface LiveProcess {
  id: string
  tool: string
  child: ChildProcess
  startedAt: number
}

const live = new Map<string, LiveProcess>()
let killedCount = 0

export function runningCount(): number { return live.size }
export function killedTotal(): number { return killedCount }
export function isRunning(): boolean { return live.size > 0 }

/**
 * Terminate every running offensive process.
 *
 * On Windows a child spawned without a shell is killed by `child.kill()`, but a tool that
 * spawned its own children (nmap's NSE, nuclei's workers) needs the tree. `taskkill /T /F` on
 * the pid is what actually stops those, so it is used when the pid is known.
 */
export function killAll(reason = 'kill switch'): { killed: number; ids: string[] } {
  const ids: string[] = []
  for (const [id, entry] of live) {
    ids.push(id)
    try {
      const pid = entry.child.pid
      if (pid && process.platform === 'win32') {
        // /T kills the tree, /F forces it. A tool that ignores SIGTERM is the normal case here.
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        entry.child.kill('SIGKILL')
      }
    } catch { /* the process may already be gone; the map entry is dropped below */ }
    live.delete(id)
  }
  killedCount += ids.length
  if (ids.length) log(`kill switch: stopped ${ids.length} process(es) — ${reason}`)
  return { killed: ids.length, ids }
}

function log(text: string): void {
  // The kill switch's own line goes to the console so it is visible even with no run open.
  // eslint-disable-next-line no-console
  console.log(`[lab] ${text}`)
}

export interface SpawnOptions {
  tool: string
  args: string[]
  /** Working directory. Defaults to the app's temp folder. */
  cwd?: string
  timeoutMs?: number
  /** Called for each chunk of stdout/stderr, so a run can stream. */
  onData?: (chunk: string) => void
  signal?: AbortSignal
}

export interface SpawnResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  killed: boolean
  /** Why it did not run at all, when the binary was missing. */
  missing: boolean
  message: string
}

/**
 * Run one external tool and wait for it.
 *
 * The process is registered before it can produce output, so the kill switch can always reach
 * it. A missing binary is reported as `missing: true` rather than as a failure, because the
 * honest answer is "that tool is not installed" and the Setup area is where it gets installed.
 */
export function runTool(binary: string, options: SpawnOptions): Promise<SpawnResult> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killed = false
    let settled = false

    const finish = (result: SpawnResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child: ChildProcess
    try {
      child = spawn(binary, options.args, {
        cwd: options.cwd,
        windowsHide: true,
        env: { ...process.env },
        // No shell: the arguments are passed as an array, so a target string can never become
        // a second command. This is the difference between a scanner and a remote shell.
        shell: false,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const missing = /ENOENT|not found/i.test(message)
      finish({ ok: false, exitCode: null, stdout: '', stderr: message, timedOut: false, killed: false, missing, message: missing ? `${binary} is not installed` : message })
      return
    }

    const id = `${options.tool}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    live.set(id, { id, tool: options.tool, child, startedAt: Date.now() })

    const timer = setTimeout(() => { timedOut = true; try { child.kill() } catch { /* gone */ } }, timeoutMs)
    const onAbort = () => { killed = true; try { child.kill() } catch { /* gone */ } }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      stdout += text
      options.onData?.(text)
    })
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      stderr += text
      options.onData?.(text)
    })

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      live.delete(id)
      const wasKilled = killed || !live.has(id) && killedCount > 0 && code === null
      finish({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        killed: wasKilled,
        missing: false,
        message: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : code === 0 ? 'finished' : `exited ${code}`,
      })
    })

    child.on('error', (err: Error) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      live.delete(id)
      const missing = /ENOENT|not found/i.test(err.message)
      finish({ ok: false, exitCode: null, stdout, stderr: err.message, timedOut: false, killed: false, missing, message: missing ? `${binary} is not installed` : err.message })
    })
  })
}

// ── The request budget ──────────────────────────────────────────────────────

export type SpendRefusal = 'cap' | 'stopped' | null

/**
 * A run's request budget.
 *
 * `spend()` is the only way a run makes a request. It refuses past the cap, and it waits
 * rather than exceeding the per-minute rate. A run that is stopped refuses everything after
 * that, so a stop is immediate even mid-loop.
 */
export class Budget {
  readonly maxRequests: number
  readonly maxPerMinute: number
  private used = 0
  private stopped = false
  private windowStart = Date.now()
  private inWindow = 0

  constructor(budget: Partial<RunBudget> = {}) {
    const max = Number(budget.maxRequests ?? DEFAULT_BUDGET.maxRequests)
    const rate = Number(budget.maxPerMinute ?? DEFAULT_BUDGET.maxPerMinute)
    this.maxRequests = Number.isFinite(max) && max > 0 ? Math.min(Math.floor(max), 100_000) : DEFAULT_BUDGET.maxRequests
    this.maxPerMinute = Number.isFinite(rate) && rate > 0 ? Math.min(Math.floor(rate), 6_000) : DEFAULT_BUDGET.maxPerMinute
  }

  get requests(): number { return this.used }
  get remaining(): number { return Math.max(0, this.maxRequests - this.used) }
  get isStopped(): boolean { return this.stopped }

  stop(): void { this.stopped = true }

  /**
   * Ask to make one request. Returns null when it may proceed, or the reason it may not.
   * Paces to the per-minute rate by waiting, so a caller does not have to.
   */
  async spend(): Promise<SpendRefusal> {
    if (this.stopped) return 'stopped'
    if (this.used >= this.maxRequests) return 'cap'
    const now = Date.now()
    if (now - this.windowStart >= 60_000) { this.windowStart = now; this.inWindow = 0 }
    if (this.inWindow >= this.maxPerMinute) {
      const wait = 60_000 - (now - this.windowStart)
      if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, 60_000)))
      this.windowStart = Date.now()
      this.inWindow = 0
      if (this.stopped) return 'stopped'
      if (this.used >= this.maxRequests) return 'cap'
    }
    this.used++
    this.inWindow++
    return null
  }
}

/** A run's log, appended as it happens. */
export class RunLog {
  private lines: RunLogLine[] = []
  constructor(private onChange?: (lines: RunLogLine[]) => void) {}

  add(level: RunLogLine['level'], text: string): void {
    this.lines.push({ time: new Date().toISOString(), level, text })
    // Keep a run's log bounded: a scanner can print a great deal.
    if (this.lines.length > 2000) this.lines = this.lines.slice(-2000)
    this.onChange?.(this.lines)
  }

  all(): RunLogLine[] { return this.lines }
}
