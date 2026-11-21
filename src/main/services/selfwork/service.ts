import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import { spawn } from 'child_process'
import { SingleUseGate } from '../approval/singleUse'
import { LogService } from '../logs'
import { contentRefusals, normalisePath, pathRefusals, protectedFamily, withinRepo } from './safety'
import { unifiedDiff } from './diff'
import type {
  RepoFile, RepoHit, RepoRead, SelfWorkAuditEntry, SelfWorkCheck, SelfWorkCheckReport,
  SelfWorkOperation, SelfWorkProposal, SelfWorkProposalView, SelfWorkRepairStatus, SelfWorkState,
} from '../../../shared/selfwork'

/**
 * Goga working on its own source code.
 *
 * The shape is: look freely, propose one exact change, have it approved, apply it once,
 * then run the project's own checks and report what they said. There is no method here
 * that commits, pushes, deploys, publishes, restarts or reloads, and none that writes
 * outside `src/` — those are absent from the code rather than blocked at runtime, except
 * where the floor in `safety.ts` has to catch a path the caller made up.
 *
 * Two things worth being explicit about, because they are the difference between this and
 * a wish:
 *
 *   - The approval is bound to the file, the operation, and the whole before and after body.
 *     Change any of them after the user approved and the gate refuses with `changed`.
 *   - The checks are not a warning. `apply` reports what the checks said, and a failed
 *     check is reported as broken — it never becomes "done".
 */

const MAX_READ_LINES = 400
const CHECK_TIMEOUT_MS = 900_000
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'shots', 'release', 'out'])

/**
 * How many corrections Goga may apply in one repair round before it stops and reports what is
 * still broken. Two: enough to recover from a check that fails for a reason the first fix missed,
 * few enough that a wrong idea cannot thrash the source indefinitely.
 */
const MAX_REPAIR_ATTEMPTS = 2

/** One command run in the repo. The seam lets the checks be driven by a stub in a test. */
export type CommandRunner = (cwd: string, cmd: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ code: number; out: string; ms: number }>

export interface SelfWorkDeps {
  /** Absolutely the repo Goga is running from; defaults to the app's own path. */
  repoRoot?: string
  /** The user's own data folder, which is never writable. */
  userDataDir?: string
  homeDir?: string
  now?: () => number
  log?: { info: (m: string) => void; warn: (m: string) => void }
  /** How a check command is run. Defaults to the real spawn; a test passes a stub. */
  runCommand?: CommandRunner
}

interface GateItem extends SelfWorkProposal {
  /** What the user approved, in the gate's terms. Kept out of the shared type. */
  _fingerprintSeed?: string
}

export function fingerprintOf(item: GateItem): string {
  // The file, the operation and both bodies. Not the summary (wording is not the change)
  // and not the diff (derived) — those can be re-rendered without altering what runs.
  return [item.path, item.operation, item.before, item.after].join('\u0000')
}

export class SelfWorkService {
  private static instance: SelfWorkService | null = null
  private gate = new SingleUseGate<GateItem>(fingerprintOf, () => this.now(), 15 * 60_000)
  private appliedProposals: SelfWorkProposal[] = []
  private auditTrail: SelfWorkAuditEntry[] = []
  private lastCheckReport: SelfWorkCheckReport | null = null
  /** The repair round: opened by a failing check, closed by a passing one or an explicit reset. */
  private repair = { active: false, attempts: 0 }
  private seq = 0
  private deps: Required<Omit<SelfWorkDeps, 'repoRoot' | 'log'>> & { repoRoot: string; log: { info: (m: string) => void; warn: (m: string) => void } }

  constructor(deps: SelfWorkDeps = {}) {
    const now = deps.now ?? (() => Date.now())
    this.deps = {
      repoRoot: path.resolve(deps.repoRoot ?? defaultRepoRoot()),
      userDataDir: path.resolve(deps.userDataDir ?? safeUserData()),
      homeDir: path.resolve(deps.homeDir ?? os.homedir()),
      now,
      log: deps.log ?? {
        info: (m: string) => LogService.getInstance().info(m),
        warn: (m: string) => LogService.getInstance().warn(m),
      },
      runCommand: deps.runCommand ?? runIn,
    }
  }

  static getInstance(): SelfWorkService {
    return SelfWorkService.instance ??= new SelfWorkService()
  }

