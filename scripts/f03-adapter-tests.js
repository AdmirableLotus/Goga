#!/usr/bin/env node
/**
 * F0.3 — Adapter Integration Tests
 *
 * Tests the DesktopAdapter and BrowserAdapter directly.
 * These are adapter-layer tests — they do NOT exercise the production
 * OrchestratorService → AgentLoop → AuthorizationService → ToolRegistry path.
 * See f03-production-tests.js for production-path tests.
 *
 * Run: npm run test:f03-adapters
 * Requires: npm run build:main first
 */

'use strict'

const path  = require('path')
const fs    = require('fs')
const { execSync, spawn } = require('child_process')

const DIST = path.join(__dirname, '..', 'dist', 'main')
const OUT  = path.join(__dirname, 'f03-adapter-results.txt')

// ── electron-store mock (DesktopAdapter does not use it, but transitive
//    imports from services pulled in by tools/index do) ────────────────────
const mockStore = () => {
  const data = {}
  function Store(opts) { Object.assign(data, opts?.defaults ?? {}) }
  Store.prototype.get = (k) => data[k]
  Store.prototype.set = (k, v) => { if (typeof k === 'object') Object.assign(data, k); else data[k] = v }
  Store.prototype.store = data
  return Store
}
require.cache[require.resolve('electron-store')] = { id: 'electron-store', filename: 'electron-store', loaded: true, exports: mockStore() }

