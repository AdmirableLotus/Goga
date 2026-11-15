import fs from 'fs'
import path from 'path'

/**
 * Where the business layer keeps its files.
 *
 * Resolved lazily and defensively so the pure logic in this folder can be unit tested
 * outside Electron. When Electron's userData folder is unavailable the callers fall back
 * to memory and say so, rather than writing somewhere unexpected.
 */
export function businessDir(): string | null {
  try {
    // Required lazily: importing 'electron' from a plain Node test process throws.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } }
    if (typeof electron?.app?.getPath !== 'function') return null
    const dir = electron.app.getPath('userData')
    return dir || null
  } catch {
    return null
  }
}

export function businessFile(name: string): string | null {
  const dir = businessDir()
  return dir ? path.join(dir, name) : null
}

export function ensureDirFor(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}
