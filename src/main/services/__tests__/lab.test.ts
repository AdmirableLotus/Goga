import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeclaredTarget } from '../../../shared/lab'

/**
 * The Lab's safety boundary, tested without a socket or a spawned process.
 *
 * The one rule the whole feature rests on is in `checkAgainst`: an active tool runs only
 * against a host a live declaration covers, cloud metadata is never coverable, a revoked
 * declaration covers nothing, and a port outside the declared range is refused. Those are pure
 * and tested directly. The declare → prepare-spray path is tested through the real store with a
 * temp userData dir, proving a spray cannot even be *proposed* for an undeclared host.
 */

const tmp = path.join(os.tmpdir(), `goga-lab-test-${process.pid}`)

beforeAll(() => {
  fs.mkdirSync(tmp, { recursive: true })
  vi.doMock('electron', () => ({
    app: { getPath: () => tmp },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s, 'utf8'), decryptString: (b: Buffer) => b.toString('utf8') },
  }))
})

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

function target(over: Partial<DeclaredTarget> = {}): DeclaredTarget {
  return {
    id: 't1', host: 'lab.example.test', ports: '', kind: 'own-server',
    note: 'my own test box', declaredAt: new Date().toISOString(), revokedAt: null, revokedReason: null,
    ...over,
  }
}

describe('the declaration gate (pure)', () => {
  it('refuses a host with no live declaration', async () => {
    const { checkAgainst } = await import('../lab/targets')
    const r = checkAgainst([], 'lab.example.test')
    expect(r.declared).toBe(false)
    expect(r.reason).toMatch(/no target is declared/i)
  })

  it('allows a host an exact declaration covers', async () => {
    const { checkAgainst } = await import('../lab/targets')
    const r = checkAgainst([target()], 'lab.example.test')
    expect(r.declared).toBe(true)
    expect(r.target?.host).toBe('lab.example.test')
  })

  it('allows an address inside a declared CIDR block', async () => {
    const { checkAgainst } = await import('../lab/targets')
    const r = checkAgainst([target({ host: '192.168.56.0/24' })], '192.168.56.10')
    expect(r.declared).toBe(true)
  })

  it('refuses an address outside a declared CIDR block', async () => {
    const { checkAgainst } = await import('../lab/targets')
    const r = checkAgainst([target({ host: '192.168.56.0/24' })], '192.168.99.10')
    expect(r.declared).toBe(false)
  })

  it('refuses a port outside the declaration\'s range', async () => {
    const { checkAgainst } = await import('../lab/targets')
    const t = target({ ports: '80,443' })
    expect(checkAgainst([t], 'lab.example.test', 443).declared).toBe(true)
    const refused = checkAgainst([t], 'lab.example.test', 8080)
    expect(refused.declared).toBe(false)
    expect(refused.reason).toMatch(/outside the ports/i)
  })

  it('refuses cloud metadata even when it is declared', async () => {
    const { checkAgainst } = await import('../lab/targets')
    const r = checkAgainst([target({ host: '169.254.169.254' })], '169.254.169.254')
    expect(r.declared).toBe(false)
    expect(r.reason).toMatch(/metadata/i)
  })

  it('treats a revoked declaration as covering nothing', async () => {
    const { checkAgainst } = await import('../lab/targets')
    const r = checkAgainst([target({ revokedAt: new Date().toISOString() })], 'lab.example.test')
    expect(r.declared).toBe(false)
  })
})

describe('port parsing', () => {
  it('parses lists and ranges and rejects nonsense', async () => {
    const { parsePorts } = await import('../lab/targets')
    expect(parsePorts('80,443,8080').ports).toEqual([80, 443, 8080])
    expect(parsePorts('1-3').ports).toEqual([1, 2, 3])
    expect(parsePorts('').ports).toBeNull() // empty = all ports
    expect(parsePorts('99999').ok).toBe(false)
    expect(parsePorts('abc').ok).toBe(false)
  })
})

describe('declare → spray proposal, through the real store', () => {
  beforeEach(() => { try { fs.rmSync(path.join(tmp, 'goga-lab-targets.json')) } catch { /* fresh */ } })

  it('refuses to even propose a spray for an undeclared target', async () => {
    const { prepareSpray } = await import('../lab/credentials')
    const r = prepareSpray({ targetId: 'nope', url: 'https://lab.example.test/login' })
    expect(r.ok).toBe(false)
    expect(r.proposal).toBeNull()
  })

  it('declares a host, then prepares a spray only for a URL on it', async () => {
    const { declareTarget } = await import('../lab/targets')
    const { prepareSpray } = await import('../lab/credentials')

    const declared = declareTarget({ host: 'lab.example.test', kind: 'own-server', note: 'my own lab vm for testing' })
    expect(declared.ok).toBe(true)
    const id = declared.target!.id

    // A URL off the declared host is refused — nothing is proposed.
    const off = prepareSpray({ targetId: id, url: 'https://not-mine.example/login', usernames: ['admin'], passwords: ['x'] })
    expect(off.ok).toBe(false)

    // A URL on the declared host produces a proposal that sends nothing yet.
    const on = prepareSpray({ targetId: id, url: 'https://lab.example.test/login', usernames: ['admin', 'root'], passwords: ['a', 'b'] })
    expect(on.ok).toBe(true)
    expect(on.proposal?.status).toBe('proposed')
    expect(on.proposal?.approved).toBe(false)
    expect(on.proposal?.totalRequests).toBe(4) // 2 usernames × 2 passwords
  })

  it('approval binds to the exact proposal, and discard removes it', async () => {
    const { declareTarget } = await import('../lab/targets')
    const { prepareSpray, decideSpray } = await import('../lab/credentials')

    const id = declareTarget({ host: 'lab.example.test', kind: 'own-server', note: 'my own lab vm for testing' }).target!.id
    const prepared = prepareSpray({ targetId: id, url: 'https://lab.example.test/login', usernames: ['admin'], passwords: ['a'] })
    const pid = prepared.proposal!.id

    // Discarding is a real, final decision.
    const discarded = decideSpray(pid, false)
    expect(discarded.ok).toBe(true)
    // Once discarded, it cannot be approved.
    expect(decideSpray(pid, true).ok).toBe(false)
  })
})
