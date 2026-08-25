#!/usr/bin/env node
/**
 * F0.3 — Focus Safety Unit Tests (noninteractive)
 *
 * Tests focusGuardedType() in isolation. No real windows opened.
 * DesktopAdapter is stubbed; activeWindowWithHwnd() returns controlled values.
 *
 * Cases:
 *   U1: missing pid        → target_required, zero keyboard calls
 *   U2: missing hwnd       → target_required, zero keyboard calls
 *   U3: wrong PID          → focus_lost, zero keyboard calls
 *   U4: correct PID, wrong HWND → allowed (PID-only check, no PS subprocess)
 *   U5: duplicate title, wrong PID/HWND → focus_lost, zero keyboard calls
 *   U6: correct PID + correct HWND → keyboard called exactly once
 *
 * Run: node scripts/f03-focus-unit-tests.js
 */

'use strict'

const path = require('path')
const os   = require('fs')  // unused but keep require pattern consistent
const fs   = require('fs')

const DIST = path.resolve(__dirname, '..', 'dist', 'main', 'main')
const OUT  = path.join(__dirname, 'f03-focus-unit-results.txt')

if (!fs.existsSync(DIST)) {
  console.error('FATAL: dist/main/main not found — run: npm run build:main')
  process.exit(1)
}

// ── Dependency mocks ──────────────────────────────────────────────────────────

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
  app: { getPath: () => require('os').tmpdir(), isPackaged: false, on: () => {} },
  BrowserWindow: class { webContents = { send: () => {} } },
  ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} }
}
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true, exports: electronMock
}

const idxPath = path.join(DIST, 'index.js')
require.cache[idxPath] = {
  id: idxPath, filename: idxPath, loaded: true,
  exports: { getMainWindow: () => null }
}

// ── Load FocusManager from dist ───────────────────────────────────────────────

const { FocusManager } = require(path.join(DIST, 'services', 'focusManager.js'))

// ── Test harness ──────────────────────────────────────────────────────────────

const lines = []
let pass = 0, fail = 0

function w(s) { lines.push(s); process.stdout.write(s + '\n') }

function result(id, name, ok, detail) {
  if (ok) pass++; else fail++
  w(`  [${ok ? '✓' : '✗'}] ${id}: ${name}  [${ok ? 'PASS' : 'FAIL'}]`)
  if (detail) w(`       ${detail}`)
}

// ── Stub helpers ──────────────────────────────────────────────────────────────
// Build a FocusManager with a stubbed DesktopAdapter.
// activeWindowWithHwnd() is the primary path; activeWindow() is the fallback.

