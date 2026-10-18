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
$script:foreground = 200
$script:owner = 77
$script:cancelled = $false
$script:sent = @()
$script:diagnostics = @()
$script:ownerReads = 0
$script:destroyed = @()
$script:dialogOwned = $true
$script:controlInDialog = $true
$script:filenameStage = 'select_all'
${setup}
function Get-FilenameForeground { $script:foreground }
function Get-FilenameOwner([long]$Handle) {
  $script:ownerReads++
  if ($script:foregroundOwner -and $script:ownerReads % 4 -eq 0) { return $script:foregroundOwner }
  if ($Handle -eq 200 -and $script:dialogOwner) { return $script:dialogOwner }
  if ($Handle -eq 300 -and $script:controlOwner) { return $script:controlOwner }
  if ($Handle -eq 900) { return 88 }
  return $script:owner
}
function Test-FilenameWindow([long]$Handle) { $Handle -ne 0 -and $script:destroyed -notcontains $Handle }
function Test-FilenameOwnerChain([long]$Child, [long]$Frame) { $script:dialogOwned -and $Frame -eq 100 -and @(200,201) -contains $Child }
function Test-FilenameChild([long]$Parent, [long]$Child) { $script:controlInDialog -and $Parent -eq 200 -and $Child -eq 300 }
function Get-FilenameContext { @{ fixture=$true } }
function Write-FilenameDiagnostic($Data) { $script:diagnostics += $Data; if ($script:cancelDuringDiagnostic) { $script:cancelled=$true } }
function Test-Path([string]$LiteralPath) { $script:cancelled }
function Send-FilenameKeys([string]$Keys) { $script:sent += $Keys; ${afterSend} }
${FILENAME_INPUT_GUARD_PS}
$errorText = $null
try {
  Invoke-GuardedFilenameKeys 100 200 300 77 'fixture-cancel' '^a'
  $script:filenameStage = 'filename_path'
  Invoke-GuardedFilenameKeys 100 200 300 77 'fixture-cancel' 'fixture-path'
} catch { $errorText = $_.Exception.Message }
@{ sent=@($script:sent); error=$errorText; diagnostics=@($script:diagnostics) } | ConvertTo-Json -Depth 10 -Compress
`, 'utf8')
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {encoding:'utf8',windowsHide:true,timeout:5000}))
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir) }
}

describe.skipIf(process.platform !== 'win32')('filename SendKeys guard (no real input)', () => {
  it('rejects another same-PID dialog even when it belongs to the same frame', () => {
    const result = simulate('$script:foreground = 201')
    expect(result).toMatchObject({sent:[],error:'filename_input_target_mismatch:foreground_hwnd expected=200 observed=201'})
    expect(result.diagnostics[0]).toMatchObject({stage:'select_all',rejected:true,identities:{foregroundAtCheck:{hwnd:201,pid:77},expectedInput:{frameHwnd:100,dialogHwnd:200,filenameControlHwnd:300,pid:77}}})
    expect(result.diagnostics[0].checks).toContainEqual({reason:'foreground_hwnd',expected:200,observed:201,passed:false})
  })
  it('rejects an unrelated foreground window and reports both HWND and PID mismatches', () => {
    const result = simulate('$script:foreground = 900')
    expect(result.sent).toEqual([])
    expect(result.diagnostics[0].checks.filter((c:any)=>!c.passed)).toEqual([
      {reason:'foreground_hwnd',expected:200,observed:900,passed:false},
      {reason:'foreground_pid',expected:77,observed:88,passed:false}
    ])
  })
  it('rejects the parent frame as foreground during Save As', () => {
    expect(simulate('$script:foreground=100')).toMatchObject({sent:[],error:'filename_input_target_mismatch:foreground_hwnd expected=200 observed=100'})
  })
  it('dispatches no input if the expected HWND has a different PID', () => {
    expect(simulate('$script:owner = 88')).toMatchObject({sent:[],error:'filename_input_target_mismatch:frame_pid expected=77 observed=88'})
  })
  it('identifies foreground PID independently from the frame PID', () => {
    const result = simulate('$script:foregroundOwner = 88')
    expect(result).toMatchObject({sent:[],error:'filename_input_target_mismatch:foreground_pid expected=77 observed=88'})
    expect(result.diagnostics[0].checks).toContainEqual({reason:'foreground_pid',expected:77,observed:88,passed:false})
  })
  it.each([['dialogOwner','dialog_pid'],['controlOwner','filename_control_pid']])('rejects wrong %s PID', (variable, reason) => {
    expect(simulate(`$script:${variable}=88`)).toMatchObject({sent:[],error:`filename_input_target_mismatch:${reason} expected=77 observed=88`})
  })
  it('requires the recorded dialog owner chain to contain the recorded frame', () => {
    expect(simulate('$script:dialogOwned=$false')).toMatchObject({sent:[],error:'filename_input_target_mismatch:dialog_owned_by_frame expected=True observed=False'})
  })
  it('requires the recorded filename control to remain a child of the recorded dialog', () => {
    expect(simulate('$script:controlInDialog=$false')).toMatchObject({sent:[],error:'filename_input_target_mismatch:filename_control_child_of_dialog expected=True observed=False'})
  })
  it.each([[100,'frame_exists'],[200,'dialog_exists'],[300,'filename_control_exists']])('rejects destroyed HWND %i before any input', (hwnd, reason) => {
    expect(simulate(`$script:destroyed=@(${hwnd})`)).toMatchObject({sent:[],error:`filename_input_target_mismatch:${reason} expected=True observed=False`})
  })
  it('dispatches no input if cancellation is already set', () => {
    expect(simulate('$script:cancelled = $true')).toMatchObject({sent:[],error:'filename_input_cancelled',diagnostics:[]})
  })
  it('rechecks exact target before the second SendKeys call', () => {
    const result = simulate('', '$script:foreground = 201')
    expect(result).toMatchObject({sent:['^a'],error:'filename_input_target_mismatch:foreground_hwnd expected=200 observed=201'})
    expect(result.diagnostics[1].stage).toBe('filename_path')
  })
  it('rechecks cancellation before the second SendKeys call', () => {
    expect(simulate('', '$script:cancelled = $true')).toMatchObject({sent:['^a'],error:'filename_input_cancelled'})
  })
  it('rechecks cancellation after identity validation and before SendKeys', () => {
    expect(simulate('$script:cancelDuringDiagnostic=$true')).toMatchObject({sent:[],error:'filename_input_cancelled'})
  })
  it.each([[200,'dialog_exists','$script:destroyed=@(200)'],[300,'filename_control_exists','$script:destroyed=@(300)'],[200,'dialog_owned_by_frame','$script:dialogOwned=$false'],[300,'filename_control_child_of_dialog','$script:controlInDialog=$false']])('rechecks identity/relationship %s before the filename-path dispatch', (_hwnd, reason, mutation) => {
    expect(simulate('',String(mutation))).toMatchObject({sent:['^a'],error:`filename_input_target_mismatch:${reason} expected=True observed=False`})
  })
  it('allows the exact owned Save As dialog in foreground for both dispatches', () => {
    expect(simulate('')).toMatchObject({sent:['^a','fixture-path'],error:null})
  })
})

describe('filename adapter cancellation and guard wiring', () => {
  it.skipIf(process.platform !== 'win32')('records native relationships separately from UIA subtree membership, including a zero dialog HWND', async () => {
    const desktop = new DesktopAdapter()
    let generated = ''
    const previousTrace = process.env.GOGA_PLANNER_TRACE
    try {
      process.env.GOGA_PLANNER_TRACE = path.join(os.tmpdir(),'fixture-opt-in-unused.jsonl')
      Object.assign(desktop,{runPS:async (script: string) => {generated=script;return 'ok:fixture-path'}})
      await desktop.setFilenameInSaveAs(100,'fixture-path',77)
    } finally {
      if (previousTrace === undefined) delete process.env.GOGA_PLANNER_TRACE
      else process.env.GOGA_PLANNER_TRACE = previousTrace
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'goga-identity-fixture-'))
    const file = path.join(dir,'identity.ps1')
    try {
      // Extract only the production metadata functions. All Win32 boundaries
      // are inert C# fixtures; the input and foreground-changing code is never run.
      fs.writeFileSync(file, `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
