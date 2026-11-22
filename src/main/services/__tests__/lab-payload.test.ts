import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Payload dispatch, tested without a socket, a spawn or a network.
 *
 * Four things are held here, and each is a way the feature could be wrong while looking right:
 *
 *   1. an undeclared host is refused **before any request object exists**, and the refusal names
 *      the host;
 *   2. a dispatch with no approval is refused, and a dispatch whose proposal changed after
 *      approval is refused;
 *   3. an echoed payload is recorded as an observation — never promoted to a finding, and never
 *      described as execution just because the bytes came back;
 *   4. loopback is the only thing the "local lab" exception admits.
 */

const tmp = path.join(os.tmpdir(), `goga-payload-${process.pid}`)

beforeAll(() => {
  fs.mkdirSync(tmp, { recursive: true })
  vi.doMock('electron', () => ({
    app: { getPath: () => tmp },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s, 'utf8'), decryptString: (b: Buffer) => b.toString('utf8') },
  }))
})

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

beforeEach(() => {
  try { fs.rmSync(path.join(tmp, 'goga-lab-targets.json')) } catch { /* fresh */ }
  try { fs.rmSync(path.join(tmp, 'goga-security.json')) } catch { /* fresh */ }
})

describe('the host gate refuses an undeclared target before anything starts', () => {
  it('refuses a public host with no declaration, and names the host', async () => {
    const { checkPayloadTarget } = await import('../lab/payload')
    const r = checkPayloadTarget('https://shop.example.com/search?q=x')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('shop.example.com')
    expect(r.reason).toMatch(/not covered/i)
  })

  it('refuses to even prepare a payload for an undeclared host', async () => {
    const { preparePayload } = await import('../lab/payload')
    const r = preparePayload({
      urlTemplate: 'https://shop.example.com/s?q={payload}',
      payload: '<img src=x onerror="document.title=\'nope\'">',
      marker: 'gogaundeclared',
    })
    expect(r.ok).toBe(false)
    expect(r.proposal).toBeNull()
    expect(r.message).toContain('shop.example.com')
  })

  it('allows loopback without a declaration, and nothing else', async () => {
    const { checkPayloadTarget, isLoopbackHost } = await import('../lab/payload')
    expect(checkPayloadTarget('http://127.0.0.1:8080/sink?v=a').allowed).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('192.168.56.10')).toBe(false)
    // A host that merely looks local is not loopback.
    expect(checkPayloadTarget('http://127.0.0.1.example.com/').allowed).toBe(false)
  })

  it('allows a host that is declared, and still refuses metadata', async () => {
    const { declareTarget } = await import('../lab/targets')
    const { checkPayloadTarget } = await import('../lab/payload')
    const declared = declareTarget({ host: 'lab.example.test', kind: 'own-server', note: 'my own test box in the lab' })
    expect(declared.ok).toBe(true)
    expect(checkPayloadTarget('http://lab.example.test/sink?v=a').allowed).toBe(true)

    const meta = declareTarget({ host: '169.254.169.254', kind: 'own-server', note: 'i think this is mine perhaps' })
    expect(meta.ok).toBe(false)
    expect(checkPayloadTarget('http://169.254.169.254/latest/meta-data/').allowed).toBe(false)
  })

  it('is refused by labRequest itself too, so a caller cannot bypass the gate', async () => {
    const { labRequest } = await import('../lab/http')
    const { Budget } = await import('../lab/runner')
    let called = false
    const fakeFetch = (async () => { called = true; return new Response('ok') }) as unknown as typeof fetch
    const res = await labRequest({ url: 'https://undeclared.example.com/', budget: new Budget({ maxRequests: 1 }), }, fakeFetch)
    expect(res.ok).toBe(false)
    expect(res.undeclared).toBe(true)
    expect(res.refusedReason).toContain('undeclared.example.com')
    expect(called).toBe(false)   // no request was ever constructed
  })
})

