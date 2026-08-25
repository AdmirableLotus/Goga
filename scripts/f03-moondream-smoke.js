#!/usr/bin/env node
/**
 * F0.3 — Moondream Smoke Test (rev 2)
 *
 * Model template (from ollama show --modelfile):
 *   TEMPLATE "{{ if .Prompt }} Question: {{ .Prompt }}\n\n{{ end }} Answer: {{ .Response }}\n\n"
 *   PARAMETER stop  <|endoftext|>
 *   PARAMETER stop  Question:
 *   PARAMETER temperature 0
 *
 * Test matrix:
 *   A  /api/generate  text only,  no temperature override
 *   B  /api/chat      text only,  no temperature override
 *   C  /api/chat      640×480 vision
 *   D  /api/generate  640×480 vision
 *   A2 /api/generate  text only,  temperature:0.2  (only if A fails)
 *   C2 /api/chat      640×480 vision, temperature:0.2  (only if A fails)
 */

const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const zlib   = require('zlib')

const OUT = path.join(__dirname, 'f03-moondream-smoke-results.txt')
const MODEL = 'moondream-nostop'
const TMP = path.join(__dirname, 'f03-smoke-tmp')
const lines = []
function w(s) { lines.push(s); process.stdout.write(s + '\n') }

// ── PNG generation (zlib-compressed) ─────────────────────────────────────────

function crc32(buf) {
  const t = crc32._t || (crc32._t = (() => {
    const a = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      a[i] = c
    }
    return a
  })())
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b }

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return Buffer.concat([u32be(d.length), t, d, u32be(crc32(Buffer.concat([t, d])))])
}

// 5×7 pixel bitmap glyphs (5-bit rows, MSB = leftmost pixel)
const GLYPHS = {
  'V':0x1111110A04, 'I':0x1F04040404, 'S':0x0E11080611,
  'O':0x0E11111111, 'N':0x1119151311, '_':0x0000001F00,
  'K':0x110A040A11, '7':0x1F01020404, '4':0x080C0A1F02,
  '2':0x0E11020411, '9':0x0E110F010E, ' ':0x0000000000,
}

function glyph(ch) {
  const v = GLYPHS[ch] ?? GLYPHS[' ']
  // unpack 5 bytes from 40-bit BigInt-style number stored as regular number
  return [
    (v / 0x100000000 | 0) & 0xFF,
    (v / 0x1000000   | 0) & 0xFF,
    (v / 0x10000     | 0) & 0xFF,
    (v / 0x100       | 0) & 0xFF,
    v & 0xFF,
  ]
}

function makePng(W, H, text, scale) {
  const pixels = Buffer.alloc(W * H * 3, 0xFF)  // white
  const cw = (5 + 1) * scale
  const ch = 7 * scale
  const ox = Math.max(0, (W - text.length * cw) >> 1)
  const oy = Math.max(0, (H - ch) >> 1)

  for (let ci = 0; ci < text.length; ci++) {
    const rows = glyph(text[ci])
    for (let row = 0; row < 5; row++) {        // 5 data rows (rows[0..4])
      const byte = rows[row]
      for (let col = 0; col < 5; col++) {
        if (!((byte >> (4 - col)) & 1)) continue
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++) {
            const px = ox + ci * cw + col * scale + sx
            const py = oy + row * scale + sy
            if (px < W && py < H) {
              const i = (py * W + px) * 3
              pixels[i] = pixels[i+1] = pixels[i+2] = 0  // black
            }
          }
      }
    }
  }

  // Raw scanlines: filter-byte 0 + RGB
  const raw = Buffer.alloc(H * (1 + W * 3))
  for (let y = 0; y < H; y++)
    pixels.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3)

  const idat = zlib.deflateSync(raw, { level: 9 })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 2  // 8-bit RGB

  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function post(apiPath, bodyObj) {
  return new Promise(resolve => {
    const body = JSON.stringify(bodyObj)
    const t0   = Date.now()
    const req  = http.request({
      hostname: 'localhost', port: 11434, path: apiPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
    }, res => {
      let raw = ''
      res.on('data', c => raw += c)
      res.on('end', () => {
        const elapsedMs = Date.now() - t0
        try {
          const j = JSON.parse(raw)
          // Normalise: /api/generate uses j.response; /api/chat uses j.message.content
          const response   = j.response ?? j.message?.content ?? ''
          const evalCount  = j.eval_count  ?? 0
          const evalDurNs  = j.eval_duration ?? 0
          const isEmpty    = response.trim().length === 0
          const genTps     = (!isEmpty && evalCount > 0 && evalDurNs > 0)
            ? Math.round(evalCount / (evalDurNs / 1e9) * 10) / 10
            : null
          resolve({
            httpStatus:      res.statusCode,
            apiError:        j.error ?? null,
            response,
            responseLen:     response.length,
            doneReason:      j.done_reason ?? null,
            promptEvalCount: j.prompt_eval_count ?? 0,
            evalCount,
            loadMs:          Math.round((j.load_duration        ?? 0) / 1e6),
            promptMs:        Math.round((j.prompt_eval_duration ?? 0) / 1e6),
            genMs:           Math.round((j.eval_duration        ?? 0) / 1e6),
            totalMs:         Math.round((j.total_duration       ?? 0) / 1e6),
            elapsedMs,
            genTps,
            rawJson:         raw.slice(0, 400),
          })
        } catch (e) {
          resolve({ httpStatus: res.statusCode, parseError: e.message, rawJson: raw.slice(0, 400), elapsedMs: Date.now() - t0 })
        }
      })
    })
    req.on('error',   e  => resolve({ httpStatus: null, parseError: e.message,  elapsedMs: Date.now() - t0 }))
    req.on('timeout', () => { req.destroy(); resolve({ httpStatus: null, parseError: 'timeout', elapsedMs: Date.now() - t0 }) })
    req.write(body); req.end()
  })
}