// electron mock — getMainWindow returns null (no IPC in adapter tests)
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: { app: { getPath: () => require('os').tmpdir(), isPackaged: false }, BrowserWindow: class {}, ipcMain: { on: () => {}, handle: () => {} } }
}

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
function runPS(script, timeoutMs = 20000) {
  const tmp = path.join(require('os').tmpdir(), 'goga-adp-' + Date.now() + '.ps1')
  fs.writeFileSync(tmp, script, 'utf8')
  return new Promise((resolve, reject) => {
    let out = '', err = ''
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp], { windowsHide: true })
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

async function run() {
  w('\n╔══════════════════════════════════════════════════════════════╗')
  w('║  F0.3 — Adapter Integration Tests                           ║')
  w('║  Layer: DesktopAdapter + BrowserAdapter (direct calls)      ║')
  w('║  NOT the production OrchestratorService → AgentLoop path    ║')
  w('╚══════════════════════════════════════════════════════════════╝\n')

  if (!fs.existsSync(DIST)) {
    w('FATAL: dist/main not found — run: npm run build:main')
    process.exit(1)
  }

  // Load compiled adapters
  const { DesktopAdapter } = require(path.join(DIST, 'adapters', 'desktop.js'))
  const desktop = new DesktopAdapter()

  // ── A1: screenshot ────────────────────────────────────────────────────────
  w('── A1: DesktopAdapter.screenshot() ──────────────────────────────')
  try {
    const r = await desktop.screenshot()
    const ok = typeof r.base64 === 'string' && r.base64.length > 1000
    result('A1', 'screenshot returns base64 PNG', ok, `base64 length=${r.base64.length}`)
  } catch (e) {
    result('A1', 'screenshot returns base64 PNG', false, `ERROR: ${e.message}`)
  }

  // ── A2: activeWindow ──────────────────────────────────────────────────────
  w('\n── A2: DesktopAdapter.activeWindow() ────────────────────────────')
  try {
    const r = await desktop.activeWindow()
    const ok = typeof r.title === 'string'
    result('A2', 'activeWindow returns title', ok, `title="${r.title}" owner="${r.owner}" pid=${r.pid}`)
  } catch (e) {
    result('A2', 'activeWindow returns title', false, `ERROR: ${e.message}`)
  }

  // ── A3: windowList ────────────────────────────────────────────────────────
  w('\n── A3: DesktopAdapter.windowList() ──────────────────────────────')
  try {
    const r = await desktop.windowList()
    const ok = Array.isArray(r) && r.length > 0
    result('A3', 'windowList returns array', ok, `count=${r.length} first="${r[0]?.title ?? ''}"`)
  } catch (e) {
    result('A3', 'windowList returns array', false, `ERROR: ${e.message}`)
  }

  // ── A4: clipboardWrite + clipboardRead ────────────────────────────────────
  w('\n── A4: DesktopAdapter clipboard round-trip ───────────────────────')
  try {
    const testVal = 'goga-adapter-test-' + Date.now()
    await desktop.clipboardWrite(testVal)
    const r = await desktop.clipboardRead()
    const ok = r.text === testVal
    result('A4', 'clipboard write+read round-trip', ok, `written="${testVal}" read="${r.text}"`)
  } catch (e) {
    result('A4', 'clipboard write+read round-trip', false, `ERROR: ${e.message}`)
  }

  // ── A5: Notepad launch via spawn (adapter-level, not via tool) ────────────
  // SAFETY: Windows 11 single-instance Notepad routes new windows into a shared
  // host process, so the launcher PID is NOT reliably the window owner. We must
  // identify the EXACT new top-level HWND (baseline EnumWindows diff) and operate
  // on that handle only. Cleanup sends WM_CLOSE to that exact HWND — never
  // Stop-Process by PID, which could kill a shared Notepad host and destroy
  // unrelated user windows. Mirrors scripts/diag-notepad-hwnd.ps1.
  w('\n── A5: Notepad launch + UIAutomation read (adapter-level) ───────')
  let testHwnd = null
  let baselineHwnds = []   // exact baseline HWND list captured before launch; verified to survive cleanup
  try {
    // Capture baseline HWNDs, launch Notepad, then isolate the exact new window.
    // The baseline list is emitted (BASELINE=csv) so cleanup can prove every
    // pre-existing window still exists afterward.
    const launchOut = await runPS(`
      Add-Type @"
        using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
        public static class NPEnum {
          public delegate bool EnumProc(IntPtr h, IntPtr l);
          [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
          [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
          [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
          public static List<IntPtr> Visible() {
            var r = new List<IntPtr>();
            EnumWindows((h,l) => { if (IsWindowVisible(h)) r.Add(h); return true; }, IntPtr.Zero);
            return r;
          }
          public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
        }
"@
      $baseline = @{}
      $baselineList = @()
      foreach ($h in [NPEnum]::Visible()) { $baseline[[int64]$h] = $true; $baselineList += [int64]$h }
      Write-Output ("BASELINE=" + ($baselineList -join ','))
      Start-Process notepad.exe | Out-Null
      $new = @()
      $deadline = (Get-Date).AddSeconds(10)
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        $new = @()
        foreach ($h in [NPEnum]::Visible()) {
          if (-not $baseline.ContainsKey([int64]$h)) {
            $t = [NPEnum]::Title($h)
            if ($t -match 'Notepad') { $new += $h }
          }
        }
        if ($new.Count -ge 1) { break }
      }
      if ($new.Count -eq 0) { Write-Output 'HWND=0'; exit }
      if ($new.Count -gt 1) { Write-Output 'HWND=AMBIGUOUS'; exit }
      Write-Output ("HWND=" + [int64]$new[0])
    `)
    const baseM = launchOut.match(/BASELINE=([\d,]*)/)
    baselineHwnds = baseM && baseM[1] ? baseM[1].split(',').filter(Boolean) : []
    const m = launchOut.trim().match(/HWND=(\d+)/)
    if (!m || launchOut.includes('AMBIGUOUS')) {
      throw new Error(`Could not isolate exactly one new Notepad HWND: "${launchOut.trim()}"`)
    }
    testHwnd = m[1]
    if (testHwnd === '0') throw new Error('Zero new Notepad windows appeared')

    // Focus and type into the EXACT test HWND (never PID-based).
    await runPS(`
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class WF { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
      [WF]::SetForegroundWindow([IntPtr]${testHwnd}) | Out-Null
      Start-Sleep -Milliseconds 300
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('Adapter test text')
    `)
    await sleep(300)

    // Read back via UIAutomation anchored to the EXACT test HWND.
    const readBack = await runPS(`
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${testHwnd})
      if (-not $el) { Write-Output ''; exit }
      foreach ($e in $el.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)) {
        $ct = $e.Current.ControlType.ProgrammaticName
        if ($ct -like '*Edit*' -or $ct -like '*Document*') {
          try {
            $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            Write-Output $vp.Current.Value; exit
          } catch {}
        }
      }
    `)
    const ok = readBack.includes('Adapter test text')
    result('A5', 'Notepad launch + UIAutomation type+readback (adapter)', ok, `hwnd=${testHwnd} readBack="${readBack.slice(0, 80)}"`)
  } catch (e) {
    result('A5', 'Notepad launch + UIAutomation type+readback (adapter)', false, `ERROR: ${e.message}`)
  } finally {
    // Close ONLY the exact test HWND via WM_CLOSE. No Stop-Process, no PID kill,
    // no name-wide taskkill. If the host process exits naturally because this was
    // its only window, that is acceptable — we never terminate it ourselves.
    //
    // This block proves two safety guarantees and records A5-cleanup PASS/FAIL:
    //   1. The test HWND is gone (IsWindow==false) within a bounded 5s poll.
    //      If it never closes, that is a FAIL (no process-kill fallback exists).
    //   2. Every baseline HWND captured before launch still exists afterward.
    //      If any baseline window disappeared, that is a FAIL.
    if (testHwnd && testHwnd !== '0') {
      const baseCsv = baselineHwnds.join(',')
      const cleanupOut = await runPS(`
        Add-Type @"
          using System; using System.Runtime.InteropServices;
          public static class NPClose {
            [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
            [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
            [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
          }
"@
        $testHwnd = [IntPtr]${testHwnd}
        # WM_CLOSE to the exact test HWND only.
        [NPClose]::PostMessage($testHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        # Poll IsWindow(testHwnd) until false, bounded to 5s.
        $deadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $deadline) {
          Start-Sleep -Milliseconds 200
          if (-not [NPClose]::IsWindow($testHwnd)) { break }
        }
        # Save-dialog handling scoped to dialogs OWNED by the exact test HWND
        # (GW_OWNER = 4). InvokePattern only — no keystrokes, no PID filter.
        Add-Type -AssemblyName UIAutomationClient
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition)) {
          $wHwnd = [IntPtr]$w.Current.NativeWindowHandle
          if ([NPClose]::GetWindow($wHwnd, 4) -ne $testHwnd) { continue }
          foreach ($btn in $w.FindAll([System.Windows.Automation.TreeScope]::Subtree,
              [System.Windows.Automation.Condition]::TrueCondition)) {
            $n = $btn.Current.Name
            if ($n -eq "Don't Save" -or $n -eq "No" -or $n -eq "Don't save") {
              try { $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {}
            }
          }
        }
        # Final bounded re-poll after any save-dialog dismissal.
        $deadline2 = (Get-Date).AddSeconds(3)
        while ((Get-Date) -lt $deadline2) {
          if (-not [NPClose]::IsWindow($testHwnd)) { break }
          Start-Sleep -Milliseconds 200
        }
        $gone = -not [NPClose]::IsWindow($testHwnd)
        # Baseline survival: every pre-launch HWND must still exist.
        $missing = 0
        $baseArr = @(${baseCsv ? baseCsv.split(',').map(h => `[int64]${h}`).join(',') : ''})
        foreach ($b in $baseArr) { if (-not [NPClose]::IsWindow([IntPtr]$b)) { $missing++ } }
        Write-Output ("gone=" + $gone + " baselineMissing=" + $missing + " baselineTotal=" + $baseArr.Count)
      `).catch(() => 'gone=unknown baselineMissing=unknown baselineTotal=unknown')

      const goneOk = /gone=True/i.test(cleanupOut)
      const missingM = cleanupOut.match(/baselineMissing=(\d+)/)
      const totalM = cleanupOut.match(/baselineTotal=(\d+)/)
      const baselineIntact = missingM ? missingM[1] === '0' : false
      const cleanupOk = goneOk && baselineIntact
      result('A5-cleanup', 'Notepad cleanup: exact HWND closed + baseline intact', cleanupOk,
        `${cleanupOut.trim()} baselineCaptured=${baselineHwnds.length}` +
        (missingM && totalM ? ` (survived ${Number(totalM[1]) - Number(missingM[1])}/${totalM[1]})` : ''))
    }
  }

  // ── A6: BrowserAdapter — open test page, read DOM ─────────────────────────
  w('\n── A6: BrowserAdapter — open test page, read DOM ────────────────')
  let browserSessionId = null
  try {
    // Load BrowserAdapter from dist
    const { BrowserAdapter } = require(path.join(DIST, 'adapters', 'browser.js'))
    const browser = new BrowserAdapter()
    const testPageUrl = 'file:///' + path.join(__dirname, 'test-page', 'index.html').replace(/\\/g, '/')

    const openResult = await browser.open(testPageUrl, { headless: false })
    browserSessionId = openResult.sessionId
    await sleep(1000)

    const snap = await browser.snapshot(browserSessionId)
    const titleOk = snap.title.toLowerCase().includes('goga') || snap.title.toLowerCase().includes('test')
    result('A6a', 'BrowserAdapter open test page', titleOk, `title="${snap.title}" url="${snap.url}"`)

    // Click #btn-submit and verify #btn-result
    await browser.evaluate(browserSessionId, `document.getElementById('btn-submit').click()`)
    await sleep(300)
    const evalResult = await browser.evaluate(browserSessionId, `document.getElementById('btn-result').textContent`)
    const domOk = String(evalResult.result).includes('submit-clicked')
    result('A6b', 'BrowserAdapter click + DOM verify', domOk, `#btn-result="${evalResult.result}"`)

    await browser.close(browserSessionId)
    browserSessionId = null
  } catch (e) {
    result('A6a', 'BrowserAdapter open test page', false, `ERROR: ${e.message}`)
    result('A6b', 'BrowserAdapter click + DOM verify', false, 'SKIP (browser failed)')
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  w('\n' + '═'.repeat(70))
  w('F0.3 ADAPTER INTEGRATION TEST RESULTS')
  w('═'.repeat(70))
  w(`Total: ${pass} PASS  ${fail} FAIL  ${skip} SKIP`)
  w('\nNote: These are adapter-layer tests only.')
  w('      Production-path tests are in f03-production-tests.js')

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  w(`\nResults written to ${OUT}`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch(err => {
  w(`\nFATAL: ${err.message}\n${err.stack}`)
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  process.exit(1)
})
