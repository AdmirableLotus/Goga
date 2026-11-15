import fs from 'fs'
import path from 'path'

/**
 * Where OSINT files live, resolved lazily so the pure logic in this folder can be unit
 * tested outside Electron. When Electron's userData folder is unavailable the callers
 * fall back to memory and say so, rather than writing somewhere unexpected.
 */
export function osintDir(): string | null {
  try {
    // Required lazily: importing 'electron' from a plain Node test process throws.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } }
    // Called on `app` itself: `getPath` is a method and loses its binding when detached.
    if (typeof electron?.app?.getPath !== 'function') return null
    const dir = electron.app.getPath('userData')
    return dir || null
  } catch {
    return null
  }
}

export function osintFile(name: string): string | null {
  const dir = osintDir()
  return dir ? path.join(dir, name) : null
}

export function ensureDirFor(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}
