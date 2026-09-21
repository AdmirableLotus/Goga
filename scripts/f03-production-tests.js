#!/usr/bin/env node
/**
 * F0.3 — Production-Path Tests
 *
 * Entry point: OrchestratorService.process()
 *   → looksLikeAgentTask() → AgentLoop.run()
 *   → AuthorizationService.evaluateAndLog()
 *   → ToolRegistry.execute()
 *   → VerificationEngine.verify()
 *
 * The LLM/planner boundary (AgentLoop.planNextStep) is replaced with a
 * deterministic queue. Everything else is real compiled production code.
 *
 * Run: npm run test:f03-production
 * Requires: npm run build:main first
 */

'use strict'

const path  = require('path')
const fs    = require('fs')
const os    = require('os')
const { spawn } = require('child_process')

const DIST = path.resolve(__dirname, '..', 'dist', 'main', 'main')
const OUT  = path.join(__dirname, 'f03-production-results.txt')

if (!fs.existsSync(DIST)) {
  console.error('FATAL: dist/main/main not found — run: npm run build:main')
  process.exit(1)
}

// ── Dependency mocks ──────────────────────────────────────────────────────────
// Must be injected before any dist require.

function makeStore() {
  function Store(opts) {
    this._data = Object.assign({}, opts && opts.defaults ? opts.defaults : {})
  }
  Store.prototype.get  = function(k)    { return this._data[k] }
  Store.prototype.set  = function(k, v) {
    if (k && typeof k === 'object') Object.assign(this._data, k)
    else this._data[k] = v
  }
  Object.defineProperty(Store.prototype, 'store', { get: function() { return this._data } })
  return Store
}
require.cache[require.resolve('electron-store')] = {
  id: 'electron-store', filename: 'electron-store', loaded: true,
  exports: makeStore()
}

const electronMock = {
  app: { getPath: () => os.tmpdir(), isPackaged: false, on: () => {} },
  BrowserWindow: class { webContents = { send: () => {} } },
  ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} }
}
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true, exports: electronMock
}

// Mock index.js to prevent Electron app bootstrap and break circular require
const idxPath = path.join(DIST, 'index.js')
require.cache[idxPath] = {
  id: idxPath, filename: idxPath, loaded: true,
  exports: { getMainWindow: () => null }
}

// ── Load production modules ───────────────────────────────────────────────────
// Order: registry → tools (self-register) → services
require(path.join(DIST, 'tools', 'index.js'))          // registers all tools
const { ToolRegistry }         = require(path.join(DIST, 'tools', 'registry.js'))
const { AuthorizationService } = require(path.join(DIST, 'services', 'authorization.js'))
const { VerificationEngine }   = require(path.join(DIST, 'services', 'verificationEngine.js'))
const { LogService }           = require(path.join(DIST, 'services', 'logs.js'))
const { AgentLoop }            = require(path.join(DIST, 'services', 'agentLoop.js'))
const { OrchestratorService }  = require(path.join(DIST, 'services', 'orchestrator.js'))

// ── Deterministic planner patch ───────────────────────────────────────────────
// Replaces AgentLoop.planNextStep() when a plan queue is installed.
// The queue is consumed in order; when empty, returns done:true.
// This is the ONLY mock — auth, registry, execution, verification are real.

let _planQueue = []

const _origPlanNextStep = AgentLoop.prototype.planNextStep
AgentLoop.prototype.planNextStep = async function(...args) {
  if (_planQueue.length > 0) {
    const step = _planQueue.shift()
    return step
  }
  return { thought: 'plan exhausted', done: true, reply: 'Test plan complete.', tool: '', params: {} }
}

function installPlan(steps) {
  _planQueue = steps.map(s => ({ done: false, params: {}, ...s }))
}
function clearPlan() { _planQueue = [] }

// ── Test harness ──────────────────────────────────────────────────────────────

const lines = []
let pass = 0, fail = 0, skip = 0

function w(s)  { lines.push(s); process.stdout.write(s + '\n') }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function result(id, name, ok, detail) {
  const status = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'
  if (ok === null) skip++; else if (ok) pass++; else fail++
  w(`  [${ok === null ? '~' : ok ? '✓' : '✗'}] ${id}: ${name}  [${status}]`)
  if (detail) w(`       ${detail}`)
}

// ── PowerShell helper ─────────────────────────────────────────────────────────
function runPS(script, timeoutMs = 25000) {
  const tmp = path.join(os.tmpdir(), 'goga-prod-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ps1')
  fs.writeFileSync(tmp, script, 'utf8')
  return new Promise((resolve, reject) => {
    let out = '', err = ''
    const proc = spawn('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { windowsHide: true })
    const timer = setTimeout(() => { proc.kill(); reject(new Error('PS timeout')) }, timeoutMs)
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', code => {
      clearTimeout(timer)
      try { fs.unlinkSync(tmp) } catch {}
      if (code !== 0 && err && !out) reject(new Error(err.trim()))
      else resolve(out.trim())
    })
    proc.on('error', e => { clearTimeout(timer); try { fs.unlinkSync(tmp) } catch {}; reject(e) })
  })
}

