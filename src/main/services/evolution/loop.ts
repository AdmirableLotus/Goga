import fs from 'fs'
import path from 'path'
import { execFileSync, spawn } from 'child_process'
import { app } from 'electron'
import type { EvolutionEvent, EvolutionRun, RunStage, Weakness } from '../../../shared/evolution'
import { contentProblems, editablePath, guardHits, inside, normalise } from './guard'
import { remember } from './learning'
import { LogService } from '../logs'

/**
 * The supervised self-improvement loop.
 *
 * It is the same shape as the older workshop, but with the guardrails made explicit and a
 * history the user can read:
 *
 *   review  — reads its own source read-only and names concrete weaknesses
 *   propose — says which specific change it will make, and why
 *   apply   — applies edits to a PRIVATE COPY (`git stash`-free, its own repo), never the
 *             running tree
 *   verify  — typecheck and the full test suite must pass on that copy
 *   await   — stops here. Nothing reaches the real code until the user approves.
 *   install — applies the patch to the real tree, rebuilds, retests; if either fails it
 *             restores the snapshot and reports that it did
 *
 * It never commits, pushes, deploys or reloads itself. Those four are absent from the code
 * on purpose: there is no function here that can do them.
 */

const PROJECT_FILES = ['package.json', 'tsconfig.json', 'tsconfig.main.json', 'vitest.config.ts', 'vitest.config.mts', 'vite.config.ts']
const MAX_ATTEMPTS = 2
const CONTEXT_CHARS = 12_000

export interface LoopDeps {
  projectRoot: string
  workRoot: string
  /** The local coding model, answering in JSON for a plan. */
  ask: (system: string, user: string, signal?: AbortSignal) => Promise<string>
  /** The same model, answering prose — used for the read-only review. */
  askText: (system: string, user: string, signal?: AbortSignal) => Promise<string>
  status: (text: string) => void
  publish: () => void
}

export interface Plan { summary: string; edits: { file: string; find: string; replace: string }[] }

/** Read the model's plan JSON. */
export function parsePlan(text: string): Plan {
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the reply had no JSON object')
  let raw: unknown
  try { raw = JSON.parse(text.slice(start, end + 1)) } catch { throw new Error('the reply was not valid JSON') }
  const o = raw as { summary?: unknown; edits?: unknown }
  if (typeof o.summary !== 'string' || !Array.isArray(o.edits) || !o.edits.length) throw new Error('the reply needs "summary" and a non-empty "edits" list')
  return {
    summary: o.summary.trim().slice(0, 600),
    edits: o.edits.map((e, i) => {
      const edit = e as { file?: unknown; find?: unknown; replace?: unknown }
      if (typeof edit.file !== 'string' || typeof edit.find !== 'string' || typeof edit.replace !== 'string') throw new Error(`edit ${i + 1} needs string "file", "find" and "replace"`)
      return { file: normalise(edit.file), find: edit.find, replace: edit.replace }
    }),
  }
}

/** Every reason a plan may not be tried. Empty means it may. */
export function planProblems(plan: Plan): string[] {
  const problems: string[] = []
  for (const e of plan.edits) {
    if (!editablePath(e.file)) problems.push(`${e.file}: only .ts/.tsx under src/ may be changed`)
    problems.push(...contentProblems(e.file, e.replace))
  }
  const hits = guardHits(plan.edits.map(e => e.file))
  for (const h of hits) problems.push(`${h.path} is protected: it ${h.why}`)
  return problems
}

/** Apply edits to a copy. A "find" must occur exactly once; an empty "find" writes a new file. */
export function applyEdits(root: string, edits: Plan['edits']): void {
  for (const e of edits) {
    const full = inside(root, e.file)
    if (!e.find) {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      if (fs.existsSync(full)) throw new Error(`${e.file} already exists — give exact "find" lines to change it`)
      fs.writeFileSync(full, e.replace)
      continue
    }
    if (!fs.existsSync(full)) throw new Error(`${e.file} does not exist`)
    const body = fs.readFileSync(full, 'utf8')
    const crlf = body.includes('\r\n')
    const text = crlf ? body.replace(/\r\n/g, '\n') : body
    const find = e.find.replace(/\r\n/g, '\n')
    const replace = e.replace.replace(/\r\n/g, '\n')
    const count = text.split(find).length - 1
    if (count !== 1) throw new Error(`in ${e.file}, the "find" text occurs ${count} times — it must occur exactly once`)
    const out = text.replace(find, () => replace)
    fs.writeFileSync(full, crlf ? out.replace(/\n/g, '\r\n') : out)
  }
}

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

