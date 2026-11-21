/**
 * A scope-gated executor for a SMALL allow-list of security tools.
 *
 * The whole safety of this module is in what it refuses to be:
 *   - Only tools on ALLOWED_TOOLS can run. Anything else is declined, not improvised.
 *   - Goga builds the ENTIRE argv itself from one validated target. The caller supplies only a
 *     target that has already passed the scope gate (eligible asset, not local/private/metadata).
 *     No free-form flags, no shell string — args go to execFile as an array, so a crafted target
 *     cannot inject a flag (every entry ends its args with `--`) or a shell metacharacter.
 *   - Each tool is bounded: a hard timeout, a rate limit where the tool supports one, a single
 *     target, and a capped amount of captured output.
 *   - Installing is a separate, explicit step. If a tool is missing and install is not permitted,
 *     the run stops and says so rather than reaching for the network quietly.
 *
 * It does NOT decide authorization. The caller must have already confirmed an active program, that
 * the target is in scope, and that the host is not forbidden — exactly as security.xssAttempt does.
 */

export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean }
export interface ExecLike { (bin: string, args: string[], opts: { timeoutMs: number }): Promise<ExecResult> }
export interface WhichLike { (bin: string): Promise<string | null> }

export interface AllowedTool {
  id: string
  bin: string
  summary: string
  /** Build the full argv from an already-scope-checked target. Throws if the target is unusable. */
  buildArgs(target: string): string[]
  /** How to install if missing, or null when Goga cannot install it safely. */
  install: { bin: string; args: string[] } | null
  timeoutMs: number
  maxOutput: number
}

/** Reject anything that is not a plain http(s) URL — the only shape these tools are given. */
function requireHttpUrl(target: string): string {
  const u = new URL(target) // throws on garbage
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http/https targets are allowed (got ${u.protocol})`)
  return u.toString()
}

const UA = 'GogaBugBounty/1.0 (authorized testing; single approved target)'

export const ALLOWED_TOOLS: AllowedTool[] = [
  {
    id: 'curl',
    bin: 'curl',
    summary: 'Fetch one in-scope URL and show status, headers and body — one request, no redirects followed.',
    buildArgs: (t) => ['-sS', '-i', '--no-keepalive', '--max-time', '20', '-A', UA, '--', requireHttpUrl(t)],
    install: { bin: 'winget', args: ['install', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--id', 'cURL.cURL'] },
    timeoutMs: 25_000,
    maxOutput: 20_000,
  },
  {
    id: 'nuclei',
    bin: 'nuclei',
    summary: 'Run ProjectDiscovery nuclei against ONE in-scope URL, rate-limited, with the standard non-destructive templates.',
    buildArgs: (t) => [
      '-u', requireHttpUrl(t),
      '-rate-limit', '20',      // cap requests/sec — bounded, not a flood
      '-concurrency', '10',
      '-timeout', '10',
      '-no-interactsh',         // no external OOB interaction server
      '-disable-update-check',
      '-silent',
      '-severity', 'low,medium,high,critical',
    ],
    install: { bin: 'go', args: ['install', '-v', 'github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest'] },
    timeoutMs: 180_000,
    maxOutput: 40_000,
  },
]

export function allowedTool(id: string): AllowedTool | null {
  const key = String(id ?? '').trim().toLowerCase()
  return ALLOWED_TOOLS.find(t => t.id === key || t.bin === key) ?? null
}

export interface RunToolOutcome {
  ran: boolean
  installed: boolean
  output: string
  log: string[]
  error?: string
}

export async function runSecurityTool(opts: {
  tool: AllowedTool
  target: string
  exec: ExecLike
  which: WhichLike
  allowInstall: boolean
}): Promise<RunToolOutcome> {
  const { tool, target, exec, which, allowInstall } = opts
  const log: string[] = []

  // Validate the target shape up front (also catches a bad URL before any process starts).
  let argv: string[]
  try { argv = tool.buildArgs(target) } catch (err) {
    return { ran: false, installed: false, output: '', log, error: err instanceof Error ? err.message : String(err) }
  }

  // Is it installed?
  let installed = true
  const found = await which(tool.bin)
  if (!found) {
    installed = false
    if (!allowInstall) {
      log.push(`${tool.bin} is not installed. Install was not approved, so nothing was run.`)
      return { ran: false, installed: false, output: '', log, error: `${tool.bin} is not installed` }
    }
    if (!tool.install) {
      log.push(`${tool.bin} is not installed and Goga has no safe way to install it automatically. Install it yourself, then re-run.`)
      return { ran: false, installed: false, output: '', log, error: `${tool.bin} cannot be auto-installed` }
    }
    log.push(`${tool.bin} is not installed — installing with: ${tool.install.bin} ${tool.install.args.join(' ')}`)
    const ins = await exec(tool.install.bin, tool.install.args, { timeoutMs: 300_000 })
    const reHit = await which(tool.bin)
    if (!reHit) {
      log.push(`Install did not make ${tool.bin} available (installer exit ${ins.code}). ${ins.stderr.slice(0, 400)}`)
      return { ran: false, installed: false, output: '', log, error: `${tool.bin} still not available after install` }
    }
    installed = true
    log.push(`${tool.bin} installed.`)
  }

  // Run it, bounded.
  log.push(`Running: ${tool.bin} ${argv.join(' ')}`)
  const res = await exec(tool.bin, argv, { timeoutMs: tool.timeoutMs })
  if (res.timedOut) log.push(`${tool.bin} hit its ${Math.round(tool.timeoutMs / 1000)}s time limit and was stopped.`)
  const combined = [res.stdout, res.stderr ? `\n[stderr]\n${res.stderr}` : ''].join('')
  const output = combined.length > tool.maxOutput ? `${combined.slice(0, tool.maxOutput)}\n… [output truncated at ${tool.maxOutput} chars]` : combined
  log.push(`${tool.bin} exited with code ${res.code}.`)
  return { ran: true, installed, output, log }
}
