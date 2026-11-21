import { describe, it, expect } from 'vitest'
import { runXssLive, injectParam, type LiveGet, type XssDriver } from '../xssLive'

/**
 * A faithful tiny world: a server that reflects the `q` parameter (raw, escaped, or not at all)
 * and a browser that runs an <img onerror> ONLY when the markup came through as live HTML. No real
 * network, no real browser — but the cause-and-effect matches reality, so the honesty rule is
 * actually tested, not assumed.
 */
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function makeWorld(mode: 'vuln' | 'escaped' | 'noreflect'): { get: LiveGet; driver: XssDriver } {
  let title = 'Home'
  const render = (value: string): string => {
    if (mode === 'noreflect') return '<html><head><title>Home</title></head><body>No results.</body></html>'
    const shown = mode === 'escaped' ? htmlEscape(value) : value
    return `<html><head><title>Home</title></head><body>Results for ${shown}</body></html>`
  }
  const get: LiveGet = async (url) => ({ status: 200, body: render(new URL(url).searchParams.get('q') ?? '') })
  const driver: XssDriver = {
    navigate: async (url) => {
      const value = new URL(url).searchParams.get('q') ?? ''
      const m = value.match(/onerror="document\.title='([^']+)'"/)
      // Only a vulnerable (unescaped) reflection lets the injected script set the title.
      title = mode === 'vuln' && m ? m[1] : 'Home'
      return { url, title }
    },
    evaluate: async (expr) => (expr === 'document.title' ? title : ''),
  }
  return { get, driver }
}

const TARGET = 'https://app.example.com/search?q=TEST'

describe('injectParam', () => {
  it('replaces the named parameter and leaves others intact', () => {
    const out = injectParam('https://a.b/s?q=x&page=2', 'q', '<img>')
    const u = new URL(out)
    expect(u.searchParams.get('q')).toBe('<img>')
    expect(u.searchParams.get('page')).toBe('2')
  })
})

describe('runXssLive', () => {
  it('confirms XSS when the payload reflects unescaped AND executes, with the control holding', async () => {
    const { get, driver } = makeWorld('vuln')
    const r = await runXssLive({ target: TARGET, param: 'q', get, driver })
    expect(r.reflected).toBe(true)
    expect(r.unescapedInResponse).toBe(true)
    expect(r.executed).toBe(true)
    expect(r.controlHeld).toBe(true)
    expect(r.confirmed).toBe(true)
    expect(r.finding).not.toBeNull()
    expect(r.finding?.severity).toBe('high')
    expect(r.finding?.asset).toBe('https://app.example.com/search')
  })

  it('does NOT confirm when the server escapes the payload (reflected but inert)', async () => {
    const { get, driver } = makeWorld('escaped')
    const r = await runXssLive({ target: TARGET, param: 'q', get, driver })
    expect(r.reflected).toBe(true)          // the benign marker still comes back
    expect(r.unescapedInResponse).toBe(false)
    expect(r.executed).toBe(false)
    expect(r.confirmed).toBe(false)
    expect(r.finding).toBeNull()
  })

  it('stops honestly when the parameter is not reflected at all', async () => {
    const { get, driver } = makeWorld('noreflect')
    const r = await runXssLive({ target: TARGET, param: 'q', get, driver })
    expect(r.reflected).toBe(false)
    expect(r.executed).toBe(false)
    expect(r.confirmed).toBe(false)
    expect(r.finding).toBeNull()
    expect(r.log.join(' ')).toMatch(/not reflected/i)
  })
})
