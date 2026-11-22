import http from 'http'
import path from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import type { Hypothesis } from '../../../shared/grimoire'
import { runReview, readForReview } from '../security/grimoire/review'
import { observePayloadResponse } from './payload'
import type { LabFinding, LiveKind } from '../../../shared/lab'

/**
 * One XSS find, from a line of source to observed evidence — on the local copy only.
 *
 * The chain this file walks, and why each link is separate:
 *
 *   1. **Source.** The XSS specialist reads one file the user named, inside the folder they
 *      pointed at, and names the line it would argue about. The independent validator then
 *      says what observable would settle it, in the file's own words.
 *   2. **Context.** The sink line is classified: where would that value land — element text, a
 *      quoted attribute, a textarea, a script block? That decides what a payload has to break
 *      out of before any script can run.
 *   3. **Local reproduction.** A page is served on 127.0.0.1 that writes the incoming value
 *      into exactly that context with exactly that line's escaping (none, in the case worth
 *      looking at). It is a reproduction of the line's behaviour, and it says so on its own
 *      face — it is not WordPress running.
 *   4. **Dispatch and observation.** The payload is sent through the Lab's payload dispatch,
 *      which needs its own approval, and the response is read to see whether the value took.
 *   5. **Verdict.** Reflected-but-escaped, taken-as-markup, and executed are three different
 *      results and are reported as three different results. Execution needs the browser to
 *      have run the payload and set the nonce title; an echo never counts as execution.
 *
 * There is no PHP on this machine, so WordPress itself cannot be run here. That is stated in
 * the result rather than papered over: what this proves is that the line's behaviour is
 * exploitable, not that a live install is.
 */

// ── The sink line's context ─────────────────────────────────────────────────

export type SinkContext = 'attribute-double' | 'attribute-single' | 'textarea' | 'script' | 'text'

export const CONTEXT_LABEL: Record<SinkContext, string> = {
  'attribute-double': 'inside a double-quoted HTML attribute',
  'attribute-single': 'inside a single-quoted HTML attribute',
  textarea: 'inside a <textarea> element',
  script: 'inside a <script> block',
  text: 'in element text',
}

/**
 * Where would this line's echoed value land?
 *
 * Read from the line itself, which is what the specialist quoted. The value is written by an
 * `echo`/`print`/`<?=`, so only the text *before* that point decides the context — counting
 * quotes across the whole line would see the closing quote and call an attribute "text",
 * which is how a real bug gets reported as inert.
 */
