#!/usr/bin/env node
/**
 * F0.2 — Primary GGUF Model Benchmark (node-llama-cpp, CUDA)
 * Benchmarks the ACTUAL primary model: Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf
 * This is what LocalLlamaService loads at runtime — NOT Ollama.
 *
 * Run: node scripts/f02-gguf-benchmark.js
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
const { execSync } = require('child_process')

const OUT = path.join(__dirname, 'f02-gguf-results.txt')
const lines = []
function w(s) { lines.push(s); process.stdout.write(s + '\n') }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function nvidiaSmi() {
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader',
      { timeout: 5000 }
    ).toString().trim()
    const p = out.split(',').map(s => s.trim())
    return { name: p[0], totalMiB: parseInt(p[1]), usedMiB: parseInt(p[2]), freeMiB: parseInt(p[3]) }
  } catch { return null }
}

const MODEL_PATH = 'E:\\Goga-Models\\hf_bartowski_Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf'
const GPU_LAYERS = 35
const CTX_SIZE   = 4096

const esmImport = new Function('pkg', 'return import(pkg)')

async function run() {
  w('\n╔══════════════════════════════════════════════════════════════╗')
  w('║  F0.2 — Primary GGUF Model Benchmark (node-llama-cpp)        ║')
  w('╚══════════════════════════════════════════════════════════════╝\n')

  w(`  Model:      ${path.basename(MODEL_PATH)}`)
  w(`  Path:       ${MODEL_PATH}`)
  w(`  GPU layers: ${GPU_LAYERS}`)
  w(`  Ctx size:   ${CTX_SIZE}`)
  w(`  File size:  ${(fs.statSync(MODEL_PATH).size / 1e9).toFixed(2)} GB`)

  // ── Baseline VRAM ─────────────────────────────────────────────────────────
  const gpuBefore = nvidiaSmi()
  w('\n── VRAM Baseline ────────────────────────────────────────────────')
  if (gpuBefore) {
    w(`  GPU:        ${gpuBefore.name}`)
    w(`  Total:      ${gpuBefore.totalMiB} MiB`)
    w(`  Used:       ${gpuBefore.usedMiB} MiB`)
    w(`  Free:       ${gpuBefore.freeMiB} MiB`)
  }

  // ── Load model ────────────────────────────────────────────────────────────
  w('\n── Model Load ───────────────────────────────────────────────────')
  let llama, model
  const loadStart = Date.now()
  try {
    const { getLlama } = await esmImport('node-llama-cpp')
    w('  getLlama() — requesting CUDA backend...')
    llama = await getLlama({ gpu: 'cuda' })
    w(`  Backend: ${llama.gpu ?? 'cpu'}`)

    w('  Loading model weights...')
    model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: GPU_LAYERS })
    const loadMs = Date.now() - loadStart
    w(`  Load time: ${loadMs} ms  (${(loadMs/1000).toFixed(1)}s)`)

    const gpuAfterLoad = nvidiaSmi()
    if (gpuAfterLoad && gpuBefore) {
      const delta = gpuAfterLoad.usedMiB - gpuBefore.usedMiB
      w(`  VRAM after load: ${gpuAfterLoad.usedMiB} MiB  (delta: +${delta} MiB)`)
      w(`  VRAM for model:  ~${delta} MiB  (${(delta/gpuBefore.totalMiB*100).toFixed(1)}% of total)`)
    }
  } catch (err) {
    w(`  LOAD FAILED: ${err.message}`)
    w('  PRIMARY MODEL STATUS: UNAVAILABLE')
    w(`  Error class: ${err.constructor?.name ?? 'unknown'}`)
    fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
    w(`\nResults written to ${OUT}`)
    return
  }

  // ── Helper: single inference ──────────────────────────────────────────────
  async function infer(systemPrompt, userPrompt, label) {
    const ctx = await model.createContext({ contextSize: CTX_SIZE })
    try {
      const { LlamaChatSession } = await esmImport('node-llama-cpp')
      const session = new LlamaChatSession({ contextSequence: ctx.getSequence() })

      const tokens = []
      let firstTokenMs = -1
      const t0 = Date.now()

      const finalPrompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt
      let result = ''
      await session.prompt(finalPrompt, {
        onTextChunk: (chunk) => {
          result += chunk
          tokens.push(chunk)
          if (firstTokenMs < 0) firstTokenMs = Date.now() - t0
        }
      })

      const totalMs = Date.now() - t0
      const tokenCount = result.split(/\s+/).length  // word-level approximation
      const genTps = tokenCount / (totalMs / 1000)

      return {
        label,
        ttftMs: firstTokenMs,
        totalMs,
        approxTokens: tokenCount,
        genTps: Math.round(genTps * 10) / 10,
        response: result.trim().slice(0, 120),
        error: null
      }
    } catch (err) {
      return { label, error: err.message, ttftMs: -1, totalMs: Date.now() - Date.now(), approxTokens: 0, genTps: 0, response: '' }
    } finally {
      await ctx.dispose().catch(() => {})
    }
  }

  // ── Benchmark 1: Cold first call (conversation) ───────────────────────────
  w('\n── Benchmark 1: Cold First Call (conversation) ──────────────────')
  const r1 = await infer(
    'You are Goga, a helpful AI assistant.',
    'Hello. What is 2 + 2? Answer in one sentence.',
    'cold-conversation'
  )
  if (r1.error) {
    w(`  ERROR: ${r1.error}`)
  } else {
    w(`  TTFT:     ${r1.ttftMs} ms`)
    w(`  Total:    ${r1.totalMs} ms`)
    w(`  ~Tokens:  ${r1.approxTokens}`)
    w(`  ~Gen t/s: ${r1.genTps}`)
    w(`  Response: "${r1.response}"`)
  }

  // ── Benchmark 2: Warm second call (conversation) ──────────────────────────
  w('\n── Benchmark 2: Warm Second Call (conversation) ─────────────────')
  const r2 = await infer(
    'You are Goga, a helpful AI assistant.',
    'Summarize in one sentence: The quick brown fox jumps over the lazy dog.',
    'warm-conversation'
  )
  if (r2.error) {
    w(`  ERROR: ${r2.error}`)
  } else {
    w(`  TTFT:     ${r2.ttftMs} ms`)
    w(`  Total:    ${r2.totalMs} ms`)
    w(`  ~Tokens:  ${r2.approxTokens}`)
    w(`  ~Gen t/s: ${r2.genTps}`)
    w(`  Response: "${r2.response}"`)
  }

  // ── Benchmark 3: Computer-actions JSON schema ─────────────────────────────
  w('\n── Benchmark 3: Computer-Actions JSON Schema ────────────────────')
  const ACTION_SYSTEM = `You are Goga, an autonomous desktop operator on Windows.
Respond ONLY with a JSON object. No markdown, no explanation outside JSON.
Format: {"thought":"...","tool":"tool.name","args":{...},"done":false}`

  const jsonResults = []
  for (let i = 0; i < 5; i++) {
    const r = await infer(
      ACTION_SYSTEM,
      'Task: open Notepad. What is the single next action?',
      `json-schema-${i+1}`
    )
    jsonResults.push(r)
    const valid = (() => {
      try {
        const m = r.response.match(/\{[\s\S]*\}/)
        if (!m) return false
        const o = JSON.parse(m[0])
        return typeof o.thought === 'string' && typeof o.tool === 'string'
      } catch { return false }
    })()
    w(`  Run ${i+1}: ttft=${r.ttftMs}ms total=${r.totalMs}ms ~${r.genTps}t/s valid=${valid} response="${r.response.slice(0,80)}"`)
  }
  const validCount = jsonResults.filter(r => {
    try {
      const m = r.response.match(/\{[\s\S]*\}/)
      if (!m) return false
      const o = JSON.parse(m[0])
      return typeof o.thought === 'string' && typeof o.tool === 'string'
    } catch { return false }
  }).length
  w(`  JSON validity: ${validCount}/5`)

  // ── Benchmark 4: Multi-turn context ──────────────────────────────────────
  w('\n── Benchmark 4: Multi-Turn Context (4K window) ──────────────────')
  const ctx4 = await model.createContext({ contextSize: CTX_SIZE })
  try {
    const { LlamaChatSession } = await esmImport('node-llama-cpp')
    const session = new LlamaChatSession({ contextSequence: ctx4.getSequence() })
    const turns = [
      'My name is TestUser. Remember that.',
      'What is the capital of France?',
      'What did I tell you my name was?'
    ]
    for (const [i, turn] of turns.entries()) {
      const t0 = Date.now()
      let resp = ''
      await session.prompt(turn, { onTextChunk: c => { resp += c } })
      const ms = Date.now() - t0
      w(`  Turn ${i+1}: "${turn.slice(0,40)}" → "${resp.trim().slice(0,60)}" (${ms}ms)`)
    }
  } catch (err) {
    w(`  ERROR: ${err.message}`)
  } finally {
    await ctx4.dispose().catch(() => {})
  }

  // ── VRAM after all benchmarks ─────────────────────────────────────────────
  w('\n── VRAM After GGUF Benchmarks ───────────────────────────────────')
  const gpuAfter = nvidiaSmi()
  if (gpuAfter && gpuBefore) {
    const delta = gpuAfter.usedMiB - gpuBefore.usedMiB
    w(`  VRAM used:   ${gpuAfter.usedMiB} MiB`)
    w(`  VRAM delta:  +${delta} MiB`)
    w(`  VRAM free:   ${gpuAfter.freeMiB} MiB`)
    w(`  % of total:  ${(gpuAfter.usedMiB / gpuAfter.totalMiB * 100).toFixed(1)}%`)
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  w('\n' + '═'.repeat(70))
  w('GGUF PRIMARY MODEL SUMMARY')
  w('═'.repeat(70))
  w(`  Model:              ${path.basename(MODEL_PATH)}`)
  w(`  Backend:            ${llama.gpu ?? 'cpu'} (CUDA requested, gpuLayers=${GPU_LAYERS})`)
  w(`  Load time:          ${Date.now() - loadStart} ms (approx — includes benchmark time)`)
  w(`  Cold TTFT:          ${r1.ttftMs} ms`)
  w(`  Warm TTFT:          ${r2.ttftMs} ms`)
  w(`  Warm gen speed:     ~${r2.genTps} t/s (word-level approx)`)
  w(`  JSON schema valid:  ${validCount}/5`)
  w(`  Status:             AVAILABLE`)

  // Cleanup
  try { await llama.dispose() } catch {}

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  w(`\nResults written to ${OUT}`)
}

run().catch(err => {
  w(`\nFATAL: ${err.message}\n${err.stack}`)
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  process.exit(1)
})