function shortFailure(out: string, max = 1800): string {
  const lines = out.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
  const keep = lines.filter(l => /error TS\d+|FAIL|×|AssertionError|Error:|expected|received/.test(l))
  return (keep.length ? keep : lines.slice(-30)).join('\n').slice(0, max)
}

export const REVIEW_SYSTEM = `You are reviewing Goga's own source code, read-only, to name real weaknesses.
Reply in plain prose with three to six short findings. For each: one line with the file path, then one or two sentences on what is wrong and what a specific fix would be.
Rules: only about code you were shown; no invented files; no general advice about testing or documentation; no suggestions that change approvals, credentials or trading safety code.`

export const PLAN_SYSTEM = `You change Goga's own TypeScript source (an Electron app) to close one weakness the user picked.
Reply with ONLY a JSON object:
{"summary":"<one or two sentences: what changes and why>","edits":[{"file":"src/...ts","find":"<exact existing text, unique>","replace":"<new text>"}]}
Rules:
- "find" is copied EXACTLY from the file shown and appears once. Use "" as "find" to create a NEW file.
- Prefer a new file over rewriting an existing one. Keep the change small.
- TypeScript is strict; tool parameters arrive as unknown, so convert them.
- Never touch approvals, security scope, broker credentials or the trading safety path; those are refused.
- No tests here; the suite already exists and must stay green.`

export class EvolutionLoop {
  private running = false
  private stage: RunStage = 'review'
  private history: EvolutionRun[] = []
  private current: EvolutionRun | null = null
  private seq = 0
  private pendingPatch: string | null = null
  private pendingSnapshot: string | null = null

  constructor(private deps: LoopDeps) { this.loadHistory() }

  private get workDir() { return path.join(this.deps.workRoot, 'evolution') }
  private get copyDir() { return path.join(this.workDir, 'code') }

