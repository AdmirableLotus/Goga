import { spawn } from 'child_process'
import { ToolRegistry } from './registry'
import { shellExecute } from './shell'

const reg = ToolRegistry.getInstance()

reg.register({
  name: 'process.start',
  description: 'Launch an application or executable. Returns the PID.',
  parameters: {
    type: 'object',
    properties: {
      executable: { type: 'string', description: 'Path or name of the executable (e.g. "notepad.exe", "code", "brave").' },
      args:       { type: 'array',  items: { type: 'string' }, description: 'Command-line arguments.' },
      cwd:        { type: 'string', description: 'Working directory.' }
    },
    required: ['executable']
  },
  riskLevel: 'medium', reversible: true, category: 'process'
}, async (p) => {
  return new Promise((resolve) => {
    try {
      const proc = spawn(p.executable as string, (p.args as string[] | undefined) ?? [], {
        cwd: p.cwd as string | undefined,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        shell: true
      })
      proc.unref()
      resolve({ success: true, data: { pid: proc.pid, executable: p.executable } })
    } catch (err) {
      resolve({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
})

reg.register({
  name: 'process.list',
  description: 'List running processes. Optionally filter by name.',
  parameters: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: 'Optional process name filter (partial match).' }
    }
  },
  riskLevel: 'low', reversible: true, category: 'process'
}, async (p) => {
  const filter = p.filter ? `| Where-Object { $_.Name -like '*${(p.filter as string).replace(/'/g, "''")}*' }` : ''
  const cmd = `Get-Process ${filter} | Select-Object Id, Name, CPU, WorkingSet | ConvertTo-Json -Compress`
  const result = await shellExecute(cmd)
  try {
    const parsed = JSON.parse(result.stdout || '[]')
    return { success: true, data: Array.isArray(parsed) ? parsed : [parsed] }
  } catch {
    return { success: false, error: result.stderr || 'Failed to parse process list' }
  }
})

reg.register({
  name: 'process.kill',
  description: 'Terminate a process by PID or name. REQUIRES APPROVAL.',
  parameters: {
    type: 'object',
    properties: {
      pid:  { type: 'number', description: 'Process ID to kill.' },
      name: { type: 'string', description: 'Process name to kill (kills all matching).' }
    }
  },
  riskLevel: 'high', reversible: false, category: 'process'
}, async (p) => {
  const cmd = p.pid
    ? `Stop-Process -Id ${p.pid} -Force`
    : `Stop-Process -Name '${(p.name as string).replace(/'/g, "''")}' -Force`
  const result = await shellExecute(cmd)
  return {
    success: result.exitCode === 0,
    data: { killed: p.pid ?? p.name },
    error: result.exitCode !== 0 ? result.stderr : undefined
  }
})

export function registerProcessTools() {
  return ToolRegistry.getInstance()
}
