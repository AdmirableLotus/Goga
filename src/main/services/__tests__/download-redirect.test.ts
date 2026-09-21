/**
 * download-redirect.test.ts
 *
 * Tests for ModelManager.downloadFile() redirect handling.
 * Uses the REAL ModelManager with an injected HTTP transport so zero real
 * network traffic is generated and https.get is never spied on directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { EventEmitter } from 'events'

vi.mock('electron', () => ({
  app: { getPath: () => '/fake/userData' },
}))

import { ModelManager } from '../../services/modelManager'

// ── Fake response / transport helpers ────────────────────────────────────────

type FakeRes = EventEmitter & {
  statusCode: number
  headers: Record<string, string>
  resume: () => void
  pipe: (dest: NodeJS.WritableStream) => NodeJS.WritableStream
}

function makeFakeRes(
  statusCode: number,
  headers: Record<string, string>,
  body?: Buffer
): FakeRes {
  const em = new EventEmitter() as FakeRes
  em.statusCode = statusCode
  em.headers = headers
  em.resume = () => {}
  em.pipe = (dest: NodeJS.WritableStream) => {
    setImmediate(() => {
      if (body) dest.write(body)
      dest.end()
    })
    return dest
  }
  return em
}

// Build a fake https.get-compatible function that serves responses in sequence.
type HttpGetFn = typeof import('https').get
function makeTransport(responses: FakeRes[]): HttpGetFn {
  let call = 0
  return ((_url: unknown, _optsOrCb: unknown, _cb?: unknown) => {
    const cb = (typeof _optsOrCb === 'function' ? _optsOrCb : _cb) as (r: FakeRes) => void
    const res = responses[Math.min(call++, responses.length - 1)]
    setImmediate(() => cb(res))
    const req = Object.assign(new EventEmitter(), { destroy: () => {} })
    return req
  }) as unknown as HttpGetFn
}

// Access the private downloadFile via cast — TypeScript private is compile-time only.
type DlFn = (
  url: string,
  dest: string,
  onReceived: (n: number) => void,
  httpGet: HttpGetFn
) => Promise<void>

function dlWith(mgr: ModelManager, transport: HttpGetFn) {
  return (url: string, dest: string) =>
    (mgr as unknown as { downloadFile: DlFn }).downloadFile(url, dest, () => {}, transport)
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('ModelManager.downloadFile redirect safety', () => {
  let tmpDir: string
  let mgr: ModelManager

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-dl-test-'))
    ;(ModelManager as unknown as { instance: undefined }).instance = undefined
    mgr = ModelManager.getInstance(tmpDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { }
  })

  // T1. 307 redirect followed — final file content saved, not redirect body
  it('follows 307 and saves the final response body, not the redirect body', async () => {
    const dest = path.join(tmpDir, 'out.json')
    const fileBytes = Buffer.from('{"model_type":"style_text_to_speech_2"}')

    const transport = makeTransport([
      makeFakeRes(307, { location: 'https://huggingface.co/final' }),
      makeFakeRes(200, {}, fileBytes),
    ])

    await dlWith(mgr, transport)('https://huggingface.co/start', dest)

    expect(fs.readFileSync(dest)).toEqual(fileBytes)
  })

  // T2. 308 redirect followed correctly
  it('follows 308 redirect to final 200', async () => {
    const dest = path.join(tmpDir, 'out308.bin')
    const fileBytes = Buffer.from('real-content')

    const transport = makeTransport([
      makeFakeRes(308, { location: 'https://huggingface.co/new-permanent' }),
      makeFakeRes(200, {}, fileBytes),
    ])

    await dlWith(mgr, transport)('https://huggingface.co/start', dest)

    expect(fs.readFileSync(dest)).toEqual(fileBytes)
  })

  // T3. 307 with missing Location header — rejects, nothing written to disk
  it('307 with no Location header rejects without saving anything', async () => {
    const dest = path.join(tmpDir, 'out-no-loc.bin')
    const transport = makeTransport([makeFakeRes(307, {})])

    await expect(
      dlWith(mgr, transport)('https://huggingface.co/start', dest)
    ).rejects.toThrow(/no Location header/)

    expect(fs.existsSync(dest)).toBe(false)
  })

  // T4. Redirect to http:// (non-HTTPS) is rejected
  it('redirect to http:// URL is rejected', async () => {
    const dest = path.join(tmpDir, 'out-http.bin')
    const transport = makeTransport([makeFakeRes(302, { location: 'http://evil.com/file' })])

    await expect(
      dlWith(mgr, transport)('https://huggingface.co/start', dest)
    ).rejects.toThrow(/non-HTTPS/)

    expect(fs.existsSync(dest)).toBe(false)
  })

  // T5. Redirect to disallowed HTTPS host is rejected
  it('redirect to untrusted HTTPS host is rejected', async () => {
    const dest = path.join(tmpDir, 'out-untrusted.bin')
    const transport = makeTransport([makeFakeRes(301, { location: 'https://evil.example.com/file' })])

    await expect(
      dlWith(mgr, transport)('https://huggingface.co/start', dest)
    ).rejects.toThrow(/untrusted host/)

    expect(fs.existsSync(dest)).toBe(false)
  })

  // T6. More than 5 redirects triggers loop guard
  it('more than 5 redirects rejects with Too many redirects', async () => {
    const dest = path.join(tmpDir, 'out-loop.bin')
    const loopRes = makeFakeRes(307, { location: 'https://huggingface.co/loop' })
    const transport = makeTransport(Array(10).fill(loopRes))

    await expect(
      dlWith(mgr, transport)('https://huggingface.co/start', dest)
    ).rejects.toThrow(/Too many redirects/)
  })

  // T7. Unsupported 3xx (303) is rejected — body never saved
  it('unsupported 3xx status is rejected without saving body', async () => {
    const dest = path.join(tmpDir, 'out-303.bin')
    const transport = makeTransport([makeFakeRes(303, { location: 'https://huggingface.co/other' })])

    await expect(
      dlWith(mgr, transport)('https://huggingface.co/start', dest)
    ).rejects.toThrow(/Unsupported redirect HTTP 303/)

    expect(fs.existsSync(dest)).toBe(false)
  })

  // T8. 307 body bytes are never piped to the destination file
  it('307 redirect body is never written to the destination file', async () => {
    const dest = path.join(tmpDir, 'out-body-check.bin')
    let pipeCalled = false
    const res307 = makeFakeRes(307, {})
    res307.pipe = () => { pipeCalled = true; return {} as NodeJS.WritableStream }
    const transport = makeTransport([res307])

    await expect(
      dlWith(mgr, transport)('https://huggingface.co/start', dest)
    ).rejects.toThrow()

    expect(pipeCalled).toBe(false)
    expect(fs.existsSync(dest)).toBe(false)
  })
})
