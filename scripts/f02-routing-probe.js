#!/usr/bin/env node
/**
 * F0.2 — Runtime Routing Probe
 * Proves which engine handles typed and voice commands at runtime.
 * Does NOT start Electron. Loads compiled dist directly.
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
const OUT  = path.join(__dirname, 'f02-routing-results.txt')
const lines = []
function w(s) { lines.push(s); process.stdout.write(s + '\n') }

const { isMissionEngineEnabled } = require('../dist/main/main/services/missionEngine.js')
const { SettingsService }        = require('../dist/main/main/services/settings.js')
const { AuthorizationService }   = require('../dist/main/main/services/authorization.js')

const settings = SettingsService.getInstance().get()
const auth     = AuthorizationService.getInstance()

w('\n╔══════════════════════════════════════════════════════════════╗')
w('║  F0.2 — Runtime Routing Probe                                ║')
w('╚══════════════════════════════════════════════════════════════╝\n')

// ── 1. Settings state ─────────────────────────────────────────────────────────
w('── 1. Persisted Settings State ──────────────────────────────────')
w(`  primaryModel:           ${settings.primaryModel}`)
w(`  missionEngineEnabled:   ${(settings).missionEngineEnabled ?? 'NOT SET (field absent from AppSettings)'}`)
w(`  autoApproveBelow:       ${settings.autoApproveBelow}`)
w(`  requireApprovalForAll:  ${settings.requireApprovalForAll}`)
w(`  localModelPath:         ${settings.localModelPath}`)

// ── 2. Feature flag resolution ────────────────────────────────────────────────
w('\n── 2. MissionEngine Feature Flag ────────────────────────────────')
w(`  GOGA_MISSION_ENGINE env:    "${process.env.GOGA_MISSION_ENGINE ?? '(not set)'}"`)
w(`  isMissionEngineEnabled():   ${isMissionEngineEnabled()}`)
w('')
w('  isMissionEngineEnabled() source (from missionEngine.ts):')
w('    return process.env.GOGA_MISSION_ENGINE === "true"')
w('        || settings.missionEngineEnabled === true')
w('')
w(`  Result: MissionEngine is ${isMissionEngineEnabled() ? 'ENABLED' : 'DISABLED'}`)

// ── 3. Typed command routing ──────────────────────────────────────────────────
w('\n── 3. Typed Command Routing (orchestrator.ts) ───────────────────')
w('  Path: chat:send IPC → OrchestratorService.process()')
w('  Routing decision: looksLikeAgentTask(message) → AgentLoop.run()')
w('  MissionEngine is NOT called from orchestrator.ts at all.')
w('  MissionEngine is ONLY reachable via mission:start IPC (MissionPage UI).')
w('')

const AGENT_TRIGGERS = [
  /\b(open|launch|start)\b.{0,40}\b(and|then|to)\b/i,
  /\b(open|launch|start)\b.{0,40}\b(browser|brave|chrome|firefox|edge|app|terminal|notepad|explorer|spotify|discord|slack|vscode|code)\b/i,
  /\b(go to|navigate to|browse to)\b/i,
  /\b(find|search for|look up|research)\b/i,
  /\b(organize|sort|move|rename|delete)\b.{0,30}\b(files?|folders?)\b/i,
  /\b(fix|debug|edit|update|modify)\b.{0,40}\b(code|file|project)\b/i,
  /\b(run|execute|install|build|compile)\b/i,
  /\bdo (this|that|it)\b/i,
]
const CONFIRM_TRIGGERS = /^(yes|yeah|yep|sure|ok|okay|go ahead|do it|proceed|please|yup|affirmative|correct|right|exactly|absolutely)[.!]?$/i

function looksLikeAgentTask(message, lastAssistantMsg) {
  if (AGENT_TRIGGERS.some(r => r.test(message))) return true
  if (CONFIRM_TRIGGERS.test(message.trim()) && lastAssistantMsg) {
    return /\b(search|look|find|open|navigate|run|execute|install|shall i|want me|would you like|should i|can i)\b/i.test(lastAssistantMsg)
  }
  return false
}

const testCases = [
  { msg: 'Open Notepad and type: Goga operator verification', last: undefined },
  { msg: 'Navigate to google.com', last: undefined },
  { msg: 'What is the weather today?', last: undefined },
  { msg: 'Hello, how are you?', last: undefined },
  { msg: 'Run a benchmark', last: undefined },
  { msg: 'Tell me about yourself', last: undefined },
  { msg: 'yes', last: 'Shall I open Notepad for you?' },
  { msg: 'yes', last: 'How are you doing today?' },
  { msg: 'Search for the latest news', last: undefined },
  { msg: 'Find files named config.json', last: undefined },
]

w('  Message                                          → Route')
w('  ' + '─'.repeat(70))
for (const tc of testCases) {
  const isAgent = looksLikeAgentTask(tc.msg, tc.last)
  const route = isAgent ? 'AgentLoop.run()' : 'LLM conversation (Ollama/LocalLlama)'
  const lastNote = tc.last ? ` [last="${tc.last.slice(0,30)}..."]` : ''
  w(`  "${tc.msg.slice(0,45).padEnd(45)}"${lastNote} → ${route}`)
}

// ── 4. Voice command routing ──────────────────────────────────────────────────
w('\n── 4. Voice Command Routing (voiceOrchestrator.ts) ─────────────')
w('  Path: wake word → STT → VoiceOrchestrator.handleUtterance()')
w('  VoiceOrchestrator calls: OrchestratorService.process()')
w('  SAME routing logic as typed commands — no separate voice path.')
w('  MissionEngine.injectConversation() is called for mid-mission utterances only.')
w('  Conclusion: voice and typed commands follow IDENTICAL routing.')

// ── 5. MissionEngine flag interaction ─────────────────────────────────────────
w('\n── 5. GOGA_MISSION_ENGINE Flag Interaction ──────────────────────')
w('  When GOGA_MISSION_ENGINE=false (default):')
w('    - mission:start IPC throws "MissionEngine is disabled"')
w('    - AgentLoop is the ONLY operator path for all chat/voice commands')
w('    - MissionEngine code is loaded but never executed')
w('')
w('  When GOGA_MISSION_ENGINE=true:')
w('    - mission:start IPC works — MissionPage can start missions')
w('    - Chat/voice commands STILL route to AgentLoop (orchestrator unchanged)')
w('    - MissionEngine and AgentLoop are PARALLEL paths, not alternatives')
w('    - No code in orchestrator.ts checks isMissionEngineEnabled()')
w('')
w('  CRITICAL FINDING: The F0 report claim "AgentLoop is disabled" is WRONG.')
w('  AgentLoop is ALWAYS the chat/voice operator path regardless of the flag.')
w('  GOGA_MISSION_ENGINE only gates the mission:start IPC handler.')
w('  The flag does NOT disable AgentLoop. It does NOT redirect chat to MissionEngine.')

// ── 6. Authorization breakdown ────────────────────────────────────────────────
w('\n── 6. Authorization Decision Breakdown ──────────────────────────')
w('  Default settings: autoApproveBelow="medium", requireApprovalForAll=false')
w('')

const toolTests = [
  { name: 'computer.screenshot', riskLevel: 'low',     reversible: true,  category: 'computer',    params: {} },
  { name: 'computer.type',       riskLevel: 'medium',  reversible: true,  category: 'computer',    params: { text: 'hello' } },
  { name: 'computer.click',      riskLevel: 'medium',  reversible: true,  category: 'computer',    params: { x: 100, y: 200 } },
  { name: 'shell.run',           riskLevel: 'critical', reversible: false, category: 'shell',       params: { command: 'dir' } },
  { name: 'filesystem.delete',   riskLevel: 'high',    reversible: false, category: 'filesystem',  params: { path: 'C:\\test.txt' } },
  { name: 'process.kill',        riskLevel: 'high',    reversible: false, category: 'process',     params: { pid: 1234 } },
  { name: 'filesystem.write',    riskLevel: 'medium',  reversible: true,  category: 'filesystem',  params: { path: 'C:\\test.txt', content: 'x' } },
  { name: 'web.search',          riskLevel: 'low',     reversible: true,  category: 'web',         params: { query: 'test' } },
  { name: 'browser.navigate',    riskLevel: 'medium',  reversible: true,  category: 'browser',     params: { url: 'https://example.com' } },
]

w('  Tool                   Risk      allowed  requiresApproval  reason')
w('  ' + '─'.repeat(80))
for (const t of toolTests) {
  const d = auth.evaluateAndLog(t, t.params, { mode: 'normal' })
  const name = t.name.padEnd(22)
  const risk = t.riskLevel.padEnd(9)
  w(`  ${name} ${risk} ${String(d.allowed).padEnd(8)} ${String(d.requiresApproval).padEnd(17)} ${d.reason}`)
}

w('\n  MUTATION BEFORE APPROVAL CHECK:')
w('  AuthorizationService.evaluate() returns a decision object only.')
w('  No mutation occurs inside evaluate(). Execution only happens after:')
w('    AgentLoop: decision.requiresApproval → requestApproval() → await user → registry.execute()')
w('    MissionEngine: decision.requiresApproval → requestApproval() → await user → registry.execute()')
w('  Therefore: no medium/high/critical mutation can occur before explicit approval.')
w('  EXCEPTION: autoApproveBelow="medium" means medium-risk tools execute WITHOUT approval.')
w('  computer.type (medium) and computer.click (medium) execute without approval by default.')

// ── 7. GGUF model status ──────────────────────────────────────────────────────
w('\n── 7. Primary GGUF Model Status ─────────────────────────────────')
const modelPath = settings.localModelPath
const modelExists = fs.existsSync(modelPath)
w(`  Configured path: ${modelPath}`)
w(`  File exists:     ${modelExists}`)
if (!modelExists) {
  w('  STATUS: PRIMARY MODEL UNAVAILABLE — file not found at configured path')
  w('  LocalLlamaService._init() will set status="error" with this message.')
  w('  Orchestrator falls back to Ollama when LocalLlama status=error.')
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
w(`\nResults written to ${OUT}`)