public static class SKHelper {
  public static IntPtr GetParent(IntPtr h) { return new IntPtr(h.ToInt64()==300 ? 200 : h.ToInt64()==200 ? 100 : 0); }
  public static IntPtr GetWindow(IntPtr h, uint command) { return GetParent(h); }
  public static IntPtr GetAncestor(IntPtr h, uint flags) { return new IntPtr(100); }
  public static bool IsChild(IntPtr parent, IntPtr child) { return parent.ToInt64()==100 ? child.ToInt64()==200 || child.ToInt64()==300 : parent.ToInt64()==200 && child.ToInt64()==300; }
}
"@
function Get-FilenameForeground { 300 }
function Get-FilenameOwner([long]$Handle) { 77 }
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(generated).toString('base64')}'))
$parseTokens=$null; $parseErrors=$null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$parseTokens,[ref]$parseErrors)
$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and @('Get-FilenameContext','Get-FilenameIdentity','Test-FilenameOwnerChain') -contains $node.Name },$true)
foreach($definition in $functions) { Invoke-Expression $definition.Extent.Text }
$script:filenameField = [PSCustomObject]@{Current=[PSCustomObject]@{NativeWindowHandle=300;ProcessId=77}}
$results = @()
foreach($dialogHwnd in @(200,0)) {
  $script:filenameDialog = [PSCustomObject]@{Current=[PSCustomObject]@{NativeWindowHandle=$dialogHwnd;ProcessId=77}}
  $results += Get-FilenameContext
}
ConvertTo-Json -InputObject $results -Depth 10 -Compress
`)
      const identities = JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file],{encoding:'utf8',windowsHide:true,timeout:10000}))
      expect(identities[0]).toMatchObject({expected:{hwnd:100,pid:77},frame:{hwnd:100,pid:77},dialog:{hwnd:200,pid:77,ownerHwnd:100},filenameControl:{hwnd:300,pid:77,parentHwnd:200},foreground:{hwnd:300,pid:77},relationships:{dialogFoundInExactFrameSubtree:true,filenameFoundInDialogSubtree:true,dialogWin32OwnerChainContainsFrame:true,filenameIsChildOfFrame:true,filenameIsChildOfDialog:true,foregroundWin32OwnerChainContainsFrame:true}})
      expect(identities[1]).toMatchObject({dialog:{hwnd:0,pid:null},dialogUiaPid:77,relationships:{dialogFoundInExactFrameSubtree:true,dialogWin32OwnerChainContainsFrame:null,filenameIsChildOfDialog:null}})
    } finally { fs.unlinkSync(file); fs.rmdirSync(dir) }
  })
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
    expect(script).toContain("Invoke-GuardedFilenameKeys 100 $dialogHwnd $controlHwnd 77 $cancelPath '^a'")
    expect(script).toContain("Invoke-GuardedFilenameKeys 100 $dialogHwnd $controlHwnd 77 $cancelPath 'fixture-path'")
    expect(script).toContain('[SKHelper]::ForceForeground([IntPtr]$dialogHwnd)')
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
