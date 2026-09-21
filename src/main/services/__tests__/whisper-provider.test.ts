/**
 * WhisperSttProvider — focused unit tests
 *
 * Mocks child_process.spawn — no real Python process is started.
 * Each test drives the mock process stdout/stderr/close events directly.
 * Covers: normal transcript, no speech, hard timeout, malformed output,
 * ERROR line, abort during recording, process killed during transcription,
 * continuous mode, dispose, preflight, READY timeout, recovery after timeout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const logs: string[] = []
vi.mock('../logs', () => ({
  LogService: { getInstance: () => ({ info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) }) },
}))

vi.mock('../settings', () => ({
  SettingsService: { getInstance: () => ({ get: () => ({ whisperModel: 'base', whisperDevice: 'cuda', whisperLanguage: '', sttProvider: 'whisper' }) }) },
}))

interface MockProc extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; writable: boolean }
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  emitStdout(line: string): void
  emitClose(code?: number): void
  writtenLines(): string[]
}

const spawnedProcs: MockProc[] = []

vi.mock('child_process', () => ({
  spawn: () => {
    const proc = new EventEmitter() as MockProc
    const written: string[] = []
    proc.stdin  = { write: vi.fn((s: string) => written.push(s)), writable: true }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill   = vi.fn(() => setImmediate(() => proc.emit('close', -1)))
    proc.emitStdout = (line: string) => proc.stdout.emit('data', Buffer.from(line + '\n'))
    proc.emitClose  = (code = 0) => proc.emit('close', code)
    proc.writtenLines = () => written.flatMap(s => s.split('\n')).filter(Boolean)
    spawnedProcs.push(proc)
    return proc
  },
}))

vi.mock('fs', async (orig) => {
  const actual = await (orig() as Promise<any>)
  return { ...actual, existsSync: (p: string) => p.includes('whisper_stt') ? true : actual.existsSync(p) }
})

vi.mock('os', async (orig) => {
  const actual = await (orig() as Promise<any>)
  return { ...actual, homedir: () => 'C:\\Users\\test' }
})

import { WhisperSttProvider } from '../speech/WhisperSttProvider'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function tick(n = 1) {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r))
}

async function bootProvider(): Promise<{ p: WhisperSttProvider; proc: MockProc }> {
  const p = new WhisperSttProvider()
  const readyPromise = p['ensureProcess']()
  await tick()
  const proc = spawnedProcs[spawnedProcs.length - 1]
  proc.emitStdout('DEVICE_INFO {"model":"base","device":"cuda","compute_type":"float16","requested_device":"cuda"}')
  proc.emitStdout('READY')
  await readyPromise
  return { p, proc }
}

/**
 * Starts recognize() and waits for listenResolve to be set.
 * Returns the in-flight Promise<SpeechRecognitionResult> directly.
 * Do NOT await this function — call it as: `const p = startRecognize(p)`
 * then emit events, then `await p`.
 */