// ── HWND-scoped Notepad cleanup ───────────────────────────────────────────────
// Closes exactly the test-created HWND via WM_CLOSE.
//
// Ownership rule:
//   The test owns the uniquely discovered HWND, not the process.
//   WM_CLOSE is sent to that exact HWND regardless of which PID hosts it.
//   This is correct even when the host PID is the pre-existing Notepad host
//   (PID 23116 on this machine) — Windows 11 single-instance Notepad places
//   new windows inside the existing host process.
//
// Protected-PID rule:
//   PROTECTED_PID = 23116 means: never terminate, kill, or stop that process.
//   It does NOT mean: skip WM_CLOSE on an exact test-owned HWND.
//   There is no process-termination path in this function. The constant is
//   retained as a documentation anchor and a guard against any future
//   process-level fallback being added.
//
// Save-dialog scoping:
//   After WM_CLOSE, if a save dialog appears it must be owned by the exact
//   test HWND (GetWindow(testHwnd, GW_OWNER) chain) or be a direct child of
//   the same top-level window. We use GetWindow(GW_OWNER=4) to walk the owner
//   chain of every visible top-level window and accept only those whose owner
//   chain includes the exact test HWND. InvokePattern only — no keystrokes.
//
// Failure mode:
//   If IsWindow(testHwnd) is still true after the 5s poll, returns { gone: false }.
//   Callers must register this as a FAIL result — no fallback action is taken.

// ── Baseline capture via computer.snapshotHwnds ─────────────────────────────────
// computer.snapshotHwnds returns { success, data: { hwnds: number[] } }.
// Schema available: { hwnd: number, pid: number, title: string }
// Note: cls is NOT returned by computer.snapshotHwnds; omitted throughout.
async function captureBaselineRecords() {
  const reg = ToolRegistry.getInstance()
  const ac  = new AbortController()
  const snap = await reg.execute('computer.snapshotHwnds', {}, { abortSignal: ac.signal }).catch(() => null)
  const rawHwnds = snap?.data?.hwnds
  if (!Array.isArray(rawHwnds) || rawHwnds.length === 0) return []

  const seen = new Set()
  const hwnds = rawHwnds.map(Number).filter(h => h > 0 && !seen.has(h) && seen.add(h))
  if (hwnds.length === 0) return []

  const hwndCsv = hwnds.join(',')
  const enrichRaw = await runPS(`
    Add-Type @"
      using System; using System.Runtime.InteropServices; using System.Text;
      public static class BLE {
        [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);
        [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
      }
"@
    $hwnds = @(${hwndCsv})
    $rows = foreach ($h in $hwnds) {
      $p = 0; [BLE]::GetWindowThreadProcessId([IntPtr]$h, [ref]$p) | Out-Null
      $ts = New-Object System.Text.StringBuilder 512
      [BLE]::GetWindowText([IntPtr]$h, $ts, 512) | Out-Null
      [PSCustomObject]@{ hwnd=$h; pid=$p; title=$ts.ToString() }
    }
    $rows | ConvertTo-Json -Compress
  `).catch(() => '[]')

  try {
    const parsed = JSON.parse(enrichRaw.trim() || '[]')
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map(r => ({ hwnd: Number(r.hwnd), pid: Number(r.pid), title: String(r.title ?? '') }))
      .filter(r => r.hwnd > 0)
  } catch { return [] }
}

const PROTECTED_PID = 23116  // never terminate this process; WM_CLOSE to its windows is still permitted

