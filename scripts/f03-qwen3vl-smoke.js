#!/usr/bin/env node
/**
 * F0.3 — Qwen3-VL 2B Smoke Test
 * Model: qwen3-vl:2b
 *   architecture: qwen3vl  parameters: 2.1B  context: 262144  quant: Q4_K_M
 *   temperature: 1  top_k: 20  top_p: 0.95  (no stop tokens, no template override)
 *
 * Checkpoint 2B: adds semantic-shapes (T3) and mock-desktop (T4) tests.
 * Checkpoint 3A: adds --vram mode (VRAM co-residence measurement).
 * T1/T1B anomaly: benign exact-output prompts produced an unexpected refusal (cause unproven).
 * Note: load_duration = model-loading time. True TTFT was not measured (stream:false).
 *
 * Run: node scripts/f03-qwen3vl-smoke.js
 *      node scripts/f03-qwen3vl-smoke.js --vram
 */

const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const { exec }     = require('child_process')
const { chromium } = require('playwright')

const VRAM_MODE = process.argv.includes('--vram')

const TMP = path.join(__dirname, 'f03-qwen3vl-tmp')

const MODEL = 'qwen3-vl-2b-instruct-lowctx'
const OUT   = path.join(__dirname, 'f03-qwen3vl-instruct-smoke-results.txt')
const lines = []
function w(s) { lines.push(s); process.stdout.write(s + '\n') }

// ── /api/chat helper ──────────────────────────────────────────────────────────

function apiChat(userContent, imageB64, think) {
  return new Promise(resolve => {
    const msg = { role: 'user', content: userContent }
    if (imageB64) msg.images = [imageB64]
    const bodyObj = { model: MODEL, messages: [msg], stream: false }
    if (think === false) bodyObj.think = false
    const body = JSON.stringify(bodyObj)
    const t0 = Date.now()
    const req = http.request({
      hostname: 'localhost', port: 11434, path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
    }, res => {
      let raw = ''
      res.on('data', c => raw += c)
      res.on('end', () => {
        const elapsedMs = Date.now() - t0
        try {
          const j        = JSON.parse(raw)
          const content  = j.message?.content  ?? ''
          const thinking = j.message?.thinking ?? ''
          const isEmpty  = content.trim().length === 0
          const evalCount   = j.eval_count    ?? 0
          const evalDurNs   = j.eval_duration ?? 0
          const genTps      = (!isEmpty && evalCount > 0 && evalDurNs > 0)
            ? Math.round(evalCount / (evalDurNs / 1e9) * 10) / 10
            : null
          resolve({
            httpStatus:      res.statusCode,
            apiError:        j.error ?? null,
            content,
            thinking,
            thinkingLen:     thinking.length,
            contentLen:      content.length,
            doneReason:      j.done_reason ?? null,
            promptEvalCount: j.prompt_eval_count ?? 0,
            evalCount,
            loadMs:          Math.round((j.load_duration        ?? 0) / 1e6),
            promptMs:        Math.round((j.prompt_eval_duration ?? 0) / 1e6),
            genMs:           Math.round((j.eval_duration        ?? 0) / 1e6),
            totalMs:         Math.round((j.total_duration       ?? 0) / 1e6),
            elapsedMs,
            genTps,
          })
        } catch (e) {
          resolve({
            httpStatus: res.statusCode,
            parseError: e.message,
            rawSnippet: raw.slice(0, 300),
            elapsedMs:  Date.now() - t0,
          })
        }
      })
    })
    req.on('error',   e  => resolve({ httpStatus: null, parseError: e.message,  elapsedMs: Date.now() - t0 }))
    req.on('timeout', () => { req.destroy(); resolve({ httpStatus: null, parseError: 'timeout', elapsedMs: Date.now() - t0 }) })
    req.write(body)
    req.end()
  })
}

function reportImg(img) {
  w(`  Dimensions:   ${img.W}×${img.H}`)
  w(`  PNG bytes:    ${img.bytes}`)
  w(`  Base64 len:   ${img.b64len} chars`)
  w(`  SHA-256:      ${img.sha}`)
}