  private loadHistory(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.deps.workRoot, 'evolution-history.json'), 'utf8')) as EvolutionRun[]
      this.history = Array.isArray(raw) ? raw.slice(-40) : []
    } catch { this.history = [] }
  }

  private saveHistory(): void {
    fs.mkdirSync(this.deps.workRoot, { recursive: true })
    fs.writeFileSync(path.join(this.deps.workRoot, 'evolution-history.json'), JSON.stringify(this.history.slice(-40), null, 2), { mode: 0o600 })
  }

  state() {
    return { running: this.running, stage: this.stage, current: this.current, history: [...this.history].reverse() }
  }

  isRunning(): boolean { return this.running }
  pending(): EvolutionRun | null { return this.current?.stage === 'awaiting' ? this.current : null }

  private log(text: string): void {
    const event: EvolutionEvent = { id: ++this.seq, time: new Date().toISOString(), stage: this.stage, text }
    if (this.current) this.current.events = [...this.current.events.slice(-400), event]
    LogService.getInstance().info(`Evolution: ${text}`)
    this.deps.publish()
  }

  private setStage(stage: RunStage): void {
    this.stage = stage
    if (this.current) this.current.stage = stage
    this.deps.publish()
  }

  private git(args: string, cwd = this.copyDir): string {
    return execFileSync('git', ['-c', 'user.name=Goga', '-c', 'user.email=goga@localhost', '-c', 'core.autocrlf=false', ...args.split(' ')], { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true }).trim()
  }

  private snapshotRealTree(): string {
    // A stash object: a commit of the working tree that changes nothing else.
    const ref = execFileSync('git', ['-C', this.deps.projectRoot, 'stash', 'create'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim()
    if (ref) return ref
    return execFileSync('git', ['-C', this.deps.projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim()
  }

  private prepareCopy(signal?: AbortSignal): Promise<void> { return Promise.resolve().then(() => {
    if (signal?.aborted) throw new Error('stopped')
    fs.rmSync(this.workDir, { recursive: true, force: true })
    fs.mkdirSync(this.copyDir, { recursive: true })
    fs.cpSync(path.join(this.deps.projectRoot, 'src'), path.join(this.copyDir, 'src'), { recursive: true })
    for (const f of PROJECT_FILES) {
      const from = path.join(this.deps.projectRoot, f)
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(this.copyDir, f))
    }
    try { fs.symlinkSync(path.join(this.deps.projectRoot, 'node_modules'), path.join(this.copyDir, 'node_modules'), 'junction') } catch { /* tests may still run with the parent's modules */ }
    fs.writeFileSync(path.join(this.copyDir, '.gitignore'), 'node_modules\ndist\n')
    this.git('init -q'); this.git('add -A'); this.git('commit -q -m baseline')
  }) }

  /** The source map and the files most likely to matter, for the review step. */
  private context(goal: string): string {
    const root = path.join(this.deps.projectRoot, 'src')
    const files: string[] = []
    const walk = (dir: string, depth = 0) => {
      if (depth > 4 || files.length > 400) return
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { if (!/node_modules|__tests__/.test(entry.name)) walk(full, depth + 1) }
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full)
      }
    }
    try { walk(root) } catch { /* no source */ }
    const words = goal.toLowerCase().split(/\W+/).filter(w => w.length > 3)
    const scored = files.map(f => {
      const rel = path.relative(root, f).replace(/\\/g, '/')
      const name = rel.toLowerCase()
      return { rel, score: words.reduce((n, w) => n + (name.includes(w) ? 5 : 0), 0) }
    }).sort((a, b) => b.score - a.score)
    const map = scored.slice(0, 60).map(s => `src/${s.rel}`).join('\n')
    let text = ''
    for (const s of scored.slice(0, 4)) {
      const body = fs.readFileSync(path.join(root, s.rel), 'utf8').replace(/\r\n/g, '\n')
      if (text.length + body.length > CONTEXT_CHARS) break
      text += `\n=== src/${s.rel} ===\n${body}\n`
    }
    return `Source files:\n${map}\n${text}`
  }

  /** Full run: review, propose, apply to a copy, verify, then stop for approval. */
  async run(goal: string, signal?: AbortSignal): Promise<EvolutionRun> {
    if (this.running) throw new Error('a self-improvement run is already in progress')
    const clean = String(goal ?? '').trim()
    if (clean.length < 12) throw new Error('say what should get better, specifically — "improve your planning failures" rather than "be smarter"')
    this.running = true
    const run: EvolutionRun = {
      id: new Date().toISOString().replace(/[:.]/g, '-'), goal: clean, startedAt: new Date().toISOString(), finishedAt: null,
      stage: 'review', weaknesses: [], summary: '', files: [], diff: '', snapshotRef: null, guardHits: [],
      buildPassed: null, testsPassed: null, installNote: null, error: null, events: [],
    }
    this.current = run
    this.deps.publish()
    try {
      this.setStage('review')
      this.deps.status('Reviewing my own source, read-only…')
      await this.prepareCopy(signal)
      const ctx = this.context(clean)
      let review = ''
      try {
        review = await this.deps.askText(REVIEW_SYSTEM, `GOAL: ${clean}\n\n${ctx}`, signal)
      } catch (err) {
        this.log(`the review step could not run (${err instanceof Error ? err.message : String(err)}); going straight to the change`)
      }
      run.weaknesses = parseWeaknesses(review)
      if (review) this.log(`review found ${run.weaknesses.length} weakness(es)`)
      remember('code', `Self-review for "${clean}": ${review.slice(0, 600)}`, run.id)

      this.setStage('propose')
      let feedback = ''
      let plan: Plan | null = null
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !plan; attempt++) {
        if (signal?.aborted) throw new Error('stopped')
        this.deps.status(`Writing the change (attempt ${attempt} of ${MAX_ATTEMPTS})…`)
        try {
          const reply = await this.deps.ask(PLAN_SYSTEM, `WEAKNESS TO FIX: ${clean}\n${review ? `\nFindings from the review:\n${review.slice(0, 2500)}\n` : ''}\n${ctx}${feedback ? `\nYOUR LAST TRY FAILED: ${feedback}\nReply with the complete JSON again.` : ''}`, signal)
          const candidate = parsePlan(reply)
          const problems = planProblems(candidate)
          if (problems.length) { feedback = problems.join('; '); run.guardHits = guardHits(candidate.edits.map(e => e.file)); this.log(`refused a change: ${feedback}`); continue }
          this.git('reset -q --hard HEAD'); this.git('clean -qfd')
          applyEdits(this.copyDir, candidate.edits)
          plan = candidate
        } catch (err) {
          feedback = err instanceof Error ? err.message : String(err)
          this.log(`attempt ${attempt} rejected: ${feedback}`)
        }
      }
      if (!plan) { this.setStage('failed'); throw new Error(`could not produce a change that passes the guardrails: ${feedback}`) }
      run.summary = plan.summary
      run.files = [...new Set(plan.edits.map(e => e.file))]
      this.log(`proposed: ${plan.summary} (${run.files.join(', ')})`)

      this.setStage('verify')
      this.deps.status('Typechecking the change on a private copy…')
      const tsc = await runCommand('npx tsc -p tsconfig.main.json --noEmit', this.copyDir, 240_000, signal)
      if (tsc.code !== 0) { this.setStage('failed'); throw new Error(`the change did not typecheck: ${shortFailure(tsc.out)}`) }
      this.deps.status('Running the full test suite on the private copy (a few minutes)…')
      const tests = await runCommand('npx vitest run', this.copyDir, 900_000, signal)
      run.testsPassed = tests.code === 0
      if (tests.code !== 0) { this.setStage('failed'); throw new Error(`the change broke tests: ${shortFailure(tests.out)}`) }

      this.git('add -A')
      this.git('commit -q -m change')
      run.diff = this.git('diff HEAD~1 HEAD')
      run.buildPassed = true
      fs.mkdirSync(this.workDir, { recursive: true })
      fs.writeFileSync(path.join(this.workDir, 'pending.patch'), run.diff)
      this.pendingPatch = path.join(this.workDir, 'pending.patch')
      this.pendingSnapshot = this.snapshotRealTree()
      run.snapshotRef = this.pendingSnapshot
      this.setStage('awaiting')
      this.log('the change passes the typecheck and every test, and is waiting for your approval. Nothing in the running code has changed.')
      remember('worked', `A change for "${clean}" passed the typecheck and the test suite: ${plan.summary}`, run.id)
      return run
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      run.error = message
      run.finishedAt = new Date().toISOString()
      if (this.stage !== 'failed') this.setStage('failed')
      remember('failed', `A self-improvement run for "${clean}" failed: ${message.slice(0, 400)}`, run.id)
      this.log(`run failed: ${message}`)
      throw err
    } finally {
      run.finishedAt = run.finishedAt ?? new Date().toISOString()
      this.history = [...this.history.slice(-39), run]
      this.saveHistory()
      this.running = false
      this.deps.publish()
    }
  }

  /** Apply the awaiting patch to the real tree, rebuild, retest; roll back if either fails. */
  async install(signal?: AbortSignal): Promise<EvolutionRun> {
    const run = this.current
    if (!run || run.stage !== 'awaiting' || !this.pendingPatch) throw new Error('there is no proved change waiting for approval')
    if (this.running) throw new Error('a run is already in progress')
    this.running = true
    this.setStage('install')
    const root = this.deps.projectRoot
    const patch = this.pendingPatch
    const snapshot = this.pendingSnapshot ?? this.snapshotRealTree()
    const backups = path.join(this.deps.workRoot, 'installed')
    fs.mkdirSync(backups, { recursive: true })
    const savedPatch = path.join(backups, `${run.id}.patch`)
    fs.copyFileSync(patch, savedPatch)
    try {
      this.deps.status('Applying the approved change and rebuilding…')
      const check = await runCommand(`git apply --check --whitespace=nowarn "${patch}"`, root, 60_000, signal)
      if (check.code !== 0) throw new Error(`the change no longer fits the code: ${check.out.slice(0, 300)}`)
      const applied = await runCommand(`git apply --whitespace=nowarn "${patch}"`, root, 60_000, signal)
      if (applied.code !== 0) throw new Error(`could not apply the change: ${applied.out.slice(0, 300)}`)
      const build = await runCommand('npm run build', root, 900_000, signal)
      run.buildPassed = build.code === 0
      if (build.code !== 0) throw new Error(`the change applied but the app did not build: ${shortFailure(build.out, 700)}`)
      this.deps.status('Running the tests against the real tree…')
      const tests = await runCommand('npx vitest run', root, 900_000, signal)
      run.testsPassed = tests.code === 0
      if (tests.code !== 0) throw new Error(`the change built but broke tests: ${shortFailure(tests.out, 700)}`)
      this.setStage('done')
      run.installNote = `Installed and rebuilt. Restart Goga yourself when you want to run it — the loop does not reload the app. Undo with: git apply -R "${savedPatch}"`
      run.finishedAt = new Date().toISOString()
      this.log(run.installNote)
      remember('worked', `Installed: ${run.summary}`, run.id)
      this.pendingPatch = null
      this.pendingSnapshot = null
      fs.rmSync(this.workDir, { recursive: true, force: true })
      return { ...run }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.status('Rolling back to the snapshot taken before the change…')
      // Put the tree back exactly as it was.
      const restore = await runCommand(`git checkout -- . && git clean -fd -- src`, root, 120_000, signal)
      let restored = restore.code === 0
      if (!restored) {
        try { this.git(`stash apply ${snapshot}`, root); restored = true } catch { restored = false }
      }
      this.setStage('rolled-back')
      run.error = `${message}\nRollback: ${restored ? 'the working tree was restored from the snapshot taken before the change' : `the automatic rollback failed — restore it yourself with: git stash apply ${snapshot}`}`
      run.finishedAt = new Date().toISOString()
      this.log(`install failed and rolled back: ${run.error}`)
      remember('failed', `Installing "${run.summary}" failed: ${message.slice(0, 300)}`, run.id)
      throw new Error(run.error)
    } finally {
      this.running = false
      this.history = [...this.history.filter(h => h.id !== run.id), { ...run }]
      this.saveHistory()
      this.deps.publish()
    }
  }

  /** Throw the awaiting change away. Nothing was ever in the running tree. */
  discard(): void {
    if (!this.current || this.current.stage !== 'awaiting') throw new Error('there is no change waiting')
    this.current.stage = 'refused'
    this.current.finishedAt = new Date().toISOString()
    this.current.installNote = 'discarded by the user; the running code was never touched'
    this.pendingPatch = null
    this.pendingSnapshot = null
    try { fs.rmSync(this.workDir, { recursive: true, force: true }) } catch { /* already gone */ }
    this.history = [...this.history.filter(h => h.id !== this.current!.id), { ...this.current }]
    this.saveHistory()
    this.deps.publish()
  }
}

/** Turn the prose review into short findings by looking for a file path per paragraph. */
export function parseWeaknesses(review: string): Weakness[] {
  const blocks = String(review ?? '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  const out: Weakness[] = []
  for (const block of blocks.slice(0, 8)) {
    const file = block.match(/(?:src\/)?[\w./-]+\.(?:ts|tsx)/)?.[0] ?? ''
    const cite = file ? (file.startsWith('src/') ? file : `src/${file.replace(/^\.?\//, '')}`) : ''
    const firstLine = block.split('\n')[0].replace(/^[-*\d.\s]+/, '').slice(0, 160)
    out.push({ title: firstLine || 'finding', area: cite.split('/').slice(0, 3).join('/') || 'unknown', problem: block.slice(0, 900), files: cite ? [cite] : [] })
  }
  return out
}

/** A stable place for the loop's files. */
export function evolutionRoot(): string {
  return path.join(app.getPath('userData'), 'evolution')
}
