import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

const mock = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mock.spawn, execFile: mock.execFile }))
vi.mock('../securityWorkspace', () => ({ SecurityWorkspaceService: { getInstance: () => ({ getActive: () => null }) } }))
import { DeveloperService, developerEnvironment, describeDeveloperEvent } from '../developer'

const dirs: string[] = []
afterEach(() => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-dev-')); dirs.push(root)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }))
  mock.execFile.mockImplementation((_file, _args, _opts, cb) => { cb(null, { stdout: 'main', stderr: '' }); return new EventEmitter() })
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(), pid: 12345 })
  mock.spawn.mockReturnValue(child)
  const service = new DeveloperService(vi.fn())
  // Use a mock executable: no live model calls or project modifications in tests.
  ;(service as any).executable = 'codex-test.exe'
  return { root, service, child }
}

describe('Developer Mode', () => {
  it('removes Goga credentials from child environment', () => {
    expect(developerEnvironment({ PATH: 'bin', TELEGRAM_BOT_TOKEN: 'secret', ELEVENLABS_API_KEY: 'secret', OPENAI_API_KEY: 'secret', APPDATA: 'data' }))
      .toEqual({ PATH: 'bin', APPDATA: 'data' })
  })

  it('does not turn unknown protocol records into success messages', () => {
    expect(describeDeveloperEvent({ type: 'thread.started' })).toBeNull()
    expect(describeDeveloperEvent({ type: 'turn.failed', error: { message: 'login required' } })).toEqual({ kind: 'error', text: 'login required' })
  })

  it('uses read-only analysis, stdin for tasks, and blocks overlapping runs', async () => {
    const { root, service, child } = setup()
    await service.selectProject(root)
    service.start('Analyze Goga; $notAShellCommand', 'plan')
    const [exe, args, opts] = mock.spawn.mock.calls[0]
    expect(exe).toBe('codex-test.exe')
    expect(args).toContain('read-only')
    expect(args).not.toContain('Analyze Goga; $notAShellCommand')
    expect(opts.shell).toBeUndefined()
    expect(() => service.start('another', 'build')).toThrow('already running')
    await expect(service.selectProject(root)).rejects.toThrow('Stop the current')
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"Analysis complete"}}\n')
    child.emit('close', 0)
    await vi.waitFor(() => expect(service.getState().status).toBe('completed'))
    expect(service.getState().summary).toBe('Analysis complete')
  })

  it('handles fragmented protocol events and marks failed turns as failed even with exit zero', async () => {
    const { root, service, child } = setup()
    await service.selectProject(root)
    service.start('Fix a bug', 'build')
    expect(mock.spawn.mock.calls[0][1]).toContain('workspace-write')
    child.stdout.write('{"type":"turn.fa')
    child.stdout.write('iled","error":{"message":"sandbox unavailable"}}\n')
    child.emit('close', 0)
    await vi.waitFor(() => expect(service.getState().status).toBe('failed'))
    expect(service.getState().events.some(event => event.text === 'sandbox unavailable')).toBe(true)
  })

  it('keeps a stopped task occupied until the process exits', async () => {
    const { root, service, child } = setup()
    await service.selectProject(root)
    service.start('Fix a bug', 'build')
    service.stop()
    expect(service.getState().status).toBe('stopping')
    expect(() => service.start('new', 'plan')).toThrow('already running')
    child.emit('close', 1)
    await vi.waitFor(() => expect(service.getState().status).toBe('stopped'))
  })
})
