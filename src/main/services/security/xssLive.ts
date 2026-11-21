import { randomBytes } from 'crypto'
import { reflectionReport } from './probe'

/**
 * Prove one reflected XSS on a LIVE, in-scope target — and prove it as honestly as the offline
 * lab does. Same rule, same refusal to bluff: reflection is not execution, and a confident
 * write-up of a payload that does not actually fire is the exact failure this project rejects.
 *
 * The difference from the lab is only the surface: here the target is a real URL the caller has
 * already put through the scope gate (eligible asset, not local/private/metadata), and the two
 * GETs come from the single scoped-GET path. This module decides nothing about authorization —
 * it is handed a `get` that only ever returns in-scope responses and a `driver` that only ever
 * navigates in-scope URLs. Its whole job is the proof:
 *
 *   1. Reflection — inject a unique benign marker and read the response. No reflection, no bug.
 *   2. Encoding  — inject the payload and check it comes back UNescaped in the response. If the
 *      server HTML-escapes it, it is reflected-but-inert, and that is reported, not dressed up.
 *   3. Execution — point the real browser at the payload URL. The payload sets document.title to
 *      a fresh nonce only running script could produce. Title changes → it executed. It does not
 *      → "reflected, not executed", never "confirmed".
 *   4. Control  — the benign marker URL must NOT carry that title, so a pre-existing title can
 *      never be mistaken for execution.
 *
 * Confirmed requires execution AND the control holding. Anything else is a partial result.
 */

/** A scoped GET: the caller guarantees it only reaches in-scope, non-forbidden hosts. */
export interface LiveGet {
  (url: string): Promise<{ status: number; body: string }>
}

/** The browser the proof drives. Navigate only ever receives an in-scope URL. */
export interface XssDriver {
  navigate(url: string): Promise<{ url: string; title: string }>
  evaluate(expression: string): Promise<string>
}

export interface XssLiveResult {
  confirmed: boolean
  reflected: boolean
  reflectionContext: string | null
  /** Did the payload survive into the response WITHOUT being HTML-escaped? */
  unescapedInResponse: boolean
  /** Did the payload actually run in the browser (title became the nonce value)? */
  executed: boolean
  /** Did the benign control URL correctly NOT carry the nonce title? */
  controlHeld: boolean
  marker: string
  payload: string
  markerUrl: string
  payloadUrl: string
  param: string
  log: string[]
  finding: {
    title: string
    severity: 'high'
    asset: string
    summary: string
    steps: string
    impact: string
    remediation: string
    evidence: string
  } | null
}

/** Put a value into one query parameter of a URL, replacing it if present. Throws on a bad URL. */
export function injectParam(rawUrl: string, param: string, value: string): string {
  const u = new URL(rawUrl)
  u.searchParams.set(param, value)
  return u.toString()
}

/** Poll document.title a few times — onerror can fire just after navigation completes. */
async function titleSettles(driver: XssDriver, expected: string, tries = 10, gapMs = 150): Promise<string> {
  let title = ''
  for (let i = 0; i < tries; i++) {
    title = (await driver.evaluate('document.title')).trim()
    if (title === expected) return title
    await new Promise(r => setTimeout(r, gapMs))
  }
  return title
}

/** True when the executable markup came back literally — not HTML-escaped (&lt;img …). */
function payloadSurvivesUnescaped(body: string, nonce: string): boolean {
  const hasNonce = body.includes(`GOGA-XSS-${nonce}`)
  const hasLiveTag = /<img\b[^>]*\bonerror\s*=/i.test(body)
  const escaped = body.includes('&lt;img') || body.includes('&lt;IMG')
  return hasNonce && hasLiveTag && !escaped
}

