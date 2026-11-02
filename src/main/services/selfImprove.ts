import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { codeContext, sourceOverview } from './selfCode'

/**
 * Self-improvement workshop: Goga changes his own code — carefully. He works on a private
 * copy of his source (never the real project), writes the change plus a test with a local
 * coding model, and keeps it only if the typecheck and EVERY test pass. Then he shows the
 * user what changed; nothing reaches the real code until the user says "merge it", and each
 * merged change is saved as a patch so it can be undone. He may change any of his files
 * (the owner's choice, 2026-11-02); a change to the files that keep him safe (paper-only
 * trading, key storage, approvals, this workshop) is flagged so the owner reviews it closely.
 */

export interface Edit { file: string; find: string; replace: string }
export interface ChangePlan { summary: string; edits: Edit[] }
export interface Proposal { id: string; goal: string; summary: string; files: string[]; diff: string; attempts: number; createdAt: string }

/** Files that keep Goga safe. He may change them, but such a change is flagged for a close look. */
export const SAFETY_FILES: { file: RegExp; guards: string }[] = [
  { file: /^src\/main\/services\/trading\/(paperTrading|desk)\.ts$/, guards: 'paper-only trading and the encrypted trading keys' },
  { file: /^src\/main\/services\/authorization\.ts$/, guards: 'which actions need your approval' },
  { file: /^src\/main\/services\/emergencyStop\.ts$/, guards: 'the emergency stop' },
  { file: /^src\/main\/services\/promptInjectionGuard\.ts$/, guards: 'protection against instructions hidden in web pages and files' },
  { file: /^src\/main\/(services|handlers)\/settings\.ts$/, guards: 'settings and stored keys' },
  { file: /^src\/main\/services\/(selfImprove|gapJournal|selfCode)\.ts$/, guards: 'this workshop and its safety checks' },
  { file: /^src\/main\/tools\/(self|registry)\.ts$/, guards: 'how tools are registered and run' },
  { file: /^src\/shared\/types\.ts$/, guards: 'shared settings and defaults' },
  { file: /__tests__\/self-(improve|workshop)/, guards: 'the tests of this workshop' },
]

/** The safety files a change touches, with what each one guards. */
export function safetyFilesTouched(files: string[]): { file: string; guards: string }[] {
  return files.flatMap(f => { const s = SAFETY_FILES.find(x => x.file.test(norm(f))); return s ? [{ file: norm(f), guards: s.guards }] : [] })
}

const MAX_ATTEMPTS = 3
const TEST_TRIES = 2
const PROJECT_FILES = ['package.json', 'tsconfig.json', 'tsconfig.main.json', 'vitest.config.ts', 'vitest.config.mts', 'vite.config.ts']
const CONTEXT_CHARS = 14_000

const norm = (f: string) => String(f ?? '').replace(/\\/g, '/').replace(/^\.?\//, '')

/** Read the model's JSON into a plan, or say what's wrong with it. */
export function parsePlan(text: string): ChangePlan {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('the reply was not valid JSON') }
  const o = raw as { summary?: unknown; edits?: unknown }
  if (typeof o?.summary !== 'string' || !Array.isArray(o.edits) || !o.edits.length) throw new Error('the reply needs "summary" and a non-empty "edits" list')
  const edits = o.edits.map((e: { file?: unknown; find?: unknown; replace?: unknown }, i: number) => {
    if (typeof e?.file !== 'string' || typeof e.find !== 'string' || typeof e.replace !== 'string') throw new Error(`edit ${i + 1} needs string "file", "find" and "replace"`)
    return { file: norm(e.file), find: e.find, replace: e.replace }
  })
  return { summary: o.summary.trim().slice(0, 600), edits }
}

/** Every rule the plan breaks. Empty means it may be tried. */
export function safetyProblems(plan: ChangePlan): string[] {
  const problems: string[] = []
  for (const e of plan.edits) {
    if (!/^src\/.+\.(ts|tsx)$/.test(e.file) || e.file.includes('..')) problems.push(`${e.file}: only .ts/.tsx files inside src/ may be changed`)
    if (/api\.alpaca\.markets/.test(e.replace) && !/paper-api\.alpaca\.markets/.test(e.replace)) problems.push(`${e.file}: adds a live (real-money) trading address`)
    if (/safeStorage|\.env\b/.test(e.replace) && !/safeStorage|\.env\b/.test(e.find)) problems.push(`${e.file}: touches key storage`)
  }
  return problems
}

