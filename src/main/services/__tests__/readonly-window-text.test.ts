import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readActiveWindowIdentity, readActiveWindowText } from '../../adapters/readOnlyWindowText'
const result = { window: { hwnd: 100, pid: 42, title: "Fixture's editor" }, texts: ['Actual UI text'], truncated: false }

describe('strict foreground UI-text boundary', () => {
  it('uses the exact foreground HWND/PID, bounds the text, skips password fields, and never activates or types', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify(result))
    expect(await readActiveWindowText(run, result.window.title, 42, 100)).toEqual(result)
    const script = run.mock.calls[0][0]
    expect(script).toContain('FromHandle($handle)')
    expect(script).toContain('$window.Current.NativeWindowHandle -ne 100')
    expect(script).toContain("Fixture''s editor")
    expect(script).toContain('Assert-ObservedWindow $handle $observedPid')
    expect(script).toContain('Assert-ObservedWindow $after $afterPid')
    expect(script).toContain('IsPassword')
    expect(script).toContain('6000')
    expect(script).not.toMatch(/SetFocus|SetForegroundWindow|SendKeys|PostMessage|InvokePattern|SetValue|ValuePattern/)
  })
  it.runIf(process.platform === 'win32')('both generated PowerShell readers parse and their native helpers compile without calling any desktop API', async () => {
    const scripts: string[] = []
    await readActiveWindowText(async source => { scripts.push(source); return JSON.stringify(result) }, result.window.title, 42, 100)
    await readActiveWindowIdentity(async source => { scripts.push(source); return JSON.stringify({ ...result.window, owner: 'Fixture.exe' }) })
    for (const script of scripts) {
      const native = script.match(/Add-Type @"\s*\n([\s\S]*?)\n"@/)![1]
      const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
      const check = `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(script)}'));$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|Out-String|Write-Error;exit 1};Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(native)}')))`
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-observation-compile-'))
      const file = path.join(temporary, 'compile.ps1')
      try {
        fs.writeFileSync(file, check, 'utf8')
        const actual = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true })
        expect(actual.status, actual.error?.message || actual.stderr).toBe(0)
      } finally {
        fs.unlinkSync(file)
        fs.rmdirSync(temporary)
      }
    }
  })
  it.each(['', 'broken JSON', '{}', JSON.stringify({ ...result, window: { ...result.window, pid: 99 } }), JSON.stringify({ ...result, window: { ...result.window, hwnd: 0 } }), JSON.stringify({ ...result, window: { ...result.window, hwnd: 200 } }), JSON.stringify({ ...result, texts: ['x'.repeat(6001)] })])('rejects invalid UI output %s', async raw => {
    await expect(readActiveWindowText(async () => raw, result.window.title, 42, 100)).rejects.toThrow()
  })
  it('preserves enumeration/native failures instead of converting them to empty text', async () => {
    await expect(readActiveWindowText(async () => { throw new Error('UI enumeration denied') }, result.window.title, 42, 100)).rejects.toThrow('UI enumeration denied')
  })
  it('rejects cancellation before or after the native read', async () => {
    const before = new AbortController(); before.abort()
    const run = vi.fn()
    await expect(readActiveWindowText(run, result.window.title, 42, 100, before.signal)).rejects.toThrow('cancelled')
    expect(run).not.toHaveBeenCalled()
    const after = new AbortController()
    await expect(readActiveWindowText(async () => { after.abort(); return JSON.stringify(result) }, result.window.title, 42, 100, after.signal)).rejects.toThrow('cancelled')
  })
  it.runIf(process.platform === 'win32').each([
    [100, 42, 100, 42, true],
    [200, 42, 200, 42, false],
    [100, 42, 200, 42, false],
    [100, 42, 100, 99, false],
    [100, 99, 100, 42, false],
    [0, 42, 100, 42, false],
  ])('executes the real HWND/PID guard for before=%s/%s after=%s/%s (accepted=%s)', async (beforeHwnd, beforePid, afterHwnd, afterPid, accepted) => {
    let script = ''
    await readActiveWindowText(async source => { script = source; return JSON.stringify(result) }, result.window.title, 42, 100)
    const guard = script.match(/    function Assert-ObservedWindow[\s\S]*?\n    }/)![0]
    const check = `${guard}\ntry { Assert-ObservedWindow ([IntPtr]${beforeHwnd}) ${beforePid}; Assert-ObservedWindow ([IntPtr]${afterHwnd}) ${afterPid}; Write-Output 'accepted' } catch { Write-Output 'rejected' }`
    const actual = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(check, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true })
    expect(actual.status, actual.stderr).toBe(0)
    expect(actual.stdout.trim()).toBe(accepted ? 'accepted' : 'rejected')
  })
  it('captures a validated HWND with the initial PID/title and preserves native identity errors', async () => {
    const identity = { ...result.window, owner: 'Fixture.exe' }
    const run = vi.fn().mockResolvedValue(JSON.stringify(identity))
    expect(await readActiveWindowIdentity(run)).toEqual(identity)
    expect(run.mock.calls[0][0]).toContain('$after -ne $handle')
    await expect(readActiveWindowIdentity(async () => JSON.stringify({ ...identity, hwnd: 0 }))).rejects.toThrow('Invalid active-window identity')
    await expect(readActiveWindowIdentity(async () => { throw new Error('Foreground changed during identity capture') })).rejects.toThrow('Foreground changed')
  })
})
