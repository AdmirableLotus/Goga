import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import type { DeveloperState, DeveloperEvent, DeveloperProject } from '../../shared/developer'
import { SecurityWorkspaceService } from './securityWorkspace'

const execute = promisify(execFile)
const MAX_TEXT = 16_000

export function developerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Do not forward Goga's Telegram, voice-provider, or API credentials.
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp',
    'home', 'userprofile', 'appdata', 'localappdata', 'programfiles', 'programfiles(x86)', 'codex_home'])
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toLowerCase())))
}

export function describeDeveloperEvent(event: any): Omit<DeveloperEvent, 'id'> | null {
  if (event.type === 'error' || event.type === 'turn.failed') return { kind: 'error', text: event.message || event.error?.message || 'Coding agent failed' }
  const item = event.item
  if (!item) return null
  if (item.type === 'agent_message' && event.type === 'item.completed') return { kind: 'message', text: String(item.text || '') }
  if (item.type === 'command_execution') return { kind: 'command', text: `${item.command || ''}\n${item.aggregated_output || ''}${item.exit_code != null ? `\nExit code: ${item.exit_code}` : ''}` }
  if (item.type === 'file_change') return { kind: 'files', text: (item.changes || []).map((change: any) => `${change.kind}: ${change.path}`).join('\n') }
  return null
}

export class DeveloperService {
  private state: DeveloperState = { project: null, available: false, status: 'idle', mode: 'plan', task: '', events: [], summary: '' }
  private child: ChildProcess | null = null
  private executable: string | null = null
  private seq = 0
  private selecting = false
  constructor(private publish: (state: DeveloperState) => void) {}

  getState(): DeveloperState { return structuredClone(this.state) }
  private emit() { this.publish(this.getState()) }
  private add(kind: DeveloperEvent['kind'], text: string) {
    this.state.events = [...this.state.events.slice(-199), { id: ++this.seq, kind, text: text.slice(0, MAX_TEXT) }]
    this.emit()
  }