/** Apply edits inside root. A "find" must match exactly once; an empty "find" creates a new file. */
export function applyEdits(root: string, edits: Edit[]): void {
  for (const e of edits) {
    const full = path.resolve(root, e.file)
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error(`${e.file} is outside the workshop`)
    if (!e.find) {
      if (fs.existsSync(full)) {
        const old = fs.readFileSync(full, 'utf8')
        const eol = old.includes('\r\n') ? '\r\n' : '\n'
        const firstLine = old.split(/\r?\n/).find(l => l.trim())?.trim() ?? ''
        // A whole-file rewrite is allowed only when it keeps most of the file — the typecheck,
        // every test and the user's review still check it.
        const rewrite = e.replace.length >= old.length * 0.8
        // Otherwise it is an addition at the end (tools register themselves when their file
        // loads, so a new tool works there), minus what the model re-declares that the file
        // already has (its imports, `const reg = …`).
        const addition = withoutRedeclarations(old, e.replace)
        if (!rewrite && addition && !(firstLine && addition.includes(firstLine))) {
          fs.writeFileSync(full, `${old.replace(/\s*$/, '')}${eol}${eol}${addition.replace(/\n/g, eol)}${eol}`)
          continue
        }
        // A short version that repeats the file's start would delete code.
        if (!rewrite) throw new Error(`${e.file} is an EXISTING file (${old.split('\n').length} lines) and your version would drop most of it. If you meant a new file, pick a name that does not exist yet (for example ${path.posix.join(path.posix.dirname(e.file), 'newFeature.ts')}); to change this file, give its exact lines in "find"`)
        fs.writeFileSync(full, old.includes('\r\n') ? e.replace.replace(/\r?\n/g, '\r\n') : e.replace)
        continue
      }
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, e.replace)
      continue
    }
    if (!fs.existsSync(full)) throw new Error(`${e.file} does not exist`)
    const body = fs.readFileSync(full, 'utf8')
    // Files may use Windows line endings; the model writes plain \n.
    const crlf = body.includes('\r\n')
    const text = crlf ? body.replace(/\r\n/g, '\n') : body
    const find = e.find.replace(/\r\n/g, '\n')
    const replace = e.replace.replace(/\r\n/g, '\n')
    const count = text.split(find).length - 1
    let out: string
    if (count === 1) out = text.replace(find, () => replace)
    else if (count > 1) throw new Error(`in ${e.file}, the "find" text was found ${count} times — include more lines so it matches exactly once`)
    else {
      // Small models get the indentation or spacing wrong: match whole lines ignoring spaces.
      const at = looseMatch(text, find)
      const added = at === null ? additionOnly(text, find, replace) : null
      if (added !== null) { out = added; fs.writeFileSync(full, crlf ? out.replace(/\n/g, '\r\n') : out); continue }
      if (at === null) throw new Error(`in ${e.file}, this "find" text is not in the file: ${JSON.stringify(find.slice(0, 160))}. ${closestLine(text, find)}Copy lines exactly from the file as shown.`)
      const lines = text.split('\n')
      out = [...lines.slice(0, at.start), ...replace.replace(/\n$/, '').split('\n'), ...lines.slice(at.end)].join('\n')
    }
    fs.writeFileSync(full, crlf ? out.replace(/\n/g, '\r\n') : out)
  }
}

const squash = (l: string) => l.replace(/\s+/g, ' ').trim()

const importedFrom = (line: string) => /^\s*import\b.*\bfrom\s+['"]([^'"]+)['"]/.exec(line)?.[1]
const topConst = (line: string) => /^const (\w+)\s*=/.exec(line)?.[1]

