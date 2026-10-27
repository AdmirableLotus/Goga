import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'

/**
 * Lets the user's own devices (first the Rabbit R1) talk to Goga over the home network.
 *
 * Security model:
 * - Off unless enabled in Settings; serves only private (home network) addresses.
 * - A device pairs once with a 6-digit code shown in Settings (valid 5 minutes, 5 tries),
 *   and receives a random 32-byte key. Only its SHA-256 is stored on the PC.
 * - Every request carries that key; devices can be forgotten from Settings.
 * - Goga's approvals still apply: risky actions wait for the desktop app, as with Telegram.
 */

export interface RemoteDevice { id: string; name: string; keyHash: string; pairedAt: number; lastSeen?: number }

export interface RemoteLinkDeps {
  devicesFile: string
  /** Same pipeline as Telegram: the reply, plus a later callback when a task finishes. */
  processText: (text: string, completed: (reply: string) => void) => Promise<string>
  transcribe: (wavPath: string) => Promise<string>
  /** Writes the reply as speech to outPath; rejects if no voice is available. */
  speak: (text: string, outPath: string) => Promise<void>
  stop: () => void
  log: { info: (m: string) => void; warn: (m: string) => void }
  tmpDir?: string
}

const MAX_JSON_BYTES = 64 * 1024
const MAX_AUDIO_BYTES = 8 * 1024 * 1024        // ~4 min of 16 kHz mono PCM
const MAX_TEXT_CHARS = 4000
const PAIR_CODE_TTL_MS = 5 * 60_000
const PAIR_MAX_TRIES = 5
const OUTBOX_SIZE = 20

/** Home-network and loopback addresses only (IPv4, IPv4-mapped IPv6, IPv6 link-local/ULA). */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false
  const a = address.replace(/^::ffff:/i, '')
  if (a === '::1') return true
  if (/^(fe8|fe9|fea|feb)[0-9a-f]:/i.test(a) || /^f[cd][0-9a-f]{2}:/i.test(a)) return true
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [o1, o2] = [Number(m[1]), Number(m[2])]
  return o1 === 10 || o1 === 127 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168)
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

/** This PC's addresses on the home network, for showing in Settings. */
export function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal && isPrivateAddress(i.address))
    .map(i => i.address)
}

class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }

export class RemoteLink {
  private server: http.Server | null = null
  private devices: RemoteDevice[] = []
  private pairing: { code: string; expires: number; tries: number } | null = null
  private busy = false
  private outbox: { id: number; text: string; at: number }[] = []
  private nextOutboxId = 1

  constructor(private deps: RemoteLinkDeps) {
    try {
      const saved = JSON.parse(fs.readFileSync(deps.devicesFile, 'utf8'))
      if (Array.isArray(saved)) this.devices = saved.filter(d => typeof d?.keyHash === 'string' && d.keyHash.length === 64)
    } catch { /* no devices yet */ }
  }

  get port(): number | null {
    const a = this.server?.address()
    return a && typeof a === 'object' ? a.port : null
  }

  start(port: number): Promise<void> {
    if (this.server) return Promise.resolve()
    const server = http.createServer((req, res) => { void this.route(req, res) })
    server.requestTimeout = 120_000
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', err => { this.server = null; reject(err) })
      server.listen(port, '0.0.0.0', () => {
        this.deps.log.info(`RemoteLink: listening on port ${this.port} (home network only)`)
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.pairing = null
    if (!server) return Promise.resolve()
    return new Promise(resolve => server.close(() => resolve()))
  }

  startPairing(now = Date.now()): string {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.pairing = { code, expires: now + PAIR_CODE_TTL_MS, tries: 0 }
    return code
  }

  listDevices(): Omit<RemoteDevice, 'keyHash'>[] {
    return this.devices.map(({ keyHash: _k, ...d }) => d)
  }

  forget(id: string): void {
    this.devices = this.devices.filter(d => d.id !== id)
    this.save()
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.deps.devicesFile), { recursive: true })
    fs.writeFileSync(this.deps.devicesFile, JSON.stringify(this.devices, null, 2), { mode: 0o600 })
  }

  private post(text: string): void {
    this.outbox.push({ id: this.nextOutboxId++, text, at: Date.now() })
    if (this.outbox.length > OUTBOX_SIZE) this.outbox.shift()
  }

