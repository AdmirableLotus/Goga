import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Microcontroller projects the way Schematik makes them (code, wiring, parts, pins and build
 * steps for Arduino, ESP32 or Raspberry Pi Pico), made on this PC with the free Arduino CLI.
 * The code Goga writes is compiled for the board, never run on the PC; installing board
 * support and uploading to a board are separate steps that ask first.
 */

export interface BoardInfo { label: string; fqbn: string; core: string; url?: string }

// Core versions are pinned to releases that have been out for a long while.
export const BOARDS: Record<string, BoardInfo> = {
  uno: { label: 'Arduino Uno', fqbn: 'arduino:avr:uno', core: 'arduino:avr@1.8.6' },
  nano: { label: 'Arduino Nano', fqbn: 'arduino:avr:nano', core: 'arduino:avr@1.8.6' },
  mega: { label: 'Arduino Mega 2560', fqbn: 'arduino:avr:mega', core: 'arduino:avr@1.8.6' },
  esp32: { label: 'ESP32 Dev Module', fqbn: 'esp32:esp32:esp32', core: 'esp32:esp32@3.1.1', url: 'https://espressif.github.io/arduino-esp32/package_esp32_index.json' },
  pico: { label: 'Raspberry Pi Pico', fqbn: 'rp2040:rp2040:rpipico', core: 'rp2040:rp2040@4.4.0', url: 'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json' },
}
const ALL_URLS = Object.values(BOARDS).map(b => b.url).filter(Boolean).join(',')

export interface ProjectPart { name: string; qty?: number; note?: string }
export interface ProjectWire { from: string; to: string; note?: string }
export interface MicroProject {
  name: string
  board: string
  code: string
  parts?: ProjectPart[]
  wiring?: ProjectWire[]
  steps?: string[]
}

export function boardFor(key: string): BoardInfo {
  const board = BOARDS[String(key ?? '').toLowerCase().replace(/^arduino[\s-]*/, '').replace(/[\s-]*dev.*$/, '')]
  if (!board) throw new Error(`unknown board "${key}" — use one of ${Object.keys(BOARDS).join(', ')}`)
  return board
}