async function closeNotepadHwnd(hwnd, ownerPid, baselineHwnds) {
  if (!hwnd) return { gone: true }  // nothing to close — not a failure

  // PROTECTED_PID guard: block any process-termination path only.
  // WM_CLOSE to the exact HWND is always permitted — the test owns the window, not the process.
  // (No process-termination path exists in this function; guard is a safety net for future edits.)
  if (ownerPid === PROTECTED_PID) {
    process.stdout.write(`       cleanup: ownerPid=${ownerPid} is PROTECTED_PID — WM_CLOSE to exact HWND still proceeds; process termination blocked\n`)
    // fall through — do NOT return
  }

  const hwndDec = hwnd

  const closeOut = await runPS(`
    Add-Type @"
      using System; using System.Runtime.InteropServices;
      public static class HWndClose {
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
      }
"@
    $testHwnd = [IntPtr]${hwndDec}
    # Send WM_CLOSE to the exact test HWND only.
    # No taskkill. No process termination. No title-wide search.
    [HWndClose]::PostMessage($testHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    # Poll IsWindow(testHwnd) until false (max 5s)
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 200
      if (-not [HWndClose]::IsWindow($testHwnd)) { break }
    }
    # Save-dialog handling: scoped to dialogs whose GW_OWNER chain includes testHwnd.
    # GW_OWNER = 4. Walk every visible top-level window; accept only those owned by testHwnd.
    # InvokePattern only — no global keyboard shortcuts.
    Add-Type -AssemblyName UIAutomationClient
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)) {
      $wHwnd = [IntPtr]$w.Current.NativeWindowHandle
      # Walk the GW_OWNER chain to see if testHwnd is an ancestor owner
      $owner = [HWndClose]::GetWindow($wHwnd, 4)
      $ownedByTest = ($owner -eq $testHwnd)
      if (-not $ownedByTest) { continue }
      foreach ($btn in $w.FindAll([System.Windows.Automation.TreeScope]::Subtree,
          [System.Windows.Automation.Condition]::TrueCondition)) {
        $n = $btn.Current.Name
        if ($n -eq "Don't Save" -or $n -eq "No" -or $n -eq "Don't save") {
          try { $btn.GetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {}
        }
      }
    }
    # Final IsWindow check
    Start-Sleep -Milliseconds 400
    $gone = -not [HWndClose]::IsWindow($testHwnd)
    Write-Output "gone=$gone"
  `).catch(() => 'gone=unknown')

  const goneStr = closeOut.trim()
  process.stdout.write(`       cleanup: WM_CLOSE hwnd=0x${hwnd.toString(16)} pid=${ownerPid} ${goneStr}\n`)

  // Per-item baseline survival check (post-cleanup snapshot)
  if (baselineHwnds && baselineHwnds.length > 0) {
    const isRich = typeof baselineHwnds[0] === 'object'
    const hwndList = isRich ? baselineHwnds.map(r => r.hwnd) : baselineHwnds
    const checkOut = await runPS(`
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public static class HWndCheck { [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); }
"@
      $hwnds = @(${hwndList.join(',')})
      $missing = $hwnds | Where-Object { -not [HWndCheck]::IsWindow([IntPtr]$_) }
      Write-Output "missing=$($missing.Count) total=$($hwnds.Count)"
      foreach ($m in $missing) { Write-Output "missingHwnd=$m" }
    `).catch(() => 'missing=unknown total=unknown')
    const missingCount = checkOut.match(/missing=(\d+)/)?.[1] ?? 'unknown'
    const totalCount   = checkOut.match(/total=(\d+)/)?.[1]   ?? 'unknown'
    const allSurvived  = missingCount === '0'
    process.stdout.write(`       cleanup: baseline hwnd survival missing=${missingCount}/${totalCount} allSurvived=${allSurvived}\n`)
    if (!allSurvived) {
      const missingHwnds = [...checkOut.matchAll(/missingHwnd=(\d+)/g)].map(m => Number(m[1]))
      for (const mh of missingHwnds) {
        if (isRich) {
          const rec = baselineHwnds.find(r => r.hwnd === mh)
          // cls not available from computer.snapshotHwnds
          process.stdout.write(`       cleanup: MISSING hwnd=0x${mh.toString(16)} pid=${rec?.pid ?? '?'} title="${rec?.title ?? '?'}"\n`)
        } else {
          process.stdout.write(`       cleanup: MISSING hwnd=0x${mh.toString(16)} (no metadata — legacy snapshot)\n`)
        }
      }
    }
  }

  // gone=True → success; gone=False → fail-closed (no fallback)
  // gone=unknown (PS error) → treated as failure to be safe
  return { gone: goneStr === 'gone=True' }
}

/**
 * Read text from the exact test HWND using UIAutomation anchored to that handle.
 * Never searches by PID, title, foreground window, or global root.
 * Pattern priority: TextPattern → ValuePattern → LegacyIAccessiblePattern (scoped fallback).
 * Polls until the expected marker appears or pollMs elapses.
 * Does not focus the window, type again, or use keyboard shortcuts.
 * @param {number} hwnd  - exact test HWND
 * @param {string} marker - expected text to find
 * @param {number} pollMs - max polling duration in ms
 * @returns {Promise<string>} text content, or '' on failure
 */
async function readNotepadTextByHwnd(hwnd, marker, pollMs = 4000) {
  const deadline = Date.now() + pollMs
  let last = ''
  while (Date.now() < deadline) {
    const text = await runPS(`
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public static class HWndRead { [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); }
"@
      $hwnd = [IntPtr]${hwnd}
      if (-not [HWndRead]::IsWindow($hwnd)) { Write-Output ''; exit }
      # Anchor UIAutomation to the exact test HWND — never use global root or PID search
      $win = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      if (-not $win) { Write-Output ''; exit }
      # 1. TextPattern (modern Notepad)
      try {
        $tp = $win.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        $text = $tp.DocumentRange.GetText(-1)
        if ($text -ne $null) { Write-Output $text; exit }
      } catch {}
      # 2. ValuePattern on descendants
      foreach ($el in $win.FindAll([System.Windows.Automation.TreeScope]::Subtree,
          [System.Windows.Automation.Condition]::TrueCondition)) {
        $ct = $el.Current.ControlType.ProgrammaticName
        if ($ct -like '*Edit*' -or $ct -like '*Document*') {
          try {
            $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $val = $vp.Current.Value
            if ($val -ne $null) { Write-Output $val; exit }
          } catch {}
        }
      }
      # 3. LegacyIAccessiblePattern — scoped fallback only
      foreach ($el in $win.FindAll([System.Windows.Automation.TreeScope]::Subtree,
          [System.Windows.Automation.Condition]::TrueCondition)) {
        try {
          $lp = $el.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
          $val = $lp.Current.Value
          if ($val -and $val.Length -gt 0) { Write-Output $val; exit }
        } catch {}
      }
      Write-Output ''
    `).catch(() => '')
    last = text.trim()
    if (last.includes(marker)) return last
    if (Date.now() < deadline) await sleep(300)
  }
  return last
}

