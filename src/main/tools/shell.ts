import { spawn } from 'child_process'
import { ToolRegistry } from './registry'

const reg = ToolRegistry.getInstance()

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export async function shellExecute(command: string, cwd?: string, timeoutMs = 30_000): Promise<ShellResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: cwd ?? process.cwd(),
      windowsHide: true,
      env: { ...process.env }
    })

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
    }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? -1, timedOut })
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout: '', stderr: err.message, exitCode: -1, timedOut: false })
    })
  })
}

reg.register({
  name: 'shell.execute',
  description: 'Run a PowerShell command and return stdout, stderr and exit code. Use for reading system info, running scripts, git commands, npm, etc. Requires approval for destructive commands.',
  parameters: {
    type: 'object',
    properties: {
      command:   { type: 'string', description: 'PowerShell command or script to run.' },
      cwd:       { type: 'string', description: 'Working directory. Optional.' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Default: 30000.' }
    },
    required: ['command']
  },
  riskLevel: 'medium', reversible: true, category: 'shell'
}, async (p) => {
  const result = await shellExecute(
    p.command as string,
    p.cwd as string | undefined,
    p.timeoutMs as number | undefined
  )
  return {
    success: result.exitCode === 0 || result.stdout.length > 0,
    data: result,
    error: result.exitCode !== 0 ? result.stderr || `Exit code ${result.exitCode}` : undefined
  }
})

// Streaming variant — emits output line by line via callback, used by agent loop for long-running tasks
export async function shellExecuteStreaming(
  command: string,
  cwd: string | undefined,
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
  abortSignal?: AbortSignal,
  timeoutMs = 120_000
): Promise<ShellResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: cwd ?? process.cwd(),
      windowsHide: true,
      env: { ...process.env }
    })

    abortSignal?.addEventListener('abort', () => { proc.kill('SIGTERM') })

    proc.stdout.on('data', (d: Buffer) => {
      const text = d.toString()
      stdout += text
      text.split('\n').filter(Boolean).forEach(l => onLine(l, 'stdout'))
    })
    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      stderr += text
      text.split('\n').filter(Boolean).forEach(l => onLine(l, 'stderr'))
    })

    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM') }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? -1, timedOut })
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout: '', stderr: err.message, exitCode: -1, timedOut: false })
    })
  })
}

export function registerShellTools() {
  return ToolRegistry.getInstance()
}