export function sinkContext(lineText: string): SinkContext {
  const line = String(lineText ?? '')
  const out = /\becho\b|\bprint\b|<\?=/.exec(line)
  // With no output call on the line, fall back to the whole line: it is the best evidence there is.
  const prefix = out ? line.slice(0, out.index) : line
  if (/<script\b[^>]*>/i.test(prefix) && !/<\/script>/i.test(prefix)) return 'script'
  if (/<textarea\b[^>]*>/i.test(prefix) && !/<\/textarea>/i.test(prefix)) return 'textarea'
  // An odd count of one quote kind means that quote is still open where the value lands.
  const doubles = (prefix.match(/"/g) ?? []).length
  const singles = (prefix.match(/'/g) ?? []).length
  if (doubles % 2 === 1) return 'attribute-double'
  if (singles % 2 === 1) return 'attribute-single'
  return 'text'
}

/**
 * What has to be sent before the payload to get out of the context.
 *
 * This is the part that makes an attribute sink different from a text sink: in element text
 * `<img …>` is already markup; inside `value="…"` it is inert until a closing quote and `>`
 * come first. Getting this wrong is how a test reports "no execution" on a real bug.
 */
export function breakoutFor(context: SinkContext): string {
  switch (context) {
    case 'attribute-double': return '">'
    case 'attribute-single': return "' >"
    case 'textarea': return '</textarea>'
    case 'script': return "';"
    default: return ''
  }
}

/** The full payload for a context: the breakout, then a tag whose onerror sets the title. */
export function payloadFor(context: SinkContext, nonce: string): string {
  return `${breakoutFor(context)}<img src=x onerror="document.title='GOGA-WPXSS-${nonce}'">`
}

/** The value only running script could set, for this run. */
export function expectedTitle(nonce: string): string {
  return `GOGA-WPXSS-${nonce}`
}

// ── Reading the source, and the validator's observable ──────────────────────

export interface SinkCandidate {
  file: string
  line: number
  excerpt: string
  context: SinkContext
  /** The validator's verdict on this candidate. */
  outcome: Hypothesis['validation']['outcome']
  /** What the validator said would confirm it, in its own words. */
  wouldConfirm: string[]
  /** The observable the validator found in the material, when it found one. */
  observable: string | null
  why: string
}

export interface SourceReading {
  root: string
  file: string
  bytes: number
  /** Every XSS candidate the specialist raised, strongest first. */
  candidates: SinkCandidate[]
  /** Candidates the validator dropped, kept so the read is honest about what it dismissed. */
  dropped: SinkCandidate[]
  /** The specialist's own reasoning, so nothing is hidden behind a count. */
  reasoning: string[]
}

/**
 * Read one file and pull out what the XSS specialist and the validator say about it.
 *
 * Only the `xss` specialist runs: this is a focused read, not a survey, and running all
 * eighteen over one file would bury the XSS answer in seventeen clean results.
 */
export function readSinks(root: string, file: string): SourceReading {
  // `file` may be relative to the folder the user pointed at (the natural way to name a file
  // in a tree) or already absolute. Resolve it against the root either way, exactly as the
  // Grimoire's own review tool does, so the containment check sees the real path.
  const target = path.isAbsolute(file) ? file : path.join(root, file)
  const read = readForReview(root, target)
  const run = runReview({
    text: read.text,
    location: read.rel,
    material: 'code_audit',
    specialists: ['xss'],
  })
  const lines = read.text.split(/\r?\n/)
  const toCandidate = (h: Hypothesis): SinkCandidate => {
    const lineText = lines[(h.line ?? 1) - 1] ?? h.excerpt
    return {
      file: read.rel,
      line: h.line ?? 0,
      excerpt: (lineText ?? '').trim().slice(0, 300),
      context: sinkContext(lineText ?? ''),
      outcome: h.validation.outcome,
      wouldConfirm: h.validation.wouldConfirm,
      observable: h.validation.observable,
      why: h.validation.why,
    }
  }
  const all = run.hypotheses.map(toCandidate)
  return {
    root,
    file: read.rel,
    bytes: read.size,
    candidates: all.filter(c => c.outcome === 'confirmed-observable'),
    dropped: all.filter(c => c.outcome !== 'confirmed-observable'),
    reasoning: run.reviews.filter(r => !r.quiet).map(r => r.reasoning),
  }
}

// ── The local reproduction ─────────────────────────────────────────────────

export interface Reproduction {
  base: string
  port: number
  /** The URL a payload is dispatched to, with `{payload}` left for the dispatcher. */
  template: string
  stop(): Promise<void>
}

/**
 * Serve a page that writes the incoming value into one context, with no escaping.
 *
 * This is the local copy. It reproduces what the sink line does — writes a value into an
 * attribute, a textarea, a script block or element text, unescaped — so a payload can be sent
 * at it and the result read. It is bound to 127.0.0.1 only, answers one path, and carries the
 * source reference on its own face so a reader can never mistake it for a live install.
 */
export function startReproduction(context: SinkContext, source: { file: string; line: number }): Promise<Reproduction> {
  const banner = `Reproduction of ${source.file}:${source.line} — a page that writes the value into ${CONTEXT_LABEL[context]} with no escaping. This is a local harness on 127.0.0.1, not a running WordPress.`
  const body = (value: string): string => {
    switch (context) {
      case 'attribute-double':
        return `<input type="text" name="q" value="${value}" />`
      case 'attribute-single':
        return `<input type='text' name='q' value='${value}' />`
      case 'textarea':
        return `<textarea name="q" rows="4">${value}</textarea>`
      case 'script':
        return `<script>var q = '${value}';</script>`
      default:
        return `<div id="result">You searched for: ${value}</div>`
    }
  }
  const server = http.createServer((req, res) => {
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('bad request'); return
    }
    if (url.pathname !== '/sink') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Goga local reproduction: request /sink?v=<value>')
      return
    }
    const value = (url.searchParams.get('v') ?? '').slice(0, 4000)
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // No CSP: the point is to let an injection run so the behaviour can be observed.
    })
    res.end([
      '<!doctype html>', '<html lang="en"><head><meta charset="utf-8">',
      `<title>${banner}</title>`,
      '</head><body>',
      `<p>${banner}</p>`,
      body(value),
      '</body></html>',
    ].join('\n'))
  })

  return new Promise<Reproduction>((resolve, reject) => {
    let settled = false
    server.on('error', err => { if (!settled) { settled = true; reject(err) } })
    server.listen(0, '127.0.0.1', () => {
      settled = true
      const port = (server.address() as AddressInfo).port
      const base = `http://127.0.0.1:${port}`
      resolve({
        base,
        port,
        template: `${base}/sink?v={payload}`,
        stop: () => new Promise<void>(done => server.close(() => done())),
      })
    })
  })
}

