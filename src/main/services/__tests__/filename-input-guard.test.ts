import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
vi.mock('screenshot-desktop', () => ({ default: vi.fn() }))
vi.mock('@nut-tree-fork/nut-js', () => ({}))
import { FILENAME_INPUT_GUARD_PS } from '../../adapters/filenameInputGuard'
import { DesktopAdapter } from '../../adapters/desktop'

// Run the actual production PowerShell guard with simulated native boundaries.
// Send-FilenameKeys records strings only: no Win32 or keyboard API is loaded.
function simulate(setup: string, afterSend = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-input-guard-'))
  const file = path.join(dir, 'guard.ps1')
  try {
    fs.writeFileSync(file, `
$ErrorActionPreference = 'Stop'
$script:foreground = 100
$script:owner = 77
$script:cancelled = $false
$script:sent = @()
${setup}
function Get-FilenameForeground { $script:foreground }
function Get-FilenameOwner([long]$Handle) { $script:owner }
function Test-Path([string]$LiteralPath) { $script:cancelled }
function Send-FilenameKeys([string]$Keys) { $script:sent += $Keys; ${afterSend} }
${FILENAME_INPUT_GUARD_PS}
$errorText = $null
try {
  Invoke-GuardedFilenameKeys 100 77 'fixture-cancel' '^a'
  Invoke-GuardedFilenameKeys 100 77 'fixture-cancel' 'fixture-path'
} catch { $errorText = $_.Exception.Message }
@{ sent=@($script:sent); error=$errorText } | ConvertTo-Json -Compress
`, 'utf8')
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {encoding:'utf8',windowsHide:true,timeout:5000}))
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir) }
}

describe.skipIf(process.platform !== 'win32')('filename SendKeys guard (no real input)', () => {
  it('dispatches no input if a different same-PID HWND is foreground', () => {
    expect(simulate('$script:foreground = 200')).toEqual({sent:[],error:'filename_input_target_mismatch'})
  })
  it('dispatches no input if the expected HWND has a different PID', () => {
    expect(simulate('$script:owner = 88')).toEqual({sent:[],error:'filename_input_target_mismatch'})
  })
  it('dispatches no input if cancellation is already set', () => {
    expect(simulate('$script:cancelled = $true')).toEqual({sent:[],error:'filename_input_cancelled'})
  })
  it('rechecks exact target before the second SendKeys call', () => {
    expect(simulate('', '$script:foreground = 200')).toEqual({sent:['^a'],error:'filename_input_target_mismatch'})
  })
  it('rechecks cancellation before the second SendKeys call', () => {
    expect(simulate('', '$script:cancelled = $true')).toEqual({sent:['^a'],error:'filename_input_cancelled'})
  })
  it('allows both calls only while target and cancellation checks pass', () => {
    expect(simulate('')).toEqual({sent:['^a','fixture-path'],error:null})
  })
})

describe('filename adapter cancellation and guard wiring', () => {
  it.skipIf(process.platform !== 'win32')('generated PowerShell parses and its native helper compiles without executing input', async () => {
    const desktop = new DesktopAdapter()
    let generated = ''
    Object.assign(desktop, {runPS:async (script: string) => { generated = script; return 'ok:fixture-path' }})
    await desktop.setFilenameInSaveAs(100, 'fixture-path', 77)
    const encoded = Buffer.from(generated).toString('base64')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-input-syntax-'))
    const file = path.join(dir, 'syntax.ps1')
    try {
      fs.writeFileSync(file, `
$ErrorActionPreference = 'Stop'
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$tokens = $null; $errors = $null
[System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count) { throw ($errors | Out-String) }
$helper = [regex]::Match($source, '(?s)Add-Type @"(.*?)"@').Groups[1].Value
Add-Type -TypeDefinition $helper
Write-Output 'syntax-ok'
`)
      expect(execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file], {encoding:'utf8',windowsHide:true,timeout:10000}).trim()).toBe('syntax-ok')
    } finally { fs.unlinkSync(file); fs.rmdirSync(dir) }
  })
  it('does not start a helper for an already cancelled call', async () => {
    const desktop = new DesktopAdapter()
    const runPS = vi.fn()
    Object.assign(desktop, {runPS})
    const controller = new AbortController(); controller.abort()
    expect(await desktop.setFilenameInSaveAs(100, 'fixture-path', 77, controller.signal)).toEqual({ok:false,reason:'filename_input_cancelled'})
    expect(runPS).not.toHaveBeenCalled()
  })
  it('wires the verified PID, signal and both guarded dispatches into the real script', async () => {
    const desktop = new DesktopAdapter()
    const controller = new AbortController()
    const runPS = vi.fn().mockResolvedValue('ok:fixture-path')
    Object.assign(desktop, {runPS})
    expect(await desktop.setFilenameInSaveAs(100, 'fixture-path', 77, controller.signal)).toEqual({ok:true,actual:'fixture-path'})
    const [script, , signal] = runPS.mock.calls[0]
    expect(signal).toBe(controller.signal)
    expect(script).toContain("Invoke-GuardedFilenameKeys 100 77 $cancelPath '^a'")
    expect(script).toContain("Invoke-GuardedFilenameKeys 100 77 $cancelPath 'fixture-path'")
    expect(script.match(/SendWait\(/g)).toHaveLength(1) // Only the guarded boundary wrapper.
  })
  it('sets a cancellation marker until the helper settles, then removes it', async () => {
    const desktop = new DesktopAdapter()
    const controller = new AbortController()
    let marker = ''
    Object.assign(desktop, {runPS: async (script: string) => {
      marker = script.match(/\$cancelPath = '([^']+)'/)![1]
      controller.abort()
      expect(fs.existsSync(marker)).toBe(true)
      throw new Error('cancelled')
    }})
    expect(await desktop.setFilenameInSaveAs(100, 'fixture-path', 77, controller.signal)).toEqual({ok:false,reason:'filename_input_cancelled'})
    expect(fs.existsSync(marker)).toBe(false)
  })
})