/**
 * New code for the end of a file, minus what the file already has: an import of a module it
 * already imports (in any form — `import fs from 'fs'` and `import * as fs from 'fs'` clash)
 * and a top-level const it already declares (the tool files' `const reg = …`).
 */
export function withoutRedeclarations(existing: string, addition: string): string {
  const lines = existing.split(/\r?\n/)
  const modules = new Set(lines.map(importedFrom).filter(Boolean))
  const consts = new Set(lines.map(topConst).filter(Boolean))
  return addition.split(/\r?\n/).filter(l => {
    const mod = importedFrom(l), name = topConst(l)
    return !(mod && modules.has(mod)) && !(name && consts.has(name))
  }).join('\n').trim()
}

/** The one run of whole lines equal to `find` apart from spacing (null when none, or more than one). */
export function looseMatch(text: string, find: string): { start: number; end: number } | null {
  const want = find.split('\n').map(squash).filter(Boolean)
  if (!want.length) return null
  const lines = text.split('\n')
  const hits: { start: number; end: number }[] = []
  for (let i = 0; i < lines.length && hits.length < 2; i++) {
    if (squash(lines[i]) !== want[0]) continue
    let j = i, k = 0
    while (j < lines.length && k < want.length) {
      if (!squash(lines[j])) { j++; continue }   // blank lines in the file don't break a match
      if (squash(lines[j]) !== want[k]) break
      j++; k++
    }
    if (k === want.length) hits.push({ start: i, end: j })
  }
  return hits.length === 1 ? hits[0] : null
}

/**
 * An edit that only ADDS lines, with "find" quoting existing lines in the wrong order (a model
 * "tidying" an import list it was asked to extend). When every find line is in the file and
 * every one is kept in the replacement, the new lines go after the last of them. Null otherwise.
 */
export function additionOnly(text: string, find: string, replace: string): string | null {
  const findLines = find.split('\n').map(squash).filter(Boolean)
  const replaceLines = replace.split('\n').filter(l => l.trim())
  const kept = new Set(replaceLines.map(squash))
  if (!findLines.length || findLines.some(l => !kept.has(l))) return null
  const lines = text.split('\n')
  const where = findLines.map(f => lines.findIndex(l => squash(l) === f))
  if (where.some(i => i < 0)) return null
  const known = new Set(lines.map(squash))
  const fresh = replaceLines.filter(l => !known.has(squash(l)))
  if (!fresh.length) return null
  const after = Math.max(...where)
  const indent = /^\s*/.exec(lines[after])?.[0] ?? ''
  return [...lines.slice(0, after + 1), ...fresh.map(l => indent + l.trim()), ...lines.slice(after + 1)].join('\n')
}

/** A test file name that isn't taken, so a new test never lands inside an existing one. */
export function freshTestName(root: string, file: string): string {
  let name = file, n = 2
  while (fs.existsSync(path.join(root, name))) name = file.replace(/\.test\.ts$/, `-${n++}.test.ts`)
  return name
}

/**
 * The test imports a helper the change forgot to export: export it. Adding `export` to a
 * top-level function or const changes nothing about how the code runs.
 */
export function exposeImported(root: string, test: Edit): string[] {
  const exposed: string[] = []
  const dir = path.dirname(path.join(root, test.file))
  for (const m of test.replace.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = [`${m[2]}.ts`, `${m[2]}.tsx`, `${m[2]}/index.ts`].map(f => path.resolve(dir, f)).find(f => fs.existsSync(f))
    if (!target || !target.startsWith(path.resolve(root, 'src') + path.sep)) continue
    let body = fs.readFileSync(target, 'utf8')
    for (const name of m[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '')).filter(n => /^\w+$/.test(n))) {
      const decl = new RegExp(`^((?:async\\s+)?function\\s+${name}\\b|const\\s+${name}\\b)`, 'm')
      if (!decl.test(body) || new RegExp(`^export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`, 'm').test(body)) continue
      body = body.replace(decl, 'export $1')
      exposed.push(name)
    }
    if (exposed.length) fs.writeFileSync(target, body)
  }
  return exposed
}

const TOOLS_INDEX = 'src/main/tools/index.ts'