function reportChat(r) {
  if (r.parseError) {
    w(`  ERROR: ${r.parseError}`)
    if (r.rawSnippet) w(`  Raw: ${r.rawSnippet}`)
    return
  }
  w(`  HTTP status:        ${r.httpStatus}`)
  if (r.apiError) w(`  API error:          ${r.apiError}`)
  if (r.thinkingLen > 0)
    w(`  thinking (${r.thinkingLen} chars): "${r.thinking.slice(0, 200)}${r.thinkingLen > 200 ? '…' : '"'}`)
  else
    w(`  thinking:           (none)`)
  w(`  answer (${r.contentLen} chars): "${r.content.slice(0, 400)}"`)
  w(`  done_reason:        ${r.doneReason}`)
  w(`  prompt_eval_count:  ${r.promptEvalCount}`)
  w(`  eval_count:         ${r.evalCount}`)
  w(`  Load duration:      ${r.loadMs} ms  (model-loading time)`)
  w(`  Prompt eval:        ${r.promptMs} ms`)
  w(`  Generation:         ${r.genMs} ms`)
  w(`  Total duration:     ${r.totalMs} ms`)
  w(`  Wall elapsed:       ${r.elapsedMs} ms`)
  w(`  Gen speed:          ${r.genTps !== null ? r.genTps + ' t/s' : 'N/A'}`)
}

// ── PNG via Playwright ────────────────────────────────────────────────────────

async function renderHtml(filename, W, H, html) {
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })
  const outFile = path.join(TMP, filename)
  const browser = await chromium.launch({ headless: true })
  const page    = await browser.newPage()
  await page.setViewportSize({ width: W, height: H })
  await page.setContent(html, { waitUntil: 'load' })
  await page.screenshot({ path: outFile, type: 'png' })
  await browser.close()
  const buf = fs.readFileSync(outFile)
  const b64 = buf.toString('base64')
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  return { b64, sha, bytes: buf.length, b64len: b64.length, W, H }
}

function makePng(W, H, text) {
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#fff;
    display:flex;align-items:center;justify-content:center;
    width:${W}px;height:${H}px;">
    <span style="font-family:'Segoe UI',Arial,sans-serif;font-size:72px;
      font-weight:bold;color:#000;">${text}</span></body></html>`
  return renderHtml('smoke-ocr.png', W, H, html)
}

