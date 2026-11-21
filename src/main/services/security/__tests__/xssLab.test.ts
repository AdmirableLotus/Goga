import { describe, it, expect, afterEach } from 'vitest'
import { startXssLab, type XssLab } from '../xssLab'
import { reflectionReport } from '../probe'

/**
 * The practice lab is a real server, so the test drives a real one — but only ever on 127.0.0.1,
 * the loopback. No external host is contacted. These assertions pin the one property the whole
 * practice rests on: the vulnerable endpoint reflects markup verbatim, and the control escapes it.
 */

let lab: XssLab | null = null
afterEach(async () => { await lab?.stop(); lab = null })

describe('xssLab', () => {
  it('serves on the loopback interface', async () => {
    lab = await startXssLab()
    expect(lab.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(lab.port).toBeGreaterThan(0)
  })

  it('reflects q verbatim on /search — the injection is not escaped', async () => {
    lab = await startXssLab()
    const payload = `<img src=x onerror="document.title='GOGA-XSS-abc123'">`
    const res = await fetch(lab.vulnerableUrl(payload))
    const body = await res.text()
    expect(res.status).toBe(200)
    // The exact markup comes back, so a browser would parse and run it.
    expect(body).toContain(payload)
    expect(body).not.toContain('&lt;img')
  })

  it('escapes q on /safe — the same payload is inert text', async () => {
    lab = await startXssLab()
    const payload = `<img src=x onerror="document.title='GOGA-XSS-abc123'">`
    const res = await fetch(lab.safeUrl(payload))
    const body = await res.text()
    expect(res.status).toBe(200)
    // The angle brackets are entity-encoded, so the browser renders text, not an element.
    expect(body).toContain('&lt;img src=x')
    expect(body).not.toContain(payload)
  })

  it('reflectionReport reads the vulnerable response as unescaped element text', async () => {
    lab = await startXssLab()
    const marker = 'goga7f3a91'
    const res = await fetch(lab.vulnerableUrl(marker))
    const body = await res.text()
    const r = reflectionReport(body, marker)
    expect(r.found).toBe(true)
    expect(r.contexts[0].context).toBe('in element text')
  })

  it('404s any other path, and never serves a reflection there', async () => {
    lab = await startXssLab()
    const res = await fetch(`${lab.base}/?q=${encodeURIComponent('<b>x</b>')}`)
    expect(res.status).toBe(404)
    const body = await res.text()
    expect(body).not.toContain('<b>x</b>')
  })
})
