import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
vi.mock('screenshot-desktop', () => ({default:vi.fn()}))
vi.mock('@nut-tree-fork/nut-js', () => ({}))
vi.mock('child_process', () => ({spawn:vi.fn()}))
import { spawn } from 'child_process'
import { DesktopAdapter } from '../../adapters/desktop'
import { consumePowerShellDiagnostics } from '../plannerDiagnostics'

const previousTrace = process.env.GOGA_PLANNER_TRACE
afterEach(() => {
  vi.clearAllMocks()
  if (previousTrace === undefined) delete process.env.GOGA_PLANNER_TRACE
  else process.env.GOGA_PLANNER_TRACE = previousTrace
})
function adapter(output: string | Error) {
  const desktop = new DesktopAdapter()
  Object.assign(desktop,{runPS:output instanceof Error ? vi.fn().mockRejectedValue(output) : vi.fn().mockResolvedValue(output)})
  return desktop
}

describe('cleanup native boundary errors are preserved', () => {
  it('returns the exact PostMessage outcome and Win32 code', async () => {
    expect(await adapter('{"requested":false,"win32Error":5}').postClose(100)).toEqual({requested:false,win32Error:5})
  })
  it('propagates a close-request helper error', async () => {
    await expect(adapter(new Error('fixture PS error')).postClose(100)).rejects.toThrow('fixture PS error')
  })
  it.each(['', '{}', '{"requested":true}'])('rejects malformed close-request output %j', async output => {
    await expect(adapter(output).postClose(100)).rejects.toThrow()
  })
  it.each(['', 'garbage', '{}', '[]'])('strict dialog lookup rejects malformed output %j', async output => {
    await expect(adapter(output).findElementByHwnd(100,"Don't Save",true)).rejects.toThrow()
  })
  it('distinguishes a lookup exception from clean absence', async () => {
    await expect(adapter(new Error('fixture lookup error')).findElementByHwnd(100,"Don't Save",true)).rejects.toThrow('fixture lookup error')
    expect(await adapter('null').findElementByHwnd(100,"Don't Save",true)).toBeNull()
  })
  it.each([new Error('fixture native read error'), ''])('strict window-state reads never disguise an error as closure', async output => {
    await expect(adapter(output).isWindow(100,true)).rejects.toThrow()
    expect(await adapter('false').isWindow(100,true)).toBe(false)
  })
})

describe('helper diagnostics survive failure and use the opt-in redactor', () => {
  it('recovers chunked stdout metadata before rejecting a failed helper, without logging secrets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'goga-cleanup-trace-'))
    const trace = path.join(dir,'trace.jsonl')
    process.env.GOGA_PLANNER_TRACE = trace
    try {
      vi.mocked(spawn).mockImplementation(() => {
        const child = Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:vi.fn()})
        queueMicrotask(() => {
          const diagnostic = 'GOGA_FILENAME_DIAGNOSTIC:'+JSON.stringify({stage:'filename_path',checks:[{reason:'foreground_hwnd',expected:100,observed:200,passed:false}],identities:{foreground:{hwnd:200,pid:77},nested:[{api_key:'fixture-secret-credential'}]}})+'\n'
          child.stdout.emit('data',Buffer.from(diagnostic.slice(0,18)))
          child.stdout.emit('data',Buffer.from(diagnostic.slice(18)))
          child.stdout.emit('data',Buffer.from('GOGA_FILENAME_DIAGNOSTIC:{"nested":[{"password":"fixture secret phrase"}]BROKEN\n'))
          child.stderr.emit('data',Buffer.from('filename_input_target_mismatch:foreground_hwnd expected=100 observed=200'))
          child.emit('close',1)
        })
        return child as any
      })
      const desktop = new DesktopAdapter()
      await expect((desktop as any).runPS('# inert fixture; spawn is mocked',undefined,undefined,true)).rejects.toThrow('foreground_hwnd expected=100 observed=200')
      const raw = fs.readFileSync(trace,'utf8')
      expect(raw).not.toContain('fixture-secret-credential')
      expect(raw).not.toContain('fixture secret phrase')
      const records = raw.trim().split('\n').map(line=>JSON.parse(line))
      expect(records[0]).toMatchObject({event:'filename.input.check',checks:[{reason:'foreground_hwnd',expected:100,observed:200,passed:false}],identities:{foreground:{hwnd:200,pid:77},nested:[{api_key:'[REDACTED]'}]}})
      expect(records[1]).toMatchObject({event:'filename.input.diagnostic_error',error:'Invalid filename diagnostic record'})
    } finally { fs.rmSync(dir,{recursive:true,force:true}) }
  })
  it('strips metadata from the tool return and emits nothing without an absolute trace path', () => {
    process.env.GOGA_PLANNER_TRACE = 'relative-fixture.log'
    const append = vi.spyOn(fs,'appendFileSync')
    try {
      expect(consumePowerShellDiagnostics('GOGA_FILENAME_DIAGNOSTIC:{"stage":"fixture"}\r\nok:fixture-path')).toBe('ok:fixture-path')
      expect(append).not.toHaveBeenCalled()
    } finally { append.mockRestore() }
  })
  it('preserves ordinary output and CRLF bytes while removing only marked diagnostic lines', () => {
    delete process.env.GOGA_PLANNER_TRACE
    expect(consumePowerShellDiagnostics('first\r\nlast\r\n')).toBe('first\r\nlast\r\n')
    expect(consumePowerShellDiagnostics('first\r\nGOGA_FILENAME_DIAGNOSTIC:{}\r\nlast\r\n')).toBe('first\r\nlast\r\n')
  })
})