// ── The whole path, one call ───────────────────────────────────────────────

export interface WpXssStep {
  step: string
  detail: string
  /** The live-log kind for this step, so the page can colour it as it arrives. */
  kind?: LiveKind
}

export interface WpXssResult {
  /** True only when the browser actually ran the payload on the reproduction and the control held. */
  executed: boolean
  reflected: boolean
  /** The payload came back as live markup rather than escaped text. */
  tookAsMarkup: boolean
  /** Did the value land in the context the source predicted? */
  contextMatched: boolean
  context: SinkContext
  payload: string
  marker: string
  nonce: string
  expectedTitle: string
  reproductionUrl: string
  status: number | null
  bytes: number
  excerpt: string
  steps: WpXssStep[]
  source: { file: string; line: number; excerpt: string; observable: string | null; wouldConfirm: string[] }
  /** A draft finding when and only when execution was proven on the reproduction. */
  finding: Omit<LabFinding, 'id'> | null
  /** What this does and does not prove, in one sentence, on the page. */
  caveat: string
}

/**
 * Run the whole path against the local copy.
 *
 * `dispatch` is injected so the caller keeps the approval it already holds: this function
 * never sends anything itself, it hands the payload through the review the caller owns.
 * `drive` is the browser adapter — optional, because the observation half is useful without
 * it, and because a run that could not launch a browser must say so rather than fail.
 */