/**
 * New tool files get their import in tools/index.ts added here, not by the model — it kept
 * quoting that list from memory (sorted, with lines that aren't there) and every try failed.
 * The model's own import-only edits to the list are dropped; any other edit to it is kept.
 */
export function registerNewTools(edits: Edit[], root: string): Edit[] {
  const isNewTool = (e: Edit) => /^src\/main\/tools\/[\w-]+\.ts$/.test(e.file) && e.file !== TOOLS_INDEX && !e.find
    && !fs.existsSync(path.join(root, e.file)) && /\.register\(/.test(e.replace)
  const importOnly = (e: Edit) => e.file === TOOLS_INDEX && e.replace.split('\n').every(l => !l.trim() || /^\s*(import\s+['"][^'"]+['"]|export \{ ToolRegistry \} from)/.test(l))
  const fresh = edits.filter(isNewTool)
  if (!fresh.length) return edits
  const index = path.join(root, TOOLS_INDEX)
  const listed = fs.existsSync(index) ? fs.readFileSync(index, 'utf8') : ''
  const lines = fresh.map(e => `import './${path.posix.basename(e.file, '.ts')}'`).filter(l => !listed.includes(l))
  const kept = edits.filter(e => !importOnly(e))
  if (!lines.length || !listed) return kept
  // Added after the last existing import, through the ordinary edit path.
  const lastImport = listed.replace(/\r\n/g, '\n').split('\n').filter(l => /^import\s+['"]/.test(l)).pop()
  return lastImport ? [...kept, { file: TOOLS_INDEX, find: lastImport, replace: [lastImport, ...lines].join('\n') }] : kept
}

/** "The closest real line is …", to help the model copy correctly. */
function closestLine(text: string, find: string): string {
  const first = squash(find.split('\n').find(l => l.trim()) ?? '')
  const words = new Set(first.toLowerCase().split(/\W+/).filter(w => w.length > 2))
  let best = '', score = 0
  for (const line of text.split('\n')) {
    const l = squash(line)
    let prefix = 0
    while (prefix < l.length && l[prefix] === first[prefix]) prefix++
    // Shared words first, then how much of the start matches.
    const s = l.toLowerCase().split(/\W+/).filter(w => words.has(w)).length * 1000 + prefix
    if (s > score) { score = s; best = line.trim() }
  }
  return best ? `The closest real line is: ${JSON.stringify(best.slice(0, 160))}. ` : ''
}

/** The useful part of a failed typecheck or test run, for the model to fix. */
export function failureSummary(output: string, max = 2500): string {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
  const keep = lines.filter(l => /error TS\d+|FAIL|×|AssertionError|Error:|expected|received|❯ .*:\d+/.test(l))
  return (keep.length ? keep : lines.slice(-40)).join('\n').slice(0, max)
}

export const SYSTEM = `You are the coding part of Goga, a local AI assistant (an Electron + TypeScript app). You change Goga's own source code to close one gap.
Reply with ONLY a JSON object:
{"summary": "<one or two plain sentences: what you changed and why>",
 "edits": [{"file": "src/...ts", "find": "<exact text copied from the file, a few whole lines, unique>", "replace": "<the new text>"}]}
Rules:
- "find" must be copied EXACTLY from the file shown (same spaces and quotes) and appear only once. Use "" as "find" to create a new file, or to ADD new code at the end of an existing file (give only the new code — never repeat the file).
- Keep the change small and focused on the goal. Match the surrounding style.
- PREFER NEW FILES. Never rewrite an existing file; change only the few lines you must. A new tool goes in a NEW file in src/main/tools/ (copy the pattern of src/main/tools/clock.ts: ToolRegistry.getInstance().register({...}, async params => ...)) — it is registered automatically, so do NOT edit src/main/tools/index.ts.
- TypeScript is strict. Tool params are \`unknown\`: convert them, e.g. String(params.folder ?? ''), Number(params.max ?? 50). In catch blocks the error is \`unknown\`: write catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }. Import every module you use (import fs from 'fs', import path from 'path'). Tool parameter properties may only have type, description, enum and items (no default).
- Do NOT write tests here; a test is written for your change in a separate step. Put logic worth testing in a small exported function.
- Never touch trading account addresses, key storage, approvals, or settings types.`

export const TEST_SYSTEM = `You write ONE vitest test file for a change just made to Goga (an Electron + TypeScript app).
Reply with ONLY a JSON object: {"file": "src/main/services/__tests__/<short-name>.test.ts", "content": "<the whole test file>"}
Rules:
- Start with: import { describe, expect, it } from 'vitest'
- Import what you test with a relative path from src/main/services/__tests__/ (for example '../../tools/findFiles' or '../myModule').
- Test the exported functions the change added or changed. No network, no Electron, no running model; use os.tmpdir() for temporary files.
- Keep it short: 2 to 4 tests.`

/** Read the test step's JSON. */
export function parseTest(text: string): Edit {
  let raw: { file?: unknown; content?: unknown }
  try { raw = JSON.parse(text) } catch { throw new Error('the test reply was not valid JSON') }
  // Wherever the model put it, the test goes in the one tests folder ('../../tools/x' imports
  // written for a sibling __tests__ folder resolve the same from there).
  const base = path.posix.basename(norm(String(raw?.file ?? ''))).replace(/(\.test)?\.tsx?$/, '').replace(/[^\w.-]/g, '') || 'change'
  const file = `src/main/services/__tests__/${base}.test.ts`
  if (typeof raw.content !== 'string' || !/from 'vitest'|from "vitest"/.test(raw.content)) throw new Error('the test file must import from vitest')
  return { file, find: '', replace: raw.content }
}

export interface WorkshopDeps {
  projectRoot: string
  workDir: string
  /** The coding model, answering in JSON. */
  ask: (messages: { role: 'system' | 'user'; content: string }[], signal?: AbortSignal) => Promise<string>
  run?: (cmd: string, cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ code: number; out: string }>
  status: (message: string) => void
  log: { info: (m: string) => void; warn: (m: string) => void }
}

/** Run a command and capture its output (never throws for a non-zero exit). */
export function runCommand(cmd: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, CI: '1' } })
    let out = ''
    const add = (b: Buffer) => { out = (out + b.toString()).slice(-200_000) }
    child.stdout.on('data', add); child.stderr.on('data', add)
    const kill = () => { try { child.kill() } catch { /* gone */ } }
    const timer = setTimeout(() => { out += '\n[timed out]'; kill() }, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, out }) })
    child.on('error', err => { clearTimeout(timer); resolve({ code: 1, out: out + String(err) }) })
  })
}

