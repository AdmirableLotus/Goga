import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'

// Read-only review of a source-code asset: Goga copies the repository and reads
// it, and never runs, builds or installs anything from it.

// Loose on the spelling a model writes ("github.com/o/r", "o/r", ".git", "/tree/main");
// the result must still equal an in-scope repository exactly.
const GITHUB_REPO = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/(?:tree|blob)\/[^\s]*)?\/?$/
const MAX_FILE_BYTES = 1_000_000
const MAX_MATCHES = 60
const MAX_LINE_CHARS = 300
const MAX_READ_LINES = 200
const MAX_FILES = 50_000

/** "https://github.com/owner/repo" for a GitHub repository address, else null. */
export function githubRepo(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const m = input.trim().replace(/^[<"'`(]+|[>"'`).,]+$/g, '').match(GITHUB_REPO)
  if (!m || m[2] === '.' || m[2] === '..') return null
  return `https://github.com/${m[1]}/${m[2]}`.toLowerCase()
}

/** The workspace folder that holds the copy of `repo`. */
export function repoFolder(root: string, workspaceId: string, repo: string): string {
  const [, , , owner, name] = repo.split('/')
  return path.join(root, workspaceId.replace(/[^A-Za-z0-9_-]/g, ''), `${owner}__${name}`)
}

/** `relative` inside `folder`, or null when it would leave it (.., absolute paths, links out). */
export function insideRepo(folder: string, relative: unknown): string | null {
  if (typeof relative !== 'string') return null
  const target = path.resolve(folder, relative.replace(/^[\\/]+/, ''))
  const base = path.resolve(folder)
  if (target !== base && !target.startsWith(base + path.sep)) return null
  if (target === path.join(base, '.git') || target.startsWith(path.join(base, '.git') + path.sep)) return null
  try {
    const real = fs.realpathSync(target), realBase = fs.realpathSync(base)
    if (real !== realBase && !real.startsWith(realBase + path.sep)) return null
  } catch { /* missing files are reported by the caller */ }
  return target
}

function git(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      windowsHide: true, timeout: 300_000, signal, maxBuffer: 4 * 1024 * 1024,
      // No credential prompts, no LFS downloads, no system or user git config.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
    }, (err, _stdout, stderr) => err ? reject(new Error(`git failed: ${String(stderr || err.message).trim().slice(0, 300)}`)) : resolve())
  })
}

function* walk(folder: string, dir = folder): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(folder, full)
    else if (entry.isFile()) yield full
  }
}

const rel = (folder: string, file: string) => path.relative(folder, file).split(path.sep).join('/')
const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0)

export class SecurityCodeService {
  constructor(private root: string) {}

  /** A fresh shallow copy of the repository. Hooks, submodules and symlinks are never set up. */
  async fetch(workspaceId: string, repo: string, signal?: AbortSignal): Promise<{ folder: string; files: number }> {
    const folder = repoFolder(this.root, workspaceId, repo)
    fs.rmSync(folder, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(folder), { recursive: true })
    await git(['-c', 'core.symlinks=false', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      'clone', '--depth', '1', '--single-branch', '--no-tags', '--', `${repo}.git`, folder], signal)
    let files = 0
    for (const _ of walk(folder)) if (++files >= MAX_FILES) break
    return { folder, files }
  }

  folder(workspaceId: string, repo: string): string {
    const folder = repoFolder(this.root, workspaceId, repo)
    if (!fs.existsSync(folder)) throw new Error(`No copy of ${repo} yet. Fetch it first with security.code.fetch.`)
    return folder
  }

  list(workspaceId: string, repo: string, dir = ''): string[] {
    const folder = this.folder(workspaceId, repo)
    const target = insideRepo(folder, dir)
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`Not a folder in the repository: ${dir}`)
    return fs.readdirSync(target, { withFileTypes: true })
      .filter(e => e.name !== '.git' && !e.isSymbolicLink())
      .map(e => e.isDirectory() ? `${e.name}/` : e.name)
      .sort()
      .slice(0, 300)
  }

  search(workspaceId: string, repo: string, pattern: string, pathFilter = ''): { matches: string[]; truncated: boolean } {
    const folder = this.folder(workspaceId, repo)
    if (typeof pattern !== 'string' || !pattern || pattern.length > 200) throw new Error('Give a search pattern of 1–200 characters.')
    let re: RegExp
    try { re = new RegExp(pattern, 'i') } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
    const filter = String(pathFilter || '').toLowerCase()
    const matches: string[] = []
    let scanned = 0
    for (const file of walk(folder)) {
      if (++scanned > MAX_FILES) break
      const name = rel(folder, file)
      if (filter && !name.toLowerCase().includes(filter)) continue
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue
      const buf = fs.readFileSync(file)
      if (isBinary(buf)) continue
      const lines = buf.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 2000 || !re.test(lines[i])) continue
        matches.push(`${name}:${i + 1}: ${lines[i].trim().slice(0, MAX_LINE_CHARS)}`)
        if (matches.length >= MAX_MATCHES) return { matches, truncated: true }
      }
    }
    return { matches, truncated: false }
  }

  read(workspaceId: string, repo: string, file: string, startLine = 1, lineCount = MAX_READ_LINES): { file: string; lines: string; totalLines: number } {
    const folder = this.folder(workspaceId, repo)
    const target = insideRepo(folder, file)
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`Not a file in the repository: ${file}`)
    if (fs.statSync(target).size > MAX_FILE_BYTES) throw new Error('That file is too large to read here.')
    const buf = fs.readFileSync(target)
    if (isBinary(buf)) throw new Error('That is a binary file.')
    const all = buf.toString('utf8').split(/\r?\n/)
    const start = Math.max(1, Math.floor(Number(startLine) || 1))
    const count = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(Number(lineCount) || MAX_READ_LINES)))
    const lines = all.slice(start - 1, start - 1 + count).map((l, i) => `${start + i}: ${l.slice(0, 500)}`).join('\n')
    return { file: rel(folder, target), lines, totalLines: all.length }
  }
}
