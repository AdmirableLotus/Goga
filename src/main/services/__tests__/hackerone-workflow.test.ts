import fs from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ dir: '', encryption: true, settings: { autoApproveBelow: 'critical', requireApprovalForAll: false } }))
vi.mock('electron', () => ({ app: { getPath: () => boundary.dir }, safeStorage: {
  isEncryptionAvailable: () => boundary.encryption,
  encryptString: (s: string) => Buffer.from('sealed:' + Buffer.from(s).toString('base64')),
  decryptString: (b: Buffer) => Buffer.from(b.toString().slice(7), 'base64').toString(),
} }))
vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => boundary.settings }) } }))
import { HackerOneService } from '../hackerOne'
import { SecurityWorkspaceService } from '../securityWorkspace'
import { AuthorizationService } from '../authorization'
import { ToolRegistry } from '../../tools/registry'
import { matchesSecurityAsset } from '../securityScope'

const token = 'fake-secret-for-tests'
const scopes = [
  { id: '1', type: 'structured-scope', attributes: { asset_type: 'WILDCARD', asset_identifier: '*.example.test', eligible_for_submission: true, instruction: 'No stress testing' } },
  { id: '2', attributes: { asset_type: 'URL', asset_identifier: 'disabled.example.test', eligible_for_submission: false } },
  { id: '3', attributes: { asset_type: 'URL', asset_identifier: 'missing.example.test' } },
  { id: '4', attributes: { asset_type: 'URL', asset_identifier: 'bounty-only.test', eligible_for_bounty: true } },
]
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
function mockApi() {
  return vi.fn(async (url: URL) => {
    if (url.pathname.endsWith('/structured_scopes')) return json({ data: scopes, links: { next: null } })
    if (url.pathname.endsWith('/scope_exclusions')) return json({ data: [{ attributes: { category: 'DoS', details: 'No denial of service' } }] })
    return json({ data: { id: 'p', attributes: { name: 'Example', policy: 'Only test authorized assets', submission_state: 'open' } } })
  })
}
beforeEach(() => { boundary.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-h1-')); boundary.encryption = true; vi.stubGlobal('fetch', mockApi()) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(boundary.dir, { recursive: true, force: true }) })
async function workspace() {
  const h1 = new HackerOneService(); h1.saveCredentials('tester', token)
  const security = new SecurityWorkspaceService()
  const ws = security.create(await h1.importProgram('example_team'), true)
  security.setActive(ws.id)
  return { h1, security, ws }
}

describe('encrypted HackerOne importer', () => {
  it('uses OS encryption and never returns a token in status', () => {
    const h1 = new HackerOneService(); h1.saveCredentials('tester', token)
    expect(fs.readFileSync(path.join(boundary.dir, 'goga-hackerone-credentials.bin')).toString()).not.toContain(token)
    expect(h1.status()).toEqual({ configured: true, encryptionAvailable: true })
    h1.clearCredentials(); expect(h1.status().configured).toBe(false)
  })
  it('fails closed when OS encryption is unavailable', () => {
    boundary.encryption = false
    expect(() => new HackerOneService().saveCredentials('tester', token)).toThrow('unavailable')
    expect(fs.readdirSync(boundary.dir)).toHaveLength(0)
  })
  it('imports policy, per-asset rules and only explicitly eligible assets with GETs to the official API', async () => {
    const { ws } = await workspace()
    expect(ws.authorizedAssets).toEqual(['*.example.test'])
    expect(ws.hackerOne?.scopes).toHaveLength(4)
    expect(ws.programRules).toContain('Only test authorized assets')
    expect(ws.programRules).toContain('No denial of service')
    expect(ws.findings).toHaveLength(0)
    for (const [url, options] of vi.mocked(fetch).mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://api.hackerone.com')
      expect(options?.method).toBe('GET'); expect(options?.redirect).toBe('manual')
    }
  })
  it('rejects malformed handles before making any request', async () => {
    await expect(new HackerOneService().importProgram('../reports')).rejects.toThrow('handle')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects redirects without contacting the redirect destination', async () => {
    const h1 = new HackerOneService(); h1.saveCredentials('tester', token)
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 302, headers: { Location: 'https://outside.test/' } }))
    await expect(h1.importProgram('example')).rejects.toThrow('redirected')
    expect(vi.mocked(fetch).mock.calls.every(([url]) => new URL(String(url)).origin === 'https://api.hackerone.com')).toBe(true)
  })
  it('sanitizes network errors rather than leaking credentials', async () => {
    const h1 = new HackerOneService(); h1.saveCredentials('tester', token)
    vi.mocked(fetch).mockRejectedValue(new Error('request headers ' + token))
    await expect(h1.importProgram('example')).rejects.toThrow('could not be completed')
    await expect(h1.importProgram('example')).rejects.not.toThrow(token)
  })
  it('rejects oversized streamed responses', async () => {
    const h1 = new HackerOneService(); h1.saveCredentials('tester', token)
    vi.mocked(fetch).mockImplementation(async () => new Response('x'.repeat(1_000_001)))
    await expect(h1.importProgram('example')).rejects.toThrow('size limit')
  })
  it('constructs pagination locally even when next points to an untrusted host', async () => {
    const h1 = new HackerOneService(); h1.saveCredentials('tester', token)
    const api = mockApi()
    vi.mocked(fetch).mockImplementation(async (url: any, options) => {
      if (url.pathname.endsWith('/structured_scopes') && url.searchParams.get('page[number]') === '1') return json({ data: scopes, links: { next: 'https://evil.test/steal' } })
      return api(url)
    })
    await h1.importProgram('example')
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url)).some(url => url.includes('evil.test'))).toBe(false)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => new URL(String(url)).searchParams.get('page[number]') === '2')).toBe(true)
  })
})