/** Problems with a project that are cheaper to catch here than in a failed compile. */
export function checkProject(p: MicroProject): string[] {
  const problems: string[] = []
  if (!/^[\w-]{1,60}$/.test(p.name ?? '')) problems.push('name must be letters, digits, - or _ (up to 60)')
  try { boardFor(p.board) } catch (err) { problems.push((err as Error).message) }
  if (!p.code || !/\bvoid\s+setup\s*\(/.test(p.code) || !/\bvoid\s+loop\s*\(/.test(p.code)) problems.push('code needs void setup() and void loop()')
  if (p.code && p.code.length > 60_000) problems.push('code is too long')
  return problems
}

const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim()

/** The build guide: parts to buy, wiring table, pins, steps. */
export function projectGuide(p: MicroProject): string {
  const board = boardFor(p.board)
  const lines = [`# ${p.name}`, '', `Board: ${board.label}`, '']
  if (p.parts?.length) {
    lines.push('## Parts to get', '', '| Part | Qty | Note |', '|---|---|---|')
    for (const part of p.parts) lines.push(`| ${cell(part.name)} | ${part.qty ?? 1} | ${cell(part.note)} |`)
    lines.push('')
  }
  if (p.wiring?.length) {
    lines.push('## Wiring', '', '| From | To | Note |', '|---|---|---|')
    for (const w of p.wiring) lines.push(`| ${cell(w.from)} | ${cell(w.to)} | ${cell(w.note)} |`)
    lines.push('')
  }
  if (p.steps?.length) {
    lines.push('## Build steps', '')
    p.steps.forEach((s, i) => lines.push(`${i + 1}. ${String(s).trim()}`))
    lines.push('')
  }
  lines.push('## Code', '', `${p.name}.ino in this folder. Upload it from Goga, or open it in the Arduino IDE.`, '')
  return lines.join('\n')
}

/** The useful lines of a compiler's complaint. */
export function compileErrors(output: string): string {
  const errors = output.split(/\r?\n/).filter(l => /error|Error|undefined reference|not declared|No such file/.test(l))
  return (errors.length ? errors : output.split(/\r?\n/).filter(Boolean)).slice(0, 8).join('\n').slice(0, 1500)
}

export function findArduinoCli(): string | undefined {
  const local = process.env.LOCALAPPDATA ?? ''
  const candidates = [path.join(local, 'Microsoft', 'WinGet', 'Links', 'arduino-cli.exe')]
  const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages')
  if (fs.existsSync(packages)) {
    for (const d of fs.readdirSync(packages).filter(d => d.startsWith('ArduinoSA.CLI'))) candidates.push(path.join(packages, d, 'arduino-cli.exe'))
  }
  candidates.push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Arduino CLI', 'arduino-cli.exe'))
  return candidates.find(c => fs.existsSync(c))
}

export interface DetectedBoard { port: string; label: string; fqbn?: string }

export class MicrocontrollerService {
  constructor(private cli = findArduinoCli(), private outRoot = path.join(os.homedir(), 'Documents', 'Goga', 'Microcontrollers')) {}

  /** Boards plugged into this PC. */
  async connectedBoards(signal?: AbortSignal): Promise<DetectedBoard[]> {
    const out = await this.run(['board', 'list', '--format', 'json'], 30_000, signal)
    const parsed = JSON.parse(out) as { detected_ports?: { port?: { address?: string; protocol_label?: string }; matching_boards?: { name?: string; fqbn?: string }[] }[] }
    return (parsed.detected_ports ?? []).filter(d => d.port?.address).map(d => ({
      port: d.port!.address!,
      label: d.matching_boards?.[0]?.name ?? d.port!.protocol_label ?? 'unknown device',
      fqbn: d.matching_boards?.[0]?.fqbn,
    }))
  }

  /** Install a board's support package, and any libraries the code needs. */
  async setup(boardKey: string, libraries: string[] = [], signal?: AbortSignal): Promise<string> {
    const board = boardFor(boardKey)
    const done: string[] = []
    await this.run(['core', 'update-index'], 300_000, signal)
    await this.run(['core', 'install', board.core], 900_000, signal)
    done.push(`board support ${board.core}`)
    for (const lib of libraries) {
      if (!/^[\w .+-]{1,80}(@[\w.+-]{1,30})?$/.test(lib)) throw new Error(`"${lib}" is not a library name`)
      await this.run(['lib', 'install', lib], 300_000, signal)
      done.push(`library ${lib}`)
    }
    return `Installed ${done.join(', ')}`
  }

  /** Write the project folder and compile it for its board. */
  async build(p: MicroProject, signal?: AbortSignal): Promise<{ folder: string; guide: string; ok: boolean; report: string }> {
    const problems = checkProject(p)
    if (problems.length > 0) throw new Error(`The project needs fixing first: ${problems.join('; ')}`)
    const board = boardFor(p.board)
    const folder = path.join(this.outRoot, p.name)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, `${p.name}.ino`), p.code)
    const guide = path.join(folder, 'BUILD-GUIDE.md')
    fs.writeFileSync(guide, projectGuide(p))
    fs.writeFileSync(path.join(folder, 'project.json'), JSON.stringify({ board: p.board, fqbn: board.fqbn }, null, 2))
    try {
      const out = await this.run(['compile', '--fqbn', board.fqbn, folder], 600_000, signal)
      const size = out.split(/\r?\n/).filter(l => /Sketch uses|Global variables/.test(l)).join('\n')
      return { folder, guide, ok: true, report: size || 'compiled' }
    } catch (err) {
      const message = (err as Error).message
      if (/platform not installed|Platform '.*' not found|not installed/i.test(message)) {
        return { folder, guide, ok: false, report: `Board support for ${board.label} is not installed yet — microcontroller.setup installs it (asks first).` }
      }
      return { folder, guide, ok: false, report: compileErrors(message) }
    }
  }

  /** Compile and upload a built project to a board on a port. */
  async upload(name: string, port: string, signal?: AbortSignal): Promise<string> {
    if (!/^[\w-]{1,60}$/.test(name)) throw new Error('bad project name')
    if (!/^[\w/][\w./:-]{0,39}$/.test(port)) throw new Error(`"${port}" is not a board port (like COM3) — see microcontroller.boards`)
    const folder = path.join(this.outRoot, name)
    const info = JSON.parse(fs.readFileSync(path.join(folder, 'project.json'), 'utf8')) as { fqbn: string }
    await this.run(['compile', '--upload', '-p', port, '--fqbn', info.fqbn, folder], 600_000, signal)
    return `Uploaded ${name} to the board on ${port}`
  }

  private run(args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
    if (!this.cli) return Promise.reject(new Error('Arduino CLI is not installed — install it (free) with: winget install ArduinoSA.CLI'))
    return new Promise((resolve, reject) => {
      execFile(this.cli!, [...args, '--additional-urls', ALL_URLS], { windowsHide: true, timeout, signal, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${stderr}\n${stdout}`.trim() || err.message))
        else resolve(stdout)
      })
    })
  }
}
