import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SelfWorkService, type CommandRunner } from '../service'

/**
 * The self-work review/repair workflow, proven against a throwaway repo and a stubbed check
 * runner — no real npm, no real network, no electron. Each test pins one promise the workflow
 * makes to the user: it stays inside the project, it writes nothing without approval, it shows the
 * change as a diff, it runs only the three predefined checks, it calls a failing check broken, and
 * it stops after two repair attempts.
 */

// Backticks and ${...} here are literal text inside a single-quoted string, not interpolation.
const SAMPLE = 'export function greet(name: string) {\n  return `hi ${name}`\n}\n'
const REL = 'src/main/services/sample.ts'

let root = ''
let sampleFile = ''

function service(run?: CommandRunner): SelfWorkService {
  return new SelfWorkService({
    repoRoot: root,
    userDataDir: path.join(root, '.userdata'),
    homeDir: path.join(root, '.home'),
    now: () => 1_700_000_000_000, // fixed, so nothing expires mid-test
    log: { info: () => {}, warn: () => {} },
    runCommand: run ?? (async () => ({ code: 0, out: '', ms: 1 })),
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-selfwork-'))
  fs.mkdirSync(path.join(root, 'src', 'main', 'services'), { recursive: true })
  sampleFile = path.join(root, 'src', 'main', 'services', 'sample.ts')
  fs.writeFileSync(sampleFile, SAMPLE, 'utf8')
})

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('project-root path enforcement', () => {
  it('refuses a write outside the repo or one that climbs out of its folder', () => {
    const svc = service()
    expect(() => svc.propose({ path: '../outside.ts', summary: 's', after: 'x' })).toThrow()
    expect(() => svc.propose({ path: 'src/../../etc/passwd.ts', summary: 's', after: 'x' })).toThrow(/outside|climbs/i)
  })

  it('refuses a write to a protected file, whatever the content', () => {
    const svc = service()
    // The gate, its own service, is on the never-writable list: refused before any approval exists.
    expect(() => svc.propose({ path: 'src/main/services/selfwork/service.ts', summary: 's', after: 'x' }))
      .toThrow(/off limits|guards/i)
  })

  it('refuses to read a path that climbs out of the source folder', () => {
    const svc = service()
    expect(() => svc.read('../../secret.ts')).toThrow()
  })
})

describe('approval before write', () => {
  it('writes nothing on propose, refuses apply until the exact proposal is approved', () => {
    const svc = service()
    const original = fs.readFileSync(sampleFile, 'utf8')

    const p = svc.propose({ path: REL, summary: 'say hello', after: SAMPLE.replace('hi', 'hello') })
    expect(fs.readFileSync(sampleFile, 'utf8')).toBe(original) // propose is read-only

    const early = svc.apply(p.id)
    expect(early.ok).toBe(false)
    expect(early.message).toMatch(/not been approved|approve it first/i)
    expect(fs.readFileSync(sampleFile, 'utf8')).toBe(original) // still untouched

    svc.decide(p.id, true)
    const applied = svc.apply(p.id)
    expect(applied.ok).toBe(true)
    expect(fs.readFileSync(sampleFile, 'utf8')).toContain('hello')

    // Single-use: a second apply of the same id cannot write again.
    const again = svc.apply(p.id)
    expect(again.ok).toBe(false)
    expect(again.message).toMatch(/already been applied/i)
  })

  it('a discarded proposal leaves the source untouched', () => {
    const svc = service()
    const original = fs.readFileSync(sampleFile, 'utf8')
    const p = svc.propose({ path: REL, summary: 'no', after: SAMPLE + '// nope\n' })
    svc.decide(p.id, false)
    const applied = svc.apply(p.id)
    expect(applied.ok).toBe(false)
    expect(fs.readFileSync(sampleFile, 'utf8')).toBe(original)
  })
})

describe('diff reporting', () => {
  it('returns a unified diff of the proposed change, before anything is written', () => {
    const svc = service()
    const p = svc.proposePatch({ path: REL, summary: 'rename greeting', find: 'hi ${name}', replace: 'hey ${name}' })
    expect(p.diff).toMatch(/^--- a\/src\/main\/services\/sample\.ts$/m)
    expect(p.diff).toMatch(/^\+\+\+ b\/src\/main\/services\/sample\.ts$/m)
    expect(p.diff).toContain('-  return `hi ${name}`')
    expect(p.diff).toContain('+  return `hey ${name}`')
    expect(fs.readFileSync(sampleFile, 'utf8')).toBe(SAMPLE) // diff is produced without writing
  })
})

describe('command allow-listing', () => {
  it('runs only the three predefined check commands, in order, and nothing else', async () => {
    const seen: string[] = []
    const run: CommandRunner = async (_cwd, cmd) => { seen.push(cmd); return { code: 0, out: '', ms: 1 } }
    const svc = service(run)
    await svc.runChecks()
    expect(seen).toEqual(['npm run build', 'npx tsc --noEmit', 'npx vitest run'])
  })

  it('a requested subset runs only that predefined command', async () => {
    const seen: string[] = []
    const run: CommandRunner = async (_cwd, cmd) => { seen.push(cmd); return { code: 0, out: '', ms: 1 } }
    const svc = service(run)
    await svc.runChecks(undefined, ['tests'])
    expect(seen).toEqual(['npx vitest run'])
  })
})

describe('failed checks are reported as broken', () => {
  it('names the failing check, keeps its output, stops at the first failure, and is not ok', async () => {
    const run: CommandRunner = async (_cwd, cmd) =>
      cmd.includes('tsc')
        ? { code: 2, out: 'src/x.ts(3,1): error TS1005: ; expected', ms: 5 }
        : { code: 0, out: '', ms: 1 }
    const svc = service(run)
    const report = await svc.runChecks()
    expect(report.ok).toBe(false)
    expect(report.summary).toMatch(/broken/i)
    expect(report.summary).toContain('error TS1005')
    // build ran and passed, typecheck failed, tests never ran.
    expect(report.checks.map(c => c.name)).toEqual(['npm run build', 'npx tsc --noEmit'])
  })
})

describe('repair-cycle limit', () => {
  const applyCorrection = (svc: SelfWorkService, n: number) => {
    const p = svc.propose({ path: REL, summary: `attempt ${n}`, after: SAMPLE + `// attempt ${n}\n` })
    svc.decide(p.id, true)
    return svc.apply(p.id)
  }

  it('allows two repair attempts after a failing check, then stops and reports what is broken', async () => {
    const run: CommandRunner = async () => ({ code: 1, out: 'FAIL some.test.ts', ms: 1 })
    const svc = service(run)

    await svc.runChecks() // fails → repair round opens
    expect(svc.repairStatus().active).toBe(true)

    expect(applyCorrection(svc, 1).ok).toBe(true)
    expect(svc.repairStatus().attempts).toBe(1)
    await svc.runChecks() // still failing

    expect(applyCorrection(svc, 2).ok).toBe(true)
    expect(svc.repairStatus().attempts).toBe(2)
    expect(svc.repairStatus().blocked).toBe(true)
    await svc.runChecks() // still failing

    // The third correction is refused before the gate is touched; the file is not written.
    const before = fs.readFileSync(sampleFile, 'utf8')
    const third = svc.propose({ path: REL, summary: 'attempt 3', after: SAMPLE + '// attempt 3\n' })
    svc.decide(third.id, true)
    const blocked = svc.apply(third.id)
    expect(blocked.ok).toBe(false)
    expect(blocked.message).toMatch(/stopping|2 repair attempts|still fail/i)
    expect(fs.readFileSync(sampleFile, 'utf8')).toBe(before)

    // A deliberate reset starts a fresh round, and the same approved change now applies.
    svc.resetRepairs()
    expect(svc.repairStatus().blocked).toBe(false)
    const resumed = svc.apply(third.id)
    expect(resumed.ok).toBe(true)
    expect(fs.readFileSync(sampleFile, 'utf8')).toContain('// attempt 3')
  })

  it('a passing check closes the round and clears the attempt count', async () => {
    let failing = true
    const run: CommandRunner = async () => ({ code: failing ? 1 : 0, out: failing ? 'FAIL' : '', ms: 1 })
    const svc = service(run)

    await svc.runChecks()
    expect(svc.repairStatus().active).toBe(true)
    expect(applyCorrection(svc, 1).ok).toBe(true)
    expect(svc.repairStatus().attempts).toBe(1)

    failing = false
    const ok = await svc.runChecks()
    expect(ok.ok).toBe(true)
    expect(svc.repairStatus().active).toBe(false)
    expect(svc.repairStatus().attempts).toBe(0)
  })

  it('does not count applies when no check has failed', () => {
    const svc = service()
    expect(applyCorrection(svc, 1).ok).toBe(true)
    expect(svc.repairStatus().active).toBe(false)
    expect(svc.repairStatus().attempts).toBe(0)
  })
})

describe('audit trail', () => {
  it('records the proposal, the approval, the apply and the checks — without source bodies', async () => {
    const svc = service()
    const p = svc.propose({ path: REL, summary: 'tidy', after: SAMPLE + '// tidy\n' })
    svc.decide(p.id, true)
    svc.apply(p.id)
    await svc.runChecks(undefined, ['tests'])

    const kinds = svc.state().audit.map(a => a.kind)
    expect(kinds).toContain('propose')
    expect(kinds).toContain('approve')
    expect(kinds).toContain('apply')
    expect(kinds).toContain('check')
    // The record keeps summaries and paths, not file contents.
    const blob = JSON.stringify(svc.state().audit)
    expect(blob).not.toContain('// tidy')
  })
})