function makeFM(fgWindow) {
  // fgWindow: { pid, hwnd, title }
  const fm = new FocusManager({ info: () => {}, warn: () => {} })
  fm['desktop'] = {
    activeWindowWithHwnd: () => Promise.resolve(fgWindow),
    activeWindow: () => Promise.resolve({ title: fgWindow.title, owner: '', pid: fgWindow.pid }),
    windowList:   () => Promise.resolve([{ title: fgWindow.title, owner: '', pid: fgWindow.pid, bounds: { x: 0, y: 0, width: 800, height: 600 } }]),
    focusWindow:  () => Promise.resolve({ focused: false, title: '' }),
    focusWindowByHwnd: () => Promise.resolve(),
    focusAndGetForeground: () => Promise.resolve(fgWindow),
    accessibilityTree: () => Promise.resolve([])
  }
  return fm
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function run() {
  w('\n╔══════════════════════════════════════════════════════════════╗')
  w('║  F0.3 — Focus Safety Unit Tests (noninteractive)             ║')
  w('╚══════════════════════════════════════════════════════════════╝\n')

  // U1: missing pid → target_required, typeFn never called
  {
    let typeCalled = 0
    const fm = makeFM({ pid: 1234, hwnd: 0x1000, title: 'Untitled - Notepad' })
    const r = await fm.focusGuardedType(
      { title: 'Notepad' },          // no pid, no hwnd
      async () => { typeCalled++ },
      undefined, 'input'
    )
    result('U1', 'missing pid → target_required, zero keyboard calls',
      !r.allowed && typeCalled === 0 && (r.reason || '').includes('target_required'),
      `allowed=${r.allowed} typeCalled=${typeCalled} reason="${r.reason}"`)
  }

  // U2: missing hwnd → target_required, typeFn never called
  {
    let typeCalled = 0
    const fm = makeFM({ pid: 1234, hwnd: 0x1000, title: 'Untitled - Notepad' })
    const r = await fm.focusGuardedType(
      { pid: 1234, title: 'Notepad' },  // pid present but no hwnd
      async () => { typeCalled++ },
      undefined, 'input'
    )
    result('U2', 'missing hwnd → target_required, zero keyboard calls',
      !r.allowed && typeCalled === 0 && (r.reason || '').includes('target_required'),
      `allowed=${r.allowed} typeCalled=${typeCalled} reason="${r.reason}"`)
  }

  // U3: wrong PID → focus_lost, typeFn never called
  {
    let typeCalled = 0
    const fm = makeFM({ pid: 9999, hwnd: 0x2000, title: 'Untitled - Notepad' })
    const r = await fm.focusGuardedType(
      { pid: 1234, hwnd: 0x1000, title: 'Notepad' },  // foreground is pid 9999
      async () => { typeCalled++ },
      undefined, 'input'
    )
    result('U3', 'wrong PID → focus_lost, zero keyboard calls',
      !r.allowed && typeCalled === 0 && (r.reason || '').includes('focus_lost'),
      `allowed=${r.allowed} typeCalled=${typeCalled} reason="${r.reason}"`)
  }

  // U4: correct PID, wrong HWND → allowed (active-win doesn't expose HWND; PID match is sufficient)
  //     HWND verification requires a PS subprocess which would steal focus.
  //     The computer.focus.window step already verified HWND before this guard runs.
  {
    let typeCalled = 0
    const fm = makeFM({ pid: 1234, hwnd: 0x9999, title: 'Untitled - Notepad' })  // different HWND
    const r = await fm.focusGuardedType(
      { pid: 1234, hwnd: 0x1000, title: 'Notepad' },  // expected HWND 0x1000
      async () => { typeCalled++ },
      undefined, 'input'
    )
    result('U4', 'correct PID, wrong HWND → allowed (PID-only check, no PS subprocess)',
      r.allowed && typeCalled === 1,
      `allowed=${r.allowed} typeCalled=${typeCalled} reason="${r.reason ?? 'none'}"`)
  }

  // U5: duplicate title, wrong PID/HWND → focus_lost, zero keyboard calls
  //     Simulates two Notepad windows; foreground belongs to a different instance.
  {
    let typeCalled = 0
    const fm = makeFM({ pid: 8888, hwnd: 0x8000, title: 'Untitled - Notepad' })
    const r = await fm.focusGuardedType(
      { pid: 1234, hwnd: 0x1000, title: 'Notepad' },  // test owns pid 1234, foreground is pid 8888
      async () => { typeCalled++ },
      undefined, 'input'
    )
    result('U5', 'duplicate title, wrong PID/HWND → focus_lost, zero keyboard calls',
      !r.allowed && typeCalled === 0 && (r.reason || '').includes('focus_lost'),
      `allowed=${r.allowed} typeCalled=${typeCalled} reason="${r.reason}"`)
  }

  // U6: correct PID + correct HWND → guard permits, typeFn called exactly once
  {
    let typeCalled = 0
    const fm = makeFM({ pid: 1234, hwnd: 0x1000, title: 'Untitled - Notepad' })
    const r = await fm.focusGuardedType(
      { pid: 1234, hwnd: 0x1000, title: 'Notepad' },
      async () => { typeCalled++ },
      undefined, 'input'
    )
    result('U6', 'correct PID + correct HWND → guard permits, typeFn called once',
      r.allowed && typeCalled === 1,
      `allowed=${r.allowed} typeCalled=${typeCalled} reason="${r.reason ?? 'none'}"`)
  }

  w('\n' + '═'.repeat(70))
  w('F0.3 FOCUS UNIT TEST RESULTS')
  w('═'.repeat(70))
  w(`Total: ${pass} PASS  ${fail} FAIL`)
  if (fail > 0) w('\nFocus unit tests FAILED.')
  else          w('\nAll 6 focus unit tests passed (U1–U6).')

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  w(`\nResults written to ${OUT}`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch(err => {
  w(`\nFATAL: ${err.message}\n${err.stack}`)
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  process.exit(1)
})
