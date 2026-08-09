#!/usr/bin/env node
/**
 * F0.1 — Local Model Performance Benchmark
 * Run: node scripts/benchmark-f01.js
 *
 * Benchmarks:
 *   - Llama 3 (llama3:latest via Ollama) at 1/2/4 concurrent, 4K/8K context
 *   - LLaVA 13B (llava:13b via Ollama) screenshot analysis
 *   - Combined VRAM headroom check
 *
 * Does NOT download, replace, or upgrade any model.
 * Uses Ollama HTTP API directly — no node-llama-cpp for benchmarks
 * (node-llama-cpp requires Electron context; Ollama is always available).
 */

const http  = require('http')
const fs    = require('fs')
const path  = require('path')
const os    = require('os')

const OUT = path.join(__dirname, 'benchmark-f01-results.txt')
const OLLAMA_HOST = 'localhost'
const OLLAMA_PORT = 11434

const lines = []
function w(s) { lines.push(s); process.stdout.write(s + '\n') }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: OLLAMA_HOST, port: OLLAMA_PORT, path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 120_000
    }, res => {
      let raw = ''
      res.on('data', c => { raw += c.toString() })
      res.on('end', () => resolve(raw))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')) })
    req.write(data)
    req.end()
  })
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: OLLAMA_HOST, port: OLLAMA_PORT, path, timeout: 5000 }, res => {
      let raw = ''
      res.on('data', c => { raw += c.toString() })
      res.on('end', () => resolve(raw))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

// ── GPU info via nvidia-smi ───────────────────────────────────────────────────

function nvidiaSmi() {
  return new Promise(resolve => {
    const { exec } = require('child_process')
    exec(
      'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,driver_version,compute_cap --format=csv,noheader',
      { timeout: 5000 },
      (err, stdout) => {
        if (err) { resolve(null); return }
        const parts = stdout.trim().split(',').map(s => s.trim())
        resolve({
          name:        parts[0],
          totalMiB:    parseInt(parts[1]),
          usedMiB:     parseInt(parts[2]),
          freeMiB:     parseInt(parts[3]),
          driver:      parts[4],
          computeCap:  parts[5]
        })
      }
    )
  })
}

// ── Ollama generate (non-streaming, returns full stats) ───────────────────────

async function ollamaGenerate(model, prompt, options = {}) {
  const t0 = Date.now()
  const raw = await post('/api/generate', {
    model,
    prompt,
    stream: false,
    options: {
      num_ctx: options.numCtx ?? 4096,
      temperature: options.temperature ?? 0.1,
      num_predict: options.numPredict ?? 200,
      ...options.extra
    }
  })
  const elapsed = Date.now() - t0
  try {
    const json = JSON.parse(raw)
    return {
      response: json.response ?? '',
      promptEvalCount: json.prompt_eval_count ?? 0,
      evalCount: json.eval_count ?? 0,
      promptEvalDurationNs: json.prompt_eval_duration ?? 0,
      evalDurationNs: json.eval_duration ?? 0,
      totalDurationNs: json.total_duration ?? 0,
      loadDurationNs: json.load_duration ?? 0,
      elapsedMs: elapsed,
      done: json.done ?? false,
      error: null
    }
  } catch (e) {
    return { response: '', error: `Parse error: ${e.message} raw="${raw.slice(0, 100)}"`, elapsedMs: elapsed }
  }
}

// ── JSON schema validity check ────────────────────────────────────────────────

const ACTION_SCHEMA_PROMPT = `You are a computer operator. Respond ONLY with a JSON object.
Task: open notepad
Required format: {"thought":"...","tool":"process.launch","args":{"executable":"notepad.exe"},"done":false}
Respond with ONLY the JSON object, no other text.`

function isValidActionSchema(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return false
    const obj = JSON.parse(match[0])
    return typeof obj.thought === 'string' && typeof obj.tool === 'string'
  } catch { return false }
}

// ── Concurrent benchmark ──────────────────────────────────────────────────────

async function benchConcurrent(model, concurrency, numCtx, temperature) {
  const prompt = `Summarize in one sentence: The quick brown fox jumps over the lazy dog.`
  const t0 = Date.now()
  const promises = Array.from({ length: concurrency }, () =>
    ollamaGenerate(model, prompt, { numCtx, temperature, numPredict: 80 })
  )
  const results = await Promise.all(promises)
  const totalMs = Date.now() - t0

  const errors = results.filter(r => r.error).length
  const avgPromptTps = results.reduce((s, r) => {
    if (!r.promptEvalDurationNs || !r.promptEvalCount) return s
    return s + (r.promptEvalCount / (r.promptEvalDurationNs / 1e9))
  }, 0) / Math.max(1, results.filter(r => !r.error).length)

  const avgGenTps = results.reduce((s, r) => {
    if (!r.evalDurationNs || !r.evalCount) return s
    return s + (r.evalCount / (r.evalDurationNs / 1e9))
  }, 0) / Math.max(1, results.filter(r => !r.error).length)

  const avgTtft = results.reduce((s, r) => {
    if (!r.promptEvalDurationNs) return s
    return s + r.promptEvalDurationNs / 1e6
  }, 0) / Math.max(1, results.filter(r => !r.error).length)

  return {
    concurrency, numCtx, temperature,
    totalMs, errors,
    avgTtftMs: Math.round(avgTtft),
    avgPromptTps: Math.round(avgPromptTps * 10) / 10,
    avgGenTps: Math.round(avgGenTps * 10) / 10,
    firstResponse: results[0]?.response?.slice(0, 80) ?? ''
  }
}

