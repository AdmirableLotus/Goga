import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteLink, isPrivateAddress } from '../remoteLink'

let link: RemoteLink | undefined
afterEach(async () => { await link?.stop(); link = undefined })

async function startLink(overrides: Partial<ConstructorParameters<typeof RemoteLink>[0]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-remote-'))
  const deps = {
    devicesFile: path.join(dir, 'remote-devices.json'),
    processText: vi.fn(async (text: string) => `You said: ${text}`),
    transcribe: vi.fn(async () => 'what time is it'),
    speak: vi.fn(async (_text: string, out: string) => { fs.writeFileSync(out, 'RIFFfakewav') }),
    stop: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
    tmpDir: dir,
    ...overrides,
  }
  link = new RemoteLink(deps)
  await link.start(0)
  const base = `http://127.0.0.1:${link.port}`
  return { deps, base, dir }
}

const json = (body: object, key?: string) => ({
  method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
})

async function pair(base: string) {
  const code = link!.startPairing()
  const r = await fetch(`${base}/v1/pair`, json({ code, name: 'Rabbit R1' }))
  return (await r.json()) as { key: string; deviceId: string }
}

describe('isPrivateAddress', () => {
  it('accepts home-network and loopback addresses only', () => {
    for (const a of ['192.168.1.20', '10.0.0.5', '172.16.4.1', '172.31.255.1', '127.0.0.1', '::1', '::ffff:192.168.0.9', 'fe80::1', 'fd12:3456::1'])
      expect(isPrivateAddress(a), a).toBe(true)
    for (const a of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '::ffff:1.2.3.4', '2001:db8::1', '', undefined])
      expect(isPrivateAddress(a), String(a)).toBe(false)
  })
})

describe('RemoteLink', () => {
  it('refuses everything until a device pairs with the code from Settings', async () => {
    const { base, deps } = await startLink()
    expect((await fetch(`${base}/v1/hello`)).status).toBe(401)
    expect((await fetch(`${base}/v1/pair`, json({ code: '123456' }))).status).toBe(403)   // pairing not open

    const { key } = await pair(base)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    const hello = await fetch(`${base}/v1/hello`, { headers: { Authorization: `Bearer ${key}` } })
    expect(await hello.json()).toEqual({ name: 'Goga', device: 'Rabbit R1' })

    // Only the key's hash is stored on the PC.
    const stored = fs.readFileSync(deps.devicesFile, 'utf8')
    expect(stored).not.toContain(key)
    expect(link!.listDevices()).toEqual([expect.objectContaining({ name: 'Rabbit R1' })])
    expect(JSON.stringify(link!.listDevices())).not.toContain('keyHash')
  })

  it('closes pairing after one use, after 5 wrong codes, and when the code expires', async () => {
    const { base } = await startLink()
    const code = link!.startPairing()
    for (let i = 0; i < 5; i++) await fetch(`${base}/v1/pair`, json({ code: code === '000000' ? '111111' : '000000' }))
    expect((await fetch(`${base}/v1/pair`, json({ code }))).status).toBe(403)

    await pair(base)
    const reused = link!.startPairing()
    await fetch(`${base}/v1/pair`, json({ code: reused }))
    expect((await fetch(`${base}/v1/pair`, json({ code: reused }))).status).toBe(403)

    const old = link!.startPairing(Date.now() - 6 * 60_000)
    expect((await fetch(`${base}/v1/pair`, json({ code: old }))).status).toBe(403)
  })

  it('answers a voice clip with the transcript, the reply and spoken audio', async () => {
    const { base, deps } = await startLink()
    const { key } = await pair(base)
    const r = await fetch(`${base}/v1/voice`, { method: 'POST', body: Buffer.alloc(4000), headers: { Authorization: `Bearer ${key}` } })
    const body = await r.json()
    expect(body.transcript).toBe('what time is it')
    expect(body.reply).toBe('You said: what time is it')
    expect(Buffer.from(body.audio, 'base64').toString()).toBe('RIFFfakewav')
    expect(deps.transcribe).toHaveBeenCalledOnce()
    // Temporary audio files are cleaned up.
    await vi.waitFor(() => expect(fs.readdirSync(path.dirname(deps.devicesFile)).filter(f => f.endsWith('.wav'))).toEqual([]))
  })

  it('still replies in text when no voice is available, and delivers finished tasks later', async () => {
    let finish!: (reply: string) => void
    const { base } = await startLink({
      speak: vi.fn(async () => { throw new Error('Kokoro missing') }),
      processText: vi.fn(async (_t: string, completed: (r: string) => void) => { finish = completed; return 'On it.' }),
    })
    const { key } = await pair(base)
    const r = await fetch(`${base}/v1/message`, json({ text: 'clean my downloads', voice: true }, key))
    expect(await r.json()).toEqual({ reply: 'On it.' })
    finish('Done: 12 files moved.')
    const updates = await (await fetch(`${base}/v1/updates?after=0`, { headers: { Authorization: `Bearer ${key}` } })).json()
    expect(updates.messages.map((m: { text: string }) => m.text)).toEqual(['Done: 12 files moved.'])
  })

  it('forgets a device, and rejects oversized uploads', async () => {
    const { base } = await startLink()
    const { key, deviceId } = await pair(base)
    const big = await fetch(`${base}/v1/message`, json({ text: 'x'.repeat(70_000) }, key)).catch(() => null)
    expect(big === null || big.status === 413).toBe(true)
    link!.forget(deviceId)
    expect((await fetch(`${base}/v1/hello`, { headers: { Authorization: `Bearer ${key}` } })).status).toBe(401)
  })
})