function apiGenerate(prompt, imageB64, temperature) {
  const opts = {}
  if (temperature !== null) opts.temperature = temperature
  const body = { model: MODEL, prompt, stream: false, options: opts }
  if (imageB64) body.images = [imageB64]
  return post('/api/generate', body)
}

function apiChat(userContent, imageB64, temperature) {
  const msg = { role: 'user', content: userContent }
  if (imageB64) msg.images = [imageB64]
  const opts = {}
  if (temperature !== null) opts.temperature = temperature
  const body = { model: MODEL, messages: [msg], stream: false, options: opts }
  return post('/api/chat', body)
}

// ── Report ────────────────────────────────────────────────────────────────────

function report(r, visionToken) {
  if (r.parseError) { w(`  ERROR: ${r.parseError}`); w(`  Raw: ${r.rawJson ?? ''}`); return }
  w(`  HTTP status:        ${r.httpStatus}`)
  if (r.apiError)    w(`  API error:          ${r.apiError}`)
  w(`  Response (${r.responseLen} chars): "${r.response.slice(0, 300)}"`)
  w(`  done_reason:        ${r.doneReason}`)
  w(`  prompt_eval_count:  ${r.promptEvalCount}`)
  w(`  eval_count:         ${r.evalCount}`)
  w(`  Load duration:      ${r.loadMs} ms`)
  w(`  Prompt eval:        ${r.promptMs} ms`)
  w(`  Generation:         ${r.genMs} ms`)
  w(`  Total duration:     ${r.totalMs} ms`)
  w(`  Wall elapsed:       ${r.elapsedMs} ms`)
  w(`  Gen speed:          ${r.genTps !== null ? r.genTps + ' t/s' : 'N/A'}`)
  if (visionToken) w(`  VISION PASS:        ${r.response.includes(visionToken) ? 'YES ✓' : 'NO ✗'}`)
}

