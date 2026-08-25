#!/usr/bin/env node
/**
 * F0.3 — Routing Unit Tests (noninteractive)
 *
 * Tests looksLikeAgentTask() in isolation against the compiled orchestrator.
 * No windows opened, no network, no agent loop started.
 *
 * Cases:
 *   R1: "fill and submit the form"          → agent path
 *   R2: "fill the form"                     → agent path
 *   R3: "submit the form"                   → agent path
 *   R4: "complete this form"                → agent path
 *   R5: "I need to fill my water bottle"    → chat path (no form/field/input context)
 *   R6: "please submit my resignation"      → chat path (no form/field/input context)
 *   R7: "open notepad and type a message"   → agent path (existing trigger)
 *   R8: "what time is it"                   → chat path
 *
 * Run: node scripts/f03-routing-tests.js
 */

'use strict'

const path = require('path')
const fs   = require('fs')
const os   = require('os')

const DIST = path.resolve(__dirname, '..', 'dist', 'main', 'main')
const OUT  = path.join(__dirname, 'f03-routing-results.txt')

if (!fs.existsSync(DIST)) {
  console.error('FATAL: dist/main/main not found — run: npm run build:main')
  process.exit(1)
}

// ── Mocks (minimal — only what orchestrator.js imports need) ──────────────────
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

// ── Extract looksLikeAgentTask from compiled orchestrator ─────────────────────
// We load the module and call OrchestratorService.process() with a mock that
// records whether startAgentTask was called. This tests the real routing logic
// without starting the agent loop.

require(path.join(DIST, 'tools', 'index.js'))

const orchSrc = path.join(DIST, 'services', 'orchestrator.js')
const { OrchestratorService } = require(orchSrc)

// Patch AgentLoop.run so it never actually runs
const { AgentLoop } = require(path.join(DIST, 'services', 'agentLoop.js'))
AgentLoop.prototype.run = async function() { return 'routing-test-stub' }
AgentLoop.prototype.isRunning = function() { return false }
AgentLoop.prototype.getState  = function() { return { status: 'idle', steps: [] } }

// ── Test harness ──────────────────────────────────────────────────────────────
const lines = []
let pass = 0, fail = 0

function w(s) { lines.push(s); process.stdout.write(s + '\n') }

function result(id, name, ok, detail) {
  if (ok) pass++; else fail++
  w(`  [${ok ? '✓' : '✗'}] ${id}: ${name}  [${ok ? 'PASS' : 'FAIL'}]`)
  if (detail) w(`       ${detail}`)
}

// Route a message and return true if it went to the agent path.
// We detect this by checking whether the immediate reply is the agent
// acknowledgement string ("On it") vs a model-error/fallback string.
async function routesToAgent(message) {
  const orch = new OrchestratorService()
  let agentStarted = false

  // Patch startAgentTask detection via the agent run stub
  const origRun = AgentLoop.prototype.run
  AgentLoop.prototype.run = async function() {
    agentStarted = true
    return 'routing-test-stub'
  }

  const msg = { id: 'r-' + Date.now(), role: 'user', content: message, timestamp: Date.now() }
  const reply = await orch.process(msg, undefined, () => {})

  AgentLoop.prototype.run = origRun

  // Agent path returns the "On it" acknowledgement immediately
  const isAgentReply = reply.content.includes('On it') || agentStarted
  return isAgentReply
}

// ── Tests ─────────────────────────────────────────────────────────────────────
async function run() {
  w('\n╔══════════════════════════════════════════════════════════════╗')
  w('║  F0.3 — Routing Unit Tests (noninteractive)                  ║')
  w('╚══════════════════════════════════════════════════════════════╝\n')

  const cases = [
    // [id, message, expectAgent, description]
    // ── Required proof cases ──────────────────────────────────────────────
    ['R1', 'fill and submit the form',          true,  'P2 phrase: fill+submit+form → agent path'],
    ['R5', 'I need to fill my water bottle',    false, 'conversational fill without form/field/input context → chat path'],
    // ── Additional form-action coverage ──────────────────────────────────
    ['R2', 'fill the form',                     true,  'fill + form → agent path'],
    ['R3', 'submit the form',                   true,  'submit + form → agent path'],
    ['R4', 'complete this form',                true,  'complete + form → agent path'],
    ['R6', 'please submit my resignation',      false, 'submit without form context → chat path'],
    ['R7', 'open notepad and type a message',   true,  'existing open+and trigger → agent path'],
    ['R8', 'what time is it',                   false, 'conversational → chat path'],
  ]

  for (const [id, msg, expectAgent, desc] of cases) {
    const isAgent = await routesToAgent(msg)
    result(id, desc,
      isAgent === expectAgent,
      `message="${msg}" expectAgent=${expectAgent} gotAgent=${isAgent}`)
  }

  w('\n' + '═'.repeat(70))
  w('F0.3 ROUTING TEST RESULTS')
  w('═'.repeat(70))
  w(`Total: ${pass} PASS  ${fail} FAIL`)
  if (fail > 0) w('\nRouting tests FAILED.')
  else          w('\nAll 8 routing tests passed (R1+R5 are required proof cases).')

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  w(`\nResults written to ${OUT}`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch(err => {
  w(`\nFATAL: ${err.message}\n${err.stack}`)
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  process.exit(1)
})