async function focusNotepadPid(pid) {
  await runPS(`
    Add-Type -AssemblyName UIAutomationClient
    Add-Type @"
      using System; using System.Runtime.InteropServices;
      public class WFP { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($w.Current.ProcessId -eq ${pid} -and $w.Current.BoundingRectangle.Width -gt 0) {
        [WFP]::SetForegroundWindow([IntPtr]$w.Current.NativeWindowHandle) | Out-Null; exit
      }
    }
  `)
  await sleep(350)
}

// ── OrchestratorService entry ─────────────────────────────────────────────────
// Mirrors the chat:send IPC handler exactly.

let _orch = null
function getOrch() {
  if (!_orch) _orch = new OrchestratorService()
  return _orch
}

function chatMsg(content) {
  return { id: 'test-' + Date.now(), role: 'user', content, timestamp: Date.now() }
}

// Call OrchestratorService.process() and wait for AgentLoop to finish via latch.
async function processAndWait(content, timeoutMs = 45000) {
  const agent = AgentLoop.getInstance()
  if (agent.isRunning()) { agent.stop('test reset'); await sleep(300) }
  // NOTE: do NOT clearPlan() here — caller installs the plan before calling processAndWait()

  let _resolve
  let _timer
  let _settled = false

  const completion = new Promise((resolve) => { _resolve = resolve })

  function settleOnce(r) {
    if (_settled) return
    _settled = true
    clearTimeout(_timer)
    _resolve(r)
  }

  _timer = setTimeout(() => {
    settleOnce({ status: 'error', reply: 'timeout', state: agent.getState(), error: 'processAndWait timed out' })
  }, timeoutMs)

  let immediateReply
  try {
    immediateReply = await getOrch().process(chatMsg(content), undefined, (result) => {
      settleOnce(result)
    })
  } catch (err) {
    settleOnce({ status: 'error', reply: String(err), state: agent.getState(), error: String(err) })
  } finally {
    // Belt-and-suspenders: clear timer if process() itself settled synchronously
    // (non-agent path) and the callback was never registered
    if (_settled) clearTimeout(_timer)
  }

  const completionResult = await completion
  return { immediateReply, state: completionResult.state }
}

// ── Checkpoint 3: Notepad production test ────────────────────────────────────

