import path from 'path'

/**
 * Guardrails for code that writes Goga's own source.
 *
 * These are checked in the main process against the real file list of a change, before it
 * is applied to the running tree. A change that crosses one is refused outright — the list
 * is not a warning, and no prompt or tool argument can widen it.
 */

export interface Guard {
  /** Matched against a normalised, repo-relative path. */
  match: RegExp
  why: string
}

export const PROTECTED: Guard[] = [
  { match: /^src\/main\/services\/authorization\.ts$/, why: 'decides which actions need your approval' },
  { match: /^src\/main\/services\/security\//, why: 'the bug-bounty scope checks, the approved-request probe and the security store' },
  { match: /^src\/main\/handlers\/security\.ts$/, why: 'the bug-bounty page bridge and the request-approval grant' },
  { match: /^src\/main\/tools\/security\.ts$/, why: 'the one tool that can reach a bounty target' },
  { match: /^src\/main\/services\/osint\//, why: 'the OSINT throttle, robots rules, scope refusal, redaction and audit trail' },
  { match: /^src\/main\/tools\/osint\.ts$/, why: 'the OSINT tools and their approval level' },
  { match: /^src\/main\/handlers\/osint\.ts$/, why: 'the OSINT page bridge' },
  { match: /^src\/main\/services\/broker\/(credentials|risk|service)\.ts$/, why: 'broker keys, the live-trading switch, the kill switch and the order path' },
  { match: /^src\/main\/handlers\/broker\.ts$/, why: 'the broker page bridge' },
  { match: /^src\/main\/services\/trading\/desk\.ts$/, why: 'where the trading keys are stored and decrypted' },
  { match: /^src\/main\/services\/emergencyStop\.ts$/, why: 'the emergency stop' },
  { match: /^src\/main\/services\/evolution\/(guard|loop)\.ts$/, why: 'this loop and its guards' },
  { match: /^src\/main\/services\/selfImprove\.ts$/, why: 'the older workshop and its safety checks' },
  { match: /^src\/main\/services\/promptInjectionGuard\.ts$/, why: 'protection against instructions hidden in pages and files' },
  { match: /^src\/main\/(services|handlers)\/settings\.ts$/, why: 'settings and stored values' },
  { match: /^src\/main\/tools\/(registry|index)\.ts$/, why: 'how tools are registered and run' },
  { match: /^electron-builder/, why: 'the packaging configuration' },
  { match: /^package(-lock)?\.json$/, why: 'dependencies and scripts' },
  { match: /(^|\/)\.env($|\.)/, why: 'environment and credentials' },
]

/** Content checks that apply even to an allowed file. */
const CONTENT_BLOCKERS: { match: RegExp; why: string }[] = [
  { match: /api\.alpaca\.markets/, why: 'would add a live trading address' },
  { match: /require\(['"]electron['"]\)\.safeStorage|[^.\w]safeStorage\.(encrypt|decrypt)/, why: 'would touch key encryption from new code' },
  { match: /\bexec(Sync|File|FileSync)?\([^)]*(?:curl|powershell|Invoke-WebRequest)/, why: 'would add a network call through a shell' },
  { match: /\.git\/hooks/, why: 'would install a git hook' },
  { match: /process\.exit\(0\)\s*;?\s*app\.relaunch|app\.relaunch/, why: 'would reload Goga automatically' },
]

const norm = (p: string) => String(p ?? '').replace(/\\/g, '/').replace(/^\.?\//, '')

export function normalise(p: string): string { return norm(p) }

/** Every protected file a change touches. Empty means the paths are allowed. */
export function guardHits(files: string[]): { path: string; why: string }[] {
  return files
    .map(norm)
    .flatMap(f => PROTECTED.filter(g => g.match.test(f)).map(g => ({ path: f, why: g.why })))
}

/** True when a path lies inside the project and ends in .ts/.tsx. */
export function editablePath(file: string): boolean {
  const f = norm(file)
  return /^src\/.+\.(ts|tsx)$/.test(f) && !f.includes('..') && !f.includes('/node_modules/')
}

/** Content-level refusals for one edit. */
export function contentProblems(file: string, text: string): string[] {
  return CONTENT_BLOCKERS.filter(b => b.match.test(text)).map(b => `${file}: ${b.why}`)
}

/** A path inside root, or a refusal. */
export function inside(root: string, rel: string): string {
  const full = path.resolve(root, rel)
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error(`${rel} is outside the project`)
  return full
}
