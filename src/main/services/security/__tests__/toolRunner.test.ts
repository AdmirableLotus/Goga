import { describe, it, expect } from 'vitest'
import { runSecurityTool, allowedTool, ALLOWED_TOOLS, type ExecLike, type WhichLike } from '../toolRunner'

const curl = allowedTool('curl')!
const TARGET = 'https://app.example.com/search?q=TEST'

function fakes(opts: { present?: boolean; afterInstall?: boolean } = {}) {
  const calls: { bin: string; args: string[] }[] = []
  let present = opts.present ?? true
  const which: WhichLike = async () => (present ? `/usr/bin/${curl.bin}` : null)
  const exec: ExecLike = async (bin, args) => {
    calls.push({ bin, args })
    if (bin === 'winget' || bin === 'go') { present = opts.afterInstall ?? true; return { code: 0, stdout: 'installed', stderr: '' } }
    return { code: 0, stdout: 'HTTP/1.1 200 OK\n\n<html>ok</html>', stderr: '' }
  }
  return { which, exec, calls }
}

describe('allowedTool', () => {
  it('returns entries for allow-listed tools and null otherwise', () => {
    expect(allowedTool('curl')?.id).toBe('curl')
    expect(allowedTool('nuclei')?.id).toBe('nuclei')
    expect(allowedTool('sqlmap')).toBeNull()
    expect(allowedTool('rm -rf /')).toBeNull()
  })
})

describe('argv construction is locked down', () => {
  it('puts the target after "--" so it cannot be read as a flag, and keeps query strings', () => {
    const args = curl.buildArgs(TARGET)
    const dashdash = args.indexOf('--')
    expect(dashdash).toBeGreaterThan(-1)
    expect(args[dashdash + 1]).toBe(TARGET)        // target is the last arg, after --
    expect(args.length).toBe(dashdash + 2)
  })

  it('rejects non-http targets (no file:, javascript:, etc.)', () => {
    expect(() => curl.buildArgs('file:///etc/passwd')).toThrow()
    expect(() => curl.buildArgs('javascript:alert(1)')).toThrow()
    expect(() => curl.buildArgs('not a url')).toThrow()
  })

  it('nuclei runs rate-limited against a single -u target', () => {
    const n = allowedTool('nuclei')!
    const args = n.buildArgs(TARGET)
    expect(args[args.indexOf('-u') + 1]).toBe(TARGET)
    expect(args).toContain('-rate-limit')
    expect(args).toContain('-no-interactsh')
  })
})

describe('runSecurityTool', () => {
  it('runs when the tool is already installed', async () => {
    const { which, exec, calls } = fakes({ present: true })
    const r = await runSecurityTool({ tool: curl, target: TARGET, exec, which, allowInstall: false })
    expect(r.ran).toBe(true)
    expect(r.installed).toBe(true)
    expect(r.output).toContain('200 OK')
    expect(calls.every(c => c.bin !== 'winget')).toBe(true)   // no install attempted
  })

  it('installs first when missing and install is approved', async () => {
    const { which, exec, calls } = fakes({ present: false, afterInstall: true })
    const r = await runSecurityTool({ tool: curl, target: TARGET, exec, which, allowInstall: true })
    expect(r.installed).toBe(true)
    expect(r.ran).toBe(true)
    expect(calls.some(c => c.bin === 'winget')).toBe(true)
  })

  it('refuses to run (and never installs) when missing and install is NOT approved', async () => {
    const { which, exec, calls } = fakes({ present: false })
    const r = await runSecurityTool({ tool: curl, target: TARGET, exec, which, allowInstall: false })
    expect(r.ran).toBe(false)
    expect(r.error).toMatch(/not installed/i)
    expect(calls.length).toBe(0)    // nothing executed at all
  })

  it('stops honestly when install was approved but the tool is still missing afterward', async () => {
    const { which, exec } = fakes({ present: false, afterInstall: false })
    const r = await runSecurityTool({ tool: curl, target: TARGET, exec, which, allowInstall: true })
    expect(r.ran).toBe(false)
    expect(r.error).toMatch(/still not available/i)
  })

  it('caps output at the tool\'s maxOutput', async () => {
    const big = 'x'.repeat(curl.maxOutput + 5000)
    const which: WhichLike = async () => '/usr/bin/curl'
    const exec: ExecLike = async () => ({ code: 0, stdout: big, stderr: '' })
    const r = await runSecurityTool({ tool: curl, target: TARGET, exec, which, allowInstall: false })
    expect(r.output.length).toBeLessThanOrEqual(curl.maxOutput + 80)
    expect(r.output).toMatch(/truncated/)
  })
})

describe('allow-list stays small and bounded', () => {
  it('every tool has a hard timeout and a capped output', () => {
    for (const t of ALLOWED_TOOLS) {
      expect(t.timeoutMs).toBeGreaterThan(0)
      expect(t.maxOutput).toBeGreaterThan(0)
    }
  })
})
