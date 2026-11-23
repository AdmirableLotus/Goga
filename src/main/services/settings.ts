import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import type { AppSettings } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Store = require('electron-store')

/**
 * Remove one leading UTF-8 byte-order mark.
 *
 * `conf` hands the raw file text straight to `JSON.parse`, and `JSON.parse`
 * rejects a BOM ("Unexpected token '', is not valid JSON"), which is an
 * uncaught exception in the main process. PowerShell's `Set-Content -Encoding
 * UTF8` (and `Out-File`) writes a BOM, so any external edit of settings.json
 * puts the app in that state on the next launch. Stripping it here — rather
 * than fixing the file once — means the next external edit cannot break the app.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Parse settings text, tolerating a leading BOM, and require a JSON object. */
export function parseSettingsFile(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stripBom(text))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('the settings file does not contain a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** The file `electron-store` (`name: 'settings'`) reads in the main process. */
function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export class SettingsService {
  private static instance: SettingsService
  private store: ReturnType<typeof Store> | null
  private loadError: string | null

  static getInstance() {
    if (!SettingsService.instance) SettingsService.instance = new SettingsService()
    return SettingsService.instance
  }

  constructor() {
    const file = settingsFilePath()
    let loadError: string | null = null
    let existing: string | null = null

    try {
      existing = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        loadError = `Goga could not read its settings file at ${file}: ${(err as Error).message}. ` +
          'It is starting on default settings and will not save any until that file can be read.'
      }
    }

    // Read it ourselves first so a file that genuinely cannot be parsed is
    // reported instead of throwing out of the constructor (which is what kills
    // the main process before the window ever opens).
    if (existing !== null) {
      try {
        parseSettingsFile(existing)
      } catch (err) {
        loadError = `Goga could not read its settings file at ${file}: it is not valid JSON (${(err as Error).message}). ` +
          'It is starting on default settings and is leaving that file untouched; ' +
          'fix or move it, then restart Goga.'
      }
    }

    this.loadError = loadError
    if (loadError) {
      // No store: writing through `conf` here would replace a file we could not
      // understand, which could throw away whatever the user had in it.
      this.store = null
      console.error(`[settings] ${loadError}`)
      return
    }

    this.store = new Store({
      name: 'settings',
      // The same directory electron-store would derive itself from
      // app.getPath('userData'); passed explicitly so the store's own path and
      // the file this service reads and reports on can never differ.
      cwd: path.dirname(file),
      defaults: DEFAULT_SETTINGS,
      // `conf` calls this on every read. Stripping the BOM here covers the read
      // that happens inside the constructor, before we ever return a store.
      deserialize: (text: string) => parseSettingsFile(text)
    })
  }

  /** A readable reason the settings file was not used, or null when it loaded. */
  getLoadError(): string | null {
    return this.loadError
  }

  get(): AppSettings {
    if (!this.store) return { ...DEFAULT_SETTINGS }
    // Merge with defaults so new fields added to DEFAULT_SETTINGS are always present
    return { ...DEFAULT_SETTINGS, ...this.store.store } as AppSettings
  }

  set(patch: Partial<AppSettings>): AppSettings {
    if (!this.store) {
      throw new Error(this.loadError ??
        'Goga cannot save settings because its settings file could not be read.')
    }
    this.store.set(patch)
    return this.get()
  }
}
