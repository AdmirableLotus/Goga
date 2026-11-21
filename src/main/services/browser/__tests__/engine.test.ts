import { describe, it, expect, vi, beforeEach } from 'vitest'

// The two resolvers reach the real filesystem; mock them so readiness is deterministic and the
// test never depends on whether Firefox or Brave happen to be installed on the test machine.
vi.mock('../firefox', () => ({ resolveFirefoxPath: vi.fn() }))
vi.mock('../../../adapters/browser', () => ({ resolveBravePath: vi.fn() }))

import { resolveFirefoxPath } from '../firefox'
import { resolveBravePath } from '../../../adapters/browser'
import { asBrowserEngine, browserReadiness } from '../engine'

const ff = resolveFirefoxPath as unknown as ReturnType<typeof vi.fn>
const br = resolveBravePath as unknown as ReturnType<typeof vi.fn>

beforeEach(() => { ff.mockReset(); br.mockReset() })

describe('asBrowserEngine', () => {
  it('accepts "brave", and defaults everything else to "firefox"', () => {
    expect(asBrowserEngine('brave')).toBe('brave')
    expect(asBrowserEngine('firefox')).toBe('firefox')
    expect(asBrowserEngine(undefined)).toBe('firefox')
    expect(asBrowserEngine('chrome')).toBe('firefox')
    expect(asBrowserEngine(null)).toBe('firefox')
  })
})

describe('browserReadiness', () => {
  it('reports Firefox installed, over BiDi, when the path resolves', () => {
    ff.mockReturnValue('C:\\Program Files\\Mozilla Firefox\\firefox.exe')
    const r = browserReadiness('firefox')
    expect(r).toMatchObject({ engine: 'firefox', installed: true, overrideVar: 'GOGA_FIREFOX_PATH' })
    expect(r.message).toMatch(/BiDi/)
    expect(br).not.toHaveBeenCalled()  // it asked only the engine it was given
  })

  it('reports Firefox missing with an actionable message and the override var', () => {
    ff.mockReturnValue(null)
    const r = browserReadiness('firefox')
    expect(r.installed).toBe(false)
    expect(r.executable).toBeNull()
    expect(r.message).toMatch(/GOGA_FIREFOX_PATH/)
  })

  it('reports Brave installed, driven by Playwright/Chromium', () => {
    br.mockReturnValue('C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe')
    const r = browserReadiness('brave')
    expect(r).toMatchObject({ engine: 'brave', installed: true, overrideVar: 'GOGA_BRAVE_PATH' })
    expect(r.message).toMatch(/Playwright/)
  })

  it('reports Brave missing, and mentions the bundled-Chromium fallback and the override var', () => {
    br.mockReturnValue(null)
    const r = browserReadiness('brave')
    expect(r.installed).toBe(false)
    expect(r.message).toMatch(/GOGA_BRAVE_PATH/)
    expect(r.message).toMatch(/Chromium/)
  })
})