  /** For tests and for a diagnostic instance pointed at another tree. */
  static reset(instance: SelfWorkService | null): void { SelfWorkService.instance = instance }

  private now(): number { return this.deps.now() }

  get repoRoot(): string { return this.deps.repoRoot }

  private record(kind: SelfWorkAuditEntry['kind'], filePath: string, summary: string, detail = ''): void {
    const entry: SelfWorkAuditEntry = {
      id: `sw${++this.seq}`, at: new Date(this.now()).toISOString(), kind, path: filePath, summary, detail,
    }
    this.auditTrail = [...this.auditTrail.slice(-400), entry]
    this.deps.log.info(`Self-work ${kind}: ${filePath}${summary ? ` — ${summary}` : ''}`)
  }

  // ── Reading (no approval) ───────────────────────────────────────────────────

  /** Every source file in the repo, so the user (and Goga) can see what is here. */
  listFiles(limit = 400): RepoFile[] {
    const root = this.deps.repoRoot
    const out: RepoFile[] = []
    const walk = (dir: string, depth = 0) => {
      if (depth > 8 || out.length >= limit) return
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (out.length >= limit) return
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1)
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          const rel = path.relative(root, full).split(path.sep).join('/')
          let bytes = 0, lineCount = 0
          try {
            const body = fs.readFileSync(full, 'utf8')
            bytes = Buffer.byteLength(body)
            lineCount = body.split('\n').length
          } catch { /* unreadable: still list it, with zeros */ }
          out.push({ path: rel, bytes, lines: lineCount })
        }
      }
    }
    walk(root)
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** One file's body, as numbered lines. Reading is never gated. */
  read(rel: string, start = 1, count = 160): RepoRead {
    const full = this.resolveForRead(rel)
    const body = fs.readFileSync(full, 'utf8')
    const all = body.split('\n')
    const from = Math.max(1, Math.floor(start) || 1)
    const to = Math.min(all.length, from + Math.min(Math.max(1, Math.floor(count) || 160), MAX_READ_LINES) - 1)
    const relPath = path.relative(this.deps.repoRoot, full).split(path.sep).join('/')
    this.record('read', relPath, `read lines ${from}–${to} of ${all.length}`)
    return {
      path: relPath, from, to, total: all.length,
      text: all.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n'),
    }
  }

  /** Whole body of one file, un-numbered — what a proposal is built from. */
  readBody(rel: string): string {
    return fs.readFileSync(this.resolveForRead(rel), 'utf8')
  }

  /** Plain-text search across the repo's source. */
  search(query: string, max = 40): RepoHit[] {
    const q = String(query ?? '').trim().toLowerCase()
    if (q.length < 2) throw new Error('Give at least two characters to search for.')
    const hits: RepoHit[] = []
    for (const file of this.listFiles(2000)) {
      if (hits.length >= max) break
      let body: string
      try { body = fs.readFileSync(path.join(this.deps.repoRoot, file.path), 'utf8') } catch { continue }
      const lines = body.split('\n')
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (lines[i].toLowerCase().includes(q)) hits.push({ path: file.path, line: i + 1, text: lines[i].trim().slice(0, 200) })
      }
    }
    this.record('search', '*', `searched for "${q}"`, `${hits.length} hit(s)`)
    return hits
  }

  private resolveForRead(rel: string): string {
    const clean = normalisePath(rel).replace(/^src\//, '')
    const full = path.resolve(this.deps.repoRoot, 'src', clean)
    if (!withinRepo(this.deps.repoRoot, full)) throw new Error(`${rel} is outside Goga's source folder.`)
    if (!/\.(ts|tsx)$/.test(full)) throw new Error('Goga only reads its own .ts and .tsx source files.')
    if (!fs.existsSync(full)) throw new Error(`There is no file at ${rel}.`)
    return full
  }

  // ── Proposing (no approval yet) ─────────────────────────────────────────────

  /**
   * Offer one exact change for approval.
   *
   * A proposal that crosses the safety floor is refused here, before it ever reaches the
   * gate, so there is no id for anyone to approve.
   */
  propose(input: { path: string; operation?: SelfWorkOperation; summary: string; after?: string; before?: string }): SelfWorkProposalView {
    const rel = normalisePath(input.path)
    const operation: SelfWorkOperation = input.operation ?? 'write'
    const full = path.resolve(this.deps.repoRoot, rel)

    const refusals = pathRefusals({
      rel, resolved: full, repoRoot: this.deps.repoRoot,
      userDataDir: this.deps.userDataDir, homeDir: this.deps.homeDir,
    })
    if (refusals.length) {
      const message = refusals.map(r => r.message).join(' ')
      this.record('refuse', rel, 'refused before it reached approval', message)
      throw new Error(message)
    }

    const exists = fs.existsSync(full)
    const before = input.before ?? (exists && operation !== 'write' ? fs.readFileSync(full, 'utf8') : (exists ? fs.readFileSync(full, 'utf8') : ''))
    if (operation !== 'delete' && typeof input.after !== 'string') {
      throw new Error('A proposed change needs the full new file body in "after".')
    }
    const after = operation === 'delete' ? '' : String(input.after)

    if (operation === 'write' && !exists) {
      // A genuinely new file: nothing to compare against, and nothing to protect.
    } else if (!exists) {
      throw new Error(`There is no file at ${rel}, so there is nothing to ${operation}.`)
    }

    const content = contentRefusals(rel, after)
    if (content.length) {
      const message = content.map(c => c.message).join(' ')
      this.record('refuse', rel, 'refused on its content', message)
      throw new Error(message)
    }

    if (before === after) {
      throw new Error(`That change would leave ${rel} exactly as it is, so there is nothing to approve.`)
    }

    const diff = unifiedDiff(before, after, rel)
    const createdAt = new Date(this.now()).toISOString()
    const item: GateItem = {
      id: `prop-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      path: rel, operation, summary: String(input.summary ?? '').slice(0, 500),
      before, after, diff, createdAt,
      expiresAt: new Date(this.now() + 15 * 60_000).toISOString(),
      state: 'proposed',
    }
    this.gate.offer(item)
    this.record('propose', rel, item.summary, `${operation}, ${diff.split('\n').length} diff lines`)
    return viewOf(item, false)
  }

  /** A patch: find one exact block and replace it. Refused unless "find" occurs once. */
  proposePatch(input: { path: string; summary: string; find: string; replace: string }): SelfWorkProposalView {
    const rel = normalisePath(input.path)
    const full = path.resolve(this.deps.repoRoot, rel)
    const exists = fs.existsSync(full)
    if (!exists) throw new Error(`There is no file at ${rel}. Use a write proposal to create one.`)
    const before = fs.readFileSync(full, 'utf8')
    const normal = before.replace(/\r\n/g, '\n')
    const find = String(input.find ?? '').replace(/\r\n/g, '\n')
    const replace = String(input.replace ?? '').replace(/\r\n/g, '\n')
    if (!find) throw new Error('A patch needs the exact existing text to replace.')
    const count = normal.split(find).length - 1
    if (count === 0) throw new Error(`That text is not in ${rel}. Read the file and copy the exact lines.`)
    if (count > 1) throw new Error(`That text appears ${count} times in ${rel}, so I would not know which one you meant. Give more surrounding lines.`)
    const after = before.includes('\r\n') ? normal.replace(find, () => replace).replace(/\n/g, '\r\n') : normal.replace(find, () => replace)
    return this.propose({ path: rel, operation: 'patch', summary: input.summary, before, after })
  }

  /** A delete, which goes through the same approval as a write. */
  proposeDelete(input: { path: string; summary: string }): SelfWorkProposalView {
    const rel = normalisePath(input.path)
    const full = path.resolve(this.deps.repoRoot, rel)
    if (!fs.existsSync(full)) throw new Error(`There is no file at ${rel}.`)
    return this.propose({ path: rel, operation: 'delete', summary: input.summary, before: fs.readFileSync(full, 'utf8'), after: '' })
  }

  // ── Approving and applying ──────────────────────────────────────────────────

  /** The user's decision about one exact proposal. */
  decide(id: string, approved: boolean): { ok: boolean; message: string; proposal: SelfWorkProposalView | null } {
    const result = this.gate.decide(id, approved, {
      unknown: 'That is not a change Goga proposed. Propose it again and I will show you the diff.',
      spent: 'That change has already been applied. It works once — propose a new one if you want another.',
      expired: 'That proposal expired before it was used. Nothing changed. Propose it again.',
      approved: 'Approved: this exact change to this exact file, once.',
      denied: 'Discarded. Your source code was not touched.',
    })
    const peeked = this.gate.peek(id)
    if (!result.ok) return { ok: false, message: result.message, proposal: peeked ? viewOf(peeked.item, peeked.approved) : null }
    if (!approved) {
      if (peeked) this.markState(peeked.item.id, 'refused')
      this.record('discard', peeked?.item.path ?? id, 'discarded by the user', '')
      return { ok: true, message: result.message, proposal: peeked ? viewOf(peeked.item, false) : null }
    }
    if (peeked) this.markState(peeked.item.id, 'approved')
    this.record('approve', peeked?.item.path ?? id, 'approved by the user', '')
    return { ok: true, message: result.message, proposal: peeked ? viewOf(peeked.item, true) : null }
  }

  /**
   * Apply an approved change, once.
   *
   * The gate is claimed before anything is written, so a second call cannot write twice
   * even if the first one threw. The floor is re-checked inside the claim hook, because the
   * approval is 15 minutes old and the file on disk may not be what it was.
   */
  apply(id: string): { ok: boolean; message: string; proposal: SelfWorkProposalView | null } {
    // The repair-round floor, checked before the gate is touched so a refused attempt neither
    // spends the approval nor writes. Two corrections to a failing check, then Goga stops and says
    // what is still broken rather than editing its own source a third, fourth, nth time.
    if (this.repair.active && this.repair.attempts >= MAX_REPAIR_ATTEMPTS) {
      const broke = this.lastCheckReport?.checks.find(c => !c.ok)
      const message =
        `Stopping: ${MAX_REPAIR_ATTEMPTS} repair attempts have already been applied for this round and the checks still fail`
        + `${broke ? ` (\`${broke.name}\` exits ${broke.exitCode})` : ''}. `
        + 'Nothing was written. Nothing more will be applied until the checks pass or you start a new repair round.'
      this.record('refuse', 'repair-limit', `hit the ${MAX_REPAIR_ATTEMPTS}-attempt repair limit`, broke ? `${broke.name}: exit ${broke.exitCode}` : '')
      return { ok: false, message, proposal: null }
    }

    const claim = this.gate.claim(id, {
      afterExpiry: item => {
        const refusals = pathRefusals({
          rel: item.path, resolved: path.resolve(this.deps.repoRoot, item.path),
          repoRoot: this.deps.repoRoot, userDataDir: this.deps.userDataDir, homeDir: this.deps.homeDir,
        })
        if (refusals.length) return { reason: 'refused', message: refusals.map(r => r.message).join(' ') }
        // The file must still be what the diff was computed against.
        const full = path.resolve(this.deps.repoRoot, item.path)
        const current = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : ''
        if (current !== item.before) {
          return {
            reason: 'stale',
            message: `${item.path} changed on disk after Goga proposed this, so the diff you approved no longer matches it. Nothing was written. Propose it again.`,
          }
        }
        return null
      },
    }, {
      unknown: 'That is not a change Goga proposed. Propose it again.',
      spent: 'That change has already been applied. It works once.',
      notApproved: 'That change has not been approved, so your source code was not touched. Approve it first.',
      expired: 'That proposal expired before it was applied. Nothing changed.',
      changed: 'That proposal changed after you approved it, so nothing was written. Propose it again.',
    })

    if (!claim.ok || !claim.item) return { ok: false, message: claim.message, proposal: null }

    const item = claim.item
    const full = path.resolve(this.deps.repoRoot, item.path)
    try {
      if (item.operation === 'delete') {
        fs.rmSync(full, { force: true })
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, item.after, 'utf8')
      }
    } catch (err) {
      const message = `The write failed: ${err instanceof Error ? err.message : String(err)}. Your source code is unchanged.`
      this.record('refuse', item.path, 'the write failed', message)
      return { ok: false, message, proposal: null }
    }

    item.state = 'applied'
    this.appliedProposals = [item, ...this.appliedProposals].slice(0, 40)
    // If a repair round is open, this applied change is one of its (at most two) attempts.
    if (this.repair.active) {
      this.repair.attempts++
      this.record('repair', item.path, `repair attempt ${this.repair.attempts} of ${MAX_REPAIR_ATTEMPTS}`, 'run the checks to see whether it holds')
    }
    this.record('apply', item.path, item.summary, `${item.operation} applied; ${item.diff.split('\n').length} diff lines`)
    const attemptNote = this.repair.active
      ? ` This is repair attempt ${this.repair.attempts} of ${MAX_REPAIR_ATTEMPTS}${this.repair.attempts >= MAX_REPAIR_ATTEMPTS ? ' — the last one before Goga stops and reports what is still broken' : ''}.`
      : ''
    return {
      ok: true,
      message: `Applied to ${item.path}. It takes effect the next time Goga is reloaded — run the checks to see whether it is sound first.${attemptNote}`,
      proposal: viewOf(item, true),
    }
  }

  /** Put an applied change back. Read-only checks are not needed to undo a change. */
  revert(id: string): { ok: boolean; message: string } {
    const item = this.appliedProposals.find(p => p.id === id)
    if (!item) throw new Error('That is not one of the changes Goga applied.')
    const full = path.resolve(this.deps.repoRoot, item.path)
    const refusals = pathRefusals({
      rel: item.path, resolved: full, repoRoot: this.deps.repoRoot,
      userDataDir: this.deps.userDataDir, homeDir: this.deps.homeDir,
    })
    if (refusals.length) throw new Error(refusals.map(r => r.message).join(' '))
    if (item.operation === 'delete') {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, item.before, 'utf8')
    } else if (item.before === '') {
      fs.rmSync(full, { force: true })
    } else {
      fs.writeFileSync(full, item.before, 'utf8')
    }
    item.state = 'refused'
    this.appliedProposals = this.appliedProposals.filter(p => p.id !== id)
    this.record('revert', item.path, `put back the version from before "${item.summary}"`, '')
    return { ok: true, message: `${item.path} is back to how it was before that change.` }
  }

  // ── Checks ──────────────────────────────────────────────────────────────────

  /**
   * Run the project's own checks and report what they said.
   *
   * Three checks, in the order that fails fastest: the build, the typecheck, then the full
   * suite. A failure stops the run and is reported by name, so "it is broken" is never
   * printed as "it is done".
   */
  async runChecks(signal?: AbortSignal, only?: ('build' | 'typecheck' | 'tests')[]): Promise<SelfWorkCheckReport> {
    const wanted = only ?? ['build', 'typecheck', 'tests']
    const checks: SelfWorkCheck[] = []
    for (const name of wanted) {
      if (signal?.aborted) break
      const cmd = name === 'build' ? 'npm run build'
        : name === 'typecheck' ? 'npx tsc --noEmit'
          : 'npx vitest run'
      const result = await this.deps.runCommand(this.repoRoot, cmd, CHECK_TIMEOUT_MS, signal)
      const check: SelfWorkCheck = {
        name: cmd, ok: result.code === 0, exitCode: result.code,
        output: tail(result.out, 4000), ms: result.ms, at: new Date(this.now()).toISOString(),
      }
      checks.push(check)
      if (!check.ok) break
    }
    const failed = checks.find(c => !c.ok)
    const report: SelfWorkCheckReport = {
      ok: checks.length > 0 && !failed,
      checks,
      summary: failed
        ? `Broken: \`${failed.name}\` failed with exit code ${failed.exitCode}. Your source code is changed but it does not ${failed.name === 'npm run build' ? 'build' : failed.name === 'npx vitest run' ? 'pass its tests' : 'typecheck'} — this is not a finished change. The last lines it printed:\n\n${firstUsefulLines(failed.output)}`
        : checks.length === 0
          ? 'No check ran.'
          : `All ${checks.length} check${checks.length === 1 ? '' : 's'} passed: ${checks.map(c => `\`${c.name}\``).join(', ')}.`,
    }
    this.lastCheckReport = report
    this.record('check', '*', report.ok ? 'checks passed' : 'checks failed',
      checks.map(c => `${c.name}: ${c.ok ? 'exit 0' : `exit ${c.exitCode}`}`).join('; '))
    // A failing check opens (or keeps open) the repair round; a passing one closes it and clears
    // the attempt count, so a fresh break later gets its own two attempts. A run of no checks
    // (e.g. aborted) changes nothing.
    if (checks.length > 0) {
      if (report.ok) {
        if (this.repair.active || this.repair.attempts > 0) this.record('repair', '*', 'checks pass — repair round closed', '')
        this.repair = { active: false, attempts: 0 }
      } else if (!this.repair.active) {
        this.repair.active = true
        this.record('repair', '*', 'checks fail — repair round opened', `two attempts allowed, then stop`)
      }
    }
    return report
  }

  /**
   * Begin a fresh repair round after Goga stopped at the two-attempt limit.
   *
   * This is the user's deliberate "try again". It clears the attempt count but changes no source
   * and runs no check — the next apply starts the count at zero again.
   */
  resetRepairs(): { ok: boolean; message: string; repair: SelfWorkRepairStatus } {
    const had = this.repair.attempts
    this.repair = { active: false, attempts: 0 }
    this.record('repair', '*', 'repair round reset by the user', had ? `cleared ${had} attempt(s)` : '')
    return {
      ok: true,
      message: had
        ? `Repair round reset — the ${had}-attempt count is cleared. The next change you approve starts a fresh round.`
        : 'There was no repair round in progress; nothing to reset.',
      repair: this.repairStatus(),
    }
  }

  /** The current repair round, for the page, the tools and the report. */
  repairStatus(): SelfWorkRepairStatus {
    return {
      active: this.repair.active,
      attempts: this.repair.attempts,
      maxAttempts: MAX_REPAIR_ATTEMPTS,
      blocked: this.repair.active && this.repair.attempts >= MAX_REPAIR_ATTEMPTS,
    }
  }

  // ── State for the page ──────────────────────────────────────────────────────

  state(): SelfWorkState {
    return {
      repoRoot: this.deps.repoRoot,
      proposals: this.gate.list()
        .filter(p => !p.spent && !p.expired)
        .map(p => viewOf(p.item, p.approved)),
      applied: this.appliedProposals.map(p => viewOf(p, true)),
      audit: [...this.auditTrail].reverse().slice(0, 200),
      lastCheck: this.lastCheckReport,
      repair: this.repairStatus(),
    }
  }

  /** The plain-language reason a path is off limits, or null when it is fine. */
  protectedReason(rel: string): string | null { return protectedFamily(normalisePath(rel)) }

  private markState(id: string, state: SelfWorkProposal['state']): void {
    const peeked = this.gate.peek(id)
    if (peeked) peeked.item.state = state
  }
}

function viewOf(item: SelfWorkProposal, approved: boolean): SelfWorkProposalView {
  return {
    id: item.id, path: item.path, operation: item.operation, summary: item.summary,
    diff: item.diff, createdAt: item.createdAt, expiresAt: item.expiresAt,
    state: item.state, approved,
  }
}

function safeUserData(): string {
  try { return app.getPath('userData') } catch { return path.join(os.homedir(), '.goga-nodata') }
}

/** The repo Goga is running from — `app.getAppPath()` in the packaged app, and the project
 *  folder in development. Goga is meant to work on the code it is actually running. */
export function defaultRepoRoot(): string {
  try { return app.getAppPath() } catch { return process.cwd() }
}

function tail(text: string, max: number): string {
  const clean = String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  return clean.length > max ? clean.slice(-max) : clean
}

/** The lines of a failure that are worth printing: errors, not progress. */
function firstUsefulLines(output: string, max = 1400): string {
  const lines = output.split(/\r?\n/)
  const keep = lines.filter(l => /error TS\d+|FAIL|×|AssertionError|Error:|expected|received|Cannot find|not found/i.test(l))
  const chosen = keep.length ? keep : lines.slice(-20)
  return chosen.join('\n').slice(0, max)
}

interface RunOutcome { code: number; out: string; ms: number }

/** Run one command in the repo, with a hard timeout and no shell-side surprises. */
export function runIn(cwd: string, cmd: string, timeoutMs: number, signal?: AbortSignal): Promise<RunOutcome> {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(cmd, {
      cwd, shell: true, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, CI: '1', FORCE_COLOR: '0' },
    })
    let out = ''
    const add = (b: Buffer) => { out = (out + b.toString()).slice(-400_000) }
    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    const kill = () => { try { child.kill() } catch { /* gone */ } }
    const timer = setTimeout(() => { out += '\n[timed out]'; kill() }, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, out, ms: Date.now() - started }) })
    child.on('error', err => { clearTimeout(timer); resolve({ code: 1, out: out + String(err), ms: Date.now() - started }) })
  })
}
