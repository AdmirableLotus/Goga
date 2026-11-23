import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The real settings path: electron-store resolves its cwd from app.getPath('userData').
// The mock points that at a throwaway folder so no real %APPDATA%\goga is ever touched.
// electron-store remembers the first userData dir it saw, so every test re-imports
// the module (vi.resetModules) after pointing the mock at a fresh folder.
let userDataDir = ''
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir, getVersion: () => '0.0.0-test' },
  ipcMain: { on: () => { /* no listener needed for a store read */ } },
  ipcRenderer: undefined,
  shell: {}
}))

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

function settingsFile() {
  return path.join(userDataDir, 'settings.json')
}

function writeSettings(bytes: Buffer) {
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(settingsFile(), bytes)
}

/** Load the service fresh, the way main.ts loads it on startup. */
async function loadService() {
  vi.resetModules()
  const mod = await import('../settings')
  return { SettingsService: mod.SettingsService, parseSettingsFile: mod.parseSettingsFile, stripBom: mod.stripBom, DEFAULT_SETTINGS: (await import('../../../shared/types')).DEFAULT_SETTINGS }
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-settings-bom-'))
})

afterEach(() => {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('settings file with a UTF-8 byte-order mark', () => {
  it('loads a BOM-prefixed settings file instead of crashing the main process', async () => {
    // This is the exact shape of the file that crashed Goga: PowerShell's
    // ConvertTo-Json (4-space indent) written with an encoding that adds a BOM + CRLF.
    const body = JSON.stringify({ theme: 'light', braveSessionMode: 'everyday' }, null, 4).replace(/\n/g, '\r\n')
    writeSettings(Buffer.concat([BOM, Buffer.from(body, 'utf8')]))
    const { SettingsService, DEFAULT_SETTINGS } = await loadService()

    const settings = new SettingsService().get()

    // Values in the file win over defaults, so the user's own settings survive.
    expect(settings.theme).toBe('light')
    expect(settings.braveSessionMode).toBe('everyday')
    // Fields the file does not hold still come from defaults.
    expect(settings.sttProvider).toBe(DEFAULT_SETTINGS.sttProvider)
  })

  it('reads a BOM-prefixed file that has no other damage as the same object as without the BOM', async () => {
    const { parseSettingsFile } = await loadService()
    const text = JSON.stringify({ theme: 'dark', voiceEnabled: false }, null, 4)
    expect(parseSettingsFile('\uFEFF' + text)).toEqual(JSON.parse(text))
  })

  it('strips only a leading BOM and leaves the rest of the text alone', async () => {
    const { stripBom } = await loadService()
    expect(stripBom('\uFEFF{"a":1}')).toBe('{"a":1}')
    expect(stripBom('{"a":"\uFEFF"}')).toBe('{"a":"\uFEFF"}')
  })

  it('writes back without a BOM, so a later read never depends on the strip', async () => {
    writeSettings(Buffer.concat([BOM, Buffer.from(JSON.stringify({ theme: 'dark' }), 'utf8')]))
    const { SettingsService } = await loadService()
    const svc = new SettingsService()
    svc.set({ theme: 'light' })

    const onDisk = fs.readFileSync(settingsFile())
    expect(onDisk[0]).not.toBe(0xef)
    // Plain JSON.parse on the bytes Goga wrote — exactly what conf does next launch.
    expect(JSON.parse(onDisk.toString('utf8')).theme).toBe('light')
  })
})

describe('settings file that genuinely cannot be parsed', () => {
  it('does not throw out of the constructor, so the main process still starts', async () => {
    writeSettings(Buffer.from('{ this is not json', 'utf8'))
    const { SettingsService } = await loadService()
    expect(() => new SettingsService()).not.toThrow()
  })

  it('starts on defaults and reports a readable message naming the file', async () => {
    writeSettings(Buffer.from('{ this is not json', 'utf8'))
    const { SettingsService, DEFAULT_SETTINGS } = await loadService()
    const svc = new SettingsService()

    expect(svc.get()).toEqual(DEFAULT_SETTINGS)
    const message = svc.getLoadError() ?? ''
    expect(message).toContain(settingsFile())
    expect(message).toMatch(/not valid JSON/i)
    // A raw SyntaxError leaking out would have read "Unexpected token".
    expect(message).not.toMatch(/Unexpected token/i)
  })

  it('leaves an unreadable file exactly as it found it', async () => {
    const bad = Buffer.from('{ this is not json', 'utf8')
    writeSettings(bad)
    const { SettingsService } = await loadService()
    new SettingsService()
    expect(fs.readFileSync(settingsFile()).equals(bad)).toBe(true)
  })

  it('refuses to write settings over a file it could not read, with a readable error', async () => {
    writeSettings(Buffer.from('{ this is not json', 'utf8'))
    const { SettingsService } = await loadService()
    const svc = new SettingsService()
    expect(() => svc.set({ theme: 'light' })).toThrow(/not valid JSON/i)
  })
})

describe('settings file that is absent', () => {
  it('starts on defaults and reports no load error', async () => {
    const { SettingsService, DEFAULT_SETTINGS } = await loadService()
    const svc = new SettingsService()
    expect(svc.get()).toEqual(DEFAULT_SETTINGS)
    expect(svc.getLoadError()).toBeNull()
  })
})