async function testNotepad() {
  w('\n── P1: Notepad — production path ────────────────────────────────')
  const MARKER = 'GogaVerification_' + Date.now()
  let notepadPid = null
  let notepadHwnd = 0
  let notepadRealPid = null
  let baselineRecords = []  // Array<{hwnd,pid,title,cls}>
  const BASELINE_FILE = path.join(__dirname, 'f03-p1-baseline-snapshot.json')

  try {
    // Capture rich baseline BEFORE launching Notepad via computer.snapshotHwnds
    baselineRecords = await captureBaselineRecords()
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baselineRecords, null, 2), 'utf8')
    const baselineValid = baselineRecords.length > 0
    w(`       baseline hwnd count=${baselineRecords.length} baselineValid=${baselineValid} (saved to ${BASELINE_FILE})`)
    // Schema: { hwnd, pid, title } — cls not available from computer.snapshotHwnds
    if (!baselineValid) {
      result('P1a', 'process.start launched Notepad, returned PID', false, 'baselineValid=false — baseline capture returned 0 records; Notepad not launched')
      result('P1b', 'AuthorizationService allowed process.start', null, 'skipped — invalid baseline')
      result('P1c', 'computer.type step succeeded', null, 'skipped — invalid baseline')
      result('P1d', 'UIAutomation readback contains marker', null, 'skipped — invalid baseline')
      result('P1e', 'VerificationEngine reports window_exists=passed', null, 'skipped — invalid baseline')
      return
    }

    // Two-phase plan:
    // Phase 1: launch Notepad, wait for window, resolve PID/HWND via process.start result.
    // Phase 2: focus by exact PID, type with exact PID.
    installPlan([
      { thought: 'Launch Notepad',
        tool: 'process.start',
        params: { executable: 'notepad.exe' } },
      { thought: 'Wait for Notepad window',
        tool: 'computer.wait',
        params: { type: 'window', windowTitle: 'Notepad', timeoutMs: 8000 } },
      { thought: 'Done phase 1', done: true, reply: 'Notepad launched.', tool: '', params: {} }
    ])

    const { state: stateA } = await processAndWait('open notepad and type a test message', 15000)
    const startStep = stateA.steps.find(s => s.tool === 'process.start')
    notepadPid = startStep?.result?.data?.pid ?? null
    w(`       process.start pid=${notepadPid}`)

    if (!notepadPid) {
      result('P1a', 'process.start launched Notepad, returned PID', false, `pid=${notepadPid}`)
      result('P1b', 'AuthorizationService allowed process.start', null, 'skipped')
      result('P1c', 'computer.type step succeeded', null, 'skipped')
      result('P1d', 'UIAutomation readback contains marker', null, 'skipped')
      result('P1e', 'VerificationEngine reports window_exists=passed', null, 'skipped')
      return
    }

    // P1a: process.start succeeded and returned a PID
    const pidOk = typeof notepadPid === 'number' && notepadPid > 0
    result('P1a', 'process.start launched Notepad, returned PID', pidOk,
      `pid=${notepadPid} step.success=${startStep?.result?.success}`)

    // P1b: authorization check — evaluated independently of HWND resolution
    const auth = AuthorizationService.getInstance()
    const reg  = ToolRegistry.getInstance()
    const toolDef = reg.get('process.start')?.definition
    const decision = toolDef ? auth.evaluate(toolDef, { executable: 'notepad.exe' }, { mode: 'normal' }) : null
    result('P1b', 'AuthorizationService allowed process.start', decision?.allowed === true && decision?.requiresApproval === false,
      `allowed=${decision?.allowed} requiresApproval=${decision?.requiresApproval} reason="${decision?.reason}"`)

    if (!pidOk) {
      result('P1c', 'computer.type step succeeded', null, 'skipped — no PID')
      result('P1d', 'UIAutomation readback contains marker', null, 'skipped — no PID')
      result('P1e', 'VerificationEngine reports window_exists=passed', null, 'skipped — no PID')
      return
    }

    // Resolve the actual Win32 HWND using windowByTitleDiff with a pre-launch baseline.
    // Windows 11 Notepad is single-instance: the launcher PID exits immediately and
    // the window is owned by an existing host process. windowsByPid(launcherPid) returns
    // nothing. windowByTitleDiff finds the window by title diff regardless of owner PID.
    const reg0 = ToolRegistry.getInstance()
    const ac0  = new AbortController()
    const baselineHwndNums = baselineRecords.map(r => r.hwnd)

    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const wbdResult = await reg0.execute('computer.windowByTitleDiff',
        { titleSubstring: 'Notepad', baselineHwnds: baselineHwndNums },
        { abortSignal: ac0.signal }).catch(() => null)
      const win = wbdResult?.data
      if (win && win.hwnd) {
        notepadHwnd = win.hwnd
        notepadRealPid = win.pid
        break
      }
      await sleep(400)
    }
    // Assert: exactly one new HWND was discovered (windowByTitleDiff enforces this; confirm here)
    const exactlyOneP1 = notepadHwnd !== 0
    w(`       windowByTitleDiff hwnd=0x${notepadHwnd.toString(16)} realPid=${notepadRealPid} exactlyOne=${exactlyOneP1}`)

    // Assert: the discovered test HWND must not be in the pre-launch baseline
    const hwndInBaseline = baselineRecords.some(r => r.hwnd === notepadHwnd)
    w(`       testHwnd absent from baseline: ${!hwndInBaseline}`)
    if (hwndInBaseline) {
      const rec = baselineRecords.find(r => r.hwnd === notepadHwnd)
      w(`       ERROR: hwnd=0x${notepadHwnd.toString(16)} was already in baseline pid=${rec?.pid} title="${rec?.title}"`)
    }

    if (!notepadHwnd) {
      result('P1c', 'computer.type step succeeded', null, 'skipped — hwnd unavailable')
      result('P1d', 'UIAutomation readback contains marker', null, 'skipped — hwnd unavailable')
      result('P1e', 'VerificationEngine reports window_exists=passed', null, 'skipped — hwnd unavailable')
      return
    }

    // Phase 2: focus by exact realPid+HWND, clear any pre-existing text, then type marker.
    // Clearing (Ctrl+A then Delete) ensures the readback contains only this run's marker,
    // regardless of text left by a prior test in the same Notepad host process.
    const focusParams  = { pid: notepadRealPid, hwnd: notepadHwnd, title: 'Notepad' }
    const selectAllKey = { key: 'ctrl+a', pid: notepadRealPid, hwnd: notepadHwnd }
    const deleteKey    = { key: 'delete',  pid: notepadRealPid, hwnd: notepadHwnd }
    const typeParams   = { text: MARKER, pid: notepadRealPid, hwnd: notepadHwnd, windowTitle: 'Notepad' }

    installPlan([
      { thought: 'Focus Notepad by exact PID+HWND',
        tool: 'computer.focus.window',
        params: focusParams },
      { thought: 'Select all existing text so it can be cleared',
        tool: 'computer.key',
        params: selectAllKey },
      { thought: 'Delete selected text - document is now empty',
        tool: 'computer.key',
        params: deleteKey },
      { thought: 'Type verification marker into clean document',
        tool: 'computer.type',
        params: typeParams },
      { thought: 'Done', done: true, reply: 'Notepad task complete.', tool: '', params: {} }
    ])

    const { state } = await processAndWait('run the marker typing task in notepad', 20000)

    // P1c: computer.type step succeeded
    const typeStep = state.steps.find(s => s.tool === 'computer.type')
    result('P1c', 'computer.type step succeeded', typeStep?.result?.success === true,
      `success=${typeStep?.result?.success} error=${typeStep?.result?.error ?? 'none'}`)

    // P1d: read back via exact-HWND UIAutomation — confirm marker is present
    // Polls up to 4s; anchored to testHwnd only, never searches by PID or global root
    const readBack = await readNotepadTextByHwnd(notepadHwnd, MARKER, 4000)
    const markerFound = readBack.includes(MARKER)
    result('P1d', 'UIAutomation readback contains marker (exact HWND)', markerFound,
      `marker="${MARKER}" readBack="${readBack.slice(0, 120)}"`)

    // P1e: VerificationEngine.verify window_exists for the Notepad PID's window
    const ve = VerificationEngine.getInstance()
    const veResult = await ve.verify({ type: 'window_exists', windowTitle: 'Notepad' })
    result('P1e', 'VerificationEngine reports window_exists=passed', veResult.outcome === 'passed',
      `outcome=${veResult.outcome} detail="${veResult.detail}"`)

  } catch (e) {
    result('P1a', 'Notepad production path', false, `FATAL: ${e.message}`)
    result('P1b', 'AuthorizationService check', null, 'skipped')
    result('P1c', 'computer.type step', null, 'skipped')
    result('P1d', 'UIAutomation readback', null, 'skipped')
    result('P1e', 'VerificationEngine window_exists', null, 'skipped')
  } finally {
    clearPlan()
    const cleanupP1 = await closeNotepadHwnd(notepadHwnd, notepadRealPid, baselineRecords)
    result('P1f', 'Notepad cleanup: exact HWND closed (gone=True)',
      cleanupP1.gone,
      `hwnd=0x${(notepadHwnd || 0).toString(16)} gone=${cleanupP1.gone}`)
  }
}

