import fs from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => boundary.dir }, safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from('sealed:' + Buffer.from(s).toString('base64')),
  decryptString: (b: Buffer) => Buffer.from(b.toString().slice(7), 'base64').toString(),
} }))
vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => ({ autoApproveBelow: 'critical', requireApprovalForAll: false }) }) } }))
import { HackerOneService } from '../hackerOne'
import { SecurityWorkspaceService } from '../securityWorkspace'
import { AuthorizationService } from '../authorization'
import { SecurityCodeService, githubRepo, insideRepo, repoFolder } from '../securityCode'
import { looksLikeAgentTask, plannerOffers } from '../agentRouting'
import { codeRoot, groundSecurityReply, unknownNames } from '../securityGrounding'

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
const scopes = [
  { id: '1', attributes: { asset_type: 'SOURCE_CODE', asset_identifier: 'https://github.com/omacom/omarchy', eligible_for_submission: true } },
  { id: '2', attributes: { asset_type: 'SOURCE_CODE', asset_identifier: 'https://github.com/omacom/old', eligible_for_submission: false } },
]
beforeEach(() => {
  boundary.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-code-'))
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
    if (url.pathname.endsWith('/structured_scopes')) return json({ data: scopes, links: { next: null } })
    if (url.pathname.endsWith('/scope_exclusions')) return json({ data: [] })
    return json({ id: 9, type: 'program', attributes: { name: 'Omarchy', policy: 'Only the repository', submission_state: 'open' } })
  }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(boundary.dir, { recursive: true, force: true }) })

async function workspace(reviewed = true) {
  const h1 = new HackerOneService(); h1.saveCredentials('tester', 'fake-token')
  const security = new SecurityWorkspaceService()
  const ws = security.create(await h1.importProgram('omarchy'), true)
  security.setActive(ws.id)
  if (reviewed) {
    security.refreshPolicy(ws.id, await h1.importProgram('omarchy'))
    security.reviewPolicy(ws.id, ws.policyReview!.fingerprint, Array(7).fill('Reviewed: source code only'))
  }
  return { security, ws }
}

describe('repository addresses and paths', () => {
  it('accepts only GitHub repository addresses', () => {
    expect(githubRepo('https://github.com/omacom/omarchy')).toBe('https://github.com/omacom/omarchy')
    expect(githubRepo('https://github.com/Omacom/Omarchy.git/')).toBe('https://github.com/omacom/omarchy')
    for (const loose of ['github.com/omacom/omarchy', 'omacom/omarchy', '"https://www.github.com/omacom/omarchy".', 'https://github.com/omacom/omarchy/tree/main/bin', 'http://github.com/omacom/omarchy'])
      expect(githubRepo(loose)).toBe('https://github.com/omacom/omarchy')
    for (const bad of ['https://evil.test/omacom/omarchy', 'https://github.com.evil.test/omacom/omarchy', 'https://github.com/omacom/..', 'git@github.com:omacom/omarchy.git', 'omarchy', 'https://github.com/omacom/omarchy/issues', 42]) expect(githubRepo(bad)).toBeNull()
  })

  it('keeps reads inside the copy and out of .git', () => {
    const folder = path.join(boundary.dir, 'repo')
    fs.mkdirSync(path.join(folder, '.git'), { recursive: true })
    expect(insideRepo(folder, 'bin/omarchy-dns')).toBe(path.join(folder, 'bin', 'omarchy-dns'))
    expect(insideRepo(folder, '/bin/x')).toBe(path.join(folder, 'bin', 'x'))
    for (const bad of ['../secret', '..\\secret', 'bin/../../secret', '.git/config', path.join(boundary.dir, 'other')]) expect(insideRepo(folder, bad)).toBeNull()
  })
})

