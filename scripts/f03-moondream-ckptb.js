const http = require('http')
const MODEL = 'moondream-nostop'
const TEXT_PROMPT = 'Reply with exactly TEXT_OK_9137'

function post(apiPath, bodyObj) {
  return new Promise(resolve => {
    const body = JSON.stringify(bodyObj)
    const t0 = Date.now()
    const req = http.request({
      hostname: 'localhost', port: 11434, path: apiPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
    }, res => {
      let raw = ''
      res.on('data', c => raw += c)
      res.on('end', () => {
        try { resolve({ j: JSON.parse(raw), raw, elapsed: Date.now() - t0 }) }
        catch(e) { resolve({ parseError: e.message, raw, elapsed: Date.now() - t0 }) }
      })
    })
    req.on('error', e => resolve({ parseError: e.message, elapsed: Date.now() - t0 }))
    req.on('timeout', () => { req.destroy(); resolve({ parseError: 'timeout', elapsed: Date.now() - t0 }) })
    req.write(body); req.end()
  })
}

async function main() {
  console.log('=== Checkpoint B: moondream-nostop text-only smoke ===')
  console.log('Model:', MODEL)
  console.log('Prompt:', TEXT_PROMPT)

  console.log('\n--- A: /api/generate text ---')
  const rA = await post('/api/generate', { model: MODEL, prompt: TEXT_PROMPT, stream: false })
  if (rA.parseError) {
    console.log('PARSE ERROR:', rA.parseError)
    console.log('Raw:', rA.raw)
  } else {
    const j = rA.j
    console.log('response:', JSON.stringify(j.response ?? ''))
    console.log('response length:', (j.response ?? '').length)
    console.log('done_reason:', j.done_reason)
    console.log('prompt_eval_count:', j.prompt_eval_count)
    console.log('eval_count:', j.eval_count)
    console.log('load ms:', Math.round((j.load_duration ?? 0) / 1e6))
    console.log('prompt_eval ms:', Math.round((j.prompt_eval_duration ?? 0) / 1e6))
    console.log('eval ms:', Math.round((j.eval_duration ?? 0) / 1e6))
    console.log('total ms:', Math.round((j.total_duration ?? 0) / 1e6))
    console.log('wall elapsed ms:', rA.elapsed)
    console.log('raw JSON (first 500):', rA.raw.slice(0, 500))
  }

  console.log('\n--- B: /api/chat text ---')
  const rB = await post('/api/chat', { model: MODEL, messages: [{ role: 'user', content: TEXT_PROMPT }], stream: false })
  if (rB.parseError) {
    console.log('PARSE ERROR:', rB.parseError)
    console.log('Raw:', rB.raw)
  } else {
    const j = rB.j
    const content = j.message?.content ?? ''
    console.log('message.content:', JSON.stringify(content))
    console.log('content length:', content.length)
    console.log('done_reason:', j.done_reason)
    console.log('prompt_eval_count:', j.prompt_eval_count)
    console.log('eval_count:', j.eval_count)
    console.log('load ms:', Math.round((j.load_duration ?? 0) / 1e6))
    console.log('prompt_eval ms:', Math.round((j.prompt_eval_duration ?? 0) / 1e6))
    console.log('eval ms:', Math.round((j.eval_duration ?? 0) / 1e6))
    console.log('total ms:', Math.round((j.total_duration ?? 0) / 1e6))
    console.log('wall elapsed ms:', rB.elapsed)
    console.log('raw JSON (first 500):', rB.raw.slice(0, 500))
  }
}

main().catch(e => console.error('FATAL:', e.message))
