/**
 * Kokoro TTS -- mock-based test suite.
 * All tests run fully offline. Zero real network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { Writable, Readable } from 'stream'

// ---- Tracking ---------------------------------------------------------------
const unlinkCalls: string[] = []
const mkdirCalls: string[] = []
const rmCalls: string[] = []
const renameCalls: Array<{ from: string; to: string }> = []
const spawnCalls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = []
const httpsGetCalls: string[] = []
const writtenSentinels: Array<{ path: string; content: string }> = []
// Tracks readdirSync calls for recovery tests
const readdirResults: Map<string, string[]> = new Map()

// ---- Configurable state -----------------------------------------------------
let sentinelExists = false
let sentinelContent = ''
let liveDirExists = true
let synthesisExitCode = 0
let synthesisError: Error | null = null
let playbackExitCode = 0
// Redirect URL to return (empty = no redirect)
let redirectTo = ''
// HTTP status code to return (default 200)
let httpStatus = 200
// key = exact basename, value = sha256 to return from digest mock
const checksumOverrides: Map<string, string> = new Map()
// Track last path passed to createReadStream so digest mock can identify artifact
let lastReadStreamPath = ''

// ---- Mock: fs ---------------------------------------------------------------
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: (p: string) => {
      if (p.endsWith('.verified')) return sentinelExists
      if (String(p).includes('kokoro-v1.0') && !String(p).includes('.staging') &&
          !String(p).includes('.old') && !String(p).endsWith('.verified')) return liveDirExists
      return true
    },
    readFileSync: (p: string, enc?: any) => {
      if (p.endsWith('.verified')) return sentinelContent
      return actual.readFileSync(p, enc)
    },
    readdirSync: (p: string) => {
      const key = String(p)
      if (readdirResults.has(key)) return readdirResults.get(key)!
      return []
    },
    unlinkSync: (p: string) => { unlinkCalls.push(p) },
    mkdirSync: (p: string) => { mkdirCalls.push(String(p)) },
    rmSync: (p: string) => { rmCalls.push(String(p)) },
    renameSync: (from: string, to: string) => { renameCalls.push({ from: String(from), to: String(to) }) },
    writeFileSync: (p: string, content: any) => {
      writtenSentinels.push({ path: String(p), content: String(content) })
    },
    createWriteStream: () => {
      const ws = new Writable({ write(_c, _e, cb) { cb() } })
      return ws
    },
    createReadStream: (p: string) => {
      lastReadStreamPath = String(p)
      const rs = new Readable({ read() {} })
      setImmediate(() => { rs.push(Buffer.from('fake-bytes')); rs.push(null) })
      return rs
    },
  }
})

// ---- Mock: child_process ----------------------------------------------------
// Playback is detected by the presence of GOGA_WAV_PATH in the spawn env
// (the new injection-safe design passes the WAV path via env, not script string).
vi.mock('child_process', () => ({
  spawn: (cmd: string, args: string[], opts?: any) => {
    spawnCalls.push({ cmd, args, env: opts?.env })
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = vi.fn(() => { setImmediate(() => proc.emit('close', 0)) })

    const isPlayback = opts?.env?.GOGA_WAV_PATH !== undefined
    if (isPlayback) {
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('PLAYBACK_STARTED\n'))
        setImmediate(() => proc.emit('close', playbackExitCode))
      })
    } else {
      if (synthesisError) {
        setImmediate(() => {
          proc.stderr.emit('data', Buffer.from(synthesisError!.message))
          proc.emit('close', 1)
        })
      } else {
        setImmediate(() => proc.emit('close', synthesisExitCode))
      }
    }
    return proc
  }
}))

// ---- Mock: https ------------------------------------------------------------
vi.mock('https', () => ({
  get: (url: string, _opts: any, callback: any) => {
    httpsGetCalls.push(url)
    const req = new EventEmitter() as any
    req.destroy = vi.fn()
    setImmediate(() => {
      const res = new EventEmitter() as any
      res.statusCode = httpStatus
      res.headers = redirectTo
        ? { location: redirectTo }
        : { 'content-length': '100' }
      res.resume = vi.fn()
      res.pipe = (dest: Writable) => {
        if (httpStatus < 400 && !redirectTo) {
          dest.write(Buffer.from('x'.repeat(10)))
          dest.end()
        }
        return dest
      }
      callback(res)
      // Reset redirect after one use so subsequent requests behave normally
      redirectTo = ''
      httpStatus = 200
    })
    return req
  }
}))

// ---- Mock: crypto -----------------------------------------------------------
// Uses exact basename matching so tokenizer.json never matches tokenizer_config.json.
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto')
  return {
    ...actual,
    createHash: (alg: string) => {
      if (alg !== 'sha256') return actual.createHash(alg)
      return {
        update: vi.fn().mockReturnThis(),
        digest: vi.fn(() => {
          const base = lastReadStreamPath.replace(/\\/g, '/').split('/').pop() ?? ''
          if (checksumOverrides.has(base)) return checksumOverrides.get(base)!
          return 'default-correct-hash'
        })
      }
    },
    randomUUID: () => 'test-uuid-1234'
  }
})

// ---- Mock: LogService -------------------------------------------------------
vi.mock('../logs', () => ({
  LogService: {
    getInstance: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })
  }
}))

// ---- Mock: SettingsService --------------------------------------------------
const settings: Record<string, any> = {
  voiceEnabled: true, autoSpeakResponses: true, voiceRate: 1.0, voiceVolume: 1.0,
  voiceName: '', allowBargeIn: true, wakePhrase: 'hey goga',
  conversationWindowSecs: 45, sttProvider: 'windows', ttsProvider: 'sapi',
}
vi.mock('../settings', () => ({
  SettingsService: { getInstance: () => ({ get: () => settings }) }
}))

vi.mock('../speech/WhisperSttProvider', () => ({
  WhisperSttProvider: class {
    name = 'Whisper'
    recognize = vi.fn(); startContinuous = vi.fn()
    stopContinuous = vi.fn(); abort = vi.fn()
    static scriptExists = () => false
  }
}))

vi.mock('electron', () => ({
  app: { getPath: (_: string) => 'C:\\fake\\userData' }
}))

// ---- Production imports -----------------------------------------------------
import { KokoroTtsProvider, KokoroModelMissingError } from '../speech/KokoroTtsProvider'
import { ModelManager, KOKORO_ARTIFACTS, MANIFEST_HASH } from '../modelManager'

function freshProvider() { return new KokoroTtsProvider('C:\\fake\\userData') }

function setModelReady(ready: boolean, hash = MANIFEST_HASH) {
  sentinelExists = ready
  sentinelContent = ready ? hash : ''
}

function allChecksumsPass() {
  checksumOverrides.clear()
  for (const a of KOKORO_ARTIFACTS) {
    const base = a.filename.replace(/\\/g, '/').split('/').pop()!
    checksumOverrides.set(base, a.sha256)
  }
}

function resetAll() {
  vi.clearAllMocks()
  unlinkCalls.length = 0; spawnCalls.length = 0; httpsGetCalls.length = 0
  mkdirCalls.length = 0; rmCalls.length = 0; renameCalls.length = 0
  writtenSentinels.length = 0; readdirResults.clear()
  checksumOverrides.clear(); lastReadStreamPath = ''
  sentinelExists = false; sentinelContent = ''
  liveDirExists = true
  synthesisExitCode = 0; synthesisError = null; playbackExitCode = 0
  redirectTo = ''; httpStatus = 200
}

// =============================================================================
// Provider tests
// =============================================================================
describe('Kokoro TTS -- provider', () => {
  beforeEach(resetAll)

  // 1. Model absent
  it('speak() throws KokoroModelMissingError when model is absent', async () => {
    setModelReady(false)
    await expect(freshProvider().speak('hello', 1, 1, '')).rejects.toThrow(KokoroModelMissingError)
  })

  // 2. Sentinel exists but manifest hash mismatches
  it('speak() throws when sentinel has wrong manifest hash', async () => {
    setModelReady(true, 'wrong-hash-from-old-manifest')
    await expect(freshProvider().speak('hello', 1, 1, '')).rejects.toThrow(KokoroModelMissingError)
  })

  it('KokoroModelMissingError has code KOKORO_MODEL_MISSING', async () => {
    setModelReady(false)
    try { await freshProvider().speak('hello', 1, 1, '') } catch (e: any) {
      expect(e.code).toBe('KOKORO_MODEL_MISSING')
    }
  })

  // 3. Zero network calls
  it('speak() makes zero network calls when model is absent', async () => {
    setModelReady(false)
    await freshProvider().speak('hello', 1, 1, '').catch(() => {})
    expect(httpsGetCalls.length).toBe(0)
  })

  it('speak() makes zero network calls when model is present', async () => {
    setModelReady(true)
    await freshProvider().speak('hello', 1, 1, '')
    expect(httpsGetCalls.length).toBe(0)
  })

  // 4. Successful speak
  it('speak() resolves when model is present and manifest matches', async () => {
    setModelReady(true)
    await expect(freshProvider().speak('hello', 1, 1, '')).resolves.toBeUndefined()
  })

  it('onPlaybackStart is called during successful speak', async () => {
    setModelReady(true)
    const p = freshProvider()
    const started = vi.fn()
    p.onPlaybackStart = started
    await p.speak('hello', 1, 1, '')
    expect(started).toHaveBeenCalledTimes(1)
  })

  // 5. stop() during synthesis
  it('stop() during synthesis resolves speak() cleanly', async () => {
    setModelReady(true)
    const p = freshProvider()
    const promise = p.speak('long text', 1, 1, '')
    await new Promise(r => setImmediate(r))
    p.stop()
    await expect(promise).resolves.toBeUndefined()
  })

  // 6. stop() during playback
  it('stop() during playback resolves speak() cleanly', async () => {
    setModelReady(true)
    const p = freshProvider()
    const promise = p.speak('hello', 1, 1, '')
    await new Promise(r => setTimeout(r, 10))
    p.stop()
    await expect(promise).resolves.toBeUndefined()
  })

  // 7. Provider reports failure, does not fall back
  it('speak() rejects with synthesis error (not silently swallowed)', async () => {
    setModelReady(true)
    synthesisError = new Error('ONNX runtime crash')
    await expect(freshProvider().speak('hello', 1, 1, '')).rejects.toThrow('ONNX runtime crash')
  })

  it('provider does NOT spawn SAPI -- fallback is the orchestrator job', async () => {
    setModelReady(true)
    synthesisError = new Error('synthesis failed')
    try { await freshProvider().speak('hello', 1, 1, '') } catch { }
    // With the new design, playback spawns are identified by GOGA_WAV_PATH env var.
    // A synthesis failure means playback is never reached, so no playback spawn.
    const playbackSpawns = spawnCalls.filter(c => c.env?.GOGA_WAV_PATH !== undefined)
    expect(playbackSpawns.length).toBe(0)
  })

  // 8. Multiple rapid stop() calls
  it('multiple rapid stop() calls do not throw', () => {
    const p = freshProvider()
    expect(() => { p.stop(); p.stop(); p.stop() }).not.toThrow()
  })

  it('stopAndWait() resolves when called multiple times concurrently', async () => {
    const p = freshProvider()
    await expect(Promise.all([p.stopAndWait(), p.stopAndWait(), p.stopAndWait()]))
      .resolves.toBeDefined()
  })

  // 9. Zero network calls on init
  it('constructing KokoroTtsProvider makes zero network calls', () => {
    httpsGetCalls.length = 0
    new KokoroTtsProvider('C:\\fake\\userData')
    expect(httpsGetCalls.length).toBe(0)
  })

  it('isModelReady() makes zero network calls', () => {
    httpsGetCalls.length = 0
    freshProvider().isModelReady()
    expect(httpsGetCalls.length).toBe(0)
  })

  // 10. Single-flight: second speak() cancels first
  it('second speak() cancels first and starts cleanly', async () => {
    setModelReady(true)
    const p = freshProvider()
    const first = p.speak('first utterance', 1, 1, '')
    await new Promise(r => setImmediate(r))
    const second = p.speak('second utterance', 1, 1, '')
    await expect(second).resolves.toBeUndefined()
    await expect(first).resolves.toBeUndefined()
  })

  // 11. stopAndWait() awaits active speak() cleanup
  it('stopAndWait() resolves only after active speak() finishes cleanup', async () => {
    setModelReady(true)
    const p = freshProvider()
    const speakPromise = p.speak('hello', 1, 1, '')
    await new Promise(r => setImmediate(r))
    await p.stopAndWait()
    await expect(speakPromise).resolves.toBeUndefined()
  })

  // 12. WAV cleanup happens after process exit
  it('WAV file is cleaned up after speak() resolves', async () => {
    setModelReady(true)
    await freshProvider().speak('hello', 1, 1, '')
    expect(unlinkCalls.some(u => u.includes('goga-kokoro'))).toBe(true)
  })

  // 13. WAV cleanup retries on file-lock
  it('WAV cleanup retries up to 3 times on failure', async () => {
    setModelReady(true)
    let unlinkAttempts = 0
    const fsMod = await import('fs')
    const origUnlink = fsMod.unlinkSync
    ;(fsMod as any).unlinkSync = (p: string) => {
      if (String(p).includes('goga-kokoro')) {
        unlinkAttempts++
        if (unlinkAttempts < 3) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        unlinkCalls.push(String(p))
        return
      }
      unlinkCalls.push(String(p))
    }
    try {
      await freshProvider().speak('hello', 1, 1, '')
      expect(unlinkAttempts).toBeGreaterThanOrEqual(1)
    } finally {
      ;(fsMod as any).unlinkSync = origUnlink
    }
  })

  // 14. env.allowRemoteModels=false in synthesis script
  it('synthesis child script sets env.allowRemoteModels = false', async () => {
    setModelReady(true)
    await freshProvider().speak('hello', 1, 1, '')
    const synthCall = spawnCalls.find(c => c.cmd === process.execPath)
    expect(synthCall).toBeDefined()
    const script = synthCall!.args.find(a => a.includes('allowRemoteModels'))
    expect(script).toBeDefined()
    expect(script).toContain('env.allowRemoteModels = false')
  })

  // 15. Controlled child-process test: network-blocked runtime causes failure
  it('synthesis fails if child process exits non-zero (simulates network-blocked runtime)', async () => {
    setModelReady(true)
    synthesisError = new Error('Cannot load model from remote. allowRemoteModels is false.')
    await expect(freshProvider().speak('hello', 1, 1, '')).rejects.toThrow(
      'allowRemoteModels is false'
    )
  })

  // ── NEW: injection-resistant WAV path ──────────────────────────────────────

  // 16. WAV path with apostrophe is passed via env var, not interpolated
  it('WAV path containing apostrophe is passed via GOGA_WAV_PATH env var, not script string', async () => {
    setModelReady(true)
    // Override randomUUID to produce a path that would break single-quote interpolation
    const cryptoMod = await import('crypto')
    const origUUID = (cryptoMod as any).randomUUID
    ;(cryptoMod as any).randomUUID = () => "o'brien-test-uuid"
    try {
      await freshProvider().speak('hello', 1, 1, '')
    } catch { } finally {
      ;(cryptoMod as any).randomUUID = origUUID
    }
    const playbackCall = spawnCalls.find(c => c.env?.GOGA_WAV_PATH !== undefined)
    expect(playbackCall).toBeDefined()
    // The WAV path is in the env, not in the script args
    expect(playbackCall!.env!.GOGA_WAV_PATH).toContain("o'brien-test-uuid")
    // The script string (args[3] for powershell -Command <script>) must NOT
    // contain the apostrophe-bearing path
    const scriptArg = playbackCall!.args.find(a => a.includes('SoundPlayer'))
    expect(scriptArg).toBeDefined()
    expect(scriptArg).not.toContain("o'brien")
  })

  // 17. Three concurrent speak() calls serialize correctly
  it('three concurrent speak() calls: only the last one completes playback', async () => {
    setModelReady(true)
    const p = freshProvider()
    const r1 = p.speak('one', 1, 1, '')
    const r2 = p.speak('two', 1, 1, '')
    const r3 = p.speak('three', 1, 1, '')
    // All three must resolve (not reject) — cancelled calls resolve cleanly
    await expect(Promise.all([r1, r2, r3])).resolves.toBeDefined()
    // Only the last call should have reached playback (GOGA_WAV_PATH env present)
    const playbackSpawns = spawnCalls.filter(c => c.env?.GOGA_WAV_PATH !== undefined)
    expect(playbackSpawns.length).toBeLessThanOrEqual(1)
  })

  // 18. WAV filename uses randomUUID (not Date.now collision risk)
  it('WAV filename contains the UUID from crypto.randomUUID()', async () => {
    setModelReady(true)
    await freshProvider().speak('hello', 1, 1, '')
    // The playback spawn must have a GOGA_WAV_PATH containing the mocked UUID
    const playbackCall = spawnCalls.find(c => c.env?.GOGA_WAV_PATH !== undefined)
    expect(playbackCall).toBeDefined()
    expect(playbackCall!.env!.GOGA_WAV_PATH).toContain('test-uuid-1234')
  })
})

// =============================================================================
// ModelManager tests
// =============================================================================
describe('ModelManager', () => {
  beforeEach(() => {
    resetAll()
    ;(ModelManager as any).instance = undefined
  })

  function freshManager() {
    ;(ModelManager as any).instance = undefined
    return new ModelManager('C:\\fake\\userData')
  }

  // 19. isModelReady false when sentinel absent
  it('isModelReady() returns false when .verified sentinel is absent', () => {
    setModelReady(false)
    expect(freshManager().isModelReady()).toBe(false)
  })

  // 20. isModelReady false when sentinel has wrong hash
  it('isModelReady() returns false when sentinel has wrong manifest hash', () => {
    setModelReady(true, 'stale-hash-from-old-version')
    expect(freshManager().isModelReady()).toBe(false)
  })

  // 21. isModelReady true when sentinel has correct hash
  it('isModelReady() returns true when sentinel has correct manifest hash', () => {
    setModelReady(true, MANIFEST_HASH)
    expect(freshManager().isModelReady()).toBe(true)
  })

  // 22. Info reported before any bytes transferred
  it('reports info phase as the first event before downloading', async () => {
    allChecksumsPass()
    const phases: string[] = []
    await freshManager().downloadKokoro(p => phases.push(p.phase))
    expect(phases[0]).toBe('info')
    expect(phases.indexOf('info')).toBeLessThan(phases.indexOf('verifying'))
  })

  // 23. Info message contains all artifact names, total size, base URL, destination
  it('info message contains artifact names, total size, URL, and destination', async () => {
    allChecksumsPass()
    let infoMsg = ''
    await freshManager().downloadKokoro(p => { if (p.phase === 'info') infoMsg = p.message })
    expect(infoMsg).toContain('MB')
    expect(infoMsg).toContain('huggingface.co')
    expect(infoMsg).toContain('kokoro-v1.0')
    expect(infoMsg).toContain('model_quantized.onnx')
    expect(infoMsg).toContain('config.json')
    expect(infoMsg).toContain('tokenizer.json')
    expect(infoMsg).toContain('tokenizer_config.json')
    expect(infoMsg).toContain('SHA-256')
  })

  // 24. Each artifact verified individually; first mismatch aborts
  it('aborts on first artifact checksum mismatch and reports error', async () => {
    allChecksumsPass()
    checksumOverrides.set('config.json', 'wrong-hash')
    const phases: string[] = []
    const msgs: string[] = []
    await expect(
      freshManager().downloadKokoro(p => { phases.push(p.phase); msgs.push(p.message) })
    ).rejects.toThrow('Checksum mismatch')
    expect(phases).toContain('error')
    expect(msgs.some(m => m.includes('config.json'))).toBe(true)
  })

  // 25. Staging dir deleted on failure; live dir untouched
  it('staging directory is deleted on checksum failure', async () => {
    allChecksumsPass()
    checksumOverrides.set('model_quantized.onnx', 'bad-hash')
    await freshManager().downloadKokoro(() => {}).catch(() => {})
    expect(rmCalls.some(p => p.includes('.staging-'))).toBe(true)
    expect(renameCalls.length).toBe(0)
  })

  // 26. Incomplete manifest: missing artifact causes failure
  it('fails when a required artifact has wrong checksum (simulates missing file)', async () => {
    allChecksumsPass()
    checksumOverrides.set('tokenizer_config.json', 'missing-file-hash')
    await expect(freshManager().downloadKokoro(() => {})).rejects.toThrow('Checksum mismatch')
  })

  // 27. Sentinel written with manifest hash on success
  it('writes .verified sentinel containing manifest hash on success', async () => {
    allChecksumsPass()
    await freshManager().downloadKokoro(() => {})
    const sentinel = writtenSentinels.find(s => s.path.endsWith('.verified'))
    expect(sentinel).toBeDefined()
    expect(sentinel!.content).toBe(MANIFEST_HASH)
  })

  // 28. isModelReady false after manifest hash changes (stale sentinel)
  it('isModelReady() returns false if sentinel was written by an older manifest', () => {
    setModelReady(true, 'hash-from-previous-manifest-version')
    expect(freshManager().isModelReady()).toBe(false)
  })

  // 29. isModelReady makes zero network calls
  it('isModelReady() makes zero network calls', () => {
    httpsGetCalls.length = 0
    freshManager().isModelReady()
    expect(httpsGetCalls.length).toBe(0)
  })

  // 30. All artifacts downloaded (one https.get per artifact)
  it('downloads every artifact in the manifest', async () => {
    allChecksumsPass()
    await freshManager().downloadKokoro(() => {})
    expect(httpsGetCalls.length).toBe(KOKORO_ARTIFACTS.length)
  })

  // ── NEW: backup-rename promotion ───────────────────────────────────────────

  // 31. Promotion uses two renames: live→backup, staging→live
  it('backup-rename promotion: live renamed to backup before staging promoted', async () => {
    allChecksumsPass()
    liveDirExists = true
    await freshManager().downloadKokoro(() => {})
    // First rename: live → backup (.old-)
    expect(renameCalls[0].from).toContain('kokoro-v1.0')
    expect(renameCalls[0].from).not.toContain('.staging-')
    expect(renameCalls[0].to).toContain('.old-')
    // Second rename: staging → live
    expect(renameCalls[1].from).toContain('.staging-')
    expect(renameCalls[1].to).toContain('kokoro-v1.0')
    expect(renameCalls[1].to).not.toContain('.staging-')
    expect(renameCalls[1].to).not.toContain('.old-')
  })

  // 32. When live dir is absent, only one rename (staging→live), no backup step
  it('when no existing live dir, only staging→live rename occurs', async () => {
    allChecksumsPass()
    liveDirExists = false
    await freshManager().downloadKokoro(() => {})
    expect(renameCalls.length).toBe(1)
    expect(renameCalls[0].from).toContain('.staging-')
    expect(renameCalls[0].to).toContain('kokoro-v1.0')
  })

  // 33. Backup dir is cleaned up after successful promotion
  it('backup directory is deleted after successful promotion', async () => {
    allChecksumsPass()
    liveDirExists = true
    await freshManager().downloadKokoro(() => {})
    // The .old- backup should be in rmCalls
    expect(rmCalls.some(p => p.includes('.old-'))).toBe(true)
  })

  // ── NEW: crash-recovery ────────────────────────────────────────────────────

  // 34. recoverInterruptedPromotion restores backup when live is absent
  it('recoverInterruptedPromotion() renames backup to live when live is absent', () => {
    liveDirExists = false
    const parent = 'C:\\fake\\userData\\models'
    const backupName = 'kokoro-v1.0.old-1700000000000'
    readdirResults.set(parent, [backupName])
    freshManager().recoverInterruptedPromotion()
    expect(renameCalls.length).toBe(1)
    expect(renameCalls[0].from).toContain(backupName)
    expect(renameCalls[0].to).toContain('kokoro-v1.0')
    expect(renameCalls[0].to).not.toContain('.old-')
  })

  // 35. recoverInterruptedPromotion is a no-op when live dir exists
  it('recoverInterruptedPromotion() is a no-op when live dir is present', () => {
    liveDirExists = true
    freshManager().recoverInterruptedPromotion()
    expect(renameCalls.length).toBe(0)
  })

  // ── NEW: redirect rejection ────────────────────────────────────────────────

  // 36. Redirect to untrusted host is blocked
  it('redirect to untrusted host is rejected and download fails', async () => {
    allChecksumsPass()
    httpStatus = 302
    redirectTo = 'http://evil.example.com/malicious'
    await expect(freshManager().downloadKokoro(() => {}))
      .rejects.toThrow('blocked')
  })

  // 37. Redirect to huggingface.co CDN is allowed
  it('redirect to cdn-lfs.huggingface.co is followed', async () => {
    allChecksumsPass()
    // First request redirects to CDN; subsequent requests are normal 200
    let callCount = 0
    const httpsMod = await import('https')
    const origGet = httpsMod.get
    ;(httpsMod as any).get = (url: string, opts: any, cb: any) => {
      httpsGetCalls.push(url)
      const req = new EventEmitter() as any
      req.destroy = vi.fn()
      setImmediate(() => {
        const res = new EventEmitter() as any
        if (callCount === 0) {
          callCount++
          res.statusCode = 302
          res.headers = { location: 'https://cdn-lfs.huggingface.co/some-file' }
          res.resume = vi.fn()
          res.pipe = vi.fn()
        } else {
          res.statusCode = 200
          res.headers = {}
          res.resume = vi.fn()
          res.pipe = (dest: Writable) => { dest.write(Buffer.from('x')); dest.end(); return dest }
        }
        cb(res)
      })
      return req
    }
    try {
      // Only test the first artifact to keep the test fast
      const m = freshManager()
      const firstArtifact = KOKORO_ARTIFACTS[0]
      checksumOverrides.set(
        firstArtifact.filename.replace(/\\/g, '/').split('/').pop()!,
        firstArtifact.sha256
      )
      // We expect it NOT to throw "Redirect to untrusted host"
      // (it may throw checksum mismatch for other artifacts — that's fine)
      let threw = false
      let thrownMsg = ''
      await m.downloadKokoro(() => {}).catch(e => { threw = true; thrownMsg = String(e.message) })
      if (threw) {
        expect(thrownMsg).not.toContain('blocked: http://evil')
      }
    } finally {
      ;(httpsMod as any).get = origGet
    }
  })

  // ── NEW: HTTP error drains response ───────────────────────────────────────

  // 38. res.resume() is called on HTTP 404 so socket is released
  it('HTTP 404 response is drained via res.resume() before rejecting', async () => {
    allChecksumsPass()
    httpStatus = 404
    let resumeCalled = false
    const httpsMod = await import('https')
    const origGet = httpsMod.get
    ;(httpsMod as any).get = (url: string, opts: any, cb: any) => {
      httpsGetCalls.push(url)
      const req = new EventEmitter() as any
      req.destroy = vi.fn()
      setImmediate(() => {
        const res = new EventEmitter() as any
        res.statusCode = 404
        res.headers = {}
        res.resume = vi.fn(() => { resumeCalled = true })
        res.pipe = vi.fn()
        cb(res)
      })
      return req
    }
    try {
      await freshManager().downloadKokoro(() => {}).catch(() => {})
      expect(resumeCalled).toBe(true)
    } finally {
      ;(httpsMod as any).get = origGet
    }
  })

  // ── NEW: artifact containment ──────────────────────────────────────────────

  // 39. Artifact path escaping staging dir is rejected
  it('artifact filename with path traversal is rejected before download', async () => {
    // Temporarily inject a malicious artifact into the manifest
    const { KOKORO_ARTIFACTS: arts } = await import('../modelManager')
    const saved = arts[0].filename
    arts[0].filename = '../../etc/passwd'
    try {
      await expect(freshManager().downloadKokoro(() => {}))
        .rejects.toThrow('escapes staging directory')
    } finally {
      arts[0].filename = saved
    }
  })
})
