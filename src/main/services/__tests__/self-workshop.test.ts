import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { Workshop, applyEdits, registerNewTools, withoutRedeclarations, exposeImported, freshTestName, parsePlan, safetyProblems, safetyFilesTouched, failureSummary, runCommand, gapNumber, IMPROVE_REQUEST, MERGE_REPLY, DISCARD_REPLY } from '../selfImprove'

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))

describe('workshop rules', () => {
  it('reads a plan and refuses bad ones', () => {
    const plan = parsePlan(JSON.stringify({ summary: 'add x', edits: [{ file: './src\\main\\a.ts', find: 'a', replace: 'b' }] }))
    expect(plan.edits[0].file).toBe('src/main/a.ts')
    expect(() => parsePlan('not json')).toThrow(/JSON/)
    expect(() => parsePlan('{"summary":"x","edits":[]}')).toThrow(/edits/)
  })

  it('lets him change any of his files, flags the safety files, and keeps real-money paths off-limits', () => {
    const p = (file: string, replace = 'x', find = 'y') => safetyProblems({ summary: '', edits: [{ file, find, replace }] })
    expect(p('src/main/services/trading/paperTrading.ts')).toEqual([])
    expect(p('src/main/services/selfImprove.ts')).toEqual([])
    expect(safetyFilesTouched(['src/main/services/authorization.ts', 'src/main/tools/web.ts', 'src\\main\\services\\trading\\paperTrading.ts'])).toEqual([
      { file: 'src/main/services/authorization.ts', guards: 'which actions need your approval' },
      { file: 'src/main/services/trading/paperTrading.ts', guards: 'paper-only trading and the encrypted trading keys' },
    ])
    expect(p('src/main/services/trading/paperTrading.ts', "const u = 'https://api.alpaca.markets/v2'")[0]).toMatch(/real-money/)
    expect(p('package.json')[0]).toMatch(/only .ts/)
    expect(p('src/main/services/x.ts', "const u = 'https://api.alpaca.markets/v2'")[0]).toMatch(/real-money/)
    expect(p('src/main/services/x.ts', 'safeStorage.decryptString(x)')[0]).toMatch(/key storage/)
    expect(p('src/main/services/browserCheck.ts')).toEqual([])
  })

  it('applies exact, unique edits — Windows line endings included — and creates new files', () => {
    const root = tmp('edits')
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'const a = 1\r\nconst b = 2\r\n')
    applyEdits(root, [{ file: 'src/a.ts', find: 'const b = 2\n', replace: 'const b = 3\n' }, { file: 'src/new.ts', find: '', replace: 'export const n = 1\n' }])
    expect(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8')).toBe('const a = 1\r\nconst b = 3\r\n')
    expect(fs.existsSync(path.join(root, 'src/new.ts'))).toBe(true)
    expect(() => applyEdits(root, [{ file: 'src/a.ts', find: 'const', replace: 'let' }])).toThrow(/2 times/)
    expect(() => applyEdits(root, [{ file: '../escape.ts', find: '', replace: '' }])).toThrow(/outside/)
  })

  it('allows a whole-file rewrite only when it keeps most of the file', () => {
    const root = tmp('rewrite')
    fs.mkdirSync(path.join(root, 'src'))
    const file = path.join(root, 'src/a.ts')
    fs.writeFileSync(file, 'export const a = 1\nexport const b = 2\nexport const c = 3\n')
    expect(() => applyEdits(root, [{ file: 'src/a.ts', find: '', replace: 'export const a = 1\n' }])).toThrow(/EXISTING file.*drop most/)
    applyEdits(root, [{ file: 'src/a.ts', find: '', replace: 'export const a = 1\nexport const b = 2\nexport const c = 4\n' }])
    expect(fs.readFileSync(file, 'utf8')).toMatch(/c = 4/)
    // New code that doesn't repeat the file is added at the end.
    applyEdits(root, [{ file: 'src/a.ts', find: '', replace: 'export const d = 5\n' }])
    expect(fs.readFileSync(file, 'utf8')).toBe('export const a = 1\nexport const b = 2\nexport const c = 4\n\nexport const d = 5\n')
    // Re-declared imports and constants the file already has are left out of an addition.
    const tools = Array.from({ length: 8 }, (_, i) => `reg.add(${i})`).join('\n')
    fs.writeFileSync(file, `import { R } from './r'\nconst reg = R.get()\n${tools}\n`)
    applyEdits(root, [{ file: 'src/a.ts', find: '', replace: "import { R } from './r'\nconst reg = R.get()\nreg.add(99)\n" }])
    expect(fs.readFileSync(file, 'utf8')).toBe(`import { R } from './r'\nconst reg = R.get()\n${tools}\n\nreg.add(99)\n`)
  })

  it('forgives wrong indentation, and points to the closest line when nothing matches', () => {
    const root = tmp('loose')
    fs.mkdirSync(path.join(root, 'src'))
    const file = path.join(root, 'src/i.ts')
    fs.writeFileSync(file, "import './clock'\n    import './web'\n\nexport { X } from './x'\n")
    applyEdits(root, [{ file: 'src/i.ts', find: "import './web'\nexport { X } from './x'", replace: "import './web'\nimport './find'\nexport { X } from './x'" }])
    expect(fs.readFileSync(file, 'utf8')).toBe("import './clock'\nimport './web'\nimport './find'\nexport { X } from './x'\n")
    expect(() => applyEdits(root, [{ file: 'src/i.ts', find: "import './webby'", replace: '' }])).toThrow(/closest real line is: "import '.\/web'"/)
  })

  it('accepts an addition even when the model quotes existing lines out of order', () => {
    const root = tmp('add')
    fs.mkdirSync(path.join(root, 'src'))
    const file = path.join(root, 'src/index.ts')
    fs.writeFileSync(file, "import './computer'\nimport './shell'\nimport './clock'\n\nexport { R } from './r'\n")
    // The model sorted them alphabetically and added one.
    applyEdits(root, [{ file: 'src/index.ts', find: "import './clock'\nimport './computer'\nimport './shell'", replace: "import './clock'\nimport './computer'\nimport './findFiles'\nimport './shell'" }])
    expect(fs.readFileSync(file, 'utf8')).toBe("import './computer'\nimport './shell'\nimport './clock'\nimport './findFiles'\n\nexport { R } from './r'\n")
    // Dropping a line is not an addition — refused.
    expect(() => applyEdits(root, [{ file: 'src/index.ts', find: "import './shell'\nimport './computer'", replace: "import './computer'" }])).toThrow(/not in the file/)
  })

  it('registers a new tool file itself and drops the model\'s import-list edit', () => {
    const root = tmp('reg')
    fs.mkdirSync(path.join(root, 'src/main/tools'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src/main/tools/index.ts'), "import './computer'\nimport './self'\n\nexport { ToolRegistry } from './registry'\n")
    const tool = { file: 'src/main/tools/findFiles.ts', find: '', replace: "import { ToolRegistry } from './registry'\nToolRegistry.getInstance().register({} as never, async () => ({ success: true }))\n" }
    const wrongList = { file: 'src/main/tools/index.ts', find: "import './a'\nimport './computer'", replace: "import './a'\nimport './computer'\nimport './findFiles'" }
    const out = registerNewTools([tool, wrongList], root)
    expect(out).toHaveLength(2)
    applyEdits(root, out)
    expect(fs.readFileSync(path.join(root, 'src/main/tools/index.ts'), 'utf8')).toBe("import './computer'\nimport './self'\nimport './findFiles'\n\nexport { ToolRegistry } from './registry'\n")
  })

  it('drops imports and constants a file already has, whatever their form', () => {
    const file = "import fs from 'fs'\nimport { ToolRegistry } from './registry'\nconst reg = ToolRegistry.getInstance()\n"
    const added = "import * as fs from 'fs'\nimport path from 'path'\nimport { ToolRegistry } from './registry'\nconst reg = ToolRegistry.getInstance()\nconst LIMIT = 50\nreg.register(x)"
    expect(withoutRedeclarations(file, added)).toBe("import path from 'path'\nconst LIMIT = 50\nreg.register(x)")
  })

  it('exports a helper the test needs, and never reuses a test file name', () => {
    const root = tmp('expose')
    fs.mkdirSync(path.join(root, 'src/main/tools'), { recursive: true })
    fs.mkdirSync(path.join(root, 'src/main/services/__tests__'), { recursive: true })
    const tool = path.join(root, 'src/main/tools/find.ts')
    fs.writeFileSync(tool, 'async function findIn(d: string) { return [d] }\nconst LIMIT = 5\nexport const done = 1\n')
    const test = { file: 'src/main/services/__tests__/find.test.ts', find: '', replace: "import { findIn, LIMIT as L, done } from '../../tools/find'\n" }
    expect(exposeImported(root, test)).toEqual(['findIn', 'LIMIT'])
    expect(fs.readFileSync(tool, 'utf8')).toBe('export async function findIn(d: string) { return [d] }\nexport const LIMIT = 5\nexport const done = 1\n')
    fs.writeFileSync(path.join(root, test.file), 'old')
    expect(freshTestName(root, test.file)).toBe('src/main/services/__tests__/find-2.test.ts')
  })

  it('keeps only the useful lines of a failure', () => {
    expect(failureSummary('noise\nsrc/a.ts(3,1): error TS2304: Cannot find name x\nmore noise')).toBe('src/a.ts(3,1): error TS2304: Cannot find name x')
  })

  it('understands the chat commands', () => {
    expect(IMPROVE_REQUEST.test('improve yourself')).toBe(true)
    expect(IMPROVE_REQUEST.test('work on gap 2')).toBe(true)
    expect(IMPROVE_REQUEST.test('improve my essay')).toBe(false)
    expect(gapNumber('please fix problem #3')).toBe(3)
    expect(MERGE_REPLY.test('merge it')).toBe(true)
    expect(MERGE_REPLY.test('yes, apply the change!')).toBe(true)
    expect(MERGE_REPLY.test('merge it with my other notes later')).toBe(false)
    expect(DISCARD_REPLY.test('discard it')).toBe(true)
  })
})

describe('workshop round', () => {
  /** A tiny project; the "model" fixes it on the second try; tsc/tests are stand-ins. */
  function setup(answers: string[]) {
    const project = tmp('project')
    fs.mkdirSync(path.join(project, 'src/main/services/__tests__'), { recursive: true })
    fs.mkdirSync(path.join(project, 'node_modules'))
    fs.writeFileSync(path.join(project, 'node_modules/keep.txt'), 'must survive')
    fs.writeFileSync(path.join(project, 'src/main/services/greet.ts'), 'export const greet = (n: string) => `hi ${n}`\n')
    fs.writeFileSync(path.join(project, 'package.json'), '{}')
    const statuses: string[] = []
    let asked = 0
    const shop = new Workshop({
      projectRoot: project,
      workDir: path.join(tmp('userdata'), 'workshop'),
      ask: async () => answers[Math.min(asked++, answers.length - 1)],
      run: (cmd, cwd, ms, signal) => cmd.startsWith('git') ? runCommand(cmd, cwd, ms, signal) : Promise.resolve({ code: 0, out: '' }),
      status: s => statuses.push(s),
      log: { info: () => {}, warn: () => {} },
    })
    return { project, shop, statuses, asked: () => asked }
  }
  const good = JSON.stringify({
    summary: 'Greet politely.',
    edits: [{ file: 'src/main/services/greet.ts', find: 'export const greet = (n: string) => `hi ${n}`', replace: 'export const greet = (n: string) => `hello ${n}`' }],
  })
  const goodTest = JSON.stringify({ file: 'src/main/services/__tests__/greet.test.ts', content: "import { it, expect } from 'vitest'\nimport { greet } from '../greet'\nit('greets', () => expect(greet('a')).toBe('hello a'))\n" })

  it('retries a bad answer, then proposes a tested change without touching the real code', async () => {
    const { project, shop, asked } = setup(['{"summary":"x","edits":[{"file":"src/main/services/greet.ts","find":"nope","replace":"y"}]}', good, goodTest])
    const p = await shop.improve('be more polite')
    expect(asked()).toBe(3)
    expect(p.attempts).toBe(2)
    expect(p.files).toContain('src/main/services/__tests__/greet.test.ts')
    expect(p.diff).toMatch(/\+export const greet = .*hello/)
    expect(fs.readFileSync(path.join(project, 'src/main/services/greet.ts'), 'utf8')).toMatch(/hi \$/)   // untouched
    expect(shop.pending()?.summary).toBe('Greet politely.')
    shop.discard()
    expect(shop.pending()).toBeNull()
    expect(fs.readFileSync(path.join(project, 'node_modules/keep.txt'), 'utf8')).toBe('must survive')
  }, 60_000)

  it('merges an approved change into the real code, keeping a patch that undoes it', async () => {
    const { project, shop } = setup([good, goodTest])
    await shop.improve('be more polite')
    const history = tmp('history')
    const saved = await shop.merge(history)
    const file = path.join(project, 'src/main/services/greet.ts')
    expect(fs.readFileSync(file, 'utf8')).toMatch(/hello \$/)
    expect(fs.existsSync(path.join(project, 'src/main/services/__tests__/greet.test.ts'))).toBe(true)
    expect(shop.pending()).toBeNull()
    expect((await runCommand(`git apply -R "${saved}"`, project, 30_000)).code).toBe(0)
    expect(fs.readFileSync(file, 'utf8')).toMatch(/hi \$/)
    expect(fs.readFileSync(path.join(project, 'node_modules/keep.txt'), 'utf8')).toBe('must survive')
  }, 60_000)

  it('does not start when the untouched copy already fails its tests', async () => {
    const { shop, asked } = setup([good])
    ;(shop as unknown as { deps: { run: (cmd: string, cwd: string, ms: number) => Promise<{ code: number; out: string }> } }).deps.run =
      (cmd, cwd, ms) => cmd.startsWith('git') ? runCommand(cmd, cwd, ms) : Promise.resolve({ code: 1, out: 'FAIL some.test.ts' })
    await expect(shop.improve('anything')).rejects.toThrow(/before any change/)
    expect(asked()).toBe(0)
  }, 60_000)

  it('needs a real test file, and gives up honestly after three tries', async () => {
    const badTest = JSON.stringify({ file: 'src/main/greet.test.ts', content: 'no vitest here' })
    const { shop } = setup([good, badTest, badTest, good, badTest, badTest, good, badTest, badTest])   // two test tries per attempt
    await expect(shop.improve('anything')).rejects.toThrow(/tried 3 times.*no passing test could be written.*import from vitest/s)
  }, 60_000)
})
