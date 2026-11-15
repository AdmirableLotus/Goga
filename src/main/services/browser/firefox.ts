import { execFile, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'

/**
 * Finding, launching and recognising Mozilla Firefox.
 *
 * The important fact this file exists to encode: Firefox 160 does NOT speak the Chrome
 * DevTools Protocol. `--remote-debugging-port` brings up a WebDriver BiDi endpoint, and
 * `/json/version` answers 404. Anything that expects CDP will fail against it, so the
 * layer above this one speaks BiDi.
 *
 * Goga launches Firefox itself, with its own profile directory, so it never touches the
 * profile the user browses in and never needs a cookie or a password out of it.
 */

export const DEFAULT_DEBUG_PORT = 9333

/** Where Firefox is on this machine, or null when it is not installed. */
export function resolveFirefoxPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.GOGA_FIREFOX_PATH?.trim()
  if (override && fs.existsSync(override)) return override

  const candidates: string[] = []
  if (process.platform === 'win32') {
    const programFiles = env.PROGRAMFILES || 'C:\\Program Files'
    const programFilesX86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    candidates.push(
      path.join(programFiles, 'Mozilla Firefox', 'firefox.exe'),
      path.join(programFilesX86, 'Mozilla Firefox', 'firefox.exe'),
      path.join(local, 'Mozilla Firefox', 'firefox.exe'),
    )
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Firefox.app/Contents/MacOS/firefox')
  } else {
    candidates.push('/usr/bin/firefox', '/usr/lib/firefox/firefox', '/snap/bin/firefox', '/usr/bin/firefox-esr')
  }

  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate } catch { /* keep looking */ }
  }
  return null
}

export interface PortProbe {
  /** Something is listening on the port. */
  listening: boolean
  /** It answered as a WebDriver BiDi endpoint. */
  bidi: boolean
  /** The browser named itself in a handshake, when one was attempted. */
  browserName: string | null
  browserVersion: string | null
  /** Plain words about what was found, for the user. */
  detail: string
}

/**
 * Ask the port what it is, without attaching.
 *
 * A CDP endpoint answers `/json/version` with JSON. A Firefox BiDi endpoint answers 404
 * there, and the only definitive test is whether a websocket upgrade to `/session`
 * succeeds — Firefox creates a session on `session.new`, not on connect, so opening and
 * closing the socket leaves nothing behind.
 *
 * That difference is how the layer tells "Firefox is up" from "something else owns this
 * port", and it is why the layer can say plainly what is wrong instead of failing
 * silently.
 */
export async function probePort(port: number, timeoutMs = 2_500): Promise<PortProbe> {
  const base = `http://127.0.0.1:${port}`
  const get = async (p: string) => {
    try {
      const res = await fetch(base + p, { signal: AbortSignal.timeout(timeoutMs) })
      return { status: res.status, body: await res.text() }
    } catch {
      return null
    }
  }

  const version = await get('/json/version')
  if (!version) {
    return { listening: false, bidi: false, browserName: null, browserVersion: null, detail: `nothing is listening on port ${port}` }
  }
  if (version.status === 200) {
    // A CDP endpoint. That is Chromium-family, not Firefox, so Goga will not drive it.
    let name: string | null = null
    try { name = (JSON.parse(version.body) as { Browser?: string }).Browser ?? null } catch { /* not JSON */ }
    return {
      listening: true, bidi: false, browserName: name, browserVersion: null,
      detail: `port ${port} is a Chrome DevTools endpoint${name ? ` (${name})` : ''}, not Firefox`,
    }
  }

  // Not CDP. The definitive test is whether the BiDi websocket accepts an upgrade.
  const upgraded = await canUpgradeToBidi(port, timeoutMs)
  if (upgraded) {
    return {
      listening: true, bidi: true, browserName: 'firefox', browserVersion: null,
      detail: `port ${port} is a WebDriver BiDi endpoint, which is what Firefox 160 serves`,
    }
  }
  return {
    listening: true, bidi: false, browserName: null, browserVersion: null,
    detail: `port ${port} is in use by something that is not a browser debugging endpoint`,
  }
}

/** True when a websocket upgrade to the BiDi endpoint succeeds. Leaves no session behind. */
function canUpgradeToBidi(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closed */ }
      resolve(value)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    let socket: WebSocket
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}/session`, { maxPayload: 1024 * 1024 })
    } catch {
      clearTimeout(timer)
      return resolve(false)
    }
    socket.once('open', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** The websocket address a Firefox BiDi endpoint listens on. */
export function bidiUrl(port: number): string {
  return `ws://127.0.0.1:${port}/session`
}

export interface LaunchResult {
  launched: boolean
  pid: number | null
  /** Plain words: what happened, and what the user would have to do if it did not. */
  message: string
}

/**
 * Start Firefox on the debugging port with Goga's own profile.
 *
 * `--no-remote` keeps this instance from joining a Firefox the user already has open, and
 * `--profile` points it at a directory under Goga's userData, so the user's real profile
 * is never opened, read or modified. `-new-instance` is not used: on Windows `--no-remote`
 * plus a distinct profile is what actually produces a separate process.
 */
export function launchFirefox(opts: {
  executable: string
  port: number
  profileDir: string
  url?: string
}): LaunchResult {
  const { executable, port, profileDir, url } = opts
  if (!fs.existsSync(executable)) {
    return { launched: false, pid: null, message: `Firefox is not at ${executable}. Install it, or set GOGA_FIREFOX_PATH to where it is.` }
  }
  try { fs.mkdirSync(profileDir, { recursive: true }) } catch (err) {
    return { launched: false, pid: null, message: `Goga could not create its Firefox profile folder at ${profileDir}: ${err instanceof Error ? err.message : String(err)}` }
  }

  const args = [
    `--remote-debugging-port=${port}`,
    '--profile', profileDir,
    '--no-remote',
    '--new-window',
    url ?? 'about:blank',
  ]
  try {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return {
      launched: true, pid: child.pid ?? null,
      message: `Started Firefox on port ${port} with Goga's own profile. It is a separate window from the Firefox you browse in.`,
    }
  } catch (err) {
    return { launched: false, pid: null, message: `Goga could not start Firefox: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** True when a process with this name is running. Used only to explain a port that is dead. */
export function firefoxRunning(): Promise<boolean> {
  return new Promise(resolve => {
    const cmd = process.platform === 'win32' ? 'tasklist' : 'ps'
    const args = process.platform === 'win32' ? ['/fi', 'imagename eq firefox.exe'] : ['-A']
    execFile(cmd, args, { windowsHide: true, timeout: 8_000 }, (err, stdout) => {
      if (err) return resolve(false)
      resolve(process.platform === 'win32' ? /firefox\.exe/i.test(String(stdout)) : /firefox/i.test(String(stdout)))
    })
  })
}