describe('a dispatch refuses without its own approval', () => {
  it('refuses to send a proposal that was never approved, and sends nothing', async () => {
    const { preparePayload, dispatchPayload } = await import('../lab/payload')
    const prepared = preparePayload({
      urlTemplate: 'http://127.0.0.1:1/sink?v={payload}',
      payload: '<img src=x onerror="document.title=\'goga1\'">',
      marker: 'goga1',
    })
    expect(prepared.ok).toBe(true)
    const result = await dispatchPayload(prepared.proposal!.id)
    expect(result.status).toBeNull()
    expect(result.bytes).toBe(0)
    expect(result.reflection.found).toBe(false)
    expect(result.caveat).toMatch(/not been approved/i)
  })

  it('refuses a proposal whose URL changed after approval', async () => {
    const { preparePayload, decidePayload, dispatchPayload } = await import('../lab/payload')
    const prepared = preparePayload({
      urlTemplate: 'http://127.0.0.1:1/sink?v={payload}',
      payload: '<img src=x onerror="document.title=\'goga2\'">',
      marker: 'goga2',
    })
    const id = prepared.proposal!.id
    expect(decidePayload(id, true).ok).toBe(true)
    // Mutate the thing that was approved. The gate's fingerprint no longer matches.
    prepared.proposal!.url = 'http://127.0.0.1:1/sink?v=CLEAN'
    const result = await dispatchPayload(id)
    expect(result.status).toBeNull()
    expect(result.bytes).toBe(0)
    expect(result.caveat).toMatch(/changed/i)
  })

  it('refuses an unknown proposal id outright', async () => {
    const { dispatchPayload } = await import('../lab/payload')
    const result = await dispatchPayload('not-a-real-id')
    expect(result.status).toBeNull()
    expect(result.caveat).toMatch(/not a payload Goga is holding/i)
  })
})

describe('an echoed payload is an observation, never an execution claim', () => {
  it('records escaped reflection as reflected, not unescaped, and never as confirmed', async () => {
    const { observePayloadResponse } = await import('../lab/payload')
    const payload = '<img src=x onerror="document.title=\'goga3\'">'
    const escaped = '&lt;img src=x onerror=&quot;document.title=&#039;goga3&#039;&quot;&gt;'
    const obs = observePayloadResponse(`<div>You searched for: ${escaped}</div>`, payload, 'goga3')
    expect(obs.found).toBe(true)          // the value came back
    expect(obs.unescaped).toBe(false)     // but not as markup
    expect(obs.context).toBeTruthy()
  })

  it('records live markup as unescaped — still an observation, still not a finding', async () => {
    const { observePayloadResponse } = await import('../lab/payload')
    const payload = '<img src=x onerror="document.title=\'goga4\'">'
    const obs = observePayloadResponse(`<div>You searched for: ${payload}</div>`, payload, 'goga4')
    expect(obs.found).toBe(true)
    expect(obs.unescaped).toBe(true)
    expect(obs.context).toMatch(/element text/i)
  })

  it('says so plainly when the payload did not come back at all', async () => {
    const { observePayloadResponse } = await import('../lab/payload')
    const obs = observePayloadResponse('<div>nothing here</div>', '<img src=x onerror="alert(1)">', 'goga5')
    expect(obs.found).toBe(false)
    expect(obs.unescaped).toBe(false)
    expect(obs.context).toBeNull()
  })

  it('a successful dispatch reports confidence observation and an explicit caveat', async () => {
    // A real local HTTP server, so this exercises the actual send path rather than a fake.
    const http = await import('http')
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      const v = u.searchParams.get('v') ?? ''
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      // Unescaped reflection, the vulnerable case.
      res.end(`<html><body><div>You searched for: ${v}</div></body></html>`)
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      const { preparePayload, decidePayload, dispatchPayload } = await import('../lab/payload')
      const payload = '<img src=x onerror="document.title=\'goga6\'">'
      const prepared = preparePayload({
        urlTemplate: `http://127.0.0.1:${port}/sink?v={payload}`,
        payload,
        marker: 'goga6',
      })
      expect(prepared.ok).toBe(true)
      expect(decidePayload(prepared.proposal!.id, true).ok).toBe(true)
      const result = await dispatchPayload(prepared.proposal!.id)
      expect(result.status).toBe(200)
      expect(result.reflection.found).toBe(true)
      expect(result.unescaped).toBe(true)
      expect(result.confidence).toBe('observation')
      expect(result.caveat).toMatch(/not a finding|not a fi/i)
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })
})
