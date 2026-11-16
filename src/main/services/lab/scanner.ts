import net from 'net'
import type {
  LabFinding, ScanResult, ScanStepId, ScanStepResult, RunBudget,
} from '../../../shared/lab'
import { checkTarget, getTarget, parsePorts } from './targets'
import { Budget, RunLog, runTool } from './runner'
import { finishRun, refuseRun, startRun, updateRun } from './runs'
import { audit } from '../security/store'
import { psQuote, runPowerShell } from '../setup/powershell'

/**
 * The scanner pipeline: subfinder, httpx, nuclei, katana, ffuf, nmap — plus a port check
 * that needs no external binary at all.
 *
 * The order of every entry point is the same and it does not vary:
 *
 *   1. Resolve the declaration. A host with no live declaration is refused here and the
 *      refusal is written to the audit trail. No process is spawned, no socket is opened.
 *   2. Re-check the host the command will actually use — for a scanner, that is the declared
 *      host, never a name found by an earlier step unless that name is itself declared.
 *   3. Only then run.
 *
 * Step 2 matters more than it looks: subfinder finds names, and a found subdomain is not in
 * the declaration just because its parent is. Each discovered name is checked against the
 * declarations before it is passed to the next step, so the pipeline can never walk off the
 * declared target by following its own output.
 */

export const SCAN_TOOLS: { id: ScanStepId; name: string; binary: string; what: string }[] = [
  { id: 'subfinder', name: 'Subfinder', binary: 'subfinder', what: 'passive subdomain enumeration from public sources' },
  { id: 'portscan', name: 'Port check (built in)', binary: '', what: 'a TCP connect check on the declared ports — no external tool needed' },
  { id: 'httpx', name: 'httpx', binary: 'httpx', what: 'probe which hosts answer HTTP and what they return' },
  { id: 'katana', name: 'Katana', binary: 'katana', what: 'crawl a site and list the endpoints it reaches' },
  { id: 'nuclei', name: 'Nuclei', binary: 'nuclei', what: 'template checks for known issues' },
  { id: 'ffuf', name: 'ffuf', binary: 'ffuf', what: 'content discovery against a wordlist' },
  { id: 'nmap', name: 'Nmap', binary: 'nmap', what: 'port and service detection' },
]

/** Which of the external tools are on PATH. Read-only, and cached briefly. */
export interface ToolAvailability { id: ScanStepId; name: string; installed: boolean; path: string | null }

let availabilityCache: { at: number; value: ToolAvailability[] } | null = null

export async function toolAvailability(force = false): Promise<ToolAvailability[]> {
  if (!force && availabilityCache && Date.now() - availabilityCache.at < 30_000) return availabilityCache.value
  const out: ToolAvailability[] = []
  for (const tool of SCAN_TOOLS) {
    if (!tool.binary) { out.push({ id: tool.id, name: tool.name, installed: true, path: 'built in' }); continue }
    const result = await runPowerShell(`$c = Get-Command ${psQuote(tool.binary)} -ErrorAction SilentlyContinue; if ($c) { $c.Source } else { '' }`, { timeoutMs: 15_000 })
    const found = result.stdout.trim().split(/\r?\n/).filter(Boolean)[0] ?? null
    out.push({ id: tool.id, name: tool.name, installed: !!found, path: found })
  }
  availabilityCache = { at: Date.now(), value: out }
  return out
}

// ── The built-in port check ─────────────────────────────────────────────────

/**
 * One TCP connect attempt. A connect that succeeds is a listening port; a refusal is a closed
 * one; a timeout is filtered or dropped. No data is sent — it opens and closes.
 */
function probePort(host: string, port: number, timeoutMs = 1200): Promise<'open' | 'closed' | 'filtered'> {
  return new Promise(resolve => {
    const socket = new net.Socket()
    let settled = false
    const done = (state: 'open' | 'closed' | 'filtered') => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(state)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done('open'))
    socket.once('timeout', () => done('filtered'))
    socket.once('error', (err: NodeJS.ErrnoException) => {
      done(err.code === 'ECONNREFUSED' ? 'closed' : 'filtered')
    })
    try { socket.connect(port, host) } catch { done('filtered') }
  })
}

export interface PortScanOptions {
  targetId: string
  /** Override the declaration's ports for this run. Still checked against the declaration. */
  ports?: string
  budget?: Partial<RunBudget>
}

/**
 * The built-in port check.
 *
 * This is the one scan that works with nothing installed, and it is what proves the whole
 * chain — declaration, budget, kill switch, audit — against a real socket.
 */
