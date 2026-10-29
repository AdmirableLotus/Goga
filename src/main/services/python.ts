import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { app } from 'electron'

// Run short Python scripts for real work: engineering maths, data, plots. Each script runs
// in its own temp folder with a time and output limit; it is Goga's code, so it is not
// treated as untrusted downloaded input, but it still cannot run forever or flood output.

const TIMEOUT_MS = 60_000
const MAX_OUTPUT = 40_000

export interface PythonResult { ok: boolean; stdout: string; stderr: string; images: string[]; timedOut: boolean }

/** The Python executable to use, or null when none is installed. */
export function findPython(): string | null {
  const candidates = process.platform === 'win32'
    ? ['python.exe', 'py.exe', 'C:\\Python314\\python.exe', 'C:\\Python312\\python.exe']
    : ['python3', 'python']
  for (const c of candidates) {
    try { execFileSyncQuiet(c, ['--version']); return c } catch { /* try next */ }
  }
  return null
}

function execFileSyncQuiet(cmd: string, args: string[]): void {
  // Throws if the command is missing; output ignored.
  require('child_process').execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000, windowsHide: true })
}

export function workDir(): string {
  const dir = path.join(app.getPath('userData'), 'python-runs', String(Date.now()))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Run `code` with Python and return its output plus any PNG files it saved to the run folder. */
export function runPython(code: string, python: string, dir: string, signal?: AbortSignal): Promise<PythonResult> {
  const scriptPath = path.join(dir, 'script.py')
  fs.writeFileSync(scriptPath, String(code))
  return new Promise((resolve) => {
    execFile(python, [scriptPath], {
      cwd: dir,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT * 2,
      windowsHide: true,
      signal,
      // Inherit the environment so installed packages (numpy, matplotlib) are found;
      // force a non-interactive plotting backend so savefig works with no window.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', MPLBACKEND: 'Agg' },
    }, (err, stdout, stderr) => {
      const timedOut = !!err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      const images = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(f => /\.png$/i.test(f)).map(f => path.join(dir, f))
        : []
      resolve({
        ok: !err,
        stdout: String(stdout).slice(0, MAX_OUTPUT),
        stderr: (timedOut ? 'Timed out after 60s. ' : '') + String(stderr).slice(0, MAX_OUTPUT),
        images,
        timedOut,
      })
    })
  })
}