function makeShapesPng() {
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#fff;
    width:640px;height:480px;position:relative;">
    <div style="position:absolute;left:100px;top:140px;width:160px;height:160px;
      background:red;"></div>
    <div style="position:absolute;left:380px;top:140px;width:160px;height:160px;
      background:blue;border-radius:50%;"></div>
  </body></html>`
  return renderHtml('smoke-shapes.png', 640, 480, html)
}

function makeDesktopPng() {
  const html = `<!DOCTYPE html><html><body style="margin:0;font-family:'Segoe UI',Arial,sans-serif;
    background:#f0f0f0;width:1280px;height:720px;">
    <div style="background:#0078d4;color:#fff;padding:8px 12px;font-size:14px;
      font-weight:bold;">Notepad</div>
    <div style="background:#fff;margin:16px;padding:16px;font-size:22px;
      min-height:400px;">Hello Goga test 123</div>
    <div style="display:flex;gap:12px;margin:0 16px;">
      <button style="padding:8px 24px;font-size:16px;">Save</button>
      <button style="padding:8px 24px;font-size:16px;">Cancel</button>
    </div>
  </body></html>`
  return renderHtml('smoke-desktop.png', 1280, 720, html)
}

// ── Shell helpers (--vram mode) ─────────────────────────────────────────────

function execCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout.trim())
    })
  })
}

async function smi() {
  const out = await execCmd(
    'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader,nounits'
  )
  const [name, total, used, free] = out.split(',').map(s => s.trim())
  return { name, total: +total, used: +used, free: +free }
}

async function waitQwenAbsent(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ps = await execCmd('ollama ps').catch(() => '')
    if (!ps.split('\n').some(line => line.split(/\s+/)[0] === MODEL)) return ps
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`${MODEL} did not disappear from ollama ps within 30 s`)
}

async function runVram() {
  const VRAM_OUT = path.join(__dirname, 'f03-qwen3vl-instruct-vram-results.txt')
  const vlines = []
  function vw(s) { vlines.push(s); process.stdout.write(s + '\n') }

  vw('\n╔══════════════════════════════════════════════════════════════╗')
  vw('║  F0.3 — Qwen3-VL 2B  VRAM Co-residence Test  (3A)           ║')
  vw('╚══════════════════════════════════════════════════════════════╝')
  vw(`\n  Model: ${MODEL}`)

  let pngDesktop
  try {
    // ── Step 1: stop Qwen only ───────────────────────────────────────────
    vw('\n── Step 1: stopping qwen3-vl:2b-instruct ────────────────────────')
    await execCmd(`ollama stop ${MODEL}`).catch(e => vw(`  (stop warning: ${e.message})`))
    const psAfterStop = await waitQwenAbsent()
    vw(`  ollama ps after stop:\n${psAfterStop || '  (no models running)'}`)

    // ── Step 2: baseline VRAM (Goga GGUF still loaded) ───────────────────
    vw('\n── Step 2: baseline VRAM ────────────────────────────────────────')
    const base = await smi()
    vw(`  GPU:          ${base.name}`)
    vw(`  Total VRAM:   ${base.total} MiB`)
    vw(`  Baseline used: ${base.used} MiB`)
    vw(`  Baseline free: ${base.free} MiB`)
    if (base.used < 3000) {
      vw('\n  RESULT: INVALID — baseline GPU usage < 3000 MiB; primary GGUF model not co-resident')
      fs.writeFileSync(VRAM_OUT, vlines.join('\n'), 'utf8')
      vw(`\nResults written to ${VRAM_OUT}`)
      return
    }

    // ── Step 3: generate mock-desktop PNG ────────────────────────────────
    vw('\n── Step 3: generating mock-desktop PNG (Playwright, 1280×720) ───')
    pngDesktop = await makeDesktopPng()
    vw(`  Dimensions:   ${pngDesktop.W}×${pngDesktop.H}`)
    vw(`  PNG bytes:    ${pngDesktop.bytes}`)
    vw(`  Base64 len:   ${pngDesktop.b64len} chars`)
    vw(`  SHA-256:      ${pngDesktop.sha}`)

    // ── Step 4: send inference + sample VRAM every ~225 ms ───────────────
    vw('\n── Step 4: inference + VRAM sampling ───────────────────────────')
    const DESKTOP_PROMPT = 'Identify the application, transcribe the main text exactly, and list every visible button. Do not invent anything.'
    const samples = []
    let inferDone = false

    const samplerInterval = setInterval(async () => {
      if (inferDone) return
      try { samples.push(await smi()) } catch {}
    }, 225)

    const t0 = Date.now()
    const r = await apiChat(DESKTOP_PROMPT, pngDesktop.b64, false)
    inferDone = true
    clearInterval(samplerInterval)
    const wallMs = Date.now() - t0

    // ── Step 5: report inference result ──────────────────────────────────
    vw('\n── Step 5: inference result ─────────────────────────────────────')
    if (r.parseError) {
      vw(`  ERROR: ${r.parseError}`)
    } else {
      if (r.apiError) vw(`  API error: ${r.apiError}`)
      vw(`  thinking (${r.thinkingLen} chars)`)
      vw(`  answer (${r.contentLen} chars): "${r.content.slice(0, 400)}"`)
      vw(`  Load duration:   ${r.loadMs} ms`)
      vw(`  Prompt eval:     ${r.promptMs} ms`)
      vw(`  Generation:      ${r.genMs} ms`)
      vw(`  Total duration:  ${r.totalMs} ms`)
      vw(`  Wall elapsed:    ${wallMs} ms`)
      vw(`  Gen speed:       ${r.genTps !== null ? r.genTps + ' t/s' : 'N/A'}`)
    }

    // ── Step 6: VRAM peak from samples ───────────────────────────────────
    vw('\n── Step 6: VRAM samples during inference ────────────────────────')
    vw(`  Samples collected: ${samples.length}`)
    const peakUsed = samples.length ? Math.max(...samples.map(s => s.used)) : null
    const peakFree = samples.length ? Math.min(...samples.map(s => s.free)) : null
    if (peakUsed !== null) {
      vw(`  Peak used:  ${peakUsed} MiB`)
      vw(`  Peak free:  ${peakFree} MiB`)
      vw(`  Qwen delta: +${peakUsed - base.used} MiB from baseline`)
    } else {
      vw('  (no samples captured during inference)')
    }

    // ── Step 7: resident VRAM after inference ─────────────────────────────
    vw('\n── Step 7: resident VRAM after inference ────────────────────────')
    const resident = await smi()
    vw(`  Resident used: ${resident.used} MiB`)
    vw(`  Resident free: ${resident.free} MiB`)
    vw(`  Delta from baseline: ${resident.used - base.used >= 0 ? '+' : ''}${resident.used - base.used} MiB`)

    // ── Step 8: ollama ps during residency ────────────────────────────────
    vw('\n── Step 8: ollama ps (post-inference) ───────────────────────────')
    const psResident = await execCmd('ollama ps').catch(e => `ERROR: ${e.message}`)
    vw(psResident || '  (no models running)')

    // ── Step 9: stop Qwen, wait, post-unload VRAM ─────────────────────────
    vw('\n── Step 9: unloading qwen3-vl:2b-instruct ───────────────────────')
    await execCmd(`ollama stop ${MODEL}`).catch(e => vw(`  (stop warning: ${e.message})`))
    await waitQwenAbsent()
    const unloaded = await smi()
    vw(`  Post-unload used: ${unloaded.used} MiB`)
    vw(`  Post-unload free: ${unloaded.free} MiB`)
    const returnDelta = Math.abs(unloaded.used - base.used)
    vw(`  Return delta from baseline: ${returnDelta} MiB`)

    // ── Step 10: score co-residence ───────────────────────────────────────
    vw('\n── Step 10: co-residence verdict ────────────────────────────────')
    const ans4 = (r.content ?? '').toLowerCase()
    const visionPass = !r.parseError
      && ans4.includes('notepad')
      && ans4.includes('hello goga test 123')
      && ans4.includes('save')
      && ans4.includes('cancel')
      && !['word','excel','chrome','firefox','vscode','visual studio','explorer'].some(a => ans4.includes(a))
    const noOom      = !r.apiError?.toLowerCase().includes('cuda') && !r.apiError?.toLowerCase().includes('oom')
    const peakFreeOk = peakFree === null || peakFree >= 1000
    const returnOk   = returnDelta <= 250
    const coPass     = visionPass && noOom && peakFreeOk && returnOk

    vw(`  Vision answer:       ${visionPass ? 'PASS ✓' : 'FAIL ✗'}`)
    vw(`  No CUDA/OOM error:   ${noOom      ? 'PASS ✓' : 'FAIL ✗'}`)
    vw(`  Peak free ≥ 1000 MiB: ${peakFreeOk ? 'PASS ✓' : 'FAIL ✗'}  (${peakFree ?? 'n/a'} MiB)`)
    vw(`  Post-unload ≤ 250 MiB drift: ${returnOk ? 'PASS ✓' : 'FAIL ✗'}  (${returnDelta} MiB)`)
    vw(`\n  CO-RESIDENCE: ${coPass ? 'PASS ✓' : 'FAIL ✗'}`)

  } finally {
    try {
      if (fs.existsSync(TMP))
        for (const f of fs.readdirSync(TMP)) fs.unlinkSync(path.join(TMP, f))
      if (fs.existsSync(TMP)) fs.rmdirSync(TMP)
    } catch {}
    fs.writeFileSync(VRAM_OUT, vlines.join('\n'), 'utf8')
    vw(`\nResults written to ${VRAM_OUT}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  w('\n╔══════════════════════════════════════════════════════════════╗')
  w('║  F0.3 — Qwen3-VL 2B Smoke Test  (checkpoint 2B)             ║')
  w('╚══════════════════════════════════════════════════════════════╝')
  w(`\n  Model: ${MODEL}`)
  w('  Architecture: qwen3vl  |  2.1B Q4_K_M  |  context: 262144')
  w('  Parameters: temperature=1  top_k=20  top_p=0.95')
  w('  Note: load_duration = model-loading time; true TTFT not measured (stream:false)')
  w('  T1/T1B anomaly: benign exact-output prompts produced an unexpected refusal (cause unproven)\n')

  const TEXT_TOKEN   = 'TEXT_OK_9137'
  const VISION_TOKEN = 'VISION_OK_7429'
  const TEXT_PROMPT  = `Reply with exactly ${TEXT_TOKEN}`
  const OCR_PROMPT   = 'Read the large text in this image. Reply with only the exact text.'
  const SHAPES_PROMPT  = 'Describe the objects in this image. State the exact count, shape, and color of each object. Do not mention anything that is not visible.'
  const DESKTOP_PROMPT = 'Identify the application, transcribe the main text exactly, and list every visible button. Do not invent anything.'

  let r1, r1b, r2, r3, r4
  let t1Pass, t1bPass, t2Pass, t3Pass, t4Pass
  let pngOcr, pngShapes, pngDesktop

  try {
    // ── T1: plain-text, think:default ──────────────────────────────────────
    w('── T1: plain-text  think:default (/api/chat) ────────────────────')
    w(`  Content: "${TEXT_PROMPT}"`)
    r1 = await apiChat(TEXT_PROMPT, null, undefined)
    reportChat(r1)
    t1Pass = !r1.parseError && r1.content.includes(TEXT_TOKEN)
    w(`  TEXT PASS: ${t1Pass ? 'YES ✓' : 'NO ✗'}`)

    // ── T1B: plain-text, think:false ───────────────────────────────────────
    w('\n── T1B: plain-text  think:false (/api/chat) ─────────────────────')
    w(`  Content: "${TEXT_PROMPT}"`)
    r1b = await apiChat(TEXT_PROMPT, null, false)
    reportChat(r1b)
    t1bPass = !r1b.parseError && r1b.content.includes(TEXT_TOKEN)
    w(`  TEXT PASS: ${t1bPass ? 'YES ✓' : 'NO ✗'}`)

    // ── OCR PNG ────────────────────────────────────────────────────────────
    w('\n── Generating OCR PNG (Playwright, 640×480) ─────────────────────')
    pngOcr = await makePng(640, 480, VISION_TOKEN)
    reportImg(pngOcr)

    // ── T2: OCR vision, think:false ────────────────────────────────────────
    w('\n── T2: OCR vision  think:false (/api/chat) ──────────────────────')
    w(`  Content: "${OCR_PROMPT}"`)
    r2 = await apiChat(OCR_PROMPT, pngOcr.b64, false)
    reportChat(r2)
    t2Pass = !r2.parseError && r2.content.includes(VISION_TOKEN)
    w(`  VISION PASS: ${t2Pass ? 'YES ✓' : 'NO ✗'}`)

    // ── Shapes PNG ─────────────────────────────────────────────────────────
    w('\n── Generating shapes PNG (Playwright, 640×480) ──────────────────')
    pngShapes = await makeShapesPng()
    reportImg(pngShapes)

    // ── T3: semantic shapes, think:false ───────────────────────────────────
    w('\n── T3: semantic shapes  think:false (/api/chat) ─────────────────')
    w(`  Content: "${SHAPES_PROMPT}"`)
    r3 = await apiChat(SHAPES_PROMPT, pngShapes.b64, false)
    reportChat(r3)
    const ans3 = r3.content.toLowerCase()
    const hasRedSquare  = ans3.includes('red') && (ans3.includes('square') || ans3.includes('rectangle'))
    const hasBlueCircle = ans3.includes('blue') && ans3.includes('circle')
    const falseColors   = ['green','yellow','orange','purple','pink','black','white'].filter(c => ans3.includes(c))
    const falseShapes   = ['triangle','star','oval','diamond','pentagon','hexagon'].filter(s => ans3.includes(s))
    t3Pass = !r3.parseError && hasRedSquare && hasBlueCircle && falseColors.length === 0 && falseShapes.length === 0
    w(`  red square:   ${hasRedSquare  ? 'found ✓' : 'missing ✗'}`)
    w(`  blue circle:  ${hasBlueCircle ? 'found ✓' : 'missing ✗'}`)
    if (falseColors.length) w(`  INVENTED colors: ${falseColors.join(', ')}`)
    if (falseShapes.length) w(`  INVENTED shapes: ${falseShapes.join(', ')}`)
    w(`  SHAPES PASS: ${t3Pass ? 'YES ✓' : 'NO ✗'}`)

    // ── Desktop PNG ────────────────────────────────────────────────────────
    w('\n── Generating mock-desktop PNG (Playwright, 1280×720) ───────────')
    pngDesktop = await makeDesktopPng()
    reportImg(pngDesktop)

    // ── T4: mock desktop, think:false ──────────────────────────────────────
    w('\n── T4: mock desktop  think:false (/api/chat) ────────────────────')
    w(`  Content: "${DESKTOP_PROMPT}"`)
    r4 = await apiChat(DESKTOP_PROMPT, pngDesktop.b64, false)
    reportChat(r4)
    const ans4 = r4.content.toLowerCase()
    const hasNotepad = ans4.includes('notepad')
    const hasText    = ans4.includes('hello goga test 123')
    const hasSave    = ans4.includes('save')
    const hasCancel  = ans4.includes('cancel')
    const falseApps  = ['word','excel','chrome','firefox','vscode','visual studio','explorer']
      .filter(a => ans4.includes(a))
    t4Pass = !r4.parseError && hasNotepad && hasText && hasSave && hasCancel && falseApps.length === 0
    w(`  Notepad:              ${hasNotepad ? 'found ✓' : 'missing ✗'}`)
    w(`  Hello Goga test 123:  ${hasText    ? 'found ✓' : 'missing ✗'}`)
    w(`  Save button:          ${hasSave    ? 'found ✓' : 'missing ✗'}`)
    w(`  Cancel button:        ${hasCancel  ? 'found ✓' : 'missing ✗'}`)
    if (falseApps.length) w(`  INVENTED apps: ${falseApps.join(', ')}`)
    w(`  DESKTOP PASS: ${t4Pass ? 'YES ✓' : 'NO ✗'}`)

  } finally {
    // ── Cleanup — runs even if a test throws ──────────────────────────────
    try {
      if (fs.existsSync(TMP))
        for (const f of fs.readdirSync(TMP)) fs.unlinkSync(path.join(TMP, f))
      if (fs.existsSync(TMP)) fs.rmdirSync(TMP)
    } catch {}
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  w('\n' + '═'.repeat(70))
  w('CHECKPOINT 2B SUMMARY')
  w('═'.repeat(70))

  function row(id, label, r, pass) {
    if (!r || r.parseError) { w(`  ${id}  ${label}: ERROR — ${r?.parseError ?? 'not run'}`); return }
    const status = pass ? 'PASS ✓' : (r.content.trim().length > 0 ? 'FAIL (wrong content)' : 'FAIL (empty)')
    w(`  ${id}  ${label}: ${status}`)
    w(`      thinking=${r.thinkingLen} chars  answer=${r.contentLen} chars  eval_count=${r.evalCount}`)
    w(`      gen=${r.genTps !== null ? r.genTps + ' t/s' : 'N/A'}  elapsed=${r.elapsedMs} ms  done_reason=${r.doneReason}`)
  }

  row('T1 ', 'plain-text  think:default', r1,  t1Pass)
  row('T1B', 'plain-text  think:false  ', r1b, t1bPass)
  row('T2 ', 'OCR vision  think:false  ', r2,  t2Pass)
  row('T3 ', 'shapes      think:false  ', r3,  t3Pass)
  row('T4 ', 'mock-desktop think:false ', r4,  t4Pass)

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  w(`\nResults written to ${OUT}`)
}

const entry = VRAM_MODE ? runVram : run
entry().catch(err => {
  const sink = VRAM_MODE
    ? path.join(__dirname, 'f03-qwen3vl-instruct-vram-results.txt')
    : OUT
  const msg = `\nFATAL: ${err.message}\n${err.stack}`
  process.stdout.write(msg + '\n')
  fs.appendFileSync(sink, msg, 'utf8')
  process.exit(1)
})
