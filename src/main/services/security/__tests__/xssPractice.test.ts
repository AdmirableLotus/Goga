import { describe, it, expect, afterEach } from 'vitest'
import { startXssLab, type XssLab } from '../xssLab'
import { runXssPractice, type XssDriver } from '../xssPractice'

/**
 * The runner is tested against a mock browser that decides execution for itself — it resets the
 * title on every navigation (as a real document does) and runs an <img onerror> handler only when
 * the markup is live and unescaped. So a green test means the runner's verdict matched what a
 * browser would actually do, not that the runner was trusted. No real Firefox, no network.
 */

function fakeBrowser(opts: { safeEscapes?: boolean; reflects?: boolean; executes?: boolean } = {}): XssDriver {
  const safeEscapes = opts.safeEscapes !== false
  const reflects = opts.reflects !== false
  // `executes: false` reflects the payload verbatim but never fires the handler — the honest
  // "reflected into a context where it does not run" case, distinct from "did not reflect".
  const executes = opts.executes !== false
  let title = 'Goga XSS Practice'
  let outerHtml = ''

  const render = (pathname: string, q: string) => {
    title = 'Goga XSS Practice' // a fresh navigation resets the document
    const shown = !reflects ? '' : pathname === '/safe' && safeEscapes
      ? q.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      : q
    outerHtml = `<html lang="en"><head><title>${title}</title></head><body><div id="result">You searched for: ${shown}</div></body></html>`
    // Execute only when the reflected markup is live (unescaped) and carries an onerror handler.
    if (executes && shown === q && q) {
      const m = /onerror="document\.title='([^']*)'"/.exec(shown)
      if (m) title = m[1]
    }
  }

  return {
    async navigate(url: string) {
      const u = new URL(url)
      render(u.pathname, u.searchParams.get('q') ?? '')
      return { url, title }
    },
    async evaluate(expression: string) {
      if (expression.includes('document.title')) return title
      if (expression.includes('outerHTML')) return outerHtml.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      return ''
    },
  }
}

let lab: XssLab | null = null
afterEach(async () => { await lab?.stop(); lab = null })

describe('runXssPractice', () => {
  it('confirms the XSS: it executes on /search and the control holds on /safe', async () => {
    lab = await startXssLab()
    const result = await runXssPractice(fakeBrowser(), lab)
    expect(result.reflected).toBe(true)
    expect(result.reflectionContext).toBe('in element text')
    expect(result.executedOnVulnerable).toBe(true)
    expect(result.controlHeld).toBe(true)
    expect(result.confirmed).toBe(true)
    expect(result.finding).not.toBeNull()
    expect(result.finding?.severity).toBe('medium')
    expect(result.finding?.evidence).toContain('document.title')
  })

  it('does NOT confirm when the escaped control also executes (broken escaping)', async () => {
    lab = await startXssLab()
    const result = await runXssPractice(fakeBrowser({ safeEscapes: false }), lab)
    expect(result.executedOnVulnerable).toBe(true)
    expect(result.controlHeld).toBe(false)
    expect(result.confirmed).toBe(false)
    expect(result.finding).toBeNull()
    expect(result.log.join('\n')).toMatch(/escaping is broken/i)
  })

  it('reports reflection WITHOUT execution honestly — reflected, but no confirm and no finding', async () => {
    lab = await startXssLab()
    const result = await runXssPractice(fakeBrowser({ executes: false }), lab)
    expect(result.reflected).toBe(true)              // the marker did come back
    expect(result.executedOnVulnerable).toBe(false)  // but the payload never ran
    expect(result.controlHeld).toBe(true)            // the escaped control stayed inert too
    expect(result.confirmed).toBe(false)             // so it is NOT claimed as confirmed
    expect(result.finding).toBeNull()                // and no finding is drafted
    expect(result.log.join('\n')).toMatch(/did NOT run/i)
  })

  it('stops honestly when nothing reflects — no execution claim', async () => {
    lab = await startXssLab()
    const result = await runXssPractice(fakeBrowser({ reflects: false }), lab)
    expect(result.reflected).toBe(false)
    expect(result.executedOnVulnerable).toBe(false)
    expect(result.confirmed).toBe(false)
    expect(result.finding).toBeNull()
    expect(result.log.join('\n')).toMatch(/nothing to exploit/i)
  })
})
