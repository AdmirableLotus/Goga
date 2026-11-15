// Type three real requests into chat and capture what Goga actually did.
//
// These are the requests that used to need a tab. The point is not that a reply appears — it
// is that a tool ran. So each one is checked against the reply text AND against the app's own
// log, which records the tool dispatch.
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')

const repo = path.resolve(__dirname, '..')
const exe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe')
const dataDir = path.join(process.env.TEMP, 'goga-diag-chat-' + Date.now())
const shotDir = path.join(repo, 'shots')
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(shotDir, { recursive: true })

const PORT = 9779
const report = { steps: [], errors: [], requests: [] }

// Settings copy: BOM-free, dangerous switches off, explicit placeholder token.
try {
  const real = path.join(process.env.APPDATA || '', 'goga', 'settings.json')
  let raw = fs.readFileSync(real, 'utf8')
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
  const s = JSON.parse(raw)
  s.telegramBotToken = 'PLACEHOLDER-DIAG-TOKEN-NOT-REAL'
  s.startWithMonitor = false
  s.remoteEnabled = false
  s.guardianEnabled = false
  s.autoTradeEnabled = false
  s.wakeWordEnabled = false
  s.tradeWatchEnabled = false
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(s, null, 2), 'utf8')
  report.steps.push('settings copied BOM-free; switches off; token is the explicit placeholder')
} catch (e) { report.errors.push(`settings: ${e.message}`) }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let b = ''
      res.on('data', d => { b += d })
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function waitForTarget(timeoutMs = 45000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('no CDP page target appeared')
}

function cdp(wsUrl) {
  const WebSocket = require('ws')
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false })
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  })
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  return {
    ready,
    send(method, params = {}) {
      const myId = ++id
      return new Promise((resolve, reject) => {
        pending.set(myId, { resolve, reject })
        ws.send(JSON.stringify({ id: myId, method, params }))
      })
    },
    close() { try { ws.close() } catch {} },
  }
}

async function evaluate(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''))
  return r.result.value
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Send one message through the real composer and wait for the reply to settle. */
async function ask(c, text) {
  const before = await evaluate(c, `document.querySelectorAll('.g-msg, [data-role], .g-bubble').length`)
  const typed = await evaluate(c, `(() => {
    const box = document.querySelector('.g-composer-input, input[type="text"], textarea')
    if (!box) return { ok: false, why: 'no composer input' }
    const proto = box.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(box, ${JSON.stringify(text)})
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: true, value: box.value, tag: box.tagName }
  })()`)
  if (!typed.ok) return { sent: false, why: typed.why }

  await sleep(300)
  const sent = await evaluate(c, `(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /^\\s*send\\s*$/i.test((b.textContent||'').trim()))
    if (btn && !btn.disabled) { btn.click(); return { ok: true, how: 'button' } }
    const box = document.querySelector('.g-composer-input, input[type="text"], textarea')
    if (!box) return { ok: false, why: 'no box' }
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    return { ok: true, how: 'enter' }
  })()`)
  if (!sent.ok) return { sent: false, why: sent.why }

  // Wait for the reply to stop growing.
  let last = '', stable = 0
  for (let i = 0; i < 420; i++) {
    await sleep(1000)
    const now = await evaluate(c, `(() => {
      const main = document.querySelector('main')
      return (main ? main.innerText : '').slice(-4000)
    })()`)
    if (now === last) { stable++; if (stable >= 6) break } else { stable = 0; last = now }
  }
  const after = await evaluate(c, `document.querySelectorAll('.g-msg, [data-role], .g-bubble').length`)
  return { sent: true, how: sent.how, before, after, text: last }
}

async function main() {
  const child = spawn(exe, ['scripts\\diag-main.js', `--remote-debugging-port=${PORT}`], {
    cwd: repo,
    windowsHide: false,
    env: { ...process.env, GOGA_DIAG_USERDATA: dataDir, TELEGRAM_BOT_TOKEN: 'PLACEHOLDER-DIAG-TOKEN-NOT-REAL' },
  })
  let log = ''
  child.stdout.on('data', d => { log += d.toString() })
  child.stderr.on('data', d => { log += d.toString() })

  try {
    const target = await waitForTarget()
    const c = cdp(target.webSocketDebuggerUrl)
    await c.ready
    await c.send('Runtime.enable')
    await c.send('Page.enable')
    for (let i = 0; i < 80; i++) {
      if (await evaluate(c, `!!document.querySelector('.g-composer-input')`).catch(() => false)) break
      await sleep(500)
    }
    await sleep(2000)

    const requests = [
      'is status.coinbase.com in scope for coinbase',
      'open the Cantina bug bounty page and tell me what it says',
      'review wp-includes/class-wp-http.php in the local WordPress copy',
    ]

    for (const text of requests) {
      report.steps.push(`asking: ${text}`)
      const r = await ask(c, text)
      report.requests.push({ request: text, ...r })
      const shot = await c.send('Page.captureScreenshot', { format: 'png' })
      const name = `chat-${report.requests.length}.png`
      fs.writeFileSync(path.join(shotDir, name), Buffer.from(shot.data, 'base64'))
      report.steps.push(`screenshot: ${path.join(shotDir, name)}`)
      await sleep(1500)
    }

    c.close()
  } catch (e) {
    report.errors.push(String((e && e.stack) || e))
  } finally {
    try { child.kill() } catch {}
    fs.writeFileSync(path.join(dataDir, 'chat-report.json'), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(dataDir, 'chat-console.txt'), log)
    console.log(JSON.stringify(report, null, 2))
  }
}

main()