// ── LLaVA benchmark ───────────────────────────────────────────────────────────

async function benchLlava() {
  // Create a minimal 1x1 white PNG as base64 (valid image, minimal VRAM for decode)
  // Real benchmark uses a screenshot — we use a synthetic image to avoid desktop dependency
  const PNG_1x1_WHITE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=='

  const t0 = Date.now()
  try {
    const raw = await post('/api/generate', {
      model: 'llava:13b',
      prompt: 'Describe what you see in this image in one sentence.',
      images: [PNG_1x1_WHITE],
      stream: false,
      options: { num_ctx: 2048, temperature: 0.1, num_predict: 60 }
    })
    const elapsed = Date.now() - t0
    const json = JSON.parse(raw)
    return {
      loadDurationMs: Math.round((json.load_duration ?? 0) / 1e6),
      analysisLatencyMs: elapsed,
      evalCount: json.eval_count ?? 0,
      genTps: json.eval_count && json.eval_duration
        ? Math.round(json.eval_count / (json.eval_duration / 1e9) * 10) / 10
        : 0,
      response: json.response?.slice(0, 100) ?? '',
      error: null
    }
  } catch (e) {
    return { error: e.message, analysisLatencyMs: Date.now() - t0 }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  w('\n╔══════════════════════════════════════════════════════════════╗')
  w('║  F0.1 — Local Model Performance Benchmark                    ║')
  w('╚══════════════════════════════════════════════════════════════╝\n')

  // ── GPU detection ─────────────────────────────────────────────────────────
  w('── GPU Detection ────────────────────────────────────────────────')
  const gpu = await nvidiaSmi()
  if (gpu) {
    w(`  GPU:          ${gpu.name}`)
    w(`  VRAM Total:   ${gpu.totalMiB} MiB  (${(gpu.totalMiB / 1024).toFixed(1)} GB)`)
    w(`  VRAM Used:    ${gpu.usedMiB} MiB`)
    w(`  VRAM Free:    ${gpu.freeMiB} MiB`)
    w(`  Driver:       ${gpu.driver}`)
    w(`  Compute Cap:  ${gpu.computeCap}`)
  } else {
    w('  nvidia-smi not available or no NVIDIA GPU detected')
  }

  // ── Ollama availability ───────────────────────────────────────────────────
  w('\n── Ollama Models ────────────────────────────────────────────────')
  try {
    const tagsRaw = await get('/api/tags')
    const tags = JSON.parse(tagsRaw)
    for (const m of (tags.models ?? [])) {
      w(`  ${m.name.padEnd(30)} ${(m.size / 1e9).toFixed(2)} GB`)
    }
  } catch (e) {
    w(`  ERROR: Ollama not available: ${e.message}`)
    w('  Cannot run model benchmarks.')
    fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
    return
  }

  // ── Llama 3 benchmarks ────────────────────────────────────────────────────
  w('\n── Llama 3 Benchmarks (llama3:latest) ───────────────────────────')
  w('  Warming up model (first call loads weights)...')

  // Warm-up
  const warmup = await ollamaGenerate('llama3:latest', 'Hello.', { numCtx: 2048, numPredict: 5 })
  w(`  Warm-up: ${warmup.elapsedMs}ms load=${Math.round((warmup.loadDurationNs ?? 0) / 1e6)}ms`)

  const llamaResults = []

  // Conversation profile: temperature 0.7, 4K context
  w('\n  [Conversation profile — temp=0.7]')
  for (const concurrency of [1, 2, 4]) {
    for (const ctx of [4096, 8192]) {
      w(`  Benchmarking concurrency=${concurrency} ctx=${ctx}...`)
      try {
        const r = await benchConcurrent('llama3:latest', concurrency, ctx, 0.7)
        llamaResults.push({ profile: 'conversation', ...r })
        w(`    ttft=${r.avgTtftMs}ms  prompt=${r.avgPromptTps}t/s  gen=${r.avgGenTps}t/s  total=${r.totalMs}ms  errors=${r.errors}`)
      } catch (e) {
        w(`    ERROR: ${e.message}`)
        llamaResults.push({ profile: 'conversation', concurrency, numCtx: ctx, error: e.message })
      }
      await sleep(500)
    }
  }

  // Computer-actions profile: temperature 0.1, JSON schema
  w('\n  [Computer-actions profile — temp=0.1, JSON schema]')
  for (const concurrency of [1, 2, 4]) {
    for (const ctx of [4096, 8192]) {
      w(`  Benchmarking concurrency=${concurrency} ctx=${ctx}...`)
      try {
        const t0 = Date.now()
        const promises = Array.from({ length: concurrency }, () =>
          ollamaGenerate('llama3:latest', ACTION_SCHEMA_PROMPT, {
            numCtx: ctx, temperature: 0.1, numPredict: 120
          })
        )
        const results = await Promise.all(promises)
        const totalMs = Date.now() - t0
        const validJson = results.filter(r => isValidActionSchema(r.response)).length
        const errors = results.filter(r => r.error).length
        const avgGenTps = results.reduce((s, r) => {
          if (!r.evalDurationNs || !r.evalCount) return s
          return s + (r.evalCount / (r.evalDurationNs / 1e9))
        }, 0) / Math.max(1, results.filter(r => !r.error).length)
        const avgTtft = results.reduce((s, r) => {
          if (!r.promptEvalDurationNs) return s
          return s + r.promptEvalDurationNs / 1e6
        }, 0) / Math.max(1, results.filter(r => !r.error).length)

        llamaResults.push({
          profile: 'computer-actions', concurrency, numCtx: ctx, temperature: 0.1,
          totalMs, errors, avgTtftMs: Math.round(avgTtft),
          avgGenTps: Math.round(avgGenTps * 10) / 10,
          jsonValid: validJson, jsonTotal: concurrency
        })
        w(`    ttft=${Math.round(avgTtft)}ms  gen=${Math.round(avgGenTps * 10) / 10}t/s  total=${totalMs}ms  json=${validJson}/${concurrency}  errors=${errors}`)
        if (results[0]?.response) w(`    sample: ${results[0].response.slice(0, 100)}`)
      } catch (e) {
        w(`    ERROR: ${e.message}`)
        llamaResults.push({ profile: 'computer-actions', concurrency, numCtx: ctx, error: e.message })
      }
      await sleep(500)
    }
  }

  // ── VRAM after Llama ──────────────────────────────────────────────────────
  w('\n── VRAM after Llama load ─────────────────────────────────────────')
  const gpuAfterLlama = await nvidiaSmi()
  let llamaVramMiB = 0
  if (gpuAfterLlama && gpu) {
    llamaVramMiB = gpuAfterLlama.usedMiB - gpu.usedMiB
    w(`  VRAM used now:  ${gpuAfterLlama.usedMiB} MiB`)
    w(`  VRAM for Llama: ~${llamaVramMiB} MiB`)
    w(`  VRAM free:      ${gpuAfterLlama.freeMiB} MiB`)
  }

  // ── LLaVA benchmark ───────────────────────────────────────────────────────
  w('\n── LLaVA 13B Benchmark (llava:13b) ──────────────────────────────')
  w('  Loading LLaVA and running screenshot analysis...')
  const llavaResult = await benchLlava()
  if (llavaResult.error) {
    w(`  ERROR: ${llavaResult.error}`)
  } else {
    w(`  Load duration:      ${llavaResult.loadDurationMs}ms`)
    w(`  Analysis latency:   ${llavaResult.analysisLatencyMs}ms`)
    w(`  Generation speed:   ${llavaResult.genTps} t/s`)
    w(`  Response sample:    "${llavaResult.response}"`)
  }

  // ── VRAM after LLaVA ─────────────────────────────────────────────────────
  w('\n── VRAM after LLaVA load ─────────────────────────────────────────')
  const gpuAfterLlava = await nvidiaSmi()
  let llavaVramMiB = 0
  let combinedVramMiB = 0
  if (gpuAfterLlava && gpu) {
    llavaVramMiB = gpuAfterLlava.usedMiB - (gpuAfterLlama?.usedMiB ?? gpu.usedMiB)
    combinedVramMiB = gpuAfterLlava.usedMiB - gpu.usedMiB
    w(`  VRAM used now:      ${gpuAfterLlava.usedMiB} MiB`)
    w(`  VRAM for LLaVA:     ~${llavaVramMiB} MiB`)
    w(`  Combined (both):    ~${combinedVramMiB} MiB`)
    w(`  VRAM free:          ${gpuAfterLlava.freeMiB} MiB`)
    const totalMiB = gpu.totalMiB
    const pct = Math.round(combinedVramMiB / totalMiB * 100)
    w(`  Combined % of total: ${pct}%  (threshold: 90%)`)
    if (pct > 90) {
      w('  ⚠ EXCEEDS 90% — ModelResidencyManager REQUIRED')
    } else {
      w('  ✓ Within 90% — simultaneous load is safe')
    }
  }

  // ── Summary tables ────────────────────────────────────────────────────────
  w('\n' + '═'.repeat(80))
  w('LLAMA 3 BENCHMARK TABLE')
  w('═'.repeat(80))
  w('Profile            Conc  Ctx    TTFT(ms)  Prompt(t/s)  Gen(t/s)  Total(ms)  JSON  Err')
  w('─'.repeat(80))
  for (const r of llamaResults) {
    if (r.error) {
      w(`${r.profile?.padEnd(18)} ${String(r.concurrency).padStart(4)}  ${String(r.numCtx).padStart(5)}  ERROR: ${r.error.slice(0, 40)}`)
      continue
    }
    const prof = (r.profile ?? '').padEnd(18)
    const conc = String(r.concurrency).padStart(4)
    const ctx  = String(r.numCtx).padStart(5)
    const ttft = String(r.avgTtftMs ?? '-').padStart(8)
    const ptps = String(r.avgPromptTps ?? '-').padStart(11)
    const gtps = String(r.avgGenTps ?? '-').padStart(8)
    const tot  = String(r.totalMs ?? '-').padStart(9)
    const json = r.jsonValid !== undefined ? `${r.jsonValid}/${r.jsonTotal}` : '-'
    const err  = String(r.errors ?? 0).padStart(3)
    w(`${prof} ${conc}  ${ctx}  ${ttft}  ${ptps}  ${gtps}  ${tot}  ${json.padStart(4)}  ${err}`)
  }

  w('\n' + '═'.repeat(80))
  w('LLAVA 13B BENCHMARK TABLE')
  w('═'.repeat(80))
  if (llavaResult.error) {
    w(`  ERROR: ${llavaResult.error}`)
  } else {
    w(`  Load duration:    ${llavaResult.loadDurationMs} ms`)
    w(`  Analysis latency: ${llavaResult.analysisLatencyMs} ms`)
    w(`  Generation speed: ${llavaResult.genTps} t/s`)
    w(`  UI element ID:    SKIP (requires real screenshot — synthetic 1x1 PNG used)`)
  }

  // ── Recommendations ───────────────────────────────────────────────────────
  w('\n' + '═'.repeat(80))
  w('RECOMMENDATIONS')
  w('═'.repeat(80))

  if (gpu) {
    const totalMiB = gpu.totalMiB
    const pct = combinedVramMiB > 0 ? Math.round(combinedVramMiB / totalMiB * 100) : 0

    w(`\nGPU: ${gpu.name}  VRAM: ${totalMiB} MiB (${(totalMiB/1024).toFixed(1)} GB)`)
    w(`Combined Llama+LLaVA VRAM: ~${combinedVramMiB} MiB (${pct}% of total)`)

    if (pct > 90) {
      w('\n⚠ ModelResidencyManager REQUIRED:')
      w('  - Keep Llama 3 loaded permanently (primary model)')
      w('  - Load LLaVA only when semantic observation fails (vision fallback)')
      w('  - Unload LLaVA immediately after vision call completes')
      w('  - Do NOT implement during F0 — document requirement for F1')
    } else {
      w('\n✓ ModelResidencyManager NOT required at current load:')
      w('  - Both models fit within 90% VRAM threshold simultaneously')
      w('  - Monitor during F1 when actual screenshot analysis runs continuously')
    }

    w('\nRecommended concurrency settings:')
    // Find best gen tps at concurrency=1 for computer-actions
    const best1 = llamaResults.find(r => r.profile === 'computer-actions' && r.concurrency === 1 && r.numCtx === 4096 && !r.error)
    const best2 = llamaResults.find(r => r.profile === 'computer-actions' && r.concurrency === 2 && r.numCtx === 4096 && !r.error)
    if (best1 && best2) {
      const degradation = best2.avgGenTps > 0 && best1.avgGenTps > 0
        ? Math.round((1 - best2.avgGenTps / best1.avgGenTps) * 100)
        : 0
      w(`  Computer-actions: concurrency=1 (${best1.avgGenTps}t/s) vs 2 (${best2.avgGenTps}t/s) — ${degradation}% degradation`)
      w(`  Recommended: concurrency=1 for computer-actions (determinism > throughput)`)
    }
    w('  Conversation: concurrency=1, context=4096 (sufficient for chat history)')
    w('  Computer-actions: temperature=0.0–0.2, context=4096')
    w('  Conversation: temperature=0.6–0.8, context=4096')
  }

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  w(`\nResults written to ${OUT}`)
}

run().catch(e => {
  w(`\nFATAL: ${e.message}\n${e.stack}`)
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  process.exit(1)
})
