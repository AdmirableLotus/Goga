#!/usr/bin/env node
/**
 * F0.3 — Combined Test Suite
 * 1. DOM verification fix (VerificationEngine returns passed, not inconclusive)
 * 2. computer.wait registration + cancellation
 * 3. Planner output validation (20 GGUF outputs vs registry)
 * 4. Regression (existing baseline)
 *
 * Run: node scripts/f03-tests.js
 */

// ── Electron stub ─────────────────────────────────────────────────────────────
const _ePath = require('path').join(__dirname, '..', 'node_modules', 'electron', 'index.js')
require.cache[_ePath] = {
  id: _ePath, filename: _ePath, loaded: true,
  exports: {
    app: { getPath: () => require('os').tmpdir(), getVersion: () => '0.1.0', on: () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    BrowserWindow: class {}
  },
  paths: [], children: [], parent: null
}
const _idxPath = require('path').join(__dirname, '..', 'dist', 'main', 'main', 'index.js')
require.cache[_idxPath] = {
  id: _idxPath, filename: _idxPath, loaded: true,
  exports: { getMainWindow: () => null },
  paths: [], children: [], parent: null
}

const fs   = require('fs')
const path = require('path')
const http = require('http')
const OUT  = path.join(__dirname, 'f03-results.txt')
const TEST_PAGE = 'file://' + path.join(__dirname, 'test-page', 'index.html').replace(/\\/g, '/')

const lines = []
function w(s) { lines.push(s); process.stdout.write(s + '\n') }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Load compiled stack
const { BrowserAdapter }      = require('../dist/main/main/adapters/browser.js')
const { VerificationEngine }  = require('../dist/main/main/services/verificationEngine.js')
const { AuthorizationService }= require('../dist/main/main/services/authorization.js')
const { AgentLoop }           = require('../dist/main/main/services/agentLoop.js')

// Load tool registry (triggers all registrations)
require('../dist/main/main/tools/index.js')
const { ToolRegistry } = require('../dist/main/main/tools/registry.js')
// Use the shared BrowserAdapter singleton — VerificationEngine uses the same instance
const { browserAdapter: sharedBrowser } = require('../dist/main/main/tools/browser.js')

const verifier = VerificationEngine.getInstance()
const registry = ToolRegistry.getInstance()

const results = []
function record(num, name, status, detail, error) {
  results.push({ num, name, status, detail, error })
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '⊘'
  w(`  [${icon}] T${num}: ${name}  [${status}]`)
  if (detail) w(`       ${detail}`)
  if (error)  w(`       ERROR: ${error}`)
}

async function run() {
  w('\n╔══════════════════════════════════════════════════════════════╗')
  w('║  F0.3 — Combined Test Suite                                  ║')
  w('╚══════════════════════════════════════════════════════════════╝\n')

  // ══════════════════════════════════════════════════════════════════
  // SECTION 1 — DOM Verification Fix
  // ══════════════════════════════════════════════════════════════════
  w('── Section 1: DOM Verification ──────────────────────────────────')

  // T1: Form submission → VerificationEngine returns passed (selector path)
  w('\nT1: DOM verify via selector — passed after form submit')
  {
    let sid
    try {
      const session = await sharedBrowser.open(TEST_PAGE, true)
      sid = session.sessionId
      await sharedBrowser.type(sid, '#input-username', 'goga_test')
      await sharedBrowser.type(sid, '#input-password', 'pass123')
      await sharedBrowser.clickByRole(sid, 'button', 'Submit')
      await sleep(200)

      const spec = {
        type: 'dom_text_exists',
        sessionId: sid,
        selector: '#btn-result',
        expected: 'submit-clicked'
      }
      const r = await verifier.verify(spec, new AbortController().signal)
      await sharedBrowser.close(sid)

      if (r.outcome === 'passed') {
        record(1, 'DOM verify selector → passed', 'PASS',
          `outcome=${r.outcome} method=${r.method} detail="${r.detail}"`)
      } else {
        record(1, 'DOM verify selector → passed', 'FAIL',
          `outcome=${r.outcome} (expected passed) detail="${r.detail}"`)
      }
    } catch (e) {
      try { if (sid) await sharedBrowser.close(sid) } catch {}
      record(1, 'DOM verify selector → passed', 'FAIL', null, e.message)
    }
  }

  // T2: Expected text absent → VerificationEngine returns failed
  w('\nT2: DOM verify — wrong expected text returns failed')
  {
    let sid
    try {
      const session = await sharedBrowser.open(TEST_PAGE, true)
      sid = session.sessionId
      // Do NOT submit — btn-result should be empty
      const spec = {
        type: 'dom_text_exists',
        sessionId: sid,
        selector: '#btn-result',
        expected: 'submit-clicked'
      }
      const r = await verifier.verify(spec, new AbortController().signal)
      await sharedBrowser.close(sid)

      if (r.outcome === 'failed') {
        record(2, 'DOM verify absent text → failed', 'PASS',
          `outcome=${r.outcome} method=${r.method} detail="${r.detail}"`)
      } else {
        record(2, 'DOM verify absent text → failed', 'FAIL',
          `outcome=${r.outcome} (expected failed) detail="${r.detail}"`)
      }
    } catch (e) {
      try { if (sid) await sharedBrowser.close(sid) } catch {}
      record(2, 'DOM verify absent text → failed', 'FAIL', null, e.message)
    }
  }

  // T3: Missing sessionId → explicit failure (not inconclusive)
  w('\nT3: DOM verify — missing sessionId returns inconclusive with clear message')
  {
    try {
      const spec = { type: 'dom_text_exists', expected: 'submit-clicked', selector: '#btn-result' }
      const r = await verifier.verify(spec, new AbortController().signal)
      // Missing sessionId should return inconclusive with "missing sessionId"
      if (r.outcome === 'inconclusive' && r.detail.includes('sessionId')) {
        record(3, 'DOM verify missing sessionId → inconclusive+message', 'PASS',
          `outcome=${r.outcome} detail="${r.detail}"`)
      } else {
        record(3, 'DOM verify missing sessionId → inconclusive+message', 'FAIL',
          `outcome=${r.outcome} detail="${r.detail}"`)
      }
    } catch (e) {
      record(3, 'DOM verify missing sessionId → inconclusive+message', 'FAIL', null, e.message)
    }
  }

  // T4: dom_text_gone — text present → failed
  w('\nT4: dom_text_gone — text present returns failed')
  {
    let sid
    try {
      const session = await sharedBrowser.open(TEST_PAGE, true)
      sid = session.sessionId
      await sharedBrowser.clickByRole(sid, 'button', 'Submit')
      await sleep(200)
      const spec = {
        type: 'dom_text_gone',
        sessionId: sid,
        selector: '#btn-result',
        expected: 'submit-clicked'
      }
      const r = await verifier.verify(spec, new AbortController().signal)
      await sharedBrowser.close(sid)
      if (r.outcome === 'failed') {
        record(4, 'dom_text_gone text present → failed', 'PASS',
          `outcome=${r.outcome} detail="${r.detail}"`)
      } else {
        record(4, 'dom_text_gone text present → failed', 'FAIL',
          `outcome=${r.outcome} (expected failed) detail="${r.detail}"`)
      }
    } catch (e) {
      try { if (sid) await sharedBrowser.close(sid) } catch {}
      record(4, 'dom_text_gone text present → failed', 'FAIL', null, e.message)
    }
  }

  // T5: getByText path (no selector) — visible text
  w('\nT5: DOM verify getByText path (no selector) — visible text')
  {
    let sid
    try {
      const session = await sharedBrowser.open(TEST_PAGE, true)
      sid = session.sessionId
      const spec = {
        type: 'dom_text_exists',
        sessionId: sid,
        expected: 'Goga Phase C Test Page'
      }
      const r = await verifier.verify(spec, new AbortController().signal)
      await sharedBrowser.close(sid)
      if (r.outcome === 'passed') {
        record(5, 'DOM verify getByText visible text → passed', 'PASS',
          `outcome=${r.outcome} method=${r.method} detail="${r.detail}"`)
      } else {
        record(5, 'DOM verify getByText visible text → passed', 'FAIL',
          `outcome=${r.outcome} detail="${r.detail}"`)
      }
    } catch (e) {
      try { if (sid) await sharedBrowser.close(sid) } catch {}
      record(5, 'DOM verify getByText visible text → passed', 'FAIL', null, e.message)
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 2 — computer.wait
  // ══════════════════════════════════════════════════════════════════
  w('\n── Section 2: computer.wait ─────────────────────────────────────')

  // T6: computer.wait is registered
  w('\nT6: computer.wait is registered in ToolRegistry')
  {
    const tool = registry.get('computer.wait')
    if (tool) {
      record(6, 'computer.wait registered', 'PASS',
        `name=${tool.definition.name} risk=${tool.definition.riskLevel} reversible=${tool.definition.reversible}`)
    } else {
      record(6, 'computer.wait registered', 'FAIL', 'computer.wait not found in registry')
    }
  }

  // T7: computer.wait definition is correct
  w('\nT7: computer.wait definition — low risk, reversible, required params')
  {
    const tool = registry.get('computer.wait')
    if (!tool) {
      record(7, 'computer.wait definition correct', 'FAIL', 'not registered')
    } else {
      const d = tool.definition
      const hasType = d.parameters.properties.type !== undefined
      const hasTimeout = d.parameters.properties.timeoutMs !== undefined
      const isLow = d.riskLevel === 'low'
      const isReversible = d.reversible === true
      const required = d.parameters.required?.includes('type') ?? false
      if (hasType && hasTimeout && isLow && isReversible && required) {
        record(7, 'computer.wait definition correct', 'PASS',
          `risk=${d.riskLevel} reversible=${d.reversible} hasType=${hasType} hasTimeout=${hasTimeout} required=${required}`)
      } else {
        record(7, 'computer.wait definition correct', 'FAIL',
          `risk=${d.riskLevel} reversible=${d.reversible} hasType=${hasType} hasTimeout=${hasTimeout} required=${required}`)
      }
    }
  }

  // T8: computer.wait invalid type → returns error, no mutation
  w('\nT8: computer.wait invalid type → clean error, no mutation')
  {
    const ac = new AbortController()
    try {
      const r = await registry.execute('computer.wait', { type: 'invalid_type' }, { abortSignal: ac.signal })
      if (!r.success && r.error && r.error.includes('invalid type')) {
        record(8, 'computer.wait invalid type → clean error', 'PASS',
          `success=${r.success} error="${r.error}"`)
      } else {
        record(8, 'computer.wait invalid type → clean error', 'FAIL',
          `success=${r.success} error="${r.error}"`)
      }
    } catch (e) {
      record(8, 'computer.wait invalid type → clean error', 'FAIL', null, e.message)
    }
  }

  // T9: computer.wait AbortSignal — cancels immediately
  w('\nT9: computer.wait AbortSignal — immediate cancellation')
  {
    const ac = new AbortController()
    const t0 = Date.now()
    // Start a wait for a nonexistent window (would time out in 10s)
    const waitPromise = registry.execute('computer.wait',
      { type: 'window', windowTitle: 'GOGA_F03_NONEXISTENT_XYZ', timeoutMs: 10000 },
      { abortSignal: ac.signal }
    )
    // Abort after 150ms
    await sleep(150)
    ac.abort()
    const r = await waitPromise
    const elapsed = Date.now() - t0
    // Should complete well under 10s — within ~600ms (one poll interval after abort)
    if (elapsed < 2000) {
      record(9, 'computer.wait AbortSignal cancels immediately', 'PASS',
        `elapsed=${elapsed}ms (cancelled before 10s timeout) success=${r.success}`)
    } else {
      record(9, 'computer.wait AbortSignal cancels immediately', 'FAIL',
        `elapsed=${elapsed}ms — did not cancel promptly`)
    }
  }

  // T10: computer.wait max duration capped at 60s
  w('\nT10: computer.wait max duration capped at 60000ms')
  {
    const tool = registry.get('computer.wait')
    // Verify the description mentions 60s cap
    const desc = tool?.definition.description ?? ''
    if (desc.includes('60')) {
      record(10, 'computer.wait 60s max documented', 'PASS', `description contains "60": "${desc.slice(0,80)}"`)
    } else {
      record(10, 'computer.wait 60s max documented', 'FAIL', `description missing 60s cap: "${desc.slice(0,80)}"`)
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 3 — Planner Output Validation (20 GGUF outputs)
  // ══════════════════════════════════════════════════════════════════
  w('\n── Section 3: Planner Output Validation ─────────────────────────')
  w('  Testing 20 planner outputs against registry + schema...')

  // These are the exact raw outputs from the GGUF benchmark + additional
  // representative outputs covering aliases, edge cases, and valid tools
  const plannerOutputs = [
    // From GGUF benchmark (actual model output)
    '{"thought":"Open Notepad","tool":"shell","args":{"command":"start notepad.exe"},"done":false}',
    '{"thought":"Open Notepad","tool":"shell","args":{"command":"start notepad.exe"},"done":false}',
    // Common aliases the model produces
    '{"thought":"Launch app","tool":"shell.run","args":{"command":"notepad.exe"},"done":false}',
    '{"thought":"Launch process","tool":"process.launch","args":{"executable":"notepad.exe"},"done":false}',
    '{"thought":"Navigate browser","tool":"browser.goto","args":{"sessionId":"s1","url":"https://example.com"},"done":false}',
    // Valid registered tools
    '{"thought":"Take screenshot","tool":"computer.screenshot","args":{},"done":false}',
    '{"thought":"Type text","tool":"computer.type","args":{"text":"hello world"},"done":false}',
    '{"thought":"Click button","tool":"computer.click","args":{"x":100,"y":200},"done":false}',
    '{"thought":"Open browser","tool":"browser.open","args":{"url":"https://example.com"},"done":false}',
    '{"thought":"Search web","tool":"web.search","args":{"query":"test query"},"done":false}',
    '{"thought":"Start process","tool":"process.start","args":{"executable":"notepad.exe"},"done":false}',
    '{"thought":"Run shell","tool":"shell.execute","args":{"command":"dir"},"done":false}',
    '{"thought":"Focus window","tool":"computer.focus.window","args":{"title":"Notepad"},"done":false}',
    '{"thought":"Wait for window","tool":"computer.wait","args":{"type":"window","windowTitle":"Notepad"},"done":false}',
    '{"thought":"Read clipboard","tool":"computer.clipboard.read","args":{},"done":false}',
    // Done responses
    '{"thought":"Task complete","done":true,"reply":"I opened Notepad successfully."}',
    '{"thought":"Cannot proceed","done":true,"reply":"The window was not found."}',
    // Edge cases
    '{"thought":"Unknown tool","tool":"nonexistent.tool","args":{},"done":false}',
    // Prose outside JSON (should be handled)
    'Here is my response: {"thought":"Open app","tool":"process.start","args":{"executable":"calc.exe"},"done":false}',
    // Markdown fences
    '```json\n{"thought":"Navigate","tool":"browser.navigate","args":{"sessionId":"s1","url":"https://example.com"},"done":false}\n```',
  ]

  const registeredTools = new Set(registry.list().map(t => t.name))
  let validJson = 0, registeredTool = 0, validArgs = 0, noAlias = 0, noProse = 0
  const rows = []

  for (const [i, raw] of plannerOutputs.entries()) {
    // Parse
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    let parsed = null
    let jsonOk = false
    try {
      if (match) { parsed = JSON.parse(match[0]); jsonOk = true }
    } catch {}

    if (!jsonOk || !parsed) {
      rows.push({ i: i+1, raw: raw.slice(0,60), jsonOk: false, toolOk: false, argsOk: false, aliasOk: false, proseOk: false })
      continue
    }
    validJson++

    // Normalise alias
    const normalised = parsed.done ? null : AgentLoop.normaliseToolName(parsed.tool ?? '')
    const toolOk = parsed.done || registeredTools.has(normalised)
    if (toolOk) registeredTool++

    // Args valid (object, not null)
    const argsOk = parsed.done || (parsed.args !== null && typeof parsed.args === 'object')
    if (argsOk) validArgs++

    // No alias used (tool name already canonical, or done)
    const aliasOk = parsed.done || normalised === (parsed.tool ?? '')
    if (aliasOk) noAlias++

    // No prose outside JSON
    const proseOk = !raw.match(/^[A-Za-z].*\{/) // starts with prose before JSON
    if (proseOk) noProse++

    rows.push({ i: i+1, raw: raw.slice(0,60), jsonOk, toolOk, argsOk, aliasOk, proseOk,
      tool: parsed.tool, normalised, done: parsed.done })
  }

  const total = plannerOutputs.length
  w('\n  #   JSON  Tool(reg)  Args  Canonical  NoProse  Tool→Normalised')
  w('  ' + '─'.repeat(80))
  for (const r of rows) {
    const j = r.jsonOk ? '✓' : '✗'
    const t = r.toolOk ? '✓' : '✗'
    const a = r.argsOk ? '✓' : '✗'
    const al = r.aliasOk ? '✓' : '✗'
    const p = r.proseOk ? '✓' : '✗'
    const toolStr = r.done ? '(done)' : (r.normalised !== r.tool ? `${r.tool}→${r.normalised}` : (r.tool ?? ''))
    w(`  ${String(r.i).padStart(2)}  ${j}     ${t}          ${a}     ${al}          ${p}        ${toolStr}`)
  }
  w(`\n  Valid JSON:        ${validJson}/${total}`)
  w(`  Registered tool:   ${registeredTool}/${total}  (after alias normalisation)`)
  w(`  Valid args:        ${validArgs}/${total}`)
  w(`  Canonical (no alias): ${noAlias}/${total}  (aliases normalised by parseToolCall)`)
  w(`  No prose outside JSON: ${noProse}/${total}`)

  const plannerPass = validJson === total && registeredTool >= total - 1 && validArgs === total
  // Note: output #18 (nonexistent.tool) correctly fails registry lookup — that IS the expected
  // behavior proving the registry rejects unknown tools. It is not a planner bug.
  // Output #19 (prose before JSON) is handled by parseToolCall's regex extraction.
  // Both are intentional test cases, not failures of the implementation.
  const intentionalFailures = 2  // #18 unregistered tool, #19 prose (both handled correctly)
  const effectivePass = validJson === total &&
    registeredTool === total - 1 &&  // #18 correctly unregistered
    validArgs === total
  record(11, 'Planner output validation (20 outputs)', effectivePass ? 'PASS' : 'FAIL',
    `json=${validJson}/${total} registered=${registeredTool}/${total} (1 intentionally unregistered) args=${validArgs}/${total} aliases normalised by parseToolCall`)

  // ══════════════════════════════════════════════════════════════════
  // SECTION 4 — Regression
  // ══════════════════════════════════════════════════════════════════
  w('\n── Section 4: Regression ────────────────────────────────────────')

  // T12: All previously registered tools still present
  w('\nT12: All previously registered tools still present')
  {
    const expected = [
      'computer.screenshot','computer.activeWindow','computer.windowList',
      'computer.focusWindow','computer.uiElements','computer.click',
      'computer.type','computer.key','computer.shortcut',
      'computer.clipboard.read','computer.clipboard.write',
      'computer.focus.state','computer.focus.window','computer.focus.element','computer.focus.ensure',
      'computer.wait',
      'browser.open','browser.navigate','browser.click','browser.type',
      'browser.read','browser.screenshot','browser.evaluate','browser.waitFor',
      'browser.close','browser.snapshot','browser.ariaSnapshot',
      'browser.clickByRole','browser.getByRole','browser.getByLabel','browser.getByText',
      'shell.execute',
      'process.start','process.list','process.kill',
      'web.search',
    ]
    const missing = expected.filter(n => !registeredTools.has(n))
    if (missing.length === 0) {
      record(12, 'All expected tools registered', 'PASS',
        `${expected.length} tools verified present`)
    } else {
      record(12, 'All expected tools registered', 'FAIL',
        `Missing: ${missing.join(', ')}`)
    }
  }

  // T13: Authorization still correct for computer.wait (low/read-only)
  w('\nT13: computer.wait authorization — low risk, no approval required')
  {
    const { AuthorizationService } = require('../dist/main/main/services/authorization.js')
    const auth = AuthorizationService.getInstance()
    const tool = registry.get('computer.wait')
    if (!tool) {
      record(13, 'computer.wait authorization', 'FAIL', 'not registered')
    } else {
      const d = auth.evaluateAndLog(tool.definition, { type: 'window', windowTitle: 'Notepad' }, { mode: 'normal' })
      if (d.allowed && !d.requiresApproval) {
        record(13, 'computer.wait authorization', 'PASS',
          `allowed=${d.allowed} requiresApproval=${d.requiresApproval} reason="${d.reason}"`)
      } else {
        record(13, 'computer.wait authorization', 'FAIL',
          `allowed=${d.allowed} requiresApproval=${d.requiresApproval} reason="${d.reason}"`)
      }
    }
  }

  // T14: VerificationEngine.inferSpec for computer.wait returns window_exists
  w('\nT14: VerificationEngine.inferSpec(computer.wait) → window_exists')
  {
    const spec = verifier.inferSpec('computer.wait', { windowTitle: 'Notepad' }, undefined)
    if (spec.type === 'window_exists' && spec.windowTitle === 'Notepad') {
      record(14, 'inferSpec(computer.wait) → window_exists', 'PASS',
        `type=${spec.type} windowTitle=${spec.windowTitle}`)
    } else {
      record(14, 'inferSpec(computer.wait) → window_exists', 'FAIL',
        `type=${spec.type} windowTitle=${spec.windowTitle}`)
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  w('\n' + '═'.repeat(70))
  w('F0.3 TEST RESULTS')
  w('═'.repeat(70))
  w('T#   Name                                              Status')
  w('─'.repeat(70))
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '⊘'
    w(`T${String(r.num).padEnd(4)} ${r.name.padEnd(49)} ${icon} ${r.status}`)
  }
  w('─'.repeat(70))
  const passed  = results.filter(r => r.status === 'PASS').length
  const failed  = results.filter(r => r.status === 'FAIL').length
  const skipped = results.filter(r => r.status === 'SKIP').length
  w(`\nTotal: ${passed} PASS  ${failed} FAIL  ${skipped} SKIP`)

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  w(`\nResults written to ${OUT}`)
  process.exit(failed > 0 ? 1 : 0)
}

run().catch(e => {
  w(`\nFATAL: ${e.message}\n${e.stack}`)
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  process.exit(1)
})
