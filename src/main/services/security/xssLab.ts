import http from 'http'
import type { AddressInfo } from 'net'

/**
 * Goga's offline XSS practice target.
 *
 * This is a deliberately-vulnerable web page that runs ONLY on this machine, bound to the
 * loopback address, started on demand and stopped when the practice is done. It exists so Goga
 * can learn to find and *prove* a reflected cross-site-scripting bug end to end — navigate, inject,
 * watch the script actually execute, and write it up — without ever touching a real external
 * target. Nothing here reaches the internet.
 *
 * Why a real server and not a canned string: an XSS is only "confirmed" when a browser actually
 * parses the injected markup and runs it. A real page, loaded by Goga's real browser, is the only
 * honest way to tell execution apart from mere reflection. So this serves two endpoints:
 *
 *   • /search?q=…  reflects q into the HTML with NO escaping — the vulnerable case.
 *   • /safe?q=…    reflects q HTML-escaped — the fixed case, as a control.
 *
 * The same payload executes on /search and is inert on /safe. That contrast is the whole lesson,
 * and it makes the practice falsifiable: if the "vulnerable" page did not fire, the run failed and
 * says so; if the "safe" page fired, the escaping is broken and that is worth knowing too.
 *
 * This is intentionally separate from the bounty scope channel (security.probe), which forbids
 * local/private addresses on purpose. Practising on localhost must never loosen that rule for real
 * targets — it is a different, clearly-labelled path.
 */

/** The marker-echo page: q is placed into the document body. `escape` decides whether it is safe. */
function page(q: string, escape: boolean): string {
  const shown = escape ? htmlEscape(q) : q
  const which = escape
    ? 'This endpoint HTML-escapes the parameter, so injected markup stays inert text. It is the fixed control.'
    : 'This endpoint reflects the parameter with NO escaping, on purpose. It is the vulnerable case.'
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>Goga XSS Practice</title></head>',
    '<body>',
    '<h1>Goga XSS practice &mdash; offline</h1>',
    `<p>This page runs only on your machine. ${which} Nothing here reaches the internet.</p>`,
    // The reflection point. On /search this is unescaped by design; on /safe it is escaped.
    `<div id="result">You searched for: ${shown}</div>`,
    '</body></html>',
  ].join('\n')
}

/** Minimal, correct HTML-text escaping for the control endpoint. */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The longest reflected input the lab accepts, so a stray request cannot grow the response. */
const MAX_Q = 4_000

/** A running practice lab: its base URL, URL builders for each endpoint, and a stop handle. */
export interface XssLab {
  /** e.g. http://127.0.0.1:53124 */
  readonly base: string
  readonly port: number
  /** Full URL for the vulnerable endpoint with q injected. */
  vulnerableUrl(q: string): string
  /** Full URL for the escaped control endpoint with q injected. */
  safeUrl(q: string): string
  /** Stop listening and free the port. Safe to call more than once. */
  stop(): Promise<void>
}

/**
 * Start the practice lab on the loopback interface, on an OS-assigned free port.
 *
 * Bound to 127.0.0.1 only — never 0.0.0.0 — so nothing off this machine can reach it. It answers
 * only /search and /safe; every other path is a 404. It is the caller's job to stop it.
 */
export function startXssLab(): Promise<XssLab> {
  const server = http.createServer((req, res) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad request')
      return
    }
    const q = (url.searchParams.get('q') ?? '').slice(0, MAX_Q)
    if (url.pathname === '/search' || url.pathname === '/safe') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // No CSP, no X-XSS-Protection: the point is to let the injection run so Goga can prove it.
        'cache-control': 'no-store',
      })
      res.end(page(q, url.pathname === '/safe'))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Goga XSS practice: try /search?q=… (vulnerable) or /safe?q=… (escaped control).')
  })

  return new Promise<XssLab>((resolve, reject) => {
    let settled = false
    // One persistent error listener for the server's whole life. Before listen resolves, a bind
    // error is the caller's to see, so it rejects. After, a late socket/server error on this
    // loopback-only practice server must NOT surface as an unhandled emitter 'error' and crash
    // main — there is nothing to recover, and the lab is stopped right after use anyway.
    server.on('error', err => { if (!settled) { settled = true; reject(err) } })
    // Port 0 asks the OS for a free port; host 127.0.0.1 keeps it on the loopback only.
    server.listen(0, '127.0.0.1', () => {
      settled = true
      const port = (server.address() as AddressInfo).port
      const base = `http://127.0.0.1:${port}`
      resolve({
        base,
        port,
        vulnerableUrl: (q: string) => `${base}/search?q=${encodeURIComponent(q)}`,
        safeUrl: (q: string) => `${base}/safe?q=${encodeURIComponent(q)}`,
        stop: () => new Promise<void>(done => server.close(() => done())),
      })
    })
  })
}
