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
  w('\n── A5: Notepad launch + UIAutomation read (adapter-level) ───────')
  let notepadPid = null
  try {
    // Launch Notepad and capture PID
    const psLaunch = await runPS(`
      $p = Start-Process notepad.exe -PassThru
      Write-Output $p.Id
    `)
    notepadPid = parseInt(psLaunch.trim(), 10)
    if (isNaN(notepadPid)) throw new Error(`Bad PID: "${psLaunch.trim()}"`)
    await sleep(1500)

    // Focus and type via SendKeys
    await runPS(`
      Add-Type -AssemblyName UIAutomationClient
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $win = $null
      foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($w.Current.ProcessId -eq ${notepadPid} -and $w.Current.BoundingRectangle.Width -gt 0) { $win = $w; break }
      }
      if ($win) {
        Add-Type @"
          using System; using System.Runtime.InteropServices;
          public class WF { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
        [WF]::SetForegroundWindow([IntPtr]$win.Current.NativeWindowHandle) | Out-Null
        Start-Sleep -Milliseconds 300
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait('Adapter test text')
      }
    `)
    await sleep(300)

    // Read back via UIAutomation ValuePattern
    const readBack = await runPS(`
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $win = $null
      foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($w.Current.ProcessId -eq ${notepadPid} -and $w.Current.BoundingRectangle.Width -gt 0) { $win = $w; break }
      }
      if (-not $win) { Write-Output ''; exit }
      foreach ($el in $win.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)) {
        $ct = $el.Current.ControlType.ProgrammaticName
        if ($ct -like '*Edit*' -or $ct -like '*Document*') {
          try {
            $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            Write-Output $vp.Current.Value; exit
          } catch {}
        }
      }
    `)
    const ok = readBack.includes('Adapter test text')
    result('A5', 'Notepad launch + UIAutomation type+readback (adapter)', ok, `readBack="${readBack.slice(0, 80)}"`)
  } catch (e) {
    result('A5', 'Notepad launch + UIAutomation type+readback (adapter)', false, `ERROR: ${e.message}`)
  } finally {
    // Close only the Notepad we launched (by PID)
    if (notepadPid) {
      await runPS(`
        $p = Get-Process -Id ${notepadPid} -ErrorAction SilentlyContinue
        if ($p) {
          $p.CloseMainWindow() | Out-Null
          Start-Sleep -Milliseconds 600
          # Dismiss Save dialog if present
          Add-Type -AssemblyName UIAutomationClient
          $root = [System.Windows.Automation.AutomationElement]::RootElement
          foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
            if ($w.Current.ProcessId -eq ${notepadPid}) {
              foreach ($btn in $w.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)) {
                if ($btn.Current.Name -eq "Don't Save" -or $btn.Current.Name -eq "No") {
                  try { $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {}
                }
              }
            }
          }
          Start-Sleep -Milliseconds 400
          Stop-Process -Id ${notepadPid} -Force -ErrorAction SilentlyContinue
        }
      `).catch(() => {})
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
