import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PracticeLab } from '../practiceLab'
import { LabClient, labAccount, labUrl } from '../securityHttp'

let lab: PracticeLab
let base: string

beforeEach(async () => { lab = new PracticeLab(); base = await lab.start(0) })
afterEach(async () => { await lab.stop() })

describe('the practice lab app', () => {
  it('serves each account only its own notes, but leaks any note by id (the planted bug)', async () => {
    const client = new LabClient(lab)
    const aliceList = await client.get('/api/notes', labAccount('alice'))
    expect(aliceList.status).toBe(200)
    expect(aliceList.body).toContain('Groceries')
    expect(aliceList.body).not.toContain('Gym plan')

    // The bug: bob reads alice's private note by its id.
    const leak = await client.get('/api/notes/102', labAccount('bob'))
    expect(leak.status).toBe(200)
    expect(leak.body).toContain('SYNTHETIC-ALICE-SECRET')
  })

  it('protects profiles correctly (the control case)', async () => {
    const client = new LabClient(lab)
    expect((await client.get('/api/profiles/1', labAccount('alice'))).status).toBe(200)
    expect((await client.get('/api/profiles/1', labAccount('bob'))).status).toBe(403)
  })

  it('refuses anyone who is not signed in', async () => {
    const client = new LabClient(lab)
    expect((await client.get('/api/notes/101', null)).status).toBe(401)
  })
})

describe('the verification runner', () => {
  it('supports the notes bug and rejects the protected profile', async () => {
    const client = new LabClient(lab)
    const notes = await client.verifyAccess('/api/notes/102', labAccount('alice')!, labAccount('bob')!)
    expect(notes.supported).toBe(true)
    expect(notes.responses).toHaveLength(4)

    const profile = await client.verifyAccess('/api/profiles/1', labAccount('alice')!, labAccount('bob')!)
    expect(profile.supported).toBe(false)
    expect(profile.reason).toMatch(/refused|access control/i)
  })

  it('does not support a path that returns nothing', async () => {
    const client = new LabClient(lab)
    const missing = await client.verifyAccess('/api/notes/999', labAccount('alice')!, labAccount('bob')!)
    expect(missing.supported).toBe(false)   // 404 for both: no owner resource to protect
  })
})

describe('lab scope', () => {
  it('keeps requests on the lab origin only', () => {
    expect(labUrl(base, '/api/notes/102')?.pathname).toBe('/api/notes/102')
    expect(labUrl(base, `${base}/api/me`)?.pathname).toBe('/api/me')
    for (const off of ['http://127.0.0.1:1/evil', 'http://example.com/x', '//evil.test', 'http://user:pass@127.0.0.1/x'])
      expect(labUrl(base, off)).toBeNull()
  })

  it('reads a test-account name, rejecting anything else', () => {
    expect(labAccount('alice')).toBe('alice')
    expect(labAccount('BOB')).toBe('bob')
    for (const bad of ['root', 'admin', '', 'carol', 42]) expect(labAccount(bad)).toBeNull()
  })
})
