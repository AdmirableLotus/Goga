#!/usr/bin/env node
/**
 * F0.3 — Focused P1 Live Harness
 *
 * Runs only the Notepad production path (P1a–P1f).
 * Does NOT run P2 (Brave) or P3 (Cancellation).
 *
 * Reports:
 *   - Baseline count and snapshot file location
 *   - New exact HWND and owner PID
 *   - Assertion that new HWND was absent from baseline
 *   - Exact-HWND marker readback (readNotepadTextByHwnd)
 *   - Scoped cleanup result (gone=True/False)
 *   - Exact list of any missing baseline HWNDs with pid/title/cls
 *
 * PASS only when:
 *   - Marker read from exact HWND
 *   - gone=True
 *   - missing=0 baseline HWNDs
 *
 * Run: node scripts/f03-p1-focused.js
 */

'use strict'

const path      = require('path')
const fs        = require('fs')
const os        = require('os')
const { spawn } = require('child_process')

const DIST = path.resolve(__dirname, '..', 'dist', 'main', 'main')
const OUT  = path.join(__dirname, 'f03-p1-focused-results.txt')
const BASELINE_FILE = path.join(__dirname, 'f03-p1-baseline-snapshot.json')

if (!fs.existsSync(DIST)) {
  console.error('FATAL: dist/main/main not found — run: npm run build:main')
  process.exit(1)
}

// ── Mocks ─────────────────────────────────────────────────────────────────────
function makeStore() {
  function Store(opts) { this._data = Object.assign({}, opts?.defaults ?? {}) }
  Store.prototype.get  = function(k)    { return this._data[k] }
  Store.prototype.set  = function(k, v) {
    if (k && typeof k === 'object') Object.assign(this._data, k)
    else this._data[k] = v
  }
  Object.defineProperty(Store.prototype, 'store', { get() { return this._data } })
  return Store
}
require.cache[require.resolve('electron-store')] = {
  id: 'electron-store', filename: 'electron-store', loaded: true, exports: makeStore()
}
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: {
    app: { getPath: () => os.tmpdir(), isPackaged: false, on: () => {} },
    BrowserWindow: class { webContents = { send: () => {} } },
    ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} }
  }
}
const idxPath = path.join(DIST, 'index.js')
require.cache[idxPath] = { id: idxPath, filename: idxPath, loaded: true, exports: { getMainWindow: () => null } }

require(path.join(DIST, 'tools', 'index.js'))
const { ToolRegistry }         = require(path.join(DIST, 'tools', 'registry.js'))
const { AuthorizationService } = require(path.join(DIST, 'services', 'authorization.js'))
const { VerificationEngine }   = require(path.join(DIST, 'services', 'verificationEngine.js'))
const { AgentLoop }            = require(path.join(DIST, 'services', 'agentLoop.js'))
const { OrchestratorService }  = require(path.join(DIST, 'services', 'orchestrator.js'))

// ── Planner patch ─────────────────────────────────────────────────────────────
let _planQueue = []
AgentLoop.prototype.planNextStep = async function() {
  if (_planQueue.length > 0) return _planQueue.shift()
  return { thought: 'plan exhausted', done: true, reply: 'Test plan complete.', tool: '', params: {} }
}
function installPlan(steps) { _planQueue = steps.map(s => ({ done: false, params: {}, ...s })) }
function clearPlan() { _planQueue = [] }

// ── Harness ───────────────────────────────────────────────────────────────────
const lines = []
let pass = 0, fail = 0

function w(s)  { lines.push(s); process.stdout.write(s + '\n') }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function result(id, name, ok, detail) {
  const status = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'
  if (ok === null) {} else if (ok) pass++; else fail++
  w(`  [${ok === null ? '~' : ok ? '✓' : '✗'}] ${id}: ${name}  [${status}]`)
  if (detail) w(`       ${detail}`)
}

const PROTECTED_PID = 23116

