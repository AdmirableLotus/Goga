import { spawn } from 'child_process'

/**
 * Running PowerShell from main, for reading the machine.
 *
 * Two rules this file keeps, and they are the reason it exists rather than each caller
 * spawning its own process:
 *
 *   - It never elevates. There is no `Start-Process -Verb RunAs`, no scheduled-task trick and
 *     no `-ExecutionPolicy Bypass` on the command line. If a step needs administrator rights,
 *     the command fails and the caller reports that the user has to do it, with the exact
 *     thing to click.
 *   - It is for reading. The one place a change is run is the install runner, and that only
 *     runs after the single-use approval gate has handed it a matching approval.
 *
 * The execution policy on this machine is RemoteSigned for the current user and Bypass for
 * the process, so `-NoProfile -NonInteractive -Command` runs as-is. Nothing here needs a
 * bypass flag, and adding one would be the kind of quiet weakening this project avoids.
 */

export interface PowerShellResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  /** True when the failure was "this needs administrator rights". */
  needsElevation: boolean
}

const ELEVATION_HINT = /requires elevation|Access is denied|requires administrator|Requested registry access is not allowed|must be run as administrator/i

export interface RunOptions {
  timeoutMs?: number
  /** Abort a long read when the caller is cancelled. */
  signal?: AbortSignal
}

/**
 * Run one PowerShell command and return what it said.
 *
 * `-NoProfile` keeps a user's profile script out of the result; `-NonInteractive` means a
 * command that would prompt fails instead of hanging the app.
 */
export function runPowerShell(command: string, options: RunOptions = {}): Promise<PowerShellResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (result: PowerShellResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        env: { ...process.env },
      })
    } catch (err) {
      finish({
        stdout: '', stderr: err instanceof Error ? err.message : String(err),
        exitCode: -1, timedOut: false, needsElevation: false,
      })
      return
    }

    const timer = setTimeout(() => { timedOut = true; proc.kill() }, timeoutMs)
    const onAbort = () => { proc.kill() }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })

    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      const combined = `${stderr}\n${stdout}`
      finish({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? -1,
        timedOut,
        needsElevation: ELEVATION_HINT.test(combined),
      })
    })

    proc.on('error', (err: Error) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      finish({ stdout: '', stderr: err.message, exitCode: -1, timedOut: false, needsElevation: false })
    })
  })
}

/**
 * Run a command that prints JSON and parse it.
 *
 * `ConvertTo-Json` on a single object produces an object, on several produces an array, and
 * on nothing produces nothing — so the caller gets `null` for an empty answer rather than a
 * parse error, and an array is always an array.
 */
export async function runPowerShellJson<T>(command: string, options: RunOptions = {}): Promise<{ data: T | null; result: PowerShellResult }> {
  const result = await runPowerShell(command, options)
  const text = result.stdout.trim()
  if (!text) return { data: null, result }
  try {
    const parsed = JSON.parse(text) as T
    return { data: parsed, result }
  } catch {
    return { data: null, result }
  }
}

/** A string safe to embed in a single-quoted PowerShell literal. */
export function psQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}
