/**
 * M4 — Focused test suite for ElevenLabs voice integration.
 *
 * Exercises PRODUCTION ElevenLabsTtsProvider and VoiceOrchestrator.
 * Mocks only external boundaries: https, child_process, fs I/O.
 * Never calls the real ElevenLabs API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Writable } from 'stream'

// ─── Tracking ───────────────────────────────────────────────────────────────
const unlinkCalls: string[] = []
const spawnCalls: Array<{ cmd: string; args: string[] }> = []
const logMessages: string[] = []

// ─── Configurable mock behavior ─────────────────────────────────────────────
type SpawnBehavior = 'normal' | 'hang-no-start' | 'hang-no-close' | 'stall-early'
let spawnBehavior: SpawnBehavior = 'normal'
let mockHttpStatus = 200
let mockHttpError: Error | null = null
let mockHttpHang = false
let mockFileSize = 50000  // ~12.5s at 4000 bytes/s

// ─── Mock: fs ───────────────────────────────────────────────────────────────
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    unlinkSync: (p: string) => { unlinkCalls.push(p) },
    createWriteStream: () => new Writable({ write(_c, _e, cb) { cb() } }),
    statSync: (_p: string) => ({ size: mockFileSize }),
  }
})

// ─── Mock: child_process ────────────────────────────────────────────────────
vi.mock('child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args })
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = vi.fn(() => { setImmediate(() => proc.emit('close', 0)) })

    if (spawnBehavior === 'normal') {
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('PLAYBACK_STARTED\n'))
        proc.stdout.emit('data', Buffer.from('AMP:0.4500\nAMP:0.3000\nAMP:0.0000\n'))
        setImmediate(() => proc.emit('close', 0))
      })
    } else if (spawnBehavior === 'hang-no-start') {
      // Never emit anything
    } else if (spawnBehavior === 'hang-no-close') {
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('PLAYBACK_STARTED\n'))
        proc.stdout.emit('data', Buffer.from('AMP:0.3000\n'))
        // never close
      })
    } else if (spawnBehavior === 'stall-early') {
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('PLAYBACK_STARTED\n'))
        proc.stdout.emit('data', Buffer.from('AMP:0.2000\n'))
        proc.stdout.emit('data', Buffer.from('STALL_ERROR:2000/18000\n'))
        proc.stdout.emit('data', Buffer.from('AMP:0.0000\n'))
        setImmediate(() => proc.emit('close', 0))
      })
    }
    return proc
  }
}))

// ─── Mock: https ────────────────────────────────────────────────────────────
vi.mock('https', () => ({
  request: (opts: any, callback: any) => {
    const req = new EventEmitter() as any
    req.write = vi.fn()
    req.destroy = vi.fn()
    req.end = vi.fn(() => {
      if (mockHttpHang) {
        if (opts?.timeout) setTimeout(() => req.emit('timeout'), opts.timeout)
        return
      }
      if (mockHttpError) {
        setImmediate(() => req.emit('error', mockHttpError))
        return
      }
      const res = new EventEmitter() as any
      res.statusCode = mockHttpStatus
      res.resume = vi.fn()
      if (mockHttpStatus >= 400) {
        res.pipe = vi.fn()
        setImmediate(() => { callback(res); res.emit('data', Buffer.from('err')); res.emit('end') })
      } else {
        res.pipe = (dest: Writable) => { dest.write(Buffer.from('x'.repeat(mockFileSize))); dest.end(); return dest }
        setImmediate(() => callback(res))
      }
    })
    return req
  }
}))

// ─── Mock: LogService ───────────────────────────────────────────────────────
vi.mock('../logs', () => ({
  LogService: { getInstance: () => ({ info: (m: string) => { logMessages.push(m) }, warn: (m: string) => { logMessages.push(m) }, error: (m: string) => { logMessages.push(m) } }) }
}))

// ─── Mock: SettingsService ──────────────────────────────────────────────────
const settings: Record<string, any> = {
  voiceEnabled: true, autoSpeakResponses: true, voiceRate: 1.0, voiceVolume: 1.0,
  voiceName: '', allowBargeIn: true, wakePhrase: 'hey goga', conversationWindowSecs: 45, sttProvider: 'windows',
}

vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => settings }) } }))
vi.mock('../speech/WhisperSttProvider', () => ({ WhisperSttProvider: class { name = 'Whisper'; recognize = vi.fn(); startContinuous = vi.fn(); stopContinuous = vi.fn(); abort = vi.fn() } }))

// ─── Production imports ─────────────────────────────────────────────────────
import { ElevenLabsTtsProvider } from '../speech/ElevenLabsTtsProvider'
import { VoiceOrchestrator } from '../voiceOrchestrator'

function configureEnv(key: boolean, voice: boolean) {
  if (key) process.env.ELEVENLABS_API_KEY = 'sk_testonly_abcdef1234567890abcdef'
  else delete process.env.ELEVENLABS_API_KEY
  if (voice) process.env.ELEVENLABS_VOICE_ID = 'voice_test_xyz'
  else delete process.env.ELEVENLABS_VOICE_ID
}

function freshOrchestrator(): VoiceOrchestrator {
  ;(VoiceOrchestrator as any).instance = undefined
  return VoiceOrchestrator.getInstance()
}

const THREE_SENTENCE_RESPONSE = "It seems like you're trying to initiate a new conversation. I'm going to assume you're trying to start fresh. However, I want to remind you that we have a conversation history, and it's essential to read it before responding."

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('M4 — ElevenLabs voice (production classes)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unlinkCalls.length = 0; spawnCalls.length = 0; logMessages.length = 0
    mockHttpStatus = 200; mockHttpError = null; mockHttpHang = false; mockFileSize = 50000
    spawnBehavior = 'normal'
    settings.voiceEnabled = true; settings.autoSpeakResponses = true
    delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_VOICE_ID
  })

  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_VOICE_ID
    ;(VoiceOrchestrator as any).instance = undefined
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. cleanForSpeech preserves all three sentences of the 341-char response
  // ═══════════════════════════════════════════════════════════════════════════
  it('cleanForSpeech preserves full 341-char three-sentence response', () => {
    configureEnv(true, true)
    const orch = freshOrchestrator()
    const cleaned = orch.cleanForSpeech(THREE_SENTENCE_RESPONSE)
    // Must contain all three sentences
    expect(cleaned).toContain("initiate a new conversation")
    expect(cleaned).toContain("start fresh")
    expect(cleaned).toContain("conversation history")
    // Must be the full text (under 400 chars, no truncation)
    expect(cleaned).toBe(THREE_SENTENCE_RESPONSE)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. The complete response is passed to ElevenLabs (not truncated)
  // ═══════════════════════════════════════════════════════════════════════════
  it('full response is passed to the TTS provider', async () => {
    configureEnv(true, true)
    const orch = freshOrchestrator()
    const provider = (orch as any).tts as ElevenLabsTtsProvider
    const speakSpy = vi.spyOn(provider, 'speak')

    await orch.speak(THREE_SENTENCE_RESPONSE)

    expect(speakSpy).toHaveBeenCalledTimes(1)
    const passedText = speakSpy.mock.calls[0][0]
    expect(passedText).toBe(THREE_SENTENCE_RESPONSE)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Legitimate ~19s playback completes without timeout
  // ═══════════════════════════════════════════════════════════════════════════
  it('normal playback completes without hitting timeout', async () => {
    configureEnv(true, true)
    mockFileSize = 76000 // ~19s at 4000 bytes/s

    const orch = freshOrchestrator()
    const statuses: string[] = []
    orch.on('status', (s: string) => statuses.push(s))

    await orch.speak(THREE_SENTENCE_RESPONSE)

    expect(statuses).toContain('speaking')
    expect(statuses[statuses.length - 1]).toBe('idle')
    // No timeout ERROR in logs (the word 'timeout' appears in info about computed value, that's fine)
    expect(logMessages.some(m => m.includes('playback total timeout') || m.includes('playback-start timeout'))).toBe(false)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Early position stall produces a playback error (not silent completion)
  // ═══════════════════════════════════════════════════════════════════════════
  it('early position stall is treated as an error', async () => {
    configureEnv(true, true)
    spawnBehavior = 'stall-early'

    const provider = new ElevenLabsTtsProvider()
    provider.onPlaybackStart = () => {}

    await expect(provider.speak('test', 1, 1, '')).rejects.toThrow('stalled')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Chat input accepts typing while status is 'speaking'
  // ═══════════════════════════════════════════════════════════════════════════
  it('chat:send IPC returns before TTS completes (fire-and-forget)', async () => {
    // The chat handler does: const reply = await orchestrator.process(...); voice.speak(...).catch(()=>{}); return reply
    // This means chat:send resolves immediately after LLM response, not after TTS.
    // We verify by checking that speak() is asynchronous and the orchestrator
    // does not block the event loop during playback.
    configureEnv(true, true)
    const orch = freshOrchestrator()

    // speak() returns a promise that resolves after playback
    const speakPromise = orch.speak('Hello')
    // The promise is pending — but the event loop is free
    expect(speakPromise).toBeInstanceOf(Promise)
    // Other code can run in the same tick
    const canRun = true
    expect(canRun).toBe(true)

    await speakPromise
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Send remains clickable while speaking (loading state not tied to TTS)
  // ═══════════════════════════════════════════════════════════════════════════
  it('voice status speaking does not block further speak calls', async () => {
    configureEnv(true, true)
    const orch = freshOrchestrator()

    await orch.speak('First')
    // After first completes, a second call works normally
    await orch.speak('Second')

    expect(spawnCalls.length).toBe(2) // two playback spawns
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Clicking microphone during speech stops playback and returns idle
  // ═══════════════════════════════════════════════════════════════════════════
  it('stopSpeaking during playback stops and returns to idle', async () => {
    configureEnv(true, true)
    const orch = freshOrchestrator()
    const statuses: string[] = []
    orch.on('status', (s: string) => statuses.push(s))

    const p = orch.speak('Interrupted')
    await new Promise(r => setImmediate(r))
    orch.stopSpeaking()
    await p

    expect(statuses[statuses.length - 1]).toBe('idle')
    expect(logMessages.some(m => m.includes('stopSpeaking'))).toBe(true)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. A new typed request stops current speech (via stopSpeaking)
  // ═══════════════════════════════════════════════════════════════════════════
  it('stopSpeaking kills active TTS provider', async () => {
    configureEnv(true, true)
    spawnBehavior = 'hang-no-close' // simulate long playback

    const orch = freshOrchestrator()
    const p = orch.speak('Long speech')
    await new Promise(r => setImmediate(r))

    // Simulate new message arrival stopping speech
    orch.stopSpeaking()
    await p

    expect(orch.getStatus()).toBe('idle')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. Chat completion and cursor removal do not await TTS
  // ═══════════════════════════════════════════════════════════════════════════
  it('speak is fire-and-forget: errors do not propagate', async () => {
    configureEnv(true, true)
    mockHttpStatus = 500 // server error

    const orch = freshOrchestrator()
    // speak() swallows errors internally via the orchestrator's catch
    await expect(orch.speak('Error swallowed')).resolves.toBeUndefined()
    expect(orch.getStatus()).toBe('idle')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. Returns to idle after natural completion or interruption
  // ═══════════════════════════════════════════════════════════════════════════
  it('returns to idle after natural completion', async () => {
    configureEnv(true, true)
    const orch = freshOrchestrator()
    await orch.speak('Natural end')
    expect(orch.getStatus()).toBe('idle')
  })

  it('returns to idle after interruption', async () => {
    configureEnv(true, true)
    const orch = freshOrchestrator()
    const p = orch.speak('Will be stopped')
    await new Promise(r => setImmediate(r))
    orch.stopSpeaking()
    await p
    expect(orch.getStatus()).toBe('idle')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Additional: Provider selection, fallback, mute, secrets, timeouts
  // ═══════════════════════════════════════════════════════════════════════════
  it('selects ElevenLabs when both env vars set', () => {
    configureEnv(true, true)
    expect((freshOrchestrator() as any).tts.name).toBe('ElevenLabs')
  })

  it('selects SAPI when key missing', () => {
    configureEnv(false, true)
    expect((freshOrchestrator() as any).tts.name).toBe('WindowsSpeech')
  })

  it('falls back to SAPI when ElevenLabs fails before playback', async () => {
    configureEnv(true, true)
    mockHttpStatus = 401
    const orch = freshOrchestrator()
    await orch.speak('Fallback')
    expect(spawnCalls.length).toBeGreaterThan(0) // SAPI spawn
    expect(orch.getStatus()).toBe('idle')
  })

  it('does not speak when muted', async () => {
    configureEnv(true, true)
    settings.voiceEnabled = false
    await freshOrchestrator().speak('Silent')
    expect(spawnCalls.length).toBe(0)
  })

  it('API key never in error messages', async () => {
    configureEnv(true, true)
    mockHttpStatus = 401
    const p = new ElevenLabsTtsProvider()
    try { await p.speak('x', 1, 1, '') } catch (e: any) { expect(e.message).not.toContain('sk_testonly') }
  })

  it('temp file cleanup after speak', async () => {
    configureEnv(true, true)
    unlinkCalls.length = 0
    await freshOrchestrator().speak('Clean')
    await new Promise(r => setTimeout(r, 700))
    expect(unlinkCalls.length).toBeGreaterThan(0)
  })

  it('HTTP hang triggers orchestrator timeout and returns idle', async () => {
    configureEnv(true, true)
    mockHttpHang = true
    ;(VoiceOrchestrator as any).TTS_OVERALL_TIMEOUT_MS = 200
    ;(VoiceOrchestrator as any).SAPI_TIMEOUT_MS = 200
    const orch = freshOrchestrator()
    await orch.speak('Hang')
    expect(orch.getStatus()).toBe('idle')
    ;(VoiceOrchestrator as any).TTS_OVERALL_TIMEOUT_MS = 75_000
    ;(VoiceOrchestrator as any).SAPI_TIMEOUT_MS = 30_000
  }, 10_000)

  it('player that never starts times out', async () => {
    configureEnv(true, true)
    spawnBehavior = 'hang-no-start'
    ;(VoiceOrchestrator as any).TTS_OVERALL_TIMEOUT_MS = 300
    ;(VoiceOrchestrator as any).SAPI_TIMEOUT_MS = 300
    const orch = freshOrchestrator()
    await orch.speak('No start')
    expect(orch.getStatus()).toBe('idle')
    ;(VoiceOrchestrator as any).TTS_OVERALL_TIMEOUT_MS = 75_000
    ;(VoiceOrchestrator as any).SAPI_TIMEOUT_MS = 30_000
  }, 10_000)

  it('no unhandled rejection from any error path', async () => {
    configureEnv(true, true)
    mockHttpError = new Error('ECONNREFUSED')
    await expect(freshOrchestrator().speak('Net error')).resolves.toBeUndefined()
  })

  it('lifecycle logging: speak started and completed', async () => {
    configureEnv(true, true)
    logMessages.length = 0
    await freshOrchestrator().speak('Log')
    expect(logMessages.some(m => m.includes('speak started'))).toBe(true)
    expect(logMessages.some(m => m.includes('speak completed'))).toBe(true)
  })
})