export class Workshop {
  private busy = false

  constructor(private deps: WorkshopDeps) {}

  private get proposalFile() { return path.join(this.deps.workDir, 'proposal.json') }
  private get copy() { return path.join(this.deps.workDir, 'code') }
  private run(cmd: string, cwd: string, timeoutMs: number, signal?: AbortSignal) { return (this.deps.run ?? runCommand)(cmd, cwd, timeoutMs, signal) }
  private git(args: string, signal?: AbortSignal) { return this.run(`git -c user.name=Goga -c user.email=goga@localhost -c core.autocrlf=false ${args}`, this.copy, 60_000, signal) }

  isBusy(): boolean { return this.busy }

  pending(): Proposal | null {
    try { return JSON.parse(fs.readFileSync(this.proposalFile, 'utf8')) } catch { return null }
  }

  /** Remove the private copy. The node_modules link is unlinked first so its target is never touched. */
  discard(): void {
    const link = path.join(this.copy, 'node_modules')
    try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link) } catch { /* no link */ }
    try { if (fs.existsSync(link)) fs.rmdirSync(link) } catch { /* a junction that unlink missed */ }
    fs.rmSync(this.deps.workDir, { recursive: true, force: true })
  }

  /** A fresh private copy of the current code, committed as the starting point. */
  private async prepare(signal?: AbortSignal): Promise<void> {
    this.discard()
    fs.mkdirSync(this.copy, { recursive: true })
    fs.cpSync(path.join(this.deps.projectRoot, 'src'), path.join(this.copy, 'src'), { recursive: true })
    for (const f of PROJECT_FILES) {
      const from = path.join(this.deps.projectRoot, f)
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(this.copy, f))
    }
    // Sample files some tests read from scripts/ (e.g. a real PDF for the library tests).
    const scripts = path.join(this.deps.projectRoot, 'scripts')
    if (fs.existsSync(scripts)) {
      fs.mkdirSync(path.join(this.copy, 'scripts'))
      for (const f of fs.readdirSync(scripts).filter(f => /^test-/.test(f))) {
        fs.cpSync(path.join(scripts, f), path.join(this.copy, 'scripts', f), { recursive: true })
      }
    }
    fs.symlinkSync(path.join(this.deps.projectRoot, 'node_modules'), path.join(this.copy, 'node_modules'), 'junction')
    fs.writeFileSync(path.join(this.copy, '.gitignore'), 'node_modules\ndist\n')
    for (const step of ['init -q', 'add -A', 'commit -q -m baseline']) {
      const r = await this.git(step, signal)
      if (r.code !== 0) throw new Error(`could not set up the workshop copy (git ${step}): ${r.out.slice(0, 300)}`)
    }
  }

  /** What the model sees: the goal, a map of the code, and the most relevant files in full. */
  private context(goal: string): string {
    const src = path.join(this.copy, 'src')
    // The tool list and a model tool are always shown: a new ability usually means a new tool file.
    const picked = [...new Set([...codeContext(src, goal, 2000).files.map(f => f.replace(/^src\//, '')), 'main/tools/index.ts', 'main/tools/clock.ts'])]
    let text = ''
    for (const rel of picked) {
      if (!fs.existsSync(path.join(src, rel))) continue
      const body = fs.readFileSync(path.join(src, rel), 'utf8').replace(/\r\n/g, '\n')
      if (text.length + body.length > CONTEXT_CHARS) { if (!text) text += `\n=== src/${rel} (first part) ===\n${body.slice(0, CONTEXT_CHARS)}\n`; continue }
      text += `\n=== src/${rel} ===\n${body}\n`
    }
    // The model kept "creating" files that already exist; name them outright.
    let tools = ''
    try { tools = fs.readdirSync(path.join(src, 'main/tools')).filter(f => f.endsWith('.ts')).join(', ') } catch { /* no tools folder */ }
    return `${tools ? `Files that ALREADY EXIST in src/main/tools/ (never create these again): ${tools}\n\n` : ''}Map of the code:\n${sourceOverview(src).slice(0, 2500)}\n\nRelevant files:${text || ' (none found — create new files if needed)'}`
  }

  /**
   * Try to make one improvement. Resolves with the proposal (tests passed) or throws with
   * the honest reason it could not be done.
   */
  async improve(goal: string, signal?: AbortSignal): Promise<Proposal> {
    if (this.busy) throw new Error('I am already working on another change')
    this.busy = true
    try {
      this.deps.status('Making a private copy of my code to work on…')
      await this.prepare(signal)
      // The untouched copy must pass first; otherwise no change could ever pass and every
      // try would be wasted on a broken workshop rather than a bad change.
      this.deps.status('Checking my copy passes all tests before changing anything (about a minute)…')
      const baseline = await this.run('npx vitest run', this.copy, 600_000, signal)
      if (baseline.code !== 0) throw new Error(`my copy's tests fail before any change, so the workshop itself is broken — not starting:\n${failureSummary(baseline.out, 800)}`)
      const context = this.context(goal)
      let feedback = ''
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (signal?.aborted) throw new Error('stopped')
        this.deps.status(`Writing the change (attempt ${attempt} of ${MAX_ATTEMPTS})…`)
        const user = `GOAL: ${goal}\n\n${context}${feedback ? `\n\nYOUR LAST TRY FAILED:\n${feedback}\nFix it. Reply with the complete JSON again (all edits, starting from the original files). Remember: to change an existing file give its exact lines in "find", or its complete new content with "find": "".` : ''}`
        let plan: ChangePlan
        try {
          plan = parsePlan(await this.deps.ask([{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], signal))
          plan.edits = registerNewTools(plan.edits.filter(e => !e.file.includes('__tests__')), this.copy)   // tests come from their own step
          if (!plan.edits.length) throw new Error('the reply only had tests — give the code change itself')
          const problems = safetyProblems(plan)
          if (problems.length) throw new Error(`not allowed: ${problems.join('; ')}`)
          // Back to the starting point (a hard reset: an earlier try may have staged files).
          await this.git('reset -q --hard HEAD', signal); await this.git('clean -qfd', signal)
          applyEdits(this.copy, plan.edits)
        } catch (err) {
          feedback = err instanceof Error ? err.message : String(err)
          this.deps.log.warn(`Workshop attempt ${attempt}: ${feedback}`)
          continue
        }
        this.deps.status('Checking it: typecheck…')
        const tsc = await this.run('npx tsc -p tsconfig.main.json --noEmit', this.copy, 180_000, signal)
        if (tsc.code !== 0) { feedback = `TypeScript errors:\n${failureSummary(tsc.out)}`; this.deps.log.warn(`Workshop attempt ${attempt}: typecheck failed`); continue }

        // A test for exactly this change, written in its own small step. The code already
        // typechecks, so a failing test is retried on its own instead of redoing the code.
        await this.git('add -A', signal)
        const changeDiff = (await this.git('diff --cached', signal)).out.slice(0, 9000)
        let test: Edit | null = null
        let testFeedback = ''
        for (let t = 1; t <= TEST_TRIES && !test; t++) {
          this.deps.status(`Writing a test for the change${t > 1 ? ` (try ${t})` : ''}…`)
          let candidate: Edit
          try {
            candidate = parseTest(await this.deps.ask([{ role: 'system', content: TEST_SYSTEM }, { role: 'user', content: `The change: ${plan.summary}\n\nThe diff:\n${changeDiff}${testFeedback ? `\n\nYOUR LAST TEST FAILED:\n${testFeedback}\nWrite the whole test file again, fixed.` : ''}` }], signal))
            candidate = { ...candidate, file: freshTestName(this.copy, candidate.file) }
            applyEdits(this.copy, [candidate])
            exposeImported(this.copy, candidate)
          } catch (err) {
            testFeedback = err instanceof Error ? err.message : String(err)
            this.deps.log.warn(`Workshop attempt ${attempt}, test ${t}: ${testFeedback}`)
            continue
          }
          this.deps.status('Checking it: typecheck and all my tests (about a minute)…')
          const tsc2 = await this.run('npx tsc -p tsconfig.main.json --noEmit', this.copy, 180_000, signal)
          const tests = tsc2.code === 0 ? await this.run('npx vitest run', this.copy, 600_000, signal) : tsc2
          if (tests.code === 0) { test = candidate; break }
          testFeedback = `${tsc2.code !== 0 ? 'TypeScript errors' : 'Tests failed'}:\n${failureSummary(tests.out)}`
          this.deps.log.warn(`Workshop attempt ${attempt}, test ${t}: ${testFeedback.slice(0, 700)}`)
          fs.rmSync(path.join(this.copy, candidate.file), { force: true })
        }
        if (!test) { feedback = `The code typechecked, but no passing test could be written for it. Last problem:\n${testFeedback}`; continue }
        plan.edits.push(test)

        await this.git('add -A', signal)
        await this.git(`commit -q -m "${plan.summary.replace(/["`$\\]/g, "'").slice(0, 200)}"`, signal)
        const diff = (await this.git('diff HEAD~1 HEAD', signal)).out
        fs.writeFileSync(path.join(this.deps.workDir, 'change.patch'), diff)
        const proposal: Proposal = {
          id: new Date().toISOString().replace(/[:.]/g, '-'), goal, summary: plan.summary,
          files: [...new Set(plan.edits.map(e => e.file))], diff, attempts: attempt, createdAt: new Date().toISOString(),
        }
        fs.writeFileSync(this.proposalFile, JSON.stringify(proposal, null, 2))
        this.deps.log.info(`Workshop: change ready after ${attempt} attempt(s) — ${plan.summary}`)
        return proposal
      }
      throw new Error(`I tried ${MAX_ATTEMPTS} times and could not make a change that passes every test. Last problem: ${feedback.slice(0, 600)}`)
    } finally {
      this.busy = false
    }
  }

  /**
   * Put the approved change into the real project and rebuild. The patch is kept in
   * `historyDir` so the change can be undone (git apply -R).
   */
  async merge(historyDir: string, signal?: AbortSignal): Promise<string> {
    const p = this.pending()
    if (!p) throw new Error('there is no change waiting')
    const patch = path.join(this.deps.workDir, 'change.patch')
    const root = this.deps.projectRoot
    const check = await this.run(`git apply --check --whitespace=nowarn "${patch}"`, root, 60_000, signal)
    if (check.code !== 0) throw new Error(`the change no longer fits the code (it changed since): ${check.out.slice(0, 300)}`)
    fs.mkdirSync(historyDir, { recursive: true })
    const saved = path.join(historyDir, `${p.id}.patch`)
    fs.copyFileSync(patch, saved)
    const applied = await this.run(`git apply --whitespace=nowarn "${patch}"`, root, 60_000, signal)
    if (applied.code !== 0) throw new Error(`could not apply the change: ${applied.out.slice(0, 300)}`)
    const build = await this.run('npm run build', root, 600_000, signal)
    if (build.code !== 0) {
      await this.run(`git apply -R --whitespace=nowarn "${saved}"`, root, 60_000)
      throw new Error(`the change applied but the app did not build, so I undid it: ${failureSummary(build.out, 600)}`)
    }
    this.discard()
    return saved
  }
}

/** "improve yourself", "work on gap 2", "fix your browser.open looping". */
export const IMPROVE_REQUEST = /\b(improve|upgrade|evolve|reprogram|fix|update) (yourself|your ?self|your (own )?code)\b|\b(work on|fix|close|solve) (gap|problem|item|number) #?\d+\b|\bstart (the )?workshop\b/i
const FILLER = new Set(['please', 'like', 'want', 'work', 'okay', 'thanks', 'thank', 'just', 'some', 'more', 'make', 'better', 'able', 'start', 'yourself', 'your', 'code', 'goga', 'there', 'that', 'this', 'with', 'from', 'what', 'need', 'needs', 'should', 'would', 'could', 'really', 'everything', 'anything', 'something', 'stronger', 'smarter', 'faster', 'good', 'great', 'best', 'improve', 'upgrade', 'evolve', 'reprogram', 'update', 'fix', 'have', 'will', 'stuff', 'things'])

/** A request to change himself that names no actual change ("please work and update your code"). */
export function isVagueImproveRequest(text: string): boolean {
  const words = (text.toLowerCase().match(/[a-z][a-z0-9.-]{3,}/g) ?? []).filter(w => !FILLER.has(w))
  return words.length < 4
}

export const MERGE_REPLY = /^\s*(yes,? )?(merge|apply|accept|keep|install) (it|that|the change|this change|your change)\s*[.!]?\s*$/i
export const DISCARD_REPLY = /^\s*(discard|reject|drop|throw away|delete|cancel) (it|that|the change|this change|your change)\s*[.!]?\s*$/i
export const RESTART_REPLY = /^\s*restart( yourself| goga)?\s*[.!]?\s*$/i

/** Whether a message is one of the workshop's commands. */
export function isWorkshopCommand(text: string): boolean {
  return RESTART_REPLY.test(text) || MERGE_REPLY.test(text) || DISCARD_REPLY.test(text) || IMPROVE_REQUEST.test(text)
}

/** The gap number in "work on gap 2" (null when none is named). */
export function gapNumber(text: string): number | null {
  const m = /\b(?:gap|problem|item|number) #?(\d+)\b/i.exec(text)
  return m ? Number(m[1]) : null
}

/** The diff, shortened for chat. */
export function diffForChat(diff: string, max = 3000): string {
  const body = diff.split('\n').filter(l => !/^(index |diff --git )/.test(l)).join('\n')
  return body.length > max ? `${body.slice(0, max)}\n… (${body.length - max} more characters)` : body
}
