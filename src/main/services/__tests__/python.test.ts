import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { findPython, runPython } from '../python'

const python = findPython()
const describeIf = python ? describe : describe.skip
let dir = ''
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })
function tmp() { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-py-')); return dir }

describeIf('running Python (skipped when Python is not installed)', () => {
  it('returns stdout from a script', async () => {
    const r = await runPython('print(2 ** 10)', python!, tmp())
    expect(r.ok).toBe(true)
    expect(r.stdout.trim()).toBe('1024')
  })

  it('reports an error without crashing', async () => {
    const r = await runPython('raise ValueError("boom")', python!, tmp())
    expect(r.ok).toBe(false)
    expect(r.stderr).toContain('boom')
  })

  it('lists a PNG a script saves', async () => {
    const r = await runPython('open("out.png","wb").write(b"\\x89PNG\\r\\n\\x1a\\n")', python!, tmp())
    expect(r.ok).toBe(true)
    expect(r.images.map(i => path.basename(i))).toContain('out.png')
  })
})

describe('python discovery', () => {
  it('returns a path string or null', () => {
    expect(python === null || typeof python === 'string').toBe(true)
  })
})