function imageInfo(label, pngBuf, b64) {
  const sha = crypto.createHash('sha256').update(pngBuf).digest('hex')
  const W   = pngBuf.readUInt32BE(16), H = pngBuf.readUInt32BE(20)
  w(`  ${label}: ${W}×${H}  PNG=${pngBuf.length} bytes  b64=${b64.length} chars  SHA256=${sha}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  w('\n╔══════════════════════════════════════════════════════════════╗')
  w('║  F0.3 — Moondream Smoke Test (rev 2)                         ║')
  w('╚══════════════════════════════════════════════════════════════╝')
  w('\nModel template (from ollama show --modelfile):')
  w('  TEMPLATE "{{ if .Prompt }} Question: {{ .Prompt }}\\n\\n{{ end }} Answer: {{ .Response }}\\n\\n"')
  w('  PARAMETER stop  <|endoftext|>')
  w('  PARAMETER stop  Question:')
  w('  PARAMETER temperature 0')

  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })

  const VISION_TOKEN = 'VISION_OK_7429'
  const TEXT_TOKEN   = 'TEXT_OK_9137'
  const VISION_PROMPT = 'Read the large text in this image. Reply with only that exact text.'
  const TEXT_PROMPT   = `Reply with exactly ${TEXT_TOKEN}`

  // Generate images
  w('\n── Images ───────────────────────────────────────────────────────')
  const png640  = makePng(640,  480,  VISION_TOKEN, 6)
  const b64_640 = png640.toString('base64')
  fs.writeFileSync(path.join(TMP, 'smoke-640.png'), png640)
  imageInfo('640×480', png640, b64_640)

  // ── A: /api/generate text, default temperature ────────────────────────────
  w('\n── A: /api/generate  text only  temperature:default ─────────────')
  w(`  Prompt: "${TEXT_PROMPT}"`)
  const rA = await apiGenerate(TEXT_PROMPT, null, null)
  report(rA, null)
  const textWorks = !rA.parseError && rA.response.trim().length > 0

  // ── B: /api/chat text, default temperature ────────────────────────────────
  w('\n── B: /api/chat  text only  temperature:default ─────────────────')
  w(`  Content: "${TEXT_PROMPT}"`)
  const rB = await apiChat(TEXT_PROMPT, null, null)
  report(rB, null)

  // ── C: /api/chat vision, default temperature ──────────────────────────────
  w('\n── C: /api/chat  640×480 vision  temperature:default ────────────')
  w(`  Content: "${VISION_PROMPT}"`)
  const rC = await apiChat(VISION_PROMPT, b64_640, null)
  report(rC, VISION_TOKEN)

  // ── D: /api/generate vision, default temperature ──────────────────────────
  w('\n── D: /api/generate  640×480 vision  temperature:default ────────')
  w(`  Prompt: "${VISION_PROMPT}"`)
  const rD = await apiGenerate(VISION_PROMPT, b64_640, null)
  report(rD, VISION_TOKEN)

  // ── A2 / C2: temperature:0.2 experiment (only if A fails) ─────────────────
  let rA2 = null, rC2 = null
  if (!textWorks) {
    w('\n── A2: /api/generate  text only  temperature:0.2 (A failed) ─────')
    w(`  Prompt: "${TEXT_PROMPT}"`)
    rA2 = await apiGenerate(TEXT_PROMPT, null, 0.2)
    report(rA2, null)

    w('\n── C2: /api/chat  640×480 vision  temperature:0.2 (A failed) ────')
    w(`  Content: "${VISION_PROMPT}"`)
    rC2 = await apiChat(VISION_PROMPT, b64_640, 0.2)
    report(rC2, VISION_TOKEN)
  } else {
    w('\n── A2/C2: skipped (A text generation succeeded) ─────────────────')
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  w('\n' + '═'.repeat(70))
  w('SMOKE TEST SUMMARY')
  w('═'.repeat(70))

  const rows = [
    { id: 'A',  label: '/api/generate text  temp:default', r: rA,  token: TEXT_TOKEN,   vision: false },
    { id: 'B',  label: '/api/chat      text  temp:default', r: rB,  token: TEXT_TOKEN,   vision: false },
    { id: 'C',  label: '/api/chat      vision temp:default', r: rC, token: VISION_TOKEN, vision: true  },
    { id: 'D',  label: '/api/generate vision temp:default', r: rD,  token: VISION_TOKEN, vision: true  },
  ]
  if (rA2) rows.push({ id: 'A2', label: '/api/generate text  temp:0.2', r: rA2, token: TEXT_TOKEN,   vision: false })
  if (rC2) rows.push({ id: 'C2', label: '/api/chat      vision temp:0.2', r: rC2, token: VISION_TOKEN, vision: true })

  for (const { id, label, r, token, vision } of rows) {
    if (!r || r.parseError) { w(`  ${id}  ${label}: ERROR — ${r?.parseError ?? 'not run'}`); continue }
    const hasText  = r.response.trim().length > 0
    const hasToken = r.response.includes(token)
    const status   = hasToken ? 'PASS ✓' : (hasText ? 'WRONG TEXT' : 'EMPTY')
    w(`  ${id}  ${label}`)
    w(`     status=${status}  eval_count=${r.evalCount}  gen=${r.genTps !== null ? r.genTps + ' t/s' : 'N/A'}  elapsed=${r.elapsedMs} ms`)
    w(`     prompt_eval_count=${r.promptEvalCount}  done_reason=${r.doneReason}`)
    w(`     response="${r.response.slice(0, 120)}"`)
  }

  // Interpretation
  w('\n── Interpretation ───────────────────────────────────────────────')
  const chatTextOk   = rB && !rB.parseError && rB.response.trim().length > 0
  const generateTextOk = rA && !rA.parseError && rA.response.trim().length > 0
  const chatVisionOk = rC && !rC.parseError && rC.response.includes(VISION_TOKEN)
  const genVisionOk  = rD && !rD.parseError && rD.response.includes(VISION_TOKEN)

  if (chatVisionOk && !genVisionOk)
    w('  RESULT: /api/chat vision succeeds, /api/generate fails → use /api/chat for vision')
  else if (chatVisionOk && genVisionOk)
    w('  RESULT: Both endpoints pass vision → earlier smoke format was defective')
  else if ((chatTextOk || generateTextOk) && !chatVisionOk && !genVisionOk)
    w('  RESULT: Text works but vision fails both endpoints → investigate vision projector artifact')
  else if (!chatTextOk && !generateTextOk)
    w('  RESULT: Both text endpoints fail → investigate model/Ollama compatibility or damaged model')
  if (rC2 && rC2.response.includes(VISION_TOKEN) && !chatVisionOk)
    w('  RESULT: temperature:0.2 unblocked vision → use smallest proven nonzero value')
  if (rA2 && rA2.response.trim().length > 0 && !generateTextOk)
    w('  RESULT: temperature:0.2 unblocked text generation')

  // Cleanup
  try {
    for (const f of fs.readdirSync(TMP)) fs.unlinkSync(path.join(TMP, f))
    fs.rmdirSync(TMP)
  } catch {}

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  w(`\nResults written to ${OUT}`)
}

run().catch(err => {
  w(`\nFATAL: ${err.message}\n${err.stack}`)
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  process.exit(1)
})