export async function portScan(options: PortScanOptions, signal?: AbortSignal): Promise<ScanResult> {
  const declared = getTarget(options.targetId)
  if (!declared) {
    const run = refuseRun('portscan', options.targetId, 'no such declaration')
    return { run, steps: [] }
  }
  const check = checkTarget(declared.host)
  if (!check.declared) {
    const run = refuseRun('portscan', declared.host, check.reason)
    return { run, steps: [] }
  }

  const portsText = options.ports ?? declared.ports
  const parsed = parsePorts(portsText)
  if (!parsed.ok) {
    const run = refuseRun('portscan', declared.host, `ports: ${parsed.reason}`)
    return { run, steps: [] }
  }
  const ports = parsed.ports ?? defaultPorts()
  if (ports.length > 4096) {
    const run = refuseRun('portscan', declared.host, `${ports.length} ports is more than the built-in check will do in one run; narrow the range`)
    return { run, steps: [] }
  }

  const run = startRun({ tool: 'portscan', targetId: declared.id, targetHost: declared.host, budget: options.budget })
  const budget = new Budget(run.budget)
  const log = new RunLog(lines => updateRun(run.id, { log: lines }))
  const onAbort = () => { budget.stop() }
  signal?.addEventListener('abort', onAbort)

  log.add('info', `built-in TCP connect check on ${declared.host}, ${ports.length} port(s), budget ${budget.maxRequests} requests at ${budget.maxPerMinute}/min`)
  const findings: LabFinding[] = []
  const lines: string[] = []
  let stopReason: string | null = null

  try {
    for (const port of ports) {
      if (signal?.aborted) { stopReason = 'stopped by the user'; break }
      const refusal = await budget.spend()
      if (refusal === 'stopped') { stopReason = 'stopped by the user'; break }
      if (refusal === 'cap') { stopReason = `request cap reached (${budget.maxRequests})`; break }
      const state = await probePort(declared.host, port)
      lines.push(`${declared.host}:${port} ${state}`)
      updateRun(run.id, { requests: budget.requests })
      if (state === 'open') {
        findings.push({
          id: `port-${port}`,
          kind: 'port',
          title: `TCP port ${port} accepts connections`,
          detail: `${declared.host}:${port} accepted a TCP connection. That tells you something is listening; it does not tell you what, and it is not a vulnerability by itself.`,
          confidence: 'observation',
          evidence: `TCP connect to ${declared.host}:${port} succeeded`,
        })
        log.add('result', `${port} open`)
      }
    }
  } catch (err) {
    stopReason = err instanceof Error ? err.message : String(err)
    log.add('error', stopReason)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  const raw = lines.join('\n')
  const step: ScanStepResult = {
    step: 'portscan', ran: true, skippedReason: null, command: `TCP connect to ${declared.host}`,
    exitCode: 0, output: raw, findings, requests: budget.requests,
  }
  const finished = finishRun(run.id, stopReason ? 'stopped' : 'done', stopReason, {
    requests: budget.requests, rawOutput: raw, findings, log: log.all(),
  })
  return { run: finished ?? run, steps: [step] }
}

/** The ports checked when a declaration names none: the common service ports, not all 65535. */
function defaultPorts(): number[] {
  return [
    21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 443, 445, 993, 995,
    1433, 1521, 2049, 3000, 3306, 3389, 5432, 5900, 6379, 8000, 8080, 8443, 8888, 9000, 9200, 11211, 27017,
  ]
}

// ── The external pipeline ───────────────────────────────────────────────────

export interface PipelineOptions {
  targetId: string
  /** Which steps to run, in what order. Defaults to the sensible chain for a web target. */
  steps?: ScanStepId[]
  /** The URL the crawl and template steps start from. Must be on the declared host. */
  url?: string
  /** A wordlist file for ffuf. Required for that step; never generated silently. */
  wordlist?: string
  budget?: Partial<RunBudget>
}

/**
 * Run the external pipeline.
 *
 * Each step is checked against the declaration with the host it will actually use, so a name
 * subfinder finds is only passed on if that name is itself declared. Steps whose binary is
 * missing are reported as skipped with the Setup area named, rather than failing the run.
 */
export async function runPipeline(options: PipelineOptions, signal?: AbortSignal): Promise<ScanResult> {
  const declared = getTarget(options.targetId)
  if (!declared) {
    const run = refuseRun('pipeline', options.targetId, 'no such declaration')
    return { run, steps: [] }
  }
  const check = checkTarget(declared.host)
  if (!check.declared) {
    const run = refuseRun('pipeline', declared.host, check.reason)
    return { run, steps: [] }
  }

  const order: ScanStepId[] = options.steps?.length ? options.steps : ['portscan', 'httpx', 'katana', 'nuclei']
  // Every step is a network step here, so the URL is required and must be on the target.
  const baseUrl = options.url ? String(options.url).trim() : `http://${declared.host}`
  const urlCheck = checkTarget(baseUrl)
  if (!urlCheck.declared) {
    const run = refuseRun('pipeline', baseUrl, urlCheck.reason)
    return { run, steps: [] }
  }

  const available = await toolAvailability(true)
  const has = (id: ScanStepId) => available.find(a => a.id === id)?.installed === true

  const run = startRun({ tool: 'pipeline', targetId: declared.id, targetHost: declared.host, budget: options.budget })
  const budget = new Budget(run.budget)
  const log = new RunLog(lines => updateRun(run.id, { log: lines }))
  const onAbort = () => budget.stop()
  signal?.addEventListener('abort', onAbort)

  log.add('info', `pipeline on ${declared.host}: ${order.join(' → ')} (budget ${budget.maxRequests} at ${budget.maxPerMinute}/min)`)
  const results: ScanStepResult[] = []
  const allFindings: LabFinding[] = []
  let raw = ''
  let stopReason: string | null = null

  try {
    for (const step of order) {
      if (signal?.aborted) { stopReason = 'stopped by the user'; break }
      if (budget.isStopped) { stopReason = 'stopped by the user'; break }
      if (budget.remaining <= 0) { stopReason = `request cap reached (${budget.maxRequests})`; break }

      if (step === 'portscan') {
        log.add('step', 'built-in port check')
        const sub = await portScan({ targetId: declared.id, budget: { maxRequests: Math.min(budget.remaining, 64), maxPerMinute: budget.maxPerMinute } }, signal)
        const subStep = sub.steps[0]
        if (subStep) { results.push(subStep); allFindings.push(...subStep.findings); raw += `${subStep.output}\n` }
        continue
      }

      const meta = SCAN_TOOLS.find(t => t.id === step)
      if (!meta) continue
      if (!has(step)) {
        results.push({
          step, ran: false,
          skippedReason: `${meta.name} is not installed. Install it from the Setup area first.`,
          command: null, exitCode: null, output: '', findings: [], requests: 0,
        })
        log.add('warn', `${meta.name} skipped: not installed`)
        continue
      }

      // The host each command will actually contact, checked again before it runs.
      const targetCheck = checkTarget(baseUrl)
      if (!targetCheck.declared) {
        results.push({ step, ran: false, skippedReason: targetCheck.reason, command: null, exitCode: null, output: '', findings: [], requests: 0 })
        log.add('warn', `${meta.name} skipped: ${targetCheck.reason}`)
        continue
      }

      const args = argsFor(step, declared.host, baseUrl, options.wordlist, budget)
      if (!args) {
        results.push({ step, ran: false, skippedReason: 'this step needs a wordlist file; give one', command: null, exitCode: null, output: '', findings: [], requests: 0 })
        log.add('warn', `${meta.name} skipped: no wordlist`)
        continue
      }

      const command = `${meta.binary} ${args.map(a => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ')}`
      log.add('step', command)
      const spent = await budget.spend()
      if (spent) { stopReason = spent === 'cap' ? `request cap reached (${budget.maxRequests})` : 'stopped by the user'; break }

      const result = await runTool(meta.binary, { tool: step, args, timeoutMs: 4 * 60_000, signal, onData: () => {} })
      const findings = parseStepOutput(step, result.stdout, declared.host)
      allFindings.push(...findings)
      raw += `$ ${command}\n${result.stdout}\n${result.stderr ? `${result.stderr}\n` : ''}`
      results.push({
        step, ran: true, skippedReason: null, command, exitCode: result.exitCode,
        output: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 60_000),
        findings, requests: 1,
      })
      updateRun(run.id, { requests: budget.requests, rawOutput: raw, findings: allFindings })
      log.add('result', `${meta.name}: ${result.exitCode === 0 ? `${findings.length} item(s)` : result.message}${result.killed ? ' (stopped)' : ''}`)
      if (result.killed) { stopReason = 'stopped by the user'; break }
    }
  } catch (err) {
    stopReason = err instanceof Error ? err.message : String(err)
    log.add('error', stopReason)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  const finished = finishRun(run.id, stopReason && stopReason.includes('stopped') ? 'stopped' : stopReason ? 'failed' : 'done', stopReason, {
    requests: budget.requests, rawOutput: raw, findings: allFindings, log: log.all(),
  })
  if (!stopReason) audit('note', `pipeline on ${declared.host}: ${results.filter(r => r.ran).length} step(s) ran, ${allFindings.length} item(s) recorded`)
  return { run: finished ?? run, steps: results }
}

/**
 * The arguments for one step.
 *
 * Deliberately conservative: no all-ports sweep, no `-A`, no aggressive template sets, no
 * recursion. The point is a scan the user chose, at a rate they set, on a host they declared —
 * not the loudest possible invocation of each tool.
 */
function argsFor(step: ScanStepId, host: string, url: string, wordlist: string | undefined, budget: Budget): string[] | null {
  const rate = Math.max(1, Math.min(budget.maxPerMinute, 150))
  switch (step) {
    case 'subfinder': return ['-d', host, '-silent']
    case 'httpx': return ['-u', url, '-silent', '-status-code', '-title', '-no-color', '-rate-limit', String(rate)]
    case 'katana': return ['-u', url, '-silent', '-no-color', '-d', '2', '-rl', String(rate)]
    case 'nuclei': return ['-u', url, '-silent', '-no-color', '-rate-limit', String(rate), '-severity', 'critical,high,medium', '-stats=false']
    case 'ffuf': return wordlist ? ['-u', `${url.replace(/\/$/, '')}/FUZZ`, '-w', wordlist, '-s', '-rate', String(rate), '-mc', '200,204,301,302,307,401,403'] : null
    case 'nmap': return ['-sT', '-Pn', '--top-ports', '100', '--host-timeout', '5m', host]
    default: return null
  }
}

/** Turn one step's stdout into findings. Plain parsing; nothing is inferred beyond the text. */
export function parseStepOutput(step: ScanStepId, stdout: string, host: string): LabFinding[] {
  const findings: LabFinding[] = []
  const lines = String(stdout ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  let n = 0
  for (const line of lines) {
    if (n >= 200) break
    if (step === 'subfinder') {
      findings.push({
        id: `sub-${n++}`, kind: 'endpoint', title: `subdomain: ${line}`,
        detail: `${line} was listed by a public source. It is only a target if it is inside your declaration.`,
        confidence: 'observation', evidence: line,
      })
    } else if (step === 'httpx') {
      findings.push({
        id: `httpx-${n++}`, kind: 'endpoint', title: `HTTP service: ${line.slice(0, 160)}`,
        detail: 'httpx got an HTTP response from this URL.', confidence: 'observation', evidence: line,
      })
    } else if (step === 'katana') {
      if (!/^https?:\/\//i.test(line)) continue
      findings.push({
        id: `url-${n++}`, kind: 'endpoint', title: `endpoint: ${line.slice(0, 160)}`,
        detail: 'Found by crawling. An endpoint is a place to look, not a vulnerability.', confidence: 'lead', evidence: line,
      })
    } else if (step === 'nuclei') {
      const m = /\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]/.exec(line)
      findings.push({
        id: `tmpl-${n++}`, kind: 'template', title: m ? `${m[3]} — ${m[2]}` : line.slice(0, 160),
        detail: m ? `Template ${m[1]} matched at ${m[3]}. A template match is a lead: read the template and confirm it by hand before calling it a finding.` : 'A nuclei template matched.',
        confidence: 'lead', evidence: line,
      })
    } else if (step === 'ffuf') {
      findings.push({
        id: `path-${n++}`, kind: 'endpoint', title: `path: ${line.slice(0, 160)}`,
        detail: 'ffuf found a path that returned a status other than 404.', confidence: 'lead', evidence: line,
      })
    } else if (step === 'nmap') {
      const open = /^(\d+)\/(tcp|udp)\s+open\s+(\S+)?\s*(.*)$/.exec(line)
      if (open) {
        findings.push({
          id: `nmap-${n++}`, kind: 'service', title: `${host}:${open[1]}/${open[2]} ${open[3] ?? 'open'} ${open[4] ?? ''}`.trim(),
          detail: 'Nmap reports this port open, with the service it thinks is behind it.', confidence: 'observation', evidence: line,
        })
      }
    }
    if (findings.length >= 200) break
  }
  return findings
}

export { defaultPorts }
