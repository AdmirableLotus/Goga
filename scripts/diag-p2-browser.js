#!/usr/bin/env node
/**
 * P2 Browser diagnostic — prints registered schemas, phase-two plan JSON,
 * and step records. Uses only the local test page. No external sites.
 */
'use strict'

const path = require('path')
const fs   = require('fs')
const os   = require('os')

const DIST = path.resolve(__dirname, '..', 'dist', 'main', 'main')
if (!fs.existsSync(DIST)) { console.error('FATAL: build first'); process.exit(1) }

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

// ── Load ──────────────────────────────────────────────────────────────────────
require(path.join(DIST, 'tools', 'index.js'))
const { ToolRegistry } = require(path.join(DIST, 'tools', 'registry.js'))
const { AgentLoop }    = require(path.join(DIST, 'services', 'agentLoop.js'))

const reg = ToolRegistry.getInstance()

// ── 1. Registered schemas ─────────────────────────────────────────────────────
console.log('\n=== REGISTERED SCHEMAS ===')
for (const name of ['browser.open', 'browser.type', 'browser.click', 'browser.close']) {
  const t = reg.get(name)
  if (!t) { console.log(`  ${name}: NOT REGISTERED`); continue }
  const req = t.definition.parameters.required ?? []
  const props = Object.keys(t.definition.parameters.properties)
  console.log(`  ${name}: required=${JSON.stringify(req)} props=${JSON.stringify(props)}`)
}

// ── 2. Phase-two plan JSON ────────────────────────────────────────────────────
const testPageUrl = 'file:///' + path.join(__dirname, 'test-page', 'index.html').replace(/\\/g, '/')
const capturedSessionId = 'browser-1'  // what phase A would return

const phaseTwoPlan = [
  { thought: 'Fill username input',
    tool: 'browser.type',
    params: { sessionId: capturedSessionId, selector: '#input-username', text: 'GogaBraveTest' } },
  { thought: 'Click submit button',
    tool: 'browser.click',
    params: { sessionId: capturedSessionId, selector: '#btn-submit' } },
  { thought: 'Done', done: true, reply: 'Form submitted.', tool: '', params: {} }
]
console.log('\n=== PHASE-TWO PLAN JSON ===')
console.log(JSON.stringify(phaseTwoPlan, null, 2))

// ── 3. Planner patch ──────────────────────────────────────────────────────────
let _queue = []
AgentLoop.prototype.planNextStep = async function() {
  if (_queue.length > 0) return _queue.shift()
  return { thought: 'exhausted', done: true, reply: 'done', tool: '', params: {} }
}

// ── 4. Execute phase-two steps directly via ToolRegistry ─────────────────────
// We do NOT open a real browser — we just check what happens when sessionId
// is passed to a non-existent session (expected: error "No browser session").
// This confirms the tool name, argument mapping, and result shape.

console.log('\n=== DIRECT TOOL EXECUTION (no real browser — session not open) ===')

async function run() {
  const ac = new AbortController()

  for (const step of phaseTwoPlan.filter(s => s.tool)) {
    const result = await reg.execute(step.tool, step.params, { abortSignal: ac.signal })
    console.log(`\n  tool: ${step.tool}`)
    console.log(`  params: ${JSON.stringify(step.params)}`)
    console.log(`  result.success: ${result.success}`)
    console.log(`  result.data:    ${JSON.stringify(result.data)}`)
    console.log(`  result.error:   ${result.error ?? '(none)'}`)
  }

  // ── 5. Check what property the production test reads ─────────────────────
  console.log('\n=== RESULT FIELD ANALYSIS ===')
  console.log('  Production test reads: step.result?.success')
  console.log('  ToolRegistry.execute returns: { success, data?, error? }')
  console.log('  AgentLoop stores step result as: step.result = await registry.execute(...)')
  console.log('  => step.result.success should be the correct field')
  console.log('  => If step.result is undefined, the step was never stored or the tool name was wrong')

  // ── 6. Verify tool names are registered ──────────────────────────────────
  console.log('\n=== TOOL NAME REGISTRATION CHECK ===')
  const names = ['browser.type', 'browser.click', 'browser.open', 'browser.close']
  for (const n of names) {
    console.log(`  ${n}: ${reg.has(n) ? 'REGISTERED' : 'MISSING'}`)
  }

  // ── 7. Check AgentLoop step storage ──────────────────────────────────────
  console.log('\n=== AgentLoop step storage path ===')
  const agentLoopSrc = path.join(DIST, 'services', 'agentLoop.js')
  const src = fs.readFileSync(agentLoopSrc, 'utf8')
  // Find how steps are stored
  const storeMatch = src.match(/step\.result\s*=|steps\.push|result\s*=\s*await.*execute/g) ?? []
  console.log('  Relevant lines (grep):')
  storeMatch.slice(0, 10).forEach(m => console.log(`    ${m}`))

  // Check if agentLoop stores the full ToolResult or just .data
  const dataOnlyMatch = src.includes('step.result = result.data') || src.includes('.result=result.data')
  const fullResultMatch = src.includes('step.result = result') && !src.includes('step.result = result.data')
  console.log(`  Stores full ToolResult (success+data+error): ${fullResultMatch}`)
  console.log(`  Stores only result.data: ${dataOnlyMatch}`)

  // Search for the actual assignment
  const assignIdx = src.indexOf('step.result')
  if (assignIdx >= 0) {
    console.log(`  step.result assignment context: ...${src.slice(Math.max(0,assignIdx-40), assignIdx+80)}...`)
  }
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
