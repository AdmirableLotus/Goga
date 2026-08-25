#!/usr/bin/env node
/**
 * F0.3 — Moondream Benchmark
 *
 * Requirements:
 *   - GGUF primary model must be loaded (node-llama-cpp) before running
 *   - 10 controlled screenshots: open Notepad, Calculator, Brave, dialogs, etc.
 *     before running so each screenshot shows a distinct, known UI state
 *   - moondream:latest must be present in Ollama
 *
 * Measures: cold TTFT, warm avg latency, gen t/s, VRAM delta, accuracy vs ground truth
 *
 * Run: node scripts/f03-moondream-benchmark.js
 */

const http  = require('http')
const fs    = require('fs')
const path  = require('path')
const { execSync } = require('child_process')

const OUT    = path.join(__dirname, 'f03-moondream-results.txt')
const SS_DIR = path.join(__dirname, 'f03-screenshots')
const lines  = []

function pct(n, total) { return total > 0 ? Math.round(n / total * 100) : 0 }
function w(s) { lines.push(s); process.stdout.write(s + '\n') }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function sysRam() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "$os=Get-CimInstance Win32_OperatingSystem; Write-Output ($os.FreePhysicalMemory.ToString() + \',\' + $os.TotalVisibleMemorySize.ToString())"',
      { timeout: 8000 }
    ).toString().trim()
    const [free, total] = out.split(',').map(Number)
    return { freeMiB: Math.round(free / 1024), totalMiB: Math.round(total / 1024) }
  } catch { return null }
}

function ollamaPs() {
  return new Promise(resolve => {
    const req = http.get(
      { hostname: 'localhost', port: 11434, path: '/api/ps', timeout: 5000 },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve(null) } }) }
    )
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

function ollamaGenerate(model, prompt, imageB64, options = {}) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model,
      prompt,
      images: imageB64 ? [imageB64] : undefined,
      stream: false,
      options: { num_ctx: options.numCtx ?? 2048, temperature: 0.1, num_predict: options.numPredict ?? 200 }
    })
    const t0 = Date.now()
    const req = http.request({
      hostname: 'localhost', port: 11434, path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000
    }, res => {
      let raw = ''
      res.on('data', c => raw += c)
      res.on('end', () => {
        const elapsed = Date.now() - t0
        try {
          const j = JSON.parse(raw)
          resolve({
            response: j.response ?? '',
            loadDurationMs: Math.round((j.load_duration ?? 0) / 1e6),
            evalCount: j.eval_count ?? 0,
            genTps: j.eval_count && j.eval_duration
              ? Math.round(j.eval_count / (j.eval_duration / 1e9) * 10) / 10 : 0,
            totalDurationMs: Math.round((j.total_duration ?? 0) / 1e6),
            elapsedMs: elapsed,
            error: null
          })
        } catch (e) {
          resolve({ error: `Parse: ${e.message} raw="${raw.slice(0, 100)}"`, elapsedMs: elapsed })
        }
      })
    })
    req.on('error', e => resolve({ error: e.message, elapsedMs: Date.now() - t0 }))
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout', elapsedMs: Date.now() - t0 }) })
    req.write(body)
    req.end()
  })
}

function takeScreenshot(label) {
  const outFile = path.join(SS_DIR, `${label}.png`)
  const psFile  = path.join(SS_DIR, `_tmp.ps1`)
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
    '$g.Dispose()',
    `$bmp.Save('${outFile.replace(/\\/g, '\\\\')}')`,
    '$bmp.Dispose()',
  ].join('\r\n')
  try {
    fs.writeFileSync(psFile, ps, 'utf8')
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { timeout: 15000 })
    if (!fs.existsSync(outFile)) return null
    return fs.readFileSync(outFile).toString('base64')
  } catch (e) {
    w(`  Screenshot failed (${label}): ${e.message.slice(0, 120)}`)
    return null
  }
}

// ── Controlled screenshot scenarios ──────────────────────────────────────────
// Each entry: label, instruction (printed to user), groundTruth (keywords that
// MUST appear in a correct response), falseElements (hallucination markers).

