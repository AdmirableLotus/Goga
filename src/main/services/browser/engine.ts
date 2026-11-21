import { resolveFirefoxPath } from './firefox'
import { resolveBravePath } from '../../adapters/browser'

/**
 * Which browser Goga drives, and whether it is actually installed.
 *
 * The two engines are not interchangeable at the protocol level, and this module is the one
 * place that states the verified reality so the rest of the app can report it honestly:
 *
 *   firefox  installed Mozilla Firefox, driven over WebDriver BiDi by the browser layer. This
 *            is a real W3C protocol Firefox serves on --remote-debugging-port.
 *   brave    installed Brave (Chromium-family), driven by Playwright's Chromium BrowserType via
 *            executablePath. Playwright is a supported, maintained framework for Chromium.
 *
 * Nothing here launches anything or reaches the network. It only resolves the executable and
 * says, in words the user can act on, whether the chosen engine can run. It is also kept free
 * of any bounty/scope concern on purpose: a browser preference must never be read as test
 * authorization.
 */

export type BrowserEngine = 'firefox' | 'brave'

export interface BrowserReadiness {
  engine: BrowserEngine
  /** The executable was found on disk. */
  installed: boolean
  /** Full path to the browser, or null when not found. */
  executable: string | null
  /** Plain words: whether it can run, and what to do if not. */
  message: string
  /** The env var that overrides the search, named so the message can point at it. */
  overrideVar: 'GOGA_FIREFOX_PATH' | 'GOGA_BRAVE_PATH'
}

/** Normalise any stored value to a known engine, defaulting to firefox. */
export function asBrowserEngine(value: unknown): BrowserEngine {
  return value === 'brave' ? 'brave' : 'firefox'
}

/** Resolve whether the chosen engine is installed, with an actionable message. Pure. */
export function browserReadiness(engine: BrowserEngine, env: NodeJS.ProcessEnv = process.env): BrowserReadiness {
  if (engine === 'brave') {
    const exe = resolveBravePath(env)
    return {
      engine, installed: exe !== null, executable: exe, overrideVar: 'GOGA_BRAVE_PATH',
      message: exe
        ? `Brave is installed (${exe}). Goga drives it with Playwright's Chromium engine.`
        : 'Brave is not installed where Goga can find it. Install Brave, or set GOGA_BRAVE_PATH to brave.exe. '
          + '(Goga can fall back to Playwright\'s bundled Chromium for a task, but it is not your Brave profile.)',
    }
  }
  const exe = resolveFirefoxPath(env)
  return {
    engine, installed: exe !== null, executable: exe, overrideVar: 'GOGA_FIREFOX_PATH',
    message: exe
      ? `Firefox is installed (${exe}). Goga drives it over WebDriver BiDi with its own profile.`
      : 'Firefox is not installed where Goga can find it. Install Firefox, or set GOGA_FIREFOX_PATH to firefox.exe.',
  }
}
