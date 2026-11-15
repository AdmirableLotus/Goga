import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The chat-authorized probe path: the user approves one exact target in chat (the tool is
 * `critical`, so that approval is forced), and the tool mints a single-use grant for exactly
 * that GET. This exercises the chain that path composes — scope default-deny, the forbidden-host
 * rule and the single-use grant — through the real store and probe code, with an injected fetch
 * so nothing reaches the network.
 */

const tmp = path.join(os.tmpdir(), `goga-probe-test-${process.pid}`)

beforeAll(() => {
  fs.mkdirSync(tmp, { recursive: true })
  vi.doMock('electron', () => ({
    app: { getPath: () => tmp },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s, 'utf8'), decryptString: (b: Buffer) => b.toString('utf8') },
  }))
})

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

function fakeHttp(calls: string[]): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url))
    return {
      status: 200,
      headers: { get: (n: string) => (({ 'content-type': 'text/html', server: 'nginx' }) as Record<string, string>)[n.toLowerCase()] ?? null },
      arrayBuffer: async () => new TextEncoder().encode('<html>hello goga7f3a91 world</html>').buffer,
    } as unknown as Response
  }) as unknown as typeof fetch
}

describe('chat-authorized probe', () => {
  it('enforces scope, the forbidden-host rule and single use', async () => {
    const { addProgram, setActiveProgram, issueGrant } = await import('../security/store')
    const { probe } = await import('../security/probe')

    const program = addProgram({
      source: 'hackerone', handle: 'acme', name: 'Acme', url: 'https://hackerone.com/acme',
      policy: '', submissionState: 'open', offersBounties: true,
      assets: [{ identifier: '*.acme.example', assetType: 'URL', eligibleForSubmission: true, eligibleForBounty: true, maxSeverity: 'critical', instruction: null }],
      exclusions: [], skipped: [], notes: '',
    })
    setActiveProgram(program.id)

    // In scope: a grant issued for this exact GET lets the one request through.
    const inScope = 'https://shop.acme.example/search?q=goga7f3a91'
    const calls: string[] = []
    const http = fakeHttp(calls)
    const grant = issueGrant(inScope, 'GET')
    const ok = await probe({ target: inScope, grantId: grant }, http)
    expect(ok.ok).toBe(true)
    expect(ok.status).toBe(200)
    expect(ok.headers['content-type']).toBe('text/html')
    expect(ok.bodyExcerpt).toContain('goga7f3a91')
    expect(calls).toEqual([inScope])

    // The grant is single-use: the same one cannot send a second request.
    const reused = await probe({ target: inScope, grantId: grant }, http)
    expect(reused.ok).toBe(false)
    expect(reused.blockedReason).toMatch(/already been used/)
    expect(calls).toEqual([inScope])

    // Out of scope: refused before anything is sent, even with a fresh grant for it.
    const outScope = 'https://evil.example/'
    const g2 = issueGrant(outScope, 'GET')
    const refused = await probe({ target: outScope, grantId: g2 }, http)
    expect(refused.ok).toBe(false)
    expect(refused.blockedReason).toMatch(/out of scope/)
    expect(calls).toEqual([inScope])

    // A private/metadata address is refused regardless of scope or grant.
    const forbidden = await probe({ target: 'https://127.0.0.1/admin', grantId: issueGrant('https://127.0.0.1/admin', 'GET') }, http)
    expect(forbidden.ok).toBe(false)
    expect(calls).toEqual([inScope])
  })
})