describe('code review in a security workspace', () => {
  it('fetching needs a reviewed policy and approval; reading the copy needs neither', async () => {
    const unreviewed = await workspace(false)
    expect(unreviewed.security.evaluateAction('security.code.fetch', {}, unreviewed.ws.id)).toMatchObject({ allowed: false, reason: expect.stringContaining('review') })

    const { security, ws } = await workspace()
    vi.spyOn(SecurityWorkspaceService, 'getInstance').mockReturnValue(security)
    const auth = new AuthorizationService(), ctx = { mode: 'security-research' as const, securityWorkspaceId: ws.id }
    expect(auth.evaluate({ name: 'security.code.fetch', riskLevel: 'high' } as any, {}, ctx)).toMatchObject({ allowed: true, requiresApproval: true })
    expect(auth.evaluate({ name: 'security.code.read', riskLevel: 'low' } as any, { file: 'README.md' }, ctx)).toMatchObject({ allowed: true, requiresApproval: false })
    expect(security.enforceDispatch('security.code.fetch', {}, ws.id)).toMatch(/approval/)
    expect(security.enforceDispatch('security.code.search', { pattern: 'sudo' }, ws.id)).toBeNull()
  })

  it('tells the chat brain what is really done, so it cannot claim progress', async () => {
    const unreviewed = await workspace(false)
    const before = unreviewed.security.chatStatus()!
    expect(before).toContain('Save reviewed checklist')
    expect(before).toContain('never describe a project')
    const { security } = await workspace()
    expect(security.chatStatus()).toContain('policy review is done')
    security.setActive(null)
    expect(security.chatStatus()).toBeNull()
  })

  it('refuses repositories that are not eligible source-code assets', async () => {
    const { security, ws } = await workspace()
    for (const repo of ['https://github.com/omacom/old', 'https://github.com/someone/else', 'omacom/omarchy-fork'])
      expect(security.evaluateAction('security.code.read', { repo, file: 'x' }, ws.id).allowed).toBe(false)
    expect(security.codeRepos(ws)).toEqual(['https://github.com/omacom/omarchy'])
    // Something that is not a repository address means the only one in scope.
    for (const odd of ['.', 'omarchy', 'bin', 'https://evil.test/x/y'])
      expect(security.codeRepo(ws, odd).repo).toBe('https://github.com/omacom/omarchy')
    // A source-code asset never makes requests to its host in scope.
    expect(security.checkScope(ws.id, 'https://github.com/omacom/omarchy').inScope).toBe(false)
  })

  it('lists, searches and reads the copy, skipping binaries and symlinked escapes', async () => {
    const { ws } = await workspace()
    const root = path.join(boundary.dir, 'security-code'), repo = 'https://github.com/omacom/omarchy'
    const folder = repoFolder(root, ws.id, repo)
    fs.mkdirSync(path.join(folder, 'install/helpers'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'install/helpers/logging.sh'), 'touch "$LOG"\nchmod 666 "$LOG"\n')
    fs.writeFileSync(path.join(folder, 'blob.bin'), Buffer.from([0, 1, 2, 0x63, 0x68, 0x6d, 0x6f, 0x64]))
    const code = new SecurityCodeService(root)
    expect(code.list(ws.id, repo)).toEqual(['blob.bin', 'install/'])
    expect(code.search(ws.id, repo, 'chmod 6[0-9]{2}')).toEqual({ matches: ['install/helpers/logging.sh:2: chmod 666 "$LOG"'], truncated: false })
    expect(code.search(ws.id, repo, 'chmod (', 'install').matches).toEqual([])
    expect(code.read(ws.id, repo, 'install/helpers/logging.sh', 2, 1)).toEqual({ file: 'install/helpers/logging.sh', lines: '2: chmod 666 "$LOG"', totalLines: 3 })
    expect(() => code.read(ws.id, repo, '../../goga-security-workspaces.json')).toThrow('Not a file')
    expect(() => code.read(ws.id, repo, 'blob.bin')).toThrow('binary')
    expect(() => new SecurityCodeService(root).list('other', repo)).toThrow('Fetch it first')
  })

  it('sends bounty and repository reviews to the tools, not to chat', () => {
    for (const ask of ['please review https://github.com/omacom/omarchy for the bounty', 'check the omarchy code for the bug bounty', 'audit the omarchy repository'])
      expect(looksLikeAgentTask(ask)).toBe(true)
    expect(looksLikeAgentTask('what is a bug bounty?')).toBe(false)
  })

  it('flags files, endpoints and progress the reply invents, and leaves real ones alone', async () => {
    const { security, ws } = await workspace()
    vi.spyOn(SecurityWorkspaceService, 'getInstance').mockReturnValue(security)
    const folder = repoFolder(codeRoot(), ws.id, 'https://github.com/omacom/omarchy')
    fs.mkdirSync(path.join(folder, 'install/helpers'), { recursive: true })
    fs.mkdirSync(path.join(folder, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'install/helpers/logging.sh'), 'chmod 666 "$LOG"\n')
    fs.writeFileSync(path.join(folder, 'bin/omarchy-dns'), '#!/bin/bash\n')

    // The report the chat brain made up for Omarchy, a repository of shell scripts.
    const invented = groundSecurityReply('I found a potential IDOR in the `handlers.go` file: POST to /api/profile/update with user_id 102.', false)
    expect(invented).toContain('`handlers.go`')
    expect(invented).toContain('`/api/profile/update`')
    expect(invented).toContain('not from Goga\'s tools')

    const real = 'install/helpers/logging.sh:1 makes the log world-writable; bin/omarchy-dns runs as root. See logging.sh.'
    expect(groundSecurityReply(real, true)).toBe(real)
    expect(unknownNames('bin/omarchy-nope and https://github.com/omacom/omarchy', folder)).toEqual(['bin/omarchy-nope'])

    security.setActive(null)
    expect(groundSecurityReply('I found handlers.go', false)).toBe('I found handlers.go')
  })

  it('saves a finding only when its quote is really at that file and line', async () => {
    const { ws } = await workspace()
    const root = path.join(boundary.dir, 'security-code'), repo = 'https://github.com/omacom/omarchy'
    const folder = repoFolder(root, ws.id, repo)
    fs.mkdirSync(path.join(folder, 'install/helpers'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'install/helpers/logging.sh'), 'mkdir -p "$dir"\ntouch "$LOG"\nchmod 666 "$LOG" 2>/dev/null || true\n')
    const code = new SecurityCodeService(root)
    expect(code.quoteAt(ws.id, repo, 'install/helpers/logging.sh', 3, 'chmod 666 "$LOG"')).toEqual({ file: 'install/helpers/logging.sh', line: 3, text: 'chmod 666 "$LOG" 2>/dev/null || true' })
    expect(code.quoteAt(ws.id, repo, 'install/helpers/logging.sh', 2, 'chmod   666 "$LOG"').line).toBe(3)   // near, spacing aside
    expect(() => code.quoteAt(ws.id, repo, 'install/helpers/logging.sh', 3, 'func UpdateProfile(')).toThrow('no line near 3')
    expect(() => code.quoteAt(ws.id, repo, 'handlers.go', 1, 'func UpdateProfile(')).toThrow('Not a file')
    expect(() => code.quoteAt(ws.id, repo, 'install/helpers/logging.sh', 3, 'x')).toThrow('Quote')
  })

  it('shows the planner only the security tools while a workspace is active', () => {
    const offered = plannerOffers('review the omarchy code', true)
    expect(['security.code.fetch', 'security.code.read', 'web.fetch'].every(offered)).toBe(true)
    expect(['shell.execute', 'browser.navigate', 'computer.click'].some(offered)).toBe(false)
    expect(plannerOffers('review the omarchy code')('security.code.fetch')).toBe(false)
  })
})