export async function runWordPressXss(opts: {
  root: string
  file: string
  /** Explicit sink choice, when the user picked one. Otherwise the strongest candidate is used. */
  line?: number
  /** The approved dispatch: sends the payload and returns the response. */
  dispatch: (url: string, payload: string) => Promise<{ status: number | null; body: string; bytes: number; refused?: string }>
  /** Optional browser, so execution can be checked rather than inferred. */
  drive?: {
    navigate(url: string): Promise<{ url: string; title: string }>
    evaluate(expression: string): Promise<string>
  }
  /**
   * Called the moment each step happens, before the next one starts.
   *
   * This is what the live view reads. It is called with the same object that ends up in
   * `steps`, so the log the user watched and the result they get afterwards cannot differ.
   */
  onStep?: (step: WpXssStep) => void
  /**
   * Called after the browser has been sent to a page, with the address it landed on.
   *
   * The live pane takes its picture here rather than on a timer alone: a run on loopback can
   * finish inside one interval, and a picture taken "every so often" would then be a picture
   * of nothing. This fires while the payload page is actually on screen.
   */
  onBrowserShown?: (url: string) => void
}): Promise<WpXssResult> {
  const steps: WpXssStep[] = []
  const step = (s: WpXssStep): void => {
    steps.push(s)
    try { opts.onStep?.(s) } catch { /* a listener must never break the run */ }
  }
  const reading = readSinks(opts.root, opts.file)
  step({
    step: 'Source',
    kind: 'source',
    detail: `${reading.file} read (${reading.bytes} bytes). The XSS specialist raised ${reading.candidates.length + reading.dropped.length} candidate(s); the validator kept ${reading.candidates.length} with a confirming observable and dropped ${reading.dropped.length}.`,
  })

  const chosen = (opts.line !== undefined
    ? reading.candidates.find(c => c.line === opts.line) ?? reading.dropped.find(c => c.line === opts.line)
    : reading.candidates[0]) ?? null

  if (!chosen) {
    step({
      step: 'Source',
      kind: 'source',
      detail: reading.dropped.length
        ? `Nothing survived the validator. The strongest dismissed candidate was line ${reading.dropped[0].line}: ${reading.dropped[0].why}`
        : 'The XSS specialist found no sink worth arguing about in this file.',
    })
    return blankResult(steps, reading, 'attribute-double')
  }

  step({
    step: 'Sink',
    kind: 'specialist',
    detail: `Line ${chosen.line}, ${CONTEXT_LABEL[chosen.context]}. ${chosen.excerpt}`,
  })
  step({
    step: 'Validator',
    kind: 'validator',
    detail: chosen.outcome === 'confirmed-observable'
      ? `The confirming observable is present: ${chosen.observable ?? chosen.excerpt}`
      : `The validator did NOT confirm this one (${chosen.outcome}): ${chosen.why}`,
  })
  step({
    step: 'What would confirm it',
    kind: 'validator',
    detail: chosen.wouldConfirm.length
      ? chosen.wouldConfirm.join(' ')
      : 'The validator named no observable, so there is nothing to reproduce here.',
  })

  const nonce = randomBytes(5).toString('hex')
  const marker = `gogawp${nonce}`
  const payload = payloadFor(chosen.context, nonce)
  const expected = expectedTitle(nonce)

  // A confirmed-observable source is the only one worth sending a payload at: a dropped
  // candidate already has its counter-evidence in the file, and reproducing it would prove
  // the reproduction, not the bug.
  if (chosen.outcome !== 'confirmed-observable') {
    step({ step: 'Dispatch', kind: 'stop', detail: 'Not sent: the validator dismissed this candidate, so there is nothing here to reproduce.' })
    return {
      ...blankResult(steps, reading, chosen.context),
      source: { file: chosen.file, line: chosen.line, excerpt: chosen.excerpt, observable: chosen.observable, wouldConfirm: chosen.wouldConfirm },
      payload, marker, nonce, expectedTitle: expected, context: chosen.context,
    }
  }

  const reproduction = await startReproduction(chosen.context, { file: chosen.file, line: chosen.line })
  step({
    step: 'Reproduction',
    kind: 'target',
    detail: `A page that writes the value into ${CONTEXT_LABEL[chosen.context]} with no escaping is now served on ${reproduction.base} — on this machine only, not a live install.`,
  })
  try {
    // Step 1 — reflection with the benign marker, which cannot execute.
    step({ step: 'Send', kind: 'send', detail: `Sending the benign marker ${marker} to 127.0.0.1:${reproduction.port} (${chosen.context}).` })
    const benign = await opts.dispatch(reproduction.template, marker)
    const benignObs = observePayloadResponse(benign.body, marker, marker)
    const reflected = benignObs.found
    step({
      step: 'Reflection',
      kind: 'response',
      detail: reflected
        ? `The marker ${marker} came back ${benignObs.context ?? ''} (HTTP ${benign.status}) — the value reaches the page.`
        : `The marker did not come back (HTTP ${benign.status}${benign.refused ? `, ${benign.refused}` : ''}). Nothing to reproduce.`,
    })
    if (!reflected) {
      return {
        ...blankResult(steps, reading, chosen.context),
        source: { file: chosen.file, line: chosen.line, excerpt: chosen.excerpt, observable: chosen.observable, wouldConfirm: chosen.wouldConfirm },
        payload, marker, nonce, expectedTitle: expected, context: chosen.context,
        reproductionUrl: reproduction.template, status: benign.status, bytes: benign.bytes,
      }
    }

    // Step 2 — the payload, and whether it survived into the response as markup.
    step({ step: 'Send', kind: 'send', detail: `Sending the payload to 127.0.0.1:${reproduction.port}: ${payload}` })
    const sent = await opts.dispatch(reproduction.template, payload)
    const obs = observePayloadResponse(sent.body, payload, marker)
    const tookAsMarkup = obs.unescaped
    const contextMatched = obs.context !== null && contextAgrees(chosen.context, obs.context)
    step({
      step: 'Dispatch',
      kind: 'response',
      detail: tookAsMarkup
        ? `HTTP ${sent.status}, ${sent.bytes} bytes. The payload came back ${obs.context ?? ''} as live markup — the angle brackets and attribute survived, so a browser would parse it.`
        : `HTTP ${sent.status}, ${sent.bytes} bytes. The payload came back ${obs.context ?? 'altered'}, but not as parseable markup — reflected, not (yet) executing.`,
    })
    step({
      step: 'Context',
      kind: 'validator',
      detail: contextMatched
        ? `The value landed where the source line predicted (${CONTEXT_LABEL[chosen.context]}).`
        : `The value came back in a different context than predicted (${obs.context ?? 'unknown'}), so read the excerpt before believing the match.`,
    })

    // Step 3 — execution, only if a browser was supplied.
    let executed = false
    if (opts.drive) {
      try {
        step({ step: 'Browser', kind: 'browser', detail: `Driving the browser to the reproduction at ${reproduction.base} to see whether the payload runs.` })
        await opts.drive.navigate(reproduction.template.replace('{payload}', encodeURIComponent(payload)))
        // The payload page is on screen now. Let the pane take its picture here, while the
        // thing being shown is the thing being tested.
        try { opts.onBrowserShown?.(reproduction.template.replace('{payload}', encodeURIComponent(payload))) } catch { /* never break the run */ }
        let title = ''
        for (let i = 0; i < 10; i++) {
          title = (await opts.drive.evaluate('document.title')).trim()
          if (title === expected) break
          await new Promise(r => setTimeout(r, 150))
        }
        executed = title === expected
        // The control: the benign marker URL must not carry that title.
        await opts.drive.navigate(reproduction.template.replace('{payload}', encodeURIComponent(marker)))
        let ctrl = ''
        for (let i = 0; i < 5; i++) {
          ctrl = (await opts.drive.evaluate('document.title')).trim()
          if (ctrl === expected) break
          await new Promise(r => setTimeout(r, 120))
        }
        const controlHeld = ctrl !== expected
        step({
          step: 'Execution',
          kind: 'verdict',
          detail: executed
            ? `The payload RAN: the page title became "${expected}", a value only the injected script could set. The benign marker URL did not carry it${controlHeld ? '' : ' — but the control is ambiguous, so this is not reported as confirmed'}.`
            : `The payload did NOT run (title stayed "${title || '∅'}"). That is a reflection result, not an execution result, and it is reported as one.`,
        })
        if (!controlHeld) executed = false
      } catch (err) {
        step({
          step: 'Execution',
          kind: 'browser',
          detail: `The browser could not be driven: ${err instanceof Error ? err.message : String(err)}. Execution was not tested, so it is not claimed.`,
        })
      }
    } else {
      step({ step: 'Execution', kind: 'browser', detail: 'No browser was attached, so execution was not tested. Reflection alone is not execution.' })
    }

    const finding: Omit<LabFinding, 'id'> | null = executed ? {      kind: 'payload',
      title: `Reflected XSS reproduced from ${chosen.file}:${chosen.line} (${CONTEXT_LABEL[chosen.context]})`,
      detail: [
        `The XSS specialist read ${chosen.file} and named line ${chosen.line}: ${chosen.excerpt}`,
        `The validator said it would be confirmed by: ${chosen.wouldConfirm.join(' ')}`,
        `A local reproduction of that line's behaviour was served on 127.0.0.1 and the payload executed there, setting document.title to "${expected}".`,
        'This was proven on a reproduction of the line, not on a running WordPress install: no PHP is available on this machine.',
      ].join(' '),
      confidence: 'confirmed',
      evidence: [
        `source: ${chosen.file}:${chosen.line}`,
        `context: ${CONTEXT_LABEL[chosen.context]}`,
        `payload: ${payload}`,
        `result: document.title became "${expected}" on the reproduction, and the benign marker URL did not carry it.`,
        `response excerpt: ${obs.excerpt.slice(0, 300)}`,
      ].join('\n'),
    } : null

    step({
      step: 'Verdict',
      kind: 'verdict',
      detail: executed
        ? `Confirmed on the local reproduction: the payload executed and the control held. This is evidence about the line, not about a live install.`
        : tookAsMarkup
          ? `The payload came back as live markup but no browser run confirmed execution. Reported as markup, not as an XSS.`
          : `The payload did not take as markup. Reported as it happened.`,
    })

    return {
      executed,
      reflected,
      tookAsMarkup,
      contextMatched,
      context: chosen.context,
      payload, marker, nonce, expectedTitle: expected,
      reproductionUrl: reproduction.template,
      status: sent.status,
      bytes: sent.bytes,
      excerpt: obs.excerpt,
      steps,
      source: { file: chosen.file, line: chosen.line, excerpt: chosen.excerpt, observable: chosen.observable, wouldConfirm: chosen.wouldConfirm },
      finding,
      caveat: 'This proves the line is exploitable when a caller controls that value. It was proven on a local reproduction of the line, not on a running WordPress install — there is no PHP on this machine — so the next step is reproducing it on a real, in-scope install.',
    }
  } finally {
    await reproduction.stop()
  }
}

/** Does the observed context agree with what the source line predicted? */
function contextAgrees(predicted: SinkContext, observed: string): boolean {
  if (predicted === 'text') return /element text/i.test(observed)
  if (predicted === 'script') return /script/i.test(observed)
  if (predicted === 'textarea') return /textarea|element text/i.test(observed)
  return /attribute/i.test(observed)
}

function blankResult(steps: WpXssStep[], reading: SourceReading, context: SinkContext): WpXssResult {
  return {
    executed: false, reflected: false, tookAsMarkup: false, contextMatched: false,
    context, payload: '', marker: '', nonce: '', expectedTitle: '',
    reproductionUrl: '', status: null, bytes: 0, excerpt: '',
    steps,
    source: {
      file: reading.file,
      line: reading.dropped[0]?.line ?? 0,
      excerpt: reading.dropped[0]?.excerpt ?? '',
      observable: null,
      wouldConfirm: [],
    },
    finding: null,
    caveat: 'Nothing was dispatched. A source read with nothing the validator would confirm is a real answer, not a failure.',
  }
}