// ── PowerShell helper ─────────────────────────────────────────────────────────
function runPS(script, timeoutMs = 25000) {
  const tmp = path.join(os.tmpdir(), 'goga-p1f-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ps1')
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

// ── readNotepadTextByHwnd ─────────────────────────────────────────────────────
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
      # Anchor to exact test HWND — never use global root or PID search
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

// ── closeNotepadHwnd ──────────────────────────────────────────────────────────
async function closeNotepadHwnd(hwnd, ownerPid, baselineRecords) {
  if (!hwnd) return { gone: true }

  if (ownerPid === PROTECTED_PID) {
    w(`       cleanup: ownerPid=${ownerPid} is PROTECTED_PID — WM_CLOSE to exact HWND still proceeds; process termination blocked`)
  }

  const closeOut = await runPS(`
    Add-Type @"
      using System; using System.Runtime.InteropServices;
      public static class HWndClose {
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
      }
"@
    $testHwnd = [IntPtr]${hwnd}
    [HWndClose]::PostMessage($testHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 200
      if (-not [HWndClose]::IsWindow($testHwnd)) { break }
    }
    Add-Type -AssemblyName UIAutomationClient
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)) {
      $wHwnd = [IntPtr]$w.Current.NativeWindowHandle
      $owner = [HWndClose]::GetWindow($wHwnd, 4)
      if ($owner -ne $testHwnd) { continue }
      foreach ($btn in $w.FindAll([System.Windows.Automation.TreeScope]::Subtree,
          [System.Windows.Automation.Condition]::TrueCondition)) {
        $n = $btn.Current.Name
        if ($n -eq "Don't Save" -or $n -eq "No" -or $n -eq "Don't save") {
          try { $btn.GetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {}
        }
      }
    }
    Start-Sleep -Milliseconds 400
    $gone = -not [HWndClose]::IsWindow($testHwnd)
    Write-Output "gone=$gone"
  `).catch(() => 'gone=unknown')

  const goneStr = closeOut.trim()
  w(`       cleanup: WM_CLOSE hwnd=0x${hwnd.toString(16)} pid=${ownerPid} ${goneStr}`)

  // Per-item baseline survival check
  if (baselineRecords && baselineRecords.length > 0) {
    const hwndList = baselineRecords.map(r => r.hwnd)
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
    w(`       cleanup: baseline survival missing=${missingCount}/${totalCount} allSurvived=${allSurvived}`)

    if (!allSurvived) {
      const missingHwnds = [...checkOut.matchAll(/missingHwnd=(\d+)/g)].map(m => Number(m[1]))
      for (const mh of missingHwnds) {
        const rec = baselineRecords.find(r => r.hwnd === mh)
        // cls not available from computer.snapshotHwnds
        w(`       cleanup: MISSING hwnd=0x${mh.toString(16)} pid=${rec?.pid ?? '?'} title="${rec?.title ?? '?'}"`)
      }
    }

    return { gone: goneStr === 'gone=True', allSurvived }
  }

  return { gone: goneStr === 'gone=True', allSurvived: true }
}

// ── OrchestratorService helpers ───────────────────────────────────────────────
let _orch = null
function getOrch() { if (!_orch) _orch = new OrchestratorService(); return _orch }
function chatMsg(content) { return { id: 'p1f-' + Date.now(), role: 'user', content, timestamp: Date.now() } }

async function processAndWait(content, timeoutMs = 45000) {
  const agent = AgentLoop.getInstance()
  if (agent.isRunning()) { agent.stop('test reset'); await sleep(300) }
  let _resolve, _timer, _settled = false
  const completion = new Promise(resolve => { _resolve = resolve })
  function settleOnce(r) {
    if (_settled) return; _settled = true; clearTimeout(_timer); _resolve(r)
  }
  _timer = setTimeout(() => settleOnce({ status: 'error', reply: 'timeout', state: agent.getState() }), timeoutMs)
  try {
    await getOrch().process(chatMsg(content), undefined, r => settleOnce(r))
  } catch (err) {
    settleOnce({ status: 'error', reply: String(err), state: agent.getState() })
  } finally { if (_settled) clearTimeout(_timer) }
  return (await completion).state
}

// ── Rich baseline capture ─────────────────────────────────────────────────────
// Uses computer.snapshotHwnds (ToolRegistry) for the HWND list — same source as
// computer.windowByTitleDiff baseline. Returns { hwnds: number[] }.
// Schema reported: { hwnd: number, pid: number, title: string }
// Note: class name is NOT returned by computer.snapshotHwnds; cls field is omitted.
async function captureBaseline() {
  const reg = ToolRegistry.getInstance()
  const ac  = new AbortController()
  const snap = await reg.execute('computer.snapshotHwnds', {}, { abortSignal: ac.signal }).catch(() => null)
  const rawHwnds = snap?.data?.hwnds
  if (!Array.isArray(rawHwnds) || rawHwnds.length === 0) return []

  // Deduplicate and reject zero/invalid
  const seen = new Set()
  const hwnds = rawHwnds.map(Number).filter(h => h > 0 && !seen.has(h) && seen.add(h))
  if (hwnds.length === 0) return []

  // Enrich with pid+title via PS loop over the known HWND list (no delegate syntax)
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

// ── P1 test ───────────────────────────────────────────────────────────────────
async function runP1() {
  w('\n── P1 (focused): Notepad — exact-HWND readback ──────────────────')
  const MARKER = 'GogaVerification_' + Date.now()
  let notepadHwnd = 0
  let notepadRealPid = null
  let baselineRecords = []

  try {
    // 1. Rich baseline — must be non-empty before launching
    baselineRecords = await captureBaseline()
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baselineRecords, null, 2), 'utf8')
    const baselineValid = baselineRecords.length > 0
    w(`       baseline hwnd count=${baselineRecords.length} baselineValid=${baselineValid}`)
    w(`       baseline snapshot saved to: ${BASELINE_FILE}`)
    // Schema: { hwnd: number, pid: number, title: string } — cls not available from computer.snapshotHwnds
    if (!baselineValid) {
      result('P1a', 'process.start launched Notepad, returned PID', false, 'baselineValid=false — baseline capture returned 0 records; Notepad not launched')
      result('P1b', 'AuthorizationService allowed process.start', null, 'skipped — invalid baseline')
      result('P1b2', 'Test HWND absent from pre-launch baseline', null, 'skipped — invalid baseline')
      result('P1c', 'computer.type step succeeded', null, 'skipped — invalid baseline')
      result('P1d', 'Exact-HWND readback contains marker', null, 'skipped — invalid baseline')
      result('P1e', 'VerificationEngine window_exists', null, 'skipped — invalid baseline')
      return
    }

    // 2. Launch Notepad
    installPlan([
      { thought: 'Launch Notepad', tool: 'process.start', params: { executable: 'notepad.exe' } },
      { thought: 'Wait for window', tool: 'computer.wait', params: { type: 'window', windowTitle: 'Notepad', timeoutMs: 8000 } },
      { thought: 'Done', done: true, reply: 'Launched.', tool: '', params: {} }
    ])
    const stateA = await processAndWait('open notepad and type a test message', 15000)
    const startStep = stateA.steps.find(s => s.tool === 'process.start')
    const launcherPid = startStep?.result?.data?.pid ?? null
    w(`       process.start launcherPid=${launcherPid}`)

    const pidOk = typeof launcherPid === 'number' && launcherPid > 0
    result('P1a', 'process.start launched Notepad, returned PID', pidOk,
      `pid=${launcherPid} success=${startStep?.result?.success}`)
    if (!pidOk) { result('P1b', 'AuthorizationService', null, 'skipped'); return }

    const auth = AuthorizationService.getInstance()
    const reg  = ToolRegistry.getInstance()
    const toolDef = reg.get('process.start')?.definition
    const decision = toolDef ? auth.evaluate(toolDef, { executable: 'notepad.exe' }, { mode: 'normal' }) : null
    result('P1b', 'AuthorizationService allowed process.start',
      decision?.allowed === true && decision?.requiresApproval === false,
      `allowed=${decision?.allowed} requiresApproval=${decision?.requiresApproval}`)

    // 3. Discover exact HWND via windowByTitleDiff
    const baselineHwndNums = baselineRecords.map(r => r.hwnd)
    const ac = new AbortController()
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const wbd = await reg.execute('computer.windowByTitleDiff',
        { titleSubstring: 'Notepad', baselineHwnds: baselineHwndNums },
        { abortSignal: ac.signal }).catch(() => null)
      const win = wbd?.data
      if (win && win.hwnd) { notepadHwnd = win.hwnd; notepadRealPid = win.pid; break }
      await sleep(400)
    }
    // Assert: exactly one new HWND was discovered
    // (windowByTitleDiff already enforces this internally; we confirm here)
    const exactlyOne = notepadHwnd !== 0
    w(`       windowByTitleDiff hwnd=0x${notepadHwnd.toString(16)} ownerPid=${notepadRealPid} exactlyOne=${exactlyOne}`)

    // 4. Assert testHwnd absent from baseline
    const inBaseline = baselineRecords.some(r => r.hwnd === notepadHwnd)
    w(`       testHwnd absent from baseline: ${!inBaseline}`)
    if (inBaseline) {
      const rec = baselineRecords.find(r => r.hwnd === notepadHwnd)
      w(`       ERROR: hwnd=0x${notepadHwnd.toString(16)} was in baseline pid=${rec?.pid} title="${rec?.title}"`)
    }
    result('P1b2', 'Test HWND absent from pre-launch baseline', !inBaseline && exactlyOne,
      `hwnd=0x${notepadHwnd.toString(16)} inBaseline=${inBaseline} exactlyOne=${exactlyOne}`)

    if (!notepadHwnd) {
      result('P1c', 'computer.type succeeded', null, 'skipped — no HWND')
      result('P1d', 'Exact-HWND readback contains marker', null, 'skipped — no HWND')
      result('P1e', 'VerificationEngine window_exists', null, 'skipped — no HWND')
      return
    }

    // 5. Focus + type
    installPlan([
      { thought: 'Focus exact HWND', tool: 'computer.focus.window', params: { pid: notepadRealPid, hwnd: notepadHwnd, title: 'Notepad' } },
      { thought: 'Type marker', tool: 'computer.type', params: { text: MARKER, pid: notepadRealPid, hwnd: notepadHwnd, windowTitle: 'Notepad' } },
      { thought: 'Done', done: true, reply: 'Typed.', tool: '', params: {} }
    ])
    const stateB = await processAndWait('run the marker typing task in notepad', 20000)
    const typeStep = stateB.steps.find(s => s.tool === 'computer.type')
    result('P1c', 'computer.type step succeeded', typeStep?.result?.success === true,
      `success=${typeStep?.result?.success} error=${typeStep?.result?.error ?? 'none'}`)

    // 6. Exact-HWND readback
    const readBack = await readNotepadTextByHwnd(notepadHwnd, MARKER, 4000)
    const markerFound = readBack.includes(MARKER)
    result('P1d', 'Exact-HWND readback contains marker', markerFound,
      `hwnd=0x${notepadHwnd.toString(16)} marker="${MARKER}" readBack="${readBack.slice(0, 120)}"`)

    // 7. VerificationEngine
    const ve = VerificationEngine.getInstance()
    const veResult = await ve.verify({ type: 'window_exists', windowTitle: 'Notepad' })
    result('P1e', 'VerificationEngine window_exists=passed', veResult.outcome === 'passed',
      `outcome=${veResult.outcome} detail="${veResult.detail}"`)

  } catch (e) {
    result('P1a', 'Notepad P1 path', false, `FATAL: ${e.message}`)
    w(e.stack)
  } finally {
    clearPlan()
    const cleanup = await closeNotepadHwnd(notepadHwnd, notepadRealPid, baselineRecords)
    result('P1f', 'Cleanup: exact HWND closed (gone=True) and missing=0',
      cleanup.gone && cleanup.allSurvived,
      `hwnd=0x${(notepadHwnd || 0).toString(16)} gone=${cleanup.gone} allSurvived=${cleanup.allSurvived}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  w('\n╔══════════════════════════════════════════════════════════════╗')
  w('║  F0.3 — Focused P1 Live Harness                             ║')
  w('║  Exact-HWND readback · Rich baseline · Scoped cleanup       ║')
  w('╚══════════════════════════════════════════════════════════════╝\n')

  await runP1()

  w('\n' + '═'.repeat(70))
  w('F0.3 P1 FOCUSED RESULTS')
  w('═'.repeat(70))
  w(`Total: ${pass} PASS  ${fail} FAIL`)
  if (fail > 0) w('\nP1 focused harness FAILED.')
  else          w('\nP1 focused harness passed.')

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  w(`\nResults written to ${OUT}`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch(err => {
  w(`\nFATAL: ${err.message}\n${err.stack}`)
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  process.exit(1)
})