describe('default-deny scope and per-action approval', () => {
  it('denies missing, outside, wildcard-apex and explicitly ineligible targets', async () => {
    const { security, ws } = await workspace()
    expect(security.checkScope(ws.id, 'https://api.example.test/').inScope).toBe(true)
    for (const target of ['', 'https://example.test', 'https://example.test.evil.test', 'https://outside.test', 'https://disabled.example.test', 'https://missing.example.test']) expect(security.checkScope(ws.id, target).inScope).toBe(false)
  })
  it('does not widen URL paths or accept malformed CIDRs', () => {
    expect(matchesSecurityAsset('https://example.test/api/v1', 'https://example.test/api')).toBe(true)
    expect(matchesSecurityAsset('https://example.test/apix', 'https://example.test/api')).toBe(false)
    expect(matchesSecurityAsset('https://other.test/api', 'https://example.test/api')).toBe(false)
    expect(matchesSecurityAsset('10.1.2.3', '10.0.0.0/8')).toBe(true)
    expect(matchesSecurityAsset('10.1.2.3', '10.0.0.0/99')).toBe(false)
    expect(matchesSecurityAsset('999.1.2.3', '0.0.0.0/0')).toBe(false)
  })
  it('requires approval even when normal mode auto-approves critical risk and read-only tools', async () => {
    const { security, ws } = await workspace()
    vi.spyOn(SecurityWorkspaceService, 'getInstance').mockReturnValue(security)
    const auth = new AuthorizationService()
    const decision = auth.evaluate({ name: 'web.fetch', riskLevel: 'low' } as any, { url: 'https://api.example.test/' }, { mode: 'security-research', securityWorkspaceId: ws.id })
    expect(decision).toMatchObject({ allowed: true, requiresApproval: true })
    expect(auth.evaluate({ name: 'shell.execute', riskLevel: 'low' } as any, { target: 'api.example.test', command: 'scan outside.test' }, { mode: 'security-research', securityWorkspaceId: ws.id }).allowed).toBe(false)
  })
  it('blocks dispatch without approval, enforces one-use grants and blocks reuse on another target', async () => {
    const { security, ws } = await workspace()
    const registry = new ToolRegistry(), execute = vi.fn().mockResolvedValue({ success: true })
    registry.register({ name: 'web.fetch' } as any, execute)
    registry.setSecurityBoundary((name, params, ctx) => security.enforceDispatch(name, params, ctx.securityWorkspaceId, ctx.securityApproval))
    const params = { url: 'https://api.example.test/' }, context = { abortSignal: new AbortController().signal, securityWorkspaceId: ws.id }
    expect((await registry.execute('web.fetch', params, context)).success).toBe(false)
    const ticket = security.issueApproval(ws.id, 'web.fetch', params)
    expect((await registry.execute('web.fetch', params, { ...context, securityApproval: ticket })).success).toBe(true)
    expect((await registry.execute('web.fetch', params, { ...context, securityApproval: ticket })).success).toBe(false)
    const wrong = security.issueApproval(ws.id, 'web.fetch', params)
    expect((await registry.execute('web.fetch', { url: 'https://other.example.test/' }, { ...context, securityApproval: wrong })).success).toBe(false)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(security.get(ws.id)?.auditLog.some(a => a.result.includes('blocked'))).toBe(true)
  })
  it('revokes approval on emergency Stop and scope deactivation', async () => {
    const { security, ws } = await workspace()
    const params = { url: 'https://api.example.test/' }
    const ticket = security.issueApproval(ws.id, 'web.fetch', params)
    security.invalidateApprovals()
    expect(security.enforceDispatch('web.fetch', params, ws.id, ticket)).not.toBeNull()
    const next = security.issueApproval(ws.id, 'web.fetch', params)
    security.setActive(null)
    expect(security.enforceDispatch('web.fetch', params, ws.id, next)).not.toBeNull()
  })
  it('does not allow manual widening of imported authority and always saves local drafts', async () => {
    const { security, ws } = await workspace()
    expect(() => security.update(ws.id, { authorizedAssets: ['*'] })).toThrow('cannot be overwritten')
    expect(() => security.update(ws.id, { hackerOne: { ...ws.hackerOne!, submissionState: 'open', scopes: [] } })).toThrow()
    const finding = security.addFinding(ws.id, { title: 'Local report', target: '', severity: 'info', description: 'Draft only', steps: '', evidenceIds: [], status: 'submitted' })
    expect(finding.status).toBe('draft')
    expect(() => security.create({ ...ws })).toThrow('official API')
  })
})