  private authenticate(req: http.IncomingMessage): RemoteDevice {
    const header = req.headers.authorization ?? ''
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!key) throw new HttpError(401, 'Not paired')
    const given = Buffer.from(hashKey(key), 'hex')
    const device = this.devices.find(d => timingSafeEqual(given, Buffer.from(d.keyHash, 'hex')))
    if (!device) throw new HttpError(401, 'Not paired')
    device.lastSeen = Date.now()
    return device
  }

  private pair(body: { code?: unknown; name?: unknown }): { key: string; deviceId: string } {
    const p = this.pairing
    if (!p || Date.now() > p.expires) throw new HttpError(403, 'Pairing is not open. Press "Pair a device" in Goga Settings.')
    if (typeof body.code !== 'string' || body.code !== p.code) {
      if (++p.tries >= PAIR_MAX_TRIES) this.pairing = null
      throw new HttpError(403, 'Wrong pairing code')
    }
    this.pairing = null
    const key = randomBytes(32).toString('hex')
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 40) : 'Device'
    const device: RemoteDevice = { id: randomBytes(6).toString('hex'), name, keyHash: hashKey(key), pairedAt: Date.now() }
    this.devices.push(device)
    this.save()
    this.deps.log.info(`RemoteLink: paired "${name}"`)
    return { key, deviceId: device.id }
  }

  /** Runs one request at a time: the brain does one job at a time anyway. */
  private async converse(text: string, withVoice: boolean): Promise<{ reply: string; audio?: string }> {
    if (this.busy) throw new HttpError(429, 'Goga is still answering the previous message')
    this.busy = true
    try {
      const reply = await this.deps.processText(text.slice(0, MAX_TEXT_CHARS), later => this.post(later))
      if (!withVoice || !reply.trim()) return { reply }
      const out = path.join(this.deps.tmpDir ?? os.tmpdir(), `goga-remote-${randomBytes(8).toString('hex')}.wav`)
      try {
        await this.deps.speak(reply, out)
        return { reply, audio: fs.readFileSync(out).toString('base64') }
      } catch (err) {
        this.deps.log.warn(`RemoteLink: no voice for reply (${err instanceof Error ? err.message : String(err)})`)
        return { reply }
      } finally {
        fs.rm(out, { force: true }, () => {})
      }
    } finally {
      this.busy = false
    }
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: object) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    try {
      if (!isPrivateAddress(req.socket.remoteAddress)) throw new HttpError(403, 'Home network only')
      const url = new URL(req.url ?? '/', 'http://goga.local')
      const route = `${req.method} ${url.pathname}`

      if (route === 'POST /v1/pair') return send(200, this.pair(JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}')))

      const device = this.authenticate(req)
      switch (route) {
        case 'GET /v1/hello':
          return send(200, { name: 'Goga', device: device.name })
        case 'POST /v1/message': {
          const body = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}')
          if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'text is required')
          return send(200, await this.converse(body.text, body.voice === true))
        }
        case 'POST /v1/voice': {
          const audio = await readBody(req, MAX_AUDIO_BYTES)
          if (audio.length < 1000) throw new HttpError(400, 'audio is too short')
          const wav = path.join(this.deps.tmpDir ?? os.tmpdir(), `goga-remote-in-${randomBytes(8).toString('hex')}.wav`)
          fs.writeFileSync(wav, audio)
          let transcript: string
          try { transcript = (await this.deps.transcribe(wav)).trim() } finally { fs.rm(wav, { force: true }, () => {}) }
          if (!transcript) return send(200, { transcript: '', reply: '' })
          return send(200, { transcript, ...await this.converse(transcript, true) })
        }
        case 'GET /v1/updates': {
          const after = Number(url.searchParams.get('after') ?? 0)
          return send(200, { messages: this.outbox.filter(m => m.id > after) })
        }
        case 'POST /v1/stop':
          this.deps.stop()
          return send(200, { ok: true })
        default:
          throw new HttpError(404, 'Not found')
      }
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message })
      if (err instanceof SyntaxError) return send(400, { error: 'Invalid JSON' })
      this.deps.log.warn(`RemoteLink: request failed (${err instanceof Error ? err.message : String(err)})`)
      send(500, { error: 'Goga could not handle that. Check the desktop app.' })
    }
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) { reject(new HttpError(413, 'Too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
