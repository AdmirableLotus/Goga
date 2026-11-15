import path from 'path'

/**
 * The floor under Goga working on its own source.
 *
 * Everything in this file is a refusal, not a prompt. A proposal that crosses one is not
 * offered for approval at all, because these are the rules that make approval mean
 * something: a change to the thing that checks changes is not a change Goga may make,
 * approved or not.
 *
 * The guard list is deliberately *separate* from `evolution/guard.ts` rather than an import
 * of it. That is not duplication for its own sake: it means dropping this file's entry from
 * the protected list cannot be done by editing one regex in one place and having both
 * mechanisms open at once. `selfwork-safety.test.ts` asserts that this file's list covers
 * everything the evolution guard protects, so the two cannot drift apart silently.
 */

export interface Refusal {
  reason: string
  /** Plain words the user reads: what was refused and why it is not negotiable. */
  message: string
}

/** A tool-agnostic normaliser: forward slashes, no leading "./". */
export function normalisePath(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()
}

/**
 * Files and folders Goga may never write, whatever the user approves.
 *
 * Each one guards a decision that would stop being a decision if the code making it could
 * be rewritten by the thing it decides about.
 */
const NEVER_WRITABLE: { match: RegExp; why: string }[] = [
  // The gate itself and the capability that uses it.
  { match: /^src\/main\/services\/selfwork\//, why: 'the code-work gate, its safety floor and its service' },
  { match: /^src\/main\/handlers\/selfwork\.ts$/, why: 'the code-work page bridge' },
  { match: /^src\/main\/tools\/selfwork\.ts$/, why: 'the code-work tools' },
  { match: /^src\/shared\/selfwork\.ts$/, why: 'the code-work types and the proposal shape the gate binds to' },
  { match: /^src\/main\/services\/approval\//, why: 'the single-use approval gate every approval in Goga goes through' },
  // Approvals and authorisation.
  { match: /^src\/main\/services\/authorization\.ts$/, why: 'decides which actions need your approval' },
  // The evolution loop and its guards (the sibling self-editing path).
  { match: /^src\/main\/services\/evolution\/(guard|loop)\.ts$/, why: 'the evolution loop and its guardrails' },
  { match: /^src\/main\/services\/selfImprove\.ts$/, why: 'the older workshop and its safety checks' },
  // Security: scope, the approved-request probe, the audit.
  { match: /^src\/main\/services\/security\//, why: 'the bug-bounty scope checks, the approved-request probe, the audit and the emergency stop' },
  { match: /^src\/main\/handlers\/security\.ts$/, why: 'the bug-bounty page bridge and the request-approval grant' },
  { match: /^src\/main\/tools\/security\.ts$/, why: 'the one tool that can reach a bounty target' },
  { match: /^src\/main\/services\/securityScope/, why: 'the scope checker' },
  { match: /^src\/main\/services\/securityWorkspace/, why: 'the security workspace store' },
  { match: /^src\/main\/services\/hackerOne/, why: 'the bug-bounty program integration' },
  { match: /^src\/main\/services\/emergencyStop\.ts$/, why: 'the emergency stop' },
  // OSINT limits.
  { match: /^src\/main\/services\/osint\//, why: 'the OSINT throttle, robots rules, scope refusal, redaction and audit trail' },
  { match: /^src\/main\/tools\/osint\.ts$/, why: 'the OSINT tools and their approval level' },
  { match: /^src\/main\/handlers\/osint\.ts$/, why: 'the OSINT page bridge' },
  // Money: broker credentials, the risk guard, the order path, the venues.
  { match: /^src\/main\/services\/broker\//, why: 'broker keys, the live-trading switch, the kill switch and the order path' },
  { match: /^src\/main\/handlers\/broker\.ts$/, why: 'the broker page bridge' },
  { match: /^src\/main\/services\/trading\/desk\.ts$/, why: 'where the trading keys are stored and decrypted' },
  { match: /^src\/main\/services\/venues\/(guard|state|journal)\.ts$/, why: 'the shared approval gate, halt switch and audit for both trading venues' },
  { match: /^src\/main\/handlers\/browser\.ts$/, why: 'the browser and venue page bridge' },
  // Prompt-injection protection.
  { match: /^src\/main\/services\/promptInjectionGuard\.ts$/, why: 'protection against instructions hidden in pages and files' },
  // Settings and stored values, tool registration, and the shell bands.
  { match: /^src\/main\/(services|handlers)\/settings\.ts$/, why: 'settings and stored values' },
  { match: /^src\/main\/tools\/(registry|index)\.ts$/, why: 'how tools are registered and run' },
  { match: /^src\/main\/index\.ts$/, why: 'the app entry point, window creation and the preload wiring' },
  { match: /^src\/preload\//, why: 'the typed bridge between the renderer and main' },
  { match: /^src\/main\/handlers\/index\.ts$/, why: 'which page bridges are registered' },
  // Packaging, dependencies, secrets, version control.
  { match: /^electron-builder/, why: 'the packaging configuration' },
  { match: /^package(-lock)?\.json$/, why: 'dependencies and scripts' },
  { match: /^tsconfig.*\.json$/, why: 'the compiler configuration the checks depend on' },
  { match: /^vitest\.config\./, why: 'the test configuration the checks depend on' },
  { match: /^vite\.config\./, why: 'the bundler configuration the checks depend on' },
  { match: /(^|\/)\.env($|\.)/, why: 'environment and credentials' },
  { match: /(^|\/)\.git\//, why: 'version control internals' },
  { match: /(^|\/)\.github\//, why: 'continuous integration and deployment' },
  { match: /(^|\/)(id_rsa|id_ed25519|\.npmrc|\.netrc|credentials|secrets)/, why: 'credentials' },
]

/** Content checks that apply even to a file Goga may edit. */
const CONTENT_BLOCKERS: { match: RegExp; why: string }[] = [
  { match: /api\.alpaca\.markets/, why: 'would add a live trading address' },
  { match: /[^.\w]safeStorage\.(encrypt|decrypt)/, why: 'would touch key encryption from new code' },
  { match: /\bexec(Sync|File|FileSync)?\([^)]*(?:curl|powershell|Invoke-WebRequest)/i, why: 'would add a network call through a shell' },
  { match: /\.git\/hooks/, why: 'would install a git hook' },
  { match: /app\.relaunch\s*\(/, why: 'would reload Goga automatically' },
  // The four things the capability must never be able to do, refused at the content level
  // as well as by there being no tool for them.
  { match: /\bgit\s+(push|commit|tag)\b/, why: 'Goga does not commit, push or tag its own code' },
  { match: /\b(gh|heroku|vercel|netlify)\s+deploy\b|\bnpm\s+publish\b/, why: 'Goga does not deploy or publish' },
  // Reaching outside the repository from inside it.
  { match: /app\.getPath\(\s*['"]userData['"]\s*\)\s*\)?\s*;?\s*[\s\S]{0,80}fs\.(write|rm|unlink|rename)/, why: 'would write into your own data folder from source code' },
]

/**
 * Absolute roots Goga may never write into, whatever a path resolves to.
 *
 * Checked against the *resolved* path, so a symlink, a `..` chain or a drive-absolute path
 * cannot walk out of the repository and into the user's data.
 */
export function forbiddenRoots(userDataDir: string, homeDir: string): string[] {
  const out = [userDataDir]
  for (const name of ['AppData', '.ssh', '.aws', '.config', 'Documents', 'Desktop', 'Downloads']) {
    out.push(path.join(homeDir, name))
  }
  return out.map(p => path.resolve(p))
}

/** True when `resolved` is the repo root itself or inside it. */
export function withinRepo(repoRoot: string, resolved: string): boolean {
  const root = path.resolve(repoRoot)
  const full = path.resolve(resolved)
  return full === root || full.startsWith(root + path.sep)
}

/**
 * Every reason a path may not be written. Empty means the path is allowed.
 *
 * `resolved` is the real absolute path the write would land on; `rel` is the path as the
 * caller gave it. Both are checked, because either can be the lie.
 */
export function pathRefusals(input: {
  rel: string
  resolved: string
  repoRoot: string
  userDataDir: string
  homeDir: string
}): Refusal[] {
  const rel = normalisePath(input.rel)
  const out: Refusal[] = []

  // 1. Inside the repository, after resolving everything.
  if (!withinRepo(input.repoRoot, input.resolved)) {
    out.push({
      reason: 'outside-repo',
      message: `${rel || input.resolved} is outside Goga's own repository. It only changes its own source code.`,
    })
    return out // nothing else matters once it is out of the tree
  }

  // 2. Not into the user's own data, even if that path somehow sits under the repo.
  for (const root of forbiddenRoots(input.userDataDir, input.homeDir)) {
    const r = path.resolve(root)
    const full = path.resolve(input.resolved)
    if (full === r || full.startsWith(r + path.sep)) {
      out.push({ reason: 'user-data', message: `${rel} is inside your own data (${r}). Goga never writes there.` })
    }
  }

  // 3. Not a relative path that climbs out.
  if (rel.split('/').includes('..')) {
    out.push({ reason: 'traversal', message: `${rel} climbs out of the folder it names, so it is refused.` })
  }

  // 4. Only source and test files, and only ones that exist or are plainly new.
  if (!/\.(ts|tsx)$/.test(rel)) {
    out.push({ reason: 'not-source', message: `Goga only changes .ts and .tsx source files, not ${rel}.` })
  }
  if (!/^src\//.test(rel)) {
    out.push({ reason: 'not-in-src', message: `${rel} is not under src/. Goga only changes its own source code.` })
  }
  if (/(^|\/)node_modules\//.test(rel) || /^dist\//.test(rel) || rel.includes('/dist/')) {
    out.push({ reason: 'generated', message: `${rel} is generated output, not source.` })
  }

  // 5. The refusals that no approval can lift.
  for (const rule of NEVER_WRITABLE) {
    if (rule.match.test(rel)) {
      out.push({
        reason: 'protected',
        message: `${rel} is off limits: it is ${rule.why}. A change to the thing that guards changes is not one Goga makes on its own, approved or not.`,
      })
    }
  }

  return out
}

/** Content-level refusals for one proposed file body. */
export function contentRefusals(rel: string, body: string): Refusal[] {
  return CONTENT_BLOCKERS
    .filter(b => b.match.test(body))
    .map(b => ({ reason: 'content', message: `${normalisePath(rel)}: ${b.why}.` }))
}

/**
 * A one-line purpose for each protected family, so a refusal can say what the file does
 * rather than only that it is refused. Used by the UI and by the agent's reply.
 */
export function protectedFamily(rel: string): string | null {
  const hit = NEVER_WRITABLE.find(r => r.match.test(normalisePath(rel)))
  return hit ? hit.why : null
}

/** The rule list itself, for the test that keeps it in step with the evolution guard. */
export function protectedPatterns(): RegExp[] {
  return NEVER_WRITABLE.map(r => r.match)
}
