import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('screenshot-desktop', () => ({ default: vi.fn() }))
vi.mock('@nut-tree-fork/nut-js', () => ({}))
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: vi.fn(),
}))
import { spawn, spawnSync } from 'child_process'
import { DesktopAdapter } from '../../adapters/desktop'
import { quotedPrioritiesText } from '../../../shared/__tests__/fixtures/prioritiesNote'

afterEach(() => vi.clearAllMocks())

async function captureHelper() {
  let bytes: Buffer | undefined
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const scriptPath = args![args!.indexOf('-File') + 1]
    bytes = fs.readFileSync(scriptPath)
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    })
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('ok:value'))
      child.emit('close', 0)
    })
    return child as any
  })
  // The UI helper is captured, never executed: spawn above is mocked.
  expect(await new DesktopAdapter().typeIntoHwnd(12345, quotedPrioritiesText)).toEqual({ ok: true })
  return bytes!
}

describe('Windows PowerShell helper source encoding', () => {
  it('writes a UTF-8 BOM so Windows PowerShell does not decode Unicode as ANSI', async () => {
    const bytes = await captureHelper()
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.toString('utf8')).toContain(quotedPrioritiesText)
  })

  it.runIf(process.platform === 'win32')('preserves the exact Unicode SetValue argument when parsed by Windows PowerShell', async () => {
    const bytes = await captureHelper()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-source-encoding-'))
    const file = path.join(dir, 'captured.ps1')
    try {
      fs.writeFileSync(file, bytes)
      // Parse only. Never execute the captured script or call desktop APIs.
      const probe = `
        $tokens = $null; $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$tokens, [ref]$parseErrors)
        if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
        $call = $ast.Find({ param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -eq 'SetValue' }, $true)
        if ($null -eq $call) { throw 'Missing SetValue argument' }
        [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($call.Arguments[0].Value)))
      `
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64')], {
        windowsHide: true, encoding: 'utf8', timeout: 15000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(Buffer.from(result.stdout.trim(), 'base64').toString('utf8')).toBe(quotedPrioritiesText)
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file)
      fs.rmdirSync(dir)
    }
  })

  it('preserves cancellation before helper creation or dispatch', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect((new DesktopAdapter() as any).runPS('# inert', undefined, controller.signal)).rejects.toThrow('cancelled')
    expect(spawn).not.toHaveBeenCalled()
  })
})
