import { randomBytes } from 'crypto'
import type { XssLab } from './xssLab'
import { reflectionReport } from './probe'

/**
 * Prove one reflected XSS, end to end, on the offline practice lab — and prove it honestly.
 *
 * "Honestly" is the whole design. Reflection is not execution, and a confident write-up of a bug
 * that does not actually fire is exactly the failure this project refuses. So the run is built to
 * be falsifiable at every step, and the verdict is computed from what the browser actually did, not
 * from what a planner hoped:
 *
 *   1. Reflection — inject a unique benign marker and read the live DOM back. If it does not come
 *      back, there is nothing to exploit and the run says so.
 *   2. Execution — inject a payload that, only if the browser parses and runs it, rewrites
 *      document.title to a value containing a fresh nonce the page could not otherwise know. If the
 *      title changes to that value, script executed. If it does not, the run reports "reflected but
 *      did not execute" rather than claiming a win.
 *   3. Control — fire the SAME payload at the escaped endpoint. A correct escaper leaves the title
 *      untouched. If the control fires too, the escaping is broken, and that is reported, not hidden.
 *
 * A confirmed result requires BOTH: it executed on the vulnerable page AND stayed inert on the
 * control. Anything else is a partial result, reported as such.
 *
 * The runner drives the browser through a tiny interface so it can be tested against a mock — no
 * real Firefox, no real network — while production passes the live browser layer.
 */

/** The minimum a browser must do for the proof: go to a URL, and evaluate a read-only expression. */
export interface XssDriver {
  navigate(url: string): Promise<{ url: string; title: string }>
  /** Evaluate an expression in the current page and return its string value (e.g. document.title). */
  evaluate(expression: string): Promise<string>
}

export interface XssPracticeResult {
  /** True only when it executed on the vulnerable page AND the escaped control stayed inert. */
  confirmed: boolean
  /** Did the benign marker come back in the DOM at all? */
  reflected: boolean
  /** The reflection context, for the write-up (e.g. "in element text"). */
  reflectionContext: string | null
  /** Did the payload actually run on /search (title changed to the nonce value)? */
  executedOnVulnerable: boolean
  /** Did the escaped /safe endpoint correctly keep the payload inert? */
  controlHeld: boolean
  /** The exact payload used. */
  payload: string
  /** The benign marker used for the reflection step. */
  marker: string
  vulnerableUrl: string
  safeUrl: string
  /** A plain, honest account of each step and its outcome. */
  log: string[]
  /** A finding draft when (and only when) the result is confirmed, else null. */
  finding: {
    title: string
    severity: 'medium'
    asset: string
    summary: string
    steps: string
    impact: string
    remediation: string
    evidence: string
  } | null
}

/** Poll document.title a few times, because onerror can fire just after navigation completes. */
async function titleSettles(driver: XssDriver, expected: string, tries = 10, gapMs = 150): Promise<string> {
  let title = ''
  for (let i = 0; i < tries; i++) {
    title = (await driver.evaluate('document.title')).trim()
    if (title === expected) return title
    await new Promise(r => setTimeout(r, gapMs))
  }
  return title
}

export async function runXssPractice(driver: XssDriver, lab: XssLab): Promise<XssPracticeResult> {
  const nonce = randomBytes(6).toString('hex')
  const marker = `goga${nonce}`
  const expectedTitle = `GOGA-XSS-${nonce}`
  // An img with a failing source fires onerror as soon as the markup is parsed — the classic
  // self-contained vector that needs no outbound request to prove execution.
  const payload = `<img src=x onerror="document.title='GOGA-XSS-${nonce}'">`
  const vulnerableUrl = lab.vulnerableUrl(payload)
  const safeUrl = lab.safeUrl(payload)
  const log: string[] = []

  // Step 1 — reflection, with a benign marker so nothing executes yet.
  await driver.navigate(lab.vulnerableUrl(marker))
  const html = await driver.evaluate('document.documentElement.outerHTML')
  const refl = reflectionReport(html, marker)
  const reflected = refl.found
  const reflectionContext = refl.contexts[0]?.context ?? null
  log.push(reflected
    ? `Reflection: the marker "${marker}" came back ${reflectionContext ? `(${reflectionContext})` : ''} — the input reaches the page unfiltered.`
    : `Reflection: the marker "${marker}" did not come back. There is nothing to exploit here; stopping.`)

  if (!reflected) {
    return { confirmed: false, reflected, reflectionContext, executedOnVulnerable: false, controlHeld: false, payload, marker, vulnerableUrl, safeUrl, log, finding: null }
  }

  // Step 2 — execution on the vulnerable endpoint.
  await driver.navigate(vulnerableUrl)
  const vulnTitle = await titleSettles(driver, expectedTitle)
  const executedOnVulnerable = vulnTitle === expectedTitle
  log.push(executedOnVulnerable
    ? `Execution: the payload ran — the browser rewrote the page title to "${expectedTitle}", which only the injected script could set.`
    : `Execution: the payload was reflected but did NOT run (title stayed "${vulnTitle || '∅'}"). Reporting this as reflection without confirmed execution.`)

  // Step 3 — the same payload against the escaped control.
  await driver.navigate(safeUrl)
  const safeTitle = await titleSettles(driver, expectedTitle, 6, 120)
  const controlHeld = safeTitle !== expectedTitle
  log.push(controlHeld
    ? `Control: the same payload against the escaped endpoint did NOT run (title stayed "${safeTitle || '∅'}"), confirming it is the missing escaping that makes /search exploitable.`
    : `Control: the escaped endpoint ALSO executed the payload — its escaping is broken too. Worth noting.`)

  const confirmed = executedOnVulnerable && controlHeld
  log.push(confirmed
    ? 'Verdict: CONFIRMED reflected XSS on /search — proven by execution, and isolated by the control.'
    : 'Verdict: not confirmed. The result above is reported as-is, without claiming a working exploit.')

  return {
    confirmed, reflected, reflectionContext, executedOnVulnerable, controlHeld, payload, marker, vulnerableUrl, safeUrl, log,
    finding: confirmed ? {
      title: '[Practice] Reflected XSS via unescaped q parameter',
      severity: 'medium',
      asset: `${lab.base}/search`,
      summary: 'The q parameter is reflected into the HTML response without escaping, allowing arbitrary script execution in the context of the page. Confirmed on the offline practice lab.',
      steps: [
        `1. Request ${vulnerableUrl}`,
        `2. The response reflects the value of q (${reflectionContext ?? 'in the page body'}) with no HTML escaping.`,
        `3. The injected <img onerror> executes, setting document.title to "${expectedTitle}" — a value only the running script could produce.`,
        `4. The same payload against ${safeUrl} does not execute, confirming the escaping on /safe is what /search is missing.`,
      ].join('\n'),
      impact: 'An attacker who controls the q value (for example via a crafted link) can run script in a victim\'s browser session: read page content, act as the user, or steal session data.',
      remediation: 'HTML-escape the parameter before writing it into the response (as /safe does), or use a templating layer that escapes by default. Add a Content-Security-Policy as defence in depth.',
      evidence: `payload: ${payload}\nresult: document.title became "${expectedTitle}" on /search and stayed unchanged on /safe.`,
    } : null,
  }
}

/** Adapt the live browser layer to the tiny driver the runner needs. */
export function layerDriver(layer: { navigate(url: string): Promise<{ url: string; title: string }>; evaluateScript(expr: string): Promise<string> }): XssDriver {
  return {
    navigate: url => layer.navigate(url),
    evaluate: expr => layer.evaluateScript(expr),
  }
}