export async function runXssLive(opts: {
  target: string
  param: string
  get: LiveGet
  driver: XssDriver
  /** The asset string for the finding; defaults to the target's origin + path. */
  asset?: string
}): Promise<XssLiveResult> {
  const { target, param, get, driver } = opts
  const nonce = randomBytes(6).toString('hex')
  const marker = `goga${nonce}`
  const expectedTitle = `GOGA-XSS-${nonce}`
  const payload = `<img src=x onerror="document.title='GOGA-XSS-${nonce}'">`
  const markerUrl = injectParam(target, param, marker)
  const payloadUrl = injectParam(target, param, payload)
  const asset = opts.asset ?? (() => { try { const u = new URL(target); return `${u.origin}${u.pathname}` } catch { return target } })()
  const log: string[] = []

  const stop = (extra: Partial<XssLiveResult>): XssLiveResult => ({
    confirmed: false, reflected: false, reflectionContext: null, unescapedInResponse: false,
    executed: false, controlHeld: false, marker, payload, markerUrl, payloadUrl, param, log, finding: null, ...extra,
  })

  // Step 1 — reflection with a benign marker (nothing executes yet).
  const r1 = await get(markerUrl)
  const refl = reflectionReport(r1.body, marker)
  const reflected = refl.found
  const reflectionContext = refl.contexts[0]?.context ?? null
  log.push(reflected
    ? `Reflection: "${param}" came back ${reflectionContext ? `(${reflectionContext})` : ''} in the response (HTTP ${r1.status}) — the input reaches the page.`
    : `Reflection: the marker did not come back (HTTP ${r1.status}). "${param}" is not reflected here; nothing to exploit. Stopping.`)
  if (!reflected) return stop({ reflectionContext })

  // Step 2 — does the payload survive unescaped?
  const r2 = await get(payloadUrl)
  const unescapedInResponse = payloadSurvivesUnescaped(r2.body, nonce)
  log.push(unescapedInResponse
    ? 'Encoding: the <img onerror> payload is reflected UNescaped — the angle brackets and attribute survive, so the browser will parse it as markup.'
    : 'Encoding: the payload came back HTML-escaped (or altered) — reflected but inert. Reporting as reflection without a working exploit, not as XSS.')

  // Step 3 — execution in the real browser.
  await driver.navigate(payloadUrl)
  const vulnTitle = await titleSettles(driver, expectedTitle)
  const executed = vulnTitle === expectedTitle
  log.push(executed
    ? `Execution: the payload RAN — the browser set document.title to "${expectedTitle}", a value only the injected script could produce.`
    : `Execution: the payload did NOT run (title stayed "${vulnTitle || '∅'}"). Reporting reflection without confirmed execution.`)

  // Step 4 — control: the benign marker URL must not carry that title.
  await driver.navigate(markerUrl)
  const ctrlTitle = await titleSettles(driver, expectedTitle, 5, 120)
  const controlHeld = ctrlTitle !== expectedTitle
  log.push(controlHeld
    ? 'Control: the benign marker URL does not carry that title, so the change above can only be the payload executing.'
    : 'Control: the benign URL ALSO shows that title — the proof is ambiguous, so this is NOT reported as confirmed.')

  const confirmed = executed && unescapedInResponse && controlHeld
  log.push(confirmed
    ? `Verdict: CONFIRMED reflected XSS in "${param}" — proven by execution and isolated by the control.`
    : 'Verdict: not confirmed. Reported exactly as observed, with no claim of a working exploit.')

  return {
    confirmed, reflected, reflectionContext, unescapedInResponse, executed, controlHeld,
    marker, payload, markerUrl, payloadUrl, param, log,
    finding: confirmed ? {
      title: `Reflected XSS via "${param}" parameter`,
      severity: 'high',
      asset,
      summary: `The "${param}" parameter is reflected into the HTML response without escaping, allowing arbitrary script execution in the context of ${asset}. Confirmed by execution in a real browser.`,
      steps: [
        `1. Request ${payloadUrl}`,
        `2. The response reflects "${param}" ${reflectionContext ? `(${reflectionContext})` : ''} with no HTML escaping.`,
        `3. The injected <img onerror> executes, setting document.title to "${expectedTitle}" — a value only the running script could produce.`,
        `4. The benign request ${markerUrl} does not carry that title, isolating the cause to the reflected payload.`,
      ].join('\n'),
      impact: 'An attacker who controls the parameter value (for example via a crafted link) can run script in a victim\'s authenticated session: read page content, act as the user, or exfiltrate session data.',
      remediation: 'HTML-escape the parameter before writing it into the response, or use a templating layer that escapes by default. Add a Content-Security-Policy as defence in depth.',
      evidence: `payload: ${payload}\nresult: document.title became "${expectedTitle}" on the payload URL and stayed unchanged on the benign URL.`,
    } : null,
  }
}