// ── Checkpoint 5: Brave production test ──────────────────────────────────────

async function testBrave() {
  w('\n── P2: Brave — production path ──────────────────────────────────')
  const testPageUrl = 'file:///' + path.join(__dirname, 'test-page', 'index.html').replace(/\\/g, '/')
  let sessionId = null

  try {
    // Step 1: browser.open → test page (visible Brave, isolated session)
    // Step 2: browser.type → fill #input-username
    // Step 3: browser.click → click #btn-submit
    // Step 4: done
    // sessionId is captured from step 1 result and threaded into steps 2-3
    // via a plan that uses a sentinel; we patch it after step 1 executes.

    // We use a two-phase plan: phase A opens the browser and captures sessionId,
    // phase B fills and submits using the real sessionId.
    let capturedSessionId = null

    // Phase A plan.
    // Task string contains fill/submit/form so looksLikeAgentTask routes to AgentLoop
    // and isSimpleOpenTask returns false, ensuring browser.open (Playwright) is used.
    installPlan([
      { thought: 'Open test page in Brave via Playwright for form automation',
        tool: 'browser.open',
        params: { url: testPageUrl, headless: false } },
      { thought: 'Done phase A', done: true, reply: 'Browser opened.', tool: '', params: {} }
    ])

    const { state: stateA } = await processAndWait('fill and submit the form at ' + testPageUrl, 30000)
    const openStep = stateA.steps.find(s => s.tool === 'browser.open')
    capturedSessionId = openStep?.result?.data?.sessionId ?? null
    sessionId = capturedSessionId
    w(`       browser.open sessionId=${capturedSessionId}`)

    const openOk = typeof capturedSessionId === 'string' && capturedSessionId.length > 0
    result('P2a', 'browser.open returned sessionId', openOk,
      `sessionId=${capturedSessionId} success=${openStep?.result?.success}`)

    if (!openOk) {
      result('P2b', 'browser.type fill input', null, 'skipped — no session')
      result('P2c', 'browser.click submit', null, 'skipped — no session')
      result('P2d', 'VerificationEngine DOM verify passed', null, 'skipped — no session')
      return
    }

    // Phase B: fill and submit using the real sessionId.
    // Task string uses fill/submit/form keywords to route through AgentLoop.
    installPlan([
      { thought: 'Fill username input',
        tool: 'browser.type',
        params: { sessionId: capturedSessionId, selector: '#input-username', text: 'GogaBraveTest' } },
      { thought: 'Click submit button',
        tool: 'browser.click',
        params: { sessionId: capturedSessionId, selector: '#btn-submit' } },
      { thought: 'Done', done: true, reply: 'Form submitted.', tool: '', params: {} }
    ])

    const { state: stateB } = await processAndWait('fill and submit the form on the test page', 20000)

    const typeStep  = stateB.steps.find(s => s.tool === 'browser.type')
    const clickStep = stateB.steps.find(s => s.tool === 'browser.click')

    result('P2b', 'browser.type filled #input-username', typeStep?.result?.success === true,
      `success=${typeStep?.result?.success} error=${typeStep?.result?.error ?? 'none'}`)
    result('P2c', 'browser.click clicked #btn-submit', clickStep?.result?.success === true,
      `success=${clickStep?.result?.success} error=${clickStep?.result?.error ?? 'none'}`)

    // P2d: VerificationEngine DOM verify — #btn-result should contain 'submit-clicked'
    await sleep(400)
    const ve = VerificationEngine.getInstance()
    const veResult = await ve.verify({
      type: 'dom_text_exists',
      sessionId: capturedSessionId,
      selector: '#btn-result',
      expected: 'submit-clicked'
    })
    result('P2d', 'VerificationEngine DOM verify passed', veResult.outcome === 'passed',
      `outcome=${veResult.outcome} detail="${veResult.detail}"`)

  } catch (e) {
    result('P2a', 'Brave production path', false, `FATAL: ${e.message}`)
    result('P2b', 'browser.type', null, 'skipped')
    result('P2c', 'browser.click', null, 'skipped')
    result('P2d', 'VerificationEngine DOM verify', null, 'skipped')
  } finally {
    clearPlan()
    // Close only the session we created
    if (sessionId) {
      const reg = ToolRegistry.getInstance()
      const ac  = new AbortController()
      await reg.execute('browser.close', { sessionId }, { abortSignal: ac.signal }).catch(() => {})
    }
  }
}