  async detect(): Promise<void> {
    const name = process.platform === 'win32' ? 'codex.exe' : 'codex'
    const candidates = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, name))
    if (process.platform === 'win32') {
      const extensions = path.join(os.homedir(), '.vscode', 'extensions')
      if (fs.existsSync(extensions)) {
        for (const dir of fs.readdirSync(extensions).filter(name => name.startsWith('openai.chatgpt-')).sort().reverse()) {
          candidates.push(path.join(extensions, dir, 'bin', 'windows-x86_64', name))
        }
      }
    }
    this.executable = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || null
    this.state.available = !!this.executable
    this.emit()
  }

  private async git(root: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await execute('git', ['-C', root, ...args], { windowsHide: true, timeout: 10_000, maxBuffer: 256_000 })
      return stdout.trim()
    } catch { return null }
  }

  private async inspect(root: string): Promise<DeveloperProject> {
    const realRoot = fs.realpathSync(root)
    if (!fs.statSync(realRoot).isDirectory()) throw new Error('Select a project folder')
    const branch = await this.git(realRoot, ['branch', '--show-current'])
    const changedFiles = await this.git(realRoot, ['status', '--short'])
    let scripts: string[] = []
    try { scripts = Object.keys(JSON.parse(fs.readFileSync(path.join(realRoot, 'package.json'), 'utf8')).scripts || {}) } catch {}
    return { path: realRoot, name: path.basename(realRoot), branch: branch || 'Detached HEAD', git: changedFiles !== null, scripts, changedFiles: changedFiles || '' }
  }

  async selectProject(root: string): Promise<DeveloperState> {
    if (this.child || this.selecting) throw new Error('Stop the current developer task before switching projects')
    this.selecting = true
    try {
      this.state.project = await this.inspect(root)
      this.state.status = 'idle'; this.state.events = []; this.state.summary = ''; this.state.task = ''
      this.emit()
      return this.getState()
    } finally { this.selecting = false }
  }

  async refresh(): Promise<DeveloperState> {
    if (this.state.project && !this.child && !this.selecting) return this.selectProject(this.state.project.path)
    return this.getState()
  }

  start(task: string, mode: 'plan' | 'build'): DeveloperState {
    if (SecurityWorkspaceService.getInstance().getActive()) throw new Error('Developer execution is disabled while a security workspace is active; coding agents cannot bypass security approvals.')
    if (typeof task !== 'string' || !task.trim() || task.length > 24_000) throw new Error('Enter a task up to 24,000 characters')
    if (mode !== 'plan' && mode !== 'build') throw new Error('Invalid developer mode')
    if (this.child || this.selecting) throw new Error('A developer operation is already running')
    if (!this.executable) throw new Error('Install Codex CLI and sign in with codex login first')
    if (!this.state.project) throw new Error('Select a project first')
    const project = this.state.project
    const root = project.path
    this.state = { ...this.state, status: 'running', mode, task: task.trim(), events: [], summary: '' }
    this.add('status', mode === 'plan' ? 'Inspecting project and preparing a plan. File edits are disabled.' : 'Working in the selected project. Review the resulting changes before committing.')
    const args = ['--ask-for-approval', 'never', 'exec', '--json', '--color', 'never', '--sandbox',
      mode === 'plan' ? 'read-only' : 'workspace-write', '--cd', root]
    if (!project.git) args.push('--skip-git-repo-check')
    args.push('-')
    const proc = spawn(this.executable, args, { cwd: root, windowsHide: true, env: developerEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = proc
    let buffer = ''
    let hadError = false
    const parse = (line: string) => {
      try {
        const event = JSON.parse(line)
        const described = describeDeveloperEvent(event)
        if (described) {
          if (described.kind === 'error') hadError = true
          if (described.kind === 'message') this.state.summary = described.text.slice(0, MAX_TEXT)
          this.add(described.kind, described.text)
        }
      } catch { /* stdout is a JSONL protocol, never display partial protocol records */ }
    }
    proc.stdout?.on('data', chunk => {
      buffer += chunk.toString()
      const lines = buffer.split('\n'); buffer = lines.pop() || ''
      for (const line of lines) parse(line)
      if (buffer.length > 1_000_000) { buffer = ''; hadError = true; this.add('error', 'Coding agent output exceeded the event size limit') }
    })
    proc.stderr?.on('data', chunk => this.add('status', chunk.toString()))
    proc.stdin?.on('error', () => {})
    proc.on('error', () => { hadError = true; this.add('error', 'Could not launch Codex. Check installation and sign-in.') })
    proc.on('close', async code => {
      if (buffer.trim()) parse(buffer)
      const stopped = this.state.status === 'stopping'
      try { this.state.project = await this.inspect(root) } catch {}
      this.child = null
      this.state.status = stopped ? 'stopped' : code === 0 && !hadError ? 'completed' : 'failed'
      this.add('status', stopped ? 'Task stopped. Review any partial file changes.' : this.state.status === 'completed' ? 'Finished. Review the summary, command results, and working tree.' : 'Task failed. Review the output; Codex may need login or sandbox setup.')
    })
    proc.stdin?.end(`You are working through Goga Developer Mode. ${mode === 'plan' ? 'Inspect the project and propose a concrete plan. Do not edit files.' : 'Inspect the project, implement the requested change, and run appropriate checks.'}\nPreserve existing user changes. Do not read credential files such as .env, publish, deploy, push commits, or delete unrelated files. Do not spawn subagents. Respect repository instructions. End with changes made, checks actually run, and remaining limitations. Never claim a check passed without evidence.\n\nUser task:\n${task.trim()}`)
    return this.getState()
  }

  stop(): void {
    if (!this.child || this.state.status === 'stopping') return
    this.state.status = 'stopping'; this.emit()
    const proc = this.child
    if (process.platform === 'win32' && proc.pid) {
      execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, error => {
        if (error) proc.kill()
      })
    } else proc.kill('SIGTERM')
  }
}