const SCENARIOS = [
  {
    label: 'sc01-notepad-text',
    instruction: 'Open Notepad and type: "Hello Goga test 123"',
    prompt: 'What text is written in the text editor? Transcribe it exactly.',
    groundTruth: ['hello', 'goga', 'test', '123'],
    falseElements: ['chrome', 'firefox', 'excel', 'word', 'calculator'],
  },
  {
    label: 'sc02-calculator',
    instruction: 'Open Calculator (standard mode)',
    prompt: 'What application is open? List all visible buttons.',
    groundTruth: ['calculator'],
    falseElements: ['notepad', 'browser', 'excel', 'word'],
  },
  {
    label: 'sc03-brave-form',
    instruction: 'Open Brave and navigate to about:blank, then open DevTools (F12)',
    prompt: 'Describe the active window and any panels or tabs visible.',
    groundTruth: ['brave', 'browser', 'devtools', 'console'],
    falseElements: ['notepad', 'calculator', 'excel'],
  },
  {
    label: 'sc04-file-dialog',
    instruction: 'In Notepad, press Ctrl+S to open the Save As dialog',
    prompt: 'Is there a dialog box open? What is its title and what controls are visible?',
    groundTruth: ['save', 'dialog', 'file', 'cancel', 'button'],
    falseElements: ['calculator', 'browser', 'excel'],
  },
  {
    label: 'sc05-taskbar',
    instruction: 'Close all dialogs. Show the desktop with taskbar visible.',
    prompt: 'Describe the taskbar. What icons or pinned apps are visible?',
    groundTruth: ['taskbar', 'windows', 'start', 'desktop'],
    falseElements: ['notepad open', 'calculator open', 'dialog'],
  },
  {
    label: 'sc06-notepad-menu',
    instruction: 'Open Notepad and click the Format menu to expand it',
    prompt: 'What menu is open? List all menu items visible.',
    groundTruth: ['format', 'font', 'word wrap'],
    falseElements: ['file menu', 'edit menu', 'view menu', 'calculator'],
  },
  {
    label: 'sc07-calc-result',
    instruction: 'In Calculator, compute 123 + 456 (show the result 579)',
    prompt: 'What number is displayed in the calculator result area?',
    groundTruth: ['579'],
    falseElements: ['123', '456', 'error', 'notepad'],
  },
  {
    label: 'sc08-vscode-editor',
    instruction: 'Switch to VS Code with a TypeScript file open',
    prompt: 'What is the name of the file open in the editor? What programming language is it?',
    groundTruth: ['typescript', 'vscode', 'visual studio', 'code', '.ts'],
    falseElements: ['calculator', 'notepad', 'browser'],
  },
  {
    label: 'sc09-disabled-button',
    instruction: 'Open the test page: scripts/test-page/index.html in Brave',
    prompt: 'Are there any disabled or grayed-out buttons? Describe them.',
    groundTruth: ['button', 'disabled', 'grayed', 'inactive'],
    falseElements: ['calculator', 'notepad', 'dialog'],
  },
  {
    label: 'sc10-multi-window',
    instruction: 'Arrange Notepad and Calculator side by side (both visible)',
    prompt: 'How many windows are visible? List their titles.',
    groundTruth: ['notepad', 'calculator', 'two', '2'],
    falseElements: ['browser', 'excel', 'word', 'three', 'four'],
  },
]

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  w('\n╔══════════════════════════════════════════════════════════════╗')
  w('║  F0.3 — Moondream Benchmark                                  ║')
  w('╚══════════════════════════════════════════════════════════════╝\n')
  w('  Model:   moondream:latest (Ollama)')
  w('  Prereq:  GGUF primary (Llama 3.1 8B) must be loaded in node-llama-cpp')
  w('  Purpose: Measure moondream latency + accuracy WITH primary model in VRAM\n')

  if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true })

  // ── Baseline ──────────────────────────────────────────────────────────────
  w('── Baseline Resources ───────────────────────────────────────────')
  const gpuBase = nvidiaSmi()
  const ramBase = sysRam()
  if (gpuBase) {
    w(`  GPU:       ${gpuBase.name}`)
    w(`  VRAM used: ${gpuBase.usedMiB} MiB  free: ${gpuBase.freeMiB} MiB  total: ${gpuBase.totalMiB} MiB`)
    if (gpuBase.usedMiB < 3000) {
      w('  WARNING: VRAM usage is low — GGUF primary may not be loaded.')
      w('           Results will not reflect co-residence VRAM pressure.')
    }
  }
  if (ramBase) {
    w(`  RAM used:  ${ramBase.totalMiB - ramBase.freeMiB} MiB  free: ${ramBase.freeMiB} MiB`)
  }

  // ── Check moondream available ─────────────────────────────────────────────
  w('\n── Checking moondream:latest ────────────────────────────────────')
  const pingResult = await ollamaGenerate('moondream:latest', 'ping', null, { numCtx: 128, numPredict: 1 })
  if (pingResult.error && pingResult.error !== 'timeout') {
    w(`  ERROR: moondream:latest not available — ${pingResult.error}`)
    w('  Run: ollama pull moondream:latest')
    fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
    return
  }
  w('  moondream:latest is available')

  // ── Capture controlled screenshots ───────────────────────────────────────
  w('\n── Controlled Screenshot Capture ────────────────────────────────')
  w('  You will be prompted to set up each scenario before capture.\n')

  const screenshots = []
  for (let i = 0; i < SCENARIOS.length; i++) {
    const sc = SCENARIOS[i]
    w(`  [${i + 1}/10] ${sc.label}`)
    w(`         Setup: ${sc.instruction}`)
    w('         Press ENTER when ready (or wait 5s for auto-capture)...')

    // In non-interactive mode (CI / scripted run), auto-capture after 5s
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5000)
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true)
        process.stdin.resume()
        process.stdin.once('data', () => {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          clearTimeout(timer)
          resolve()
        })
      }
    })

    const b64 = takeScreenshot(sc.label)
    if (b64) {
      const sizeKB = Math.round(b64.length * 0.75 / 1024)
      screenshots.push({ ...sc, b64, sizeKB })
      w(`         [OK] ${sizeKB} KB`)
    } else {
      w(`         [FAIL] screenshot not captured — skipping`)
    }
    await sleep(200)
  }

  w(`\n  Captured: ${screenshots.length}/10 screenshots`)
  if (screenshots.length === 0) {
    w('  FATAL: No screenshots — cannot benchmark')
    fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
    return
  }

  // ── COLD call ─────────────────────────────────────────────────────────────
  w('\n── Cold Call (first moondream inference) ────────────────────────')
  const coldSS = screenshots[0]
  w(`  Screenshot: ${coldSS.label}`)
  w(`  Prompt:     "${coldSS.prompt}"`)
  const coldResult = await ollamaGenerate('moondream:latest', coldSS.prompt, coldSS.b64, { numCtx: 2048, numPredict: 200 })
  if (coldResult.error) {
    w(`  ERROR: ${coldResult.error}`)
  } else {
    w(`  Load duration:   ${coldResult.loadDurationMs} ms`)
    w(`  Total duration:  ${coldResult.totalDurationMs} ms`)
    w(`  Wall elapsed:    ${coldResult.elapsedMs} ms`)
    w(`  Gen speed:       ${coldResult.genTps} t/s`)
    w(`  Response:        "${coldResult.response.slice(0, 200)}"`)
  }

  // ── VRAM after cold load ──────────────────────────────────────────────────
  w('\n── Resources After Cold Load ────────────────────────────────────')
  const gpuAfterCold = nvidiaSmi()
  let moondreamVramDelta = 0
  if (gpuAfterCold && gpuBase) {
    moondreamVramDelta = gpuAfterCold.usedMiB - gpuBase.usedMiB
    w(`  VRAM used:  ${gpuAfterCold.usedMiB} MiB  (delta: +${moondreamVramDelta} MiB)`)
    w(`  VRAM free:  ${gpuAfterCold.freeMiB} MiB`)
    w(`  % of total: ${(gpuAfterCold.usedMiB / gpuAfterCold.totalMiB * 100).toFixed(1)}%`)
    if (moondreamVramDelta < 200) {
      w('  NOTE: Low VRAM delta — moondream may be CPU-offloaded or already cached')
    }
  }

  // ── ollama ps ─────────────────────────────────────────────────────────────
  w('\n── Ollama PS (CPU/GPU Split) ─────────────────────────────────────')
  const ps = await ollamaPs()
  const models = ps?.models ?? []
  if (models.length > 0) {
    for (const m of models) {
      const gpuPct = m.size && m.size_vram ? Math.round(m.size_vram / m.size * 100) : '?'
      const cpuPct = m.size && m.size_vram ? Math.round((m.size - m.size_vram) / m.size * 100) : '?'
      w(`  ${m.name}  size=${m.size ? (m.size / 1e9).toFixed(2) + 'GB' : '?'}  vram=${m.size_vram ? (m.size_vram / 1e9).toFixed(2) + 'GB' : '?'}  GPU=${gpuPct}%  CPU=${cpuPct}%`)
    }
  } else {
    w('  No models in ollama ps (model may have unloaded)')
  }

  // ── Warm calls ────────────────────────────────────────────────────────────
  w('\n── Warm Calls (screenshots 2–10) ────────────────────────────────')
  const warmResults = []
  for (let i = 1; i < screenshots.length; i++) {
    const sc = screenshots[i]
    w(`  [${i + 1}/10] ${sc.label}`)
    w(`         Prompt: "${sc.prompt.slice(0, 80)}"`)
    const r = await ollamaGenerate('moondream:latest', sc.prompt, sc.b64, { numCtx: 2048, numPredict: 200 })
    if (r.error) {
      w(`         ERROR: ${r.error}`)
      warmResults.push({ label: sc.label, error: r.error })
    } else {
      w(`         elapsed=${r.elapsedMs}ms  genTps=${r.genTps}  response="${r.response.slice(0, 120)}"`)
      warmResults.push({ label: sc.label, elapsedMs: r.elapsedMs, genTps: r.genTps, response: r.response })
    }
  }

  // ── Accuracy scoring ──────────────────────────────────────────────────────
  w('\n── Accuracy Scoring ─────────────────────────────────────────────')
  w('  Scoring: CORRECT      (all groundTruth keywords found)')
  w('           PARTIAL      (≥50% groundTruth keywords found)')
  w('           WRONG        (<50% groundTruth keywords found)')
  w('           HALLUCINATED (falseElement keyword found in response)')
  w('  OCR scenes (sc01, sc07): keyword match IS the OCR score\n')

  const allResults = [
    { sc: screenshots[0], response: coldResult.error ? '' : coldResult.response },
    ...warmResults.filter(r => !r.error).map((r, i) => ({ sc: screenshots[i + 1], response: r.response ?? '' }))
  ]

  let correct = 0, partial = 0, wrong = 0, hallucinated = 0
  const scoreDetails = []

  const ocrLabels = new Set(['sc01-notepad-text', 'sc07-calc-result'])
  let ocrCorrect = 0, ocrTotal = 0

  for (const { sc, response } of allResults) {
    if (!sc) continue
    const resp = response.toLowerCase()
    const falseHit = sc.falseElements.find(f => resp.includes(f.toLowerCase()))
    if (falseHit) {
      hallucinated++
      scoreDetails.push({ label: sc.label, score: 'HALLUCINATED', detail: `"${falseHit}" not present` })
      w(`  ${sc.label}: HALLUCINATED — "${falseHit}" not present on screen`)
      if (ocrLabels.has(sc.label)) ocrTotal++
      continue
    }
    const hits = sc.groundTruth.filter(k => resp.includes(k.toLowerCase()))
    const ratio = hits.length / sc.groundTruth.length
    const isOcr = ocrLabels.has(sc.label)
    if (isOcr) ocrTotal++
    if (ratio >= 1.0) {
      correct++
      if (isOcr) ocrCorrect++
      scoreDetails.push({ label: sc.label, score: 'CORRECT', detail: `${hits.length}/${sc.groundTruth.length} keywords` })
      w(`  ${sc.label}: CORRECT — ${hits.length}/${sc.groundTruth.length} keywords matched`)
    } else if (ratio >= 0.5) {
      partial++
      scoreDetails.push({ label: sc.label, score: 'PARTIAL', detail: `${hits.length}/${sc.groundTruth.length} keywords` })
      w(`  ${sc.label}: PARTIAL — ${hits.length}/${sc.groundTruth.length} keywords matched`)
    } else {
      wrong++
      scoreDetails.push({ label: sc.label, score: 'WRONG', detail: `${hits.length}/${sc.groundTruth.length} keywords` })
      w(`  ${sc.label}: WRONG — ${hits.length}/${sc.groundTruth.length} keywords matched`)
    }
  }
  w(`\n  OCR score (sc01 + sc07): ${ocrCorrect}/${ocrTotal} (${pct(ocrCorrect, ocrTotal)}%)`)

  const total = allResults.filter(r => r.sc).length
  w(`\n  Total scored:  ${total}`)
  w(`  CORRECT:       ${correct}  (${pct(correct, total)}%)`)
  w(`  PARTIAL:       ${partial}  (${pct(partial, total)}%)`)
  w(`  WRONG:         ${wrong}  (${pct(wrong, total)}%)`)
  w(`  HALLUCINATED:  ${hallucinated}  (${pct(hallucinated, total)}%)`)
  w(`  Accuracy:      ${pct(correct + partial, total)}% (correct+partial)`)

  // ── Warm latency stats ────────────────────────────────────────────────────
  w('\n── Warm Latency Statistics ──────────────────────────────────────')
  const warmOk = warmResults.filter(r => !r.error && r.elapsedMs)
  if (warmOk.length > 0) {
    const lats = warmOk.map(r => r.elapsedMs).sort((a, b) => a - b)
    const avg  = Math.round(lats.reduce((s, v) => s + v, 0) / lats.length)
    const p50  = lats[Math.floor(lats.length * 0.5)]
    const p95  = lats[Math.floor(lats.length * 0.95)] ?? lats[lats.length - 1]
    const avgTps = warmOk.reduce((s, r) => s + (r.genTps || 0), 0) / warmOk.length
    w(`  Samples:  ${warmOk.length}`)
    w(`  Min:      ${lats[0]} ms`)
    w(`  Avg:      ${avg} ms`)
    w(`  P50:      ${p50} ms`)
    w(`  P95:      ${p95} ms`)
    w(`  Max:      ${lats[lats.length - 1]} ms`)
    w(`  Avg gen:  ${avgTps.toFixed(1)} t/s`)
  }

  // ── Final VRAM ────────────────────────────────────────────────────────────
  w('\n── Final Resources ──────────────────────────────────────────────')
  const gpuFinal = nvidiaSmi()
  if (gpuFinal && gpuBase) {
    const delta = gpuFinal.usedMiB - gpuBase.usedMiB
    w(`  VRAM used:  ${gpuFinal.usedMiB} MiB  (delta from baseline: +${delta} MiB)`)
    w(`  VRAM free:  ${gpuFinal.freeMiB} MiB`)
    w(`  % of total: ${(gpuFinal.usedMiB / gpuFinal.totalMiB * 100).toFixed(1)}%`)
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const coldMs  = coldResult.error ? 'ERROR' : coldResult.elapsedMs
  const warmAvg = warmOk.length > 0
    ? Math.round(warmOk.reduce((s, r) => s + r.elapsedMs, 0) / warmOk.length) : 'N/A'
  const avgTps  = warmOk.length > 0
    ? (warmOk.reduce((s, r) => s + (r.genTps || 0), 0) / warmOk.length).toFixed(1) : 'N/A'

  w('\n' + '═'.repeat(70))
  w('MOONDREAM BENCHMARK SUMMARY')
  w('═'.repeat(70))
  w(`  Screenshots:       ${screenshots.length}/10 captured`)
  w(`  Cold TTFT:         ${coldMs} ms`)
  w(`  Warm avg latency:  ${warmAvg} ms`)
  w(`  Avg gen speed:     ${avgTps} t/s`)
  w(`  VRAM delta:        +${moondreamVramDelta} MiB`)
  w(`  Accuracy:          ${pct(correct + partial, total)}% (${correct} correct, ${partial} partial)`)
  w(`  Hallucination:     ${pct(hallucinated, total)}% (${hallucinated}/${total})`)

  // Co-residence verdict
  if (gpuBase && gpuAfterCold) {
    const combined = gpuAfterCold.usedMiB
    const headroom = gpuBase.totalMiB - combined
    w(`\n  Co-residence check (GGUF primary + moondream):`)
    w(`    GGUF baseline VRAM:  ${gpuBase.usedMiB} MiB`)
    w(`    After moondream:     ${gpuAfterCold.usedMiB} MiB`)
    w(`    Headroom remaining:  ${headroom} MiB`)
    if (headroom > 500) {
      w('    VERDICT: FITS — moondream co-resides with GGUF primary ✓')
    } else {
      w('    VERDICT: TIGHT — less than 500 MiB headroom, may cause OOM under load')
    }
  }

  // Comparison vs LLaVA 13B
  w('\n  vs LLaVA 13B (from F0.2 benchmark):')
  w('    LLaVA cold:   ~82163 ms    Moondream cold:  ' + coldMs + ' ms')
  w('    LLaVA warm:   ~7162 ms     Moondream warm:  ' + warmAvg + ' ms')
  w('    LLaVA VRAM:   +8363 MiB    Moondream VRAM:  +' + moondreamVramDelta + ' MiB')
  w('    LLaVA gen:    ~17.4 t/s    Moondream gen:   ' + avgTps + ' t/s')

  // ── Delete screenshots after results written ─────────────────────────────
  try {
    const files = fs.readdirSync(SS_DIR)
    for (const f of files) fs.unlinkSync(path.join(SS_DIR, f))
    fs.rmdirSync(SS_DIR)
    w('  Screenshots deleted.')
  } catch (e) {
    w(`  WARNING: Could not delete screenshots: ${e.message}`)
  }

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  w(`\nResults written to ${OUT}`)
}

run().catch(err => {
  w(`\nFATAL: ${err.message}\n${err.stack}`)
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  process.exit(1)
})