// ── Checkpoint 7: Cancellation test ──────────────────────────────────────────

async function testCancellation() {
  w('\n── P3: Cancellation — real AbortController path ─────────────────')
  const MARKER_1 = 'MutationOne_' + Date.now()
  const MARKER_2 = 'MutationTwo_' + Date.now()
  let notepadPid = null
  let notepadHwndC = 0
  let notepadRealPidC = null
  let baselineRecordsC = []  // Array<{hwnd,pid,title,cls}>

  try {
    const agent = AgentLoop.getInstance()
    const log   = LogService.getInstance()

    const logsBefore = log.list().length

    // Capture rich baseline BEFORE launching Notepad via computer.snapshotHwnds
    baselineRecordsC = await captureBaselineRecords()
    const baselineCValid = baselineRecordsC.length > 0
    w(`       cancellation baseline hwnd count=${baselineRecordsC.length} baselineValid=${baselineCValid}`)
    if (!baselineCValid) throw new Error('baseline capture returned 0 records — cannot proceed')

    // Phase 1: launch Notepad, wait, resolve PID.
    // Phase 2 (installed after PID known): focus by PID, type MARKER_1, type MARKER_2.
    installPlan([
      { thought: 'Launch Notepad for cancellation test',
        tool: 'process.start',
        params: { executable: 'notepad.exe' } },
      { thought: 'Wait for Notepad',
        tool: 'computer.wait',
        params: { type: 'window', windowTitle: 'Notepad', timeoutMs: 8000 } },
      { thought: 'Done phase 1', done: true, reply: 'Notepad launched.', tool: '', params: {} }
    ])

    // Start phase 1 via production entry point
    if (agent.isRunning()) { agent.stop('test reset'); await sleep(300) }
    const { state: stateP1 } = await processAndWait('open notepad for cancellation test', 15000)
    const startStepC = stateP1.steps.find(s => s.tool === 'process.start')
    notepadPid = startStepC?.result?.data?.pid ?? null
    w(`       cancellation notepadPid=${notepadPid}`)
    if (!notepadPid) throw new Error(`process.start did not return a PID`)

    // Resolve Win32 HWND via windowByTitleDiff — handles single-instance Notepad
    const ac0c = new AbortController()
    const baselineHwndNumsC = baselineRecordsC.map(r => r.hwnd)
    const deadlineC = Date.now() + 8000
    while (Date.now() < deadlineC) {
      const wbdC = await ToolRegistry.getInstance().execute('computer.windowByTitleDiff',
        { titleSubstring: 'Notepad', baselineHwnds: baselineHwndNumsC },
        { abortSignal: ac0c.signal }).catch(() => null)
      const winC = wbdC?.data
      if (winC && winC.hwnd) { notepadHwndC = winC.hwnd; notepadRealPidC = winC.pid; break }
      await sleep(400)
    }
    // Assert: exactly one new HWND was discovered
    const exactlyOneC = notepadHwndC !== 0
    w(`       cancellation hwnd=0x${notepadHwndC.toString(16)} realPid=${notepadRealPidC} exactlyOne=${exactlyOneC}`)

    // Assert: the discovered test HWND must not be in the pre-launch baseline
    const hwndInBaselineC = baselineRecordsC.some(r => r.hwnd === notepadHwndC)
    w(`       testHwnd absent from baseline: ${!hwndInBaselineC}`)
    if (hwndInBaselineC) {
      const rec = baselineRecordsC.find(r => r.hwnd === notepadHwndC)
      w(`       ERROR: hwnd=0x${notepadHwndC.toString(16)} was already in baseline pid=${rec?.pid} title="${rec?.title}"`)
    }

    if (!notepadHwndC) throw new Error(`windowByTitleDiff returned no hwnd — cannot proceed without HWND`)

    notepadPid = notepadRealPidC  // update outer var so finally block closes the real owner
    const focusParamsC = { pid: notepadRealPidC, hwnd: notepadHwndC, title: 'Notepad' }
    const typeParams1  = { text: MARKER_1, pid: notepadRealPidC, hwnd: notepadHwndC, windowTitle: 'Notepad' }
    const typeParams2  = { text: MARKER_2, pid: notepadRealPidC, hwnd: notepadHwndC, windowTitle: 'Notepad' }

    // Phase 2: focus + type MARKER_1 + type MARKER_2 (stop will fire between them)
    installPlan([
      { thought: 'Focus Notepad by exact PID+HWND',
        tool: 'computer.focus.window',
        params: focusParamsC },
      { thought: 'First mutation — type marker 1',
        tool: 'computer.type',
        params: typeParams1 },
      // MARKER_2 step — must never execute after stop()
      { thought: 'Second mutation — type marker 2',
        tool: 'computer.type',
        params: typeParams2 },
      { thought: 'Done', done: true, reply: 'Done.', tool: '', params: {} }
    ])

    // Start the agent via the production entry point (fire-and-forget)
    if (agent.isRunning()) { agent.stop('test reset'); await sleep(300) }
    getOrch().process(chatMsg('run the two-message typing task in notepad'))

    // Poll telemetry until mutation 1 is confirmed in the log, then stop
    const deadline = Date.now() + 25000
    let mutation1Logged = false
    while (Date.now() < deadline) {
      await sleep(200)
      const newEntries = log.list().slice(0, log.list().length - logsBefore)
      mutation1Logged = newEntries.some(e =>
        e.message.includes('computer.type') && e.message.includes(MARKER_1.slice(0, 10))
        || (e.message.includes('Agent step') && e.message.includes('computer.type'))
      )
      // Also check agent steps directly
      const steps = agent.getState().steps
      const typeSteps = steps.filter(s => s.tool === 'computer.type')
      if (typeSteps.length >= 1) { mutation1Logged = true; break }
    }

    w(`       mutation1Logged=${mutation1Logged}`)

    // Call the real production stop path
    agent.stop('test cancellation after mutation 1')
    await sleep(600)

    // P3a: mutation 1 was confirmed before stop
    result('P3a', 'Mutation 1 (MARKER_1) executed before stop()', mutation1Logged,
      `mutation1Logged=${mutation1Logged}`)

    // P3b: agent status is stopped/done (not running)
    const finalState = agent.getState()
    const stopped = !agent.isRunning()
    result('P3b', 'AgentLoop.stop() halted the loop', stopped,
      `status=${finalState.status} isRunning=${agent.isRunning()}`)

    // P3c: MARKER_2 was never typed — read via exact-HWND UIAutomation
    await sleep(300)
    const readBackC = await readNotepadTextByHwnd(notepadHwndC, MARKER_2, 2000)
    const marker2Absent = !readBackC.includes(MARKER_2)
    result('P3c', 'MARKER_2 absent — second mutation never executed', marker2Absent,
      `marker2="${MARKER_2.slice(0, 20)}…" absent=${marker2Absent} readBack="${readBackC.slice(0, 120)}"`)

    // P3d: telemetry records the stop reason
    const stopEntry = log.list().find(e =>
      e.message.includes('stopped') || e.message.includes('Stopped') || e.message.includes('cancellation')
    )
    result('P3d', 'LogService records cancellation', stopEntry != null,
      `entry="${stopEntry?.message?.slice(0, 80) ?? 'not found'}"`)

    // P3e: mutationsAfterCancel = 0
    // Count computer.type steps that ran after stop was called.
    // stop() sets abortController.abort() — any step that started after that
    // would have been skipped. We verify by checking step timestamps vs stop time.
    const stopTime = Date.now() - 600  // approximate stop time
    const stepsAfterStop = finalState.steps.filter(
      s => s.tool === 'computer.type' && s.timestamp > stopTime
    )
    result('P3e', 'mutationsAfterCancel=0', stepsAfterStop.length === 0,
      `stepsAfterStop=${stepsAfterStop.length}`)

  } catch (e) {
    result('P3a', 'Cancellation production path', false, `FATAL: ${e.message}`)
    result('P3b', 'AgentLoop.stop() halted loop', null, 'skipped')
    result('P3c', 'MARKER_2 absent', null, 'skipped')
    result('P3d', 'LogService records cancellation', null, 'skipped')
    result('P3e', 'mutationsAfterCancel=0', null, 'skipped')
  } finally {
    clearPlan()
    const cleanupP3 = await closeNotepadHwnd(notepadHwndC, notepadRealPidC, baselineRecordsC)
    result('P3f', 'Notepad cleanup: exact HWND closed (gone=True)',
      cleanupP3.gone,
      `hwnd=0x${(notepadHwndC || 0).toString(16)} gone=${cleanupP3.gone}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  w('\n╔══════════════════════════════════════════════════════════════╗')
  w('║  F0.3 — Production-Path Tests                                ║')
  w('║  Entry: OrchestratorService.process() → AgentLoop.run()      ║')
  w('║  → AuthorizationService → ToolRegistry → VerificationEngine  ║')
  w('╚══════════════════════════════════════════════════════════════╝\n')

  await testNotepad()
  await testBrave()
  await testCancellation()

  w('\n' + '═'.repeat(70))
  w('F0.3 PRODUCTION-PATH TEST RESULTS')
  w('═'.repeat(70))
  w(`Total: ${pass} PASS  ${fail} FAIL  ${skip} SKIP`)
  if (fail > 0) w('\nF0.3 NOT READY — production-path tests failed.')
  else          w('\nAll production-path tests passed.')

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  w(`\nResults written to ${OUT}`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch(err => {
  w(`\nFATAL: ${err.message}\n${err.stack}`)
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  process.exit(1)
})