function startRecognize(p: WhisperSttProvider, ms = 5000) {
  // recognize() is async: it does `await ensureProcess()` (already resolved),
  // then sets listenResolve. We return a promise that resolves to the
  // SpeechRecognitionResult after the internal setup tick completes.
  return tick(3).then(() => p.recognize(ms))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WhisperSttProvider — lifecycle', () => {
  beforeEach(() => { logs.length = 0; spawnedProcs.length = 0; vi.clearAllMocks(); vi.clearAllTimers() })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  // ── DEVICE_INFO ───────────────────────────────────────────────────────────

  it('logs actual device=cuda and compute_type from DEVICE_INFO', async () => {
    const { p } = await bootProvider()
    expect(logs.some(m => m.includes('device=cuda') && m.includes('compute_type=float16'))).toBe(true)
    expect(logs.some(m => m.includes('READY'))).toBe(true)
    p.dispose()
  })

  it('logs fallback note when device differs from requested', async () => {
    const p = new WhisperSttProvider()
    const ready = p['ensureProcess']()
    await tick()
    const proc = spawnedProcs[spawnedProcs.length - 1]
    proc.emitStdout('DEVICE_INFO {"model":"base","device":"cpu","compute_type":"int8","requested_device":"cuda"}')
    proc.emitStdout('READY')
    await ready
    expect(logs.some(m => m.includes('fell back to cpu'))).toBe(true)
    p.dispose()
  })

  // ── Normal transcript ─────────────────────────────────────────────────────

  it('resolves with transcript when TRANSCRIPT then DONE arrive', async () => {
    const { p, proc } = await bootProvider()
    // Start recognize, wait for listenResolve to be set, then emit events
    let result: any
    const done = p.recognize(5000).then(r => { result = r })
    await tick(3)  // let recognize() set listenResolve
    proc.emitStdout('TRANSCRIPT Hello Goga')
    proc.emitStdout('DONE')
    await tick()
    await done
    expect(result.transcript).toBe('Hello Goga')
    p.dispose()
  })

  it('resolves empty when DONE arrives with no TRANSCRIPT (no speech)', async () => {
    const { p, proc } = await bootProvider()
    let result: any
    const done = p.recognize(5000).then(r => { result = r })
    await tick(3)
    proc.emitStdout('DONE')
    await tick()
    await done
    expect(result.transcript).toBe('')
    p.dispose()
  })

  // ── Hard timeout ──────────────────────────────────────────────────────────

  it('kills process and resolves empty when DONE never arrives (hard timeout)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // Boot provider with fake timers active
    const p = new WhisperSttProvider()
    const readyPromise = p['ensureProcess']()
    await tick()
    const proc = spawnedProcs[spawnedProcs.length - 1]
    proc.emitStdout('DEVICE_INFO {"model":"base","device":"cuda","compute_type":"float16","requested_device":"cuda"}')
    proc.emitStdout('READY')
    await readyPromise

    let result: any
    const done = p.recognize(5000).then(r => { result = r })
    await tick(3)
    vi.advanceTimersByTime(21_000)
    await tick()
    await done
    expect(result.transcript).toBe('')
    expect(proc.kill).toHaveBeenCalled()
    expect(logs.some(m => m.includes('hard timeout'))).toBe(true)
    vi.useRealTimers()
    p.dispose()
  }, 10_000)

  it('process is restarted on next recognize() after hard timeout kill', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = new WhisperSttProvider()
    const r1 = p['ensureProcess']()
    await tick()
    const proc1 = spawnedProcs[spawnedProcs.length - 1]
    proc1.emitStdout('DEVICE_INFO {"model":"base","device":"cuda","compute_type":"float16","requested_device":"cuda"}')
    proc1.emitStdout('READY')
    await r1

    let res1: any
    const d1 = p.recognize(5000).then(r => { res1 = r })
    await tick(3)
    vi.advanceTimersByTime(21_000)
    await tick()
    await d1
    vi.useRealTimers()

    // Provider torn down — next recognize() spawns a new process
    let res2: any
    const d2 = p.recognize(5000).then(r => { res2 = r })
    await tick()
    const proc2 = spawnedProcs[spawnedProcs.length - 1]
    proc2.emitStdout('DEVICE_INFO {"model":"base","device":"cuda","compute_type":"float16","requested_device":"cuda"}')
    proc2.emitStdout('READY')
    await tick(3)
    proc2.emitStdout('TRANSCRIPT recovered')
    proc2.emitStdout('DONE')
    await tick()
    await d2
    expect(res2.transcript).toBe('recovered')
    p.dispose()
  }, 10_000)

  // ── Malformed / error output ──────────────────────────────────────────────

  it('ignores unrecognised stdout lines without crashing', async () => {
    const { p, proc } = await bootProvider()
    let result: any
    const done = p.recognize(5000).then(r => { result = r })
    await tick(3)
    proc.emitStdout('GARBAGE LINE')
    proc.emitStdout('ANOTHER UNKNOWN TOKEN foo bar')
    proc.emitStdout('DONE')
    await tick()
    await done
    expect(result.transcript).toBe('')
    p.dispose()
  })

  it('handles ERROR line from Python: resolves empty, does not throw', async () => {
    const { p, proc } = await bootProvider()
    let result: any
    const done = p.recognize(5000).then(r => { result = r })
    await tick(3)
    proc.emitStdout('ERROR sounddevice: No default input device')
    await tick()
    await done
    expect(result.transcript).toBe('')
    expect(logs.some(m => m.includes('No default input device'))).toBe(true)
    p.dispose()
  })

  // ── abort() ───────────────────────────────────────────────────────────────

  it('abort() resolves recognize immediately with empty transcript', async () => {
    const { p, proc } = await bootProvider()
    let result: any
    const done = p.recognize(5000).then(r => { result = r })
    await tick(3)
    p.abort()
    await tick()
    await done
    expect(result.transcript).toBe('')
    expect(proc.writtenLines().some(l => l.includes('ABORT'))).toBe(true)
    p.dispose()
  })

  it('late TRANSCRIPT after abort is ignored', async () => {
    const { p, proc } = await bootProvider()
    let result: any
    const done = p.recognize(5000).then(r => { result = r })
    await tick(3)
    p.abort()
    await tick()
    await done
    expect(() => proc.emitStdout('TRANSCRIPT late text')).not.toThrow()
    expect(result.transcript).toBe('')
    p.dispose()
  })

  // ── Process killed during transcription ───────────────────────────────────

  it('process close during recognize resolves empty', async () => {
    const { p, proc } = await bootProvider()
    let result: any
    const done = p.recognize(5000).then(r => { result = r })
    await tick(3)
    proc.emitClose(0)
    await tick()
    await done
    expect(result.transcript).toBe('')
    p.dispose()
  })

  // ── Continuous mode ───────────────────────────────────────────────────────

  it('startContinuous sends CONTINUOUS_START and delivers transcripts', async () => {
    const { p, proc } = await bootProvider()
    const results: string[] = []
    p.startContinuous(r => results.push(r.transcript))
    await tick(3)
    expect(proc.writtenLines().some(l => l.includes('CONTINUOUS_START'))).toBe(true)
    proc.emitStdout('TRANSCRIPT Do you remember the book')
    proc.emitStdout('TRANSCRIPT Open Notepad')
    await tick(2)
    expect(results).toEqual(['Do you remember the book', 'Open Notepad'])
    p.stopContinuous()
    p.dispose()
  })

  it('stopContinuous sends CONTINUOUS_STOP', async () => {
    const { p, proc } = await bootProvider()
    p.startContinuous(() => {})
    await tick(3)
    p.stopContinuous()
    expect(proc.writtenLines().some(l => l.includes('CONTINUOUS_STOP'))).toBe(true)
    p.dispose()
  })

  // ── dispose() ─────────────────────────────────────────────────────────────

  it('dispose() sends QUIT and kills process after 500ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = new WhisperSttProvider()
    const ready = p['ensureProcess']()
    await tick()
    const proc = spawnedProcs[spawnedProcs.length - 1]
    proc.emitStdout('DEVICE_INFO {"model":"base","device":"cuda","compute_type":"float16","requested_device":"cuda"}')
    proc.emitStdout('READY')
    await ready
    p.dispose()
    expect(proc.writtenLines().some(l => l.includes('QUIT'))).toBe(true)
    vi.advanceTimersByTime(600)
    await tick()
    expect(proc.kill).toHaveBeenCalled()
    vi.useRealTimers()
  }, 10_000)

  // ── preflight() ───────────────────────────────────────────────────────────

  it('preflight() returns correct shape', () => {
    const result = WhisperSttProvider.preflight('base', 'cuda')
    expect(result.model).toBe('base')
    expect(result.device).toBe('cuda')
    expect(typeof result.downloadMB).toBe('number')
    expect(result.downloadMB).toBeGreaterThanOrEqual(0)
    expect(typeof result.cached).toBe('boolean')
    expect(result.source).toContain('huggingface.co')
    expect(result.cacheDir).toContain('faster-whisper-base')
  })

  it('preflight() large-v3 has correct model name', () => {
    const result = WhisperSttProvider.preflight('large-v3', 'cuda')
    expect(result.model).toBe('large-v3')
    expect(result.downloadMB).toBeGreaterThanOrEqual(0)
  })

  // ── READY timeout ─────────────────────────────────────────────────────────

  it('rejects ensureProcess if READY never arrives within timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = new WhisperSttProvider()
    // Attach catch immediately to prevent unhandled rejection
    const readyPromise = p['ensureProcess']()
    const caught = readyPromise.catch(e => e)
    await tick()
    vi.advanceTimersByTime(301_000)
    await tick()
    const err = await caught
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('timeout')
    vi.useRealTimers()
    p.dispose()
  }, 10_000)
})
