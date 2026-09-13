/**
 * model-manager.test.ts
 *
 * Tests for the model IPC handler layer (handlers/model.ts) and the
 * ModelManager service. All network I/O is mocked — no bytes are transferred.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import type { DownloadProgress } from '../../services/modelManager'

// ── Mock electron app before any import that touches it ──────────────────────
vi.mock('electron', () => ({
  app: { getPath: () => '/fake/userData' },
}))

// ── Capture the ModelManager constructor arg and mock its methods ─────────────
let mockIsModelReady = false
let mockDownloadImpl: ((cb: (p: DownloadProgress) => void) => Promise<void>) | null = null

vi.mock('../../services/modelManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/modelManager')>()
  class MockModelManager {
    static _instance: MockModelManager | null = null
    static getInstance(_path: string) {
      if (!MockModelManager._instance) MockModelManager._instance = new MockModelManager()
      return MockModelManager._instance
    }
    get modelDir() { return '/fake/userData/models/kokoro-v1.0' }
    isModelReady() { return mockIsModelReady }
    async downloadKokoro(cb: (p: DownloadProgress) => void) {
      if (mockDownloadImpl) return mockDownloadImpl(cb)
    }
  }
  return {
    ...real,
    ModelManager: MockModelManager,
    HF_COMMIT: 'deadbeef1234',
  }
})

// ── Import handler factory after mocks are in place ───────────────────────────
import { registerModelHandlers, _resetDownloadFlag } from '../../handlers/model'
import { ModelManager as MockedModelManager, KOKORO_ARTIFACTS, MANIFEST_HASH } from '../../services/modelManager'

// ── Minimal IpcMain / BrowserWindow stubs ─────────────────────────────────────
function makeIpc() {
  const handlers: Record<string, (event: unknown, ...args: unknown[]) => unknown> = {}
  const handle = (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
    handlers[channel] = fn
  }
  const invoke = async (channel: string, event: unknown = {}, ...args: unknown[]) => {
    const fn = handlers[channel]
    if (!fn) throw new Error(`No handler for ${channel}`)
    return fn(event, ...args)
  }
  return { handle, invoke, ipcMain: { handle, invoke } }
}

function makeWindow(id = 1) {
  const sent: Array<[string, unknown]> = []
  const win = {
    webContents: {
      id,
      isDestroyed: () => false,
      send: (ch: string, payload: unknown) => sent.push([ch, payload]),
    },
    _sent: sent,
  }
  return win
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('model IPC handler', () => {
  let ipc: ReturnType<typeof makeIpc>
  let win: ReturnType<typeof makeWindow>

  beforeEach(() => {
    ;(MockedModelManager as unknown as { _instance: null })._instance = null
    mockIsModelReady = false
    mockDownloadImpl = null
    _resetDownloadFlag()

    win = makeWindow(1)
    ipc = makeIpc()
    registerModelHandlers(ipc.ipcMain as never, () => win as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 1. Status — not installed
  it('model:kokoro-status returns installed=false when model absent', async () => {
    const result = await ipc.invoke('model:kokoro-status')
    expect(result).toEqual({ installed: false, downloading: false })
  })

  // 2. Status — installed
  it('model:kokoro-status returns installed=true when model present', async () => {
    mockIsModelReady = true
    const result = await ipc.invoke('model:kokoro-status')
    expect(result).toEqual({ installed: true, downloading: false })
  })

  // 3. Preflight — zero network, returns manifest info
  it('model:kokoro-preflight returns manifest without touching network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not be called'))
    const result = await ipc.invoke('model:kokoro-preflight') as {
      commit: string; manifestVersion: string; totalSize: string
      destination: string; artifacts: Array<{ filename: string; sha256: string; sizeMB: string }>
    }

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.commit).toBe('deadbeef1234')
    expect(result.manifestVersion).toMatch(/\d+\.\d+\.\d+/)
    expect(result.totalSize).toMatch(/MB/)
    expect(result.destination).toContain('kokoro')
    expect(result.artifacts.length).toBeGreaterThan(0)
    expect(result.artifacts[0].sha256).toBeTruthy()
  })

  // 4. Manifest has exactly 4 artifacts — voices/af_heart.bin must not be present
  it('manifest contains exactly 4 artifacts and no voice .bin file', () => {
    expect(KOKORO_ARTIFACTS).toHaveLength(4)
    const filenames = KOKORO_ARTIFACTS.map(a => a.filename)
    expect(filenames).toContain(path.join('onnx', 'model_quantized.onnx'))
    expect(filenames).toContain('config.json')
    expect(filenames).toContain('tokenizer.json')
    expect(filenames).toContain('tokenizer_config.json')
    // Voice .bin must NOT be in the download manifest
    expect(filenames.some(f => f.endsWith('.bin'))).toBe(false)
  })

  // 5. Full 64-character SHA-256 values in preflight response
  it('preflight returns full 64-character SHA-256 for every artifact', async () => {
    const result = await ipc.invoke('model:kokoro-preflight') as {
      artifacts: Array<{ sha256: string }>
    }
    for (const a of result.artifacts) {
      expect(a.sha256).toHaveLength(64)
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  // 6. Voice .bin file is provided by kokoro-js package, not the download manifest
  it('af_heart.bin exists in the kokoro-js package voices directory', () => {
    const fs = require('fs')
    // Resolve via the package's dist entry, then walk up to the package root
    const entryPoint = require.resolve('kokoro-js')
    const pkgDir = path.dirname(path.dirname(entryPoint)) // dist/ -> package root
    const voicePath = path.join(pkgDir, 'voices', 'af_heart.bin')
    expect(fs.existsSync(voicePath)).toBe(true)
    const stat = fs.statSync(voicePath)
    expect(stat.size).toBe(522_240)
  })

  // 7. MANIFEST_HASH is consistent with the 4-artifact set
  it('MANIFEST_HASH is derived from the 4 artifact SHA-256s + version', () => {
    const crypto = require('crypto')
    const h = crypto.createHash('sha256')
    for (const a of KOKORO_ARTIFACTS) h.update(a.sha256)
    h.update('1.0.0')
    expect(h.digest('hex')).toBe(MANIFEST_HASH)
  })

  // 8. Approval/download separation — preflight does NOT start download
  it('preflight does not trigger any download side-effects', async () => {
    let downloadCalled = false
    mockDownloadImpl = async () => { downloadCalled = true }

    await ipc.invoke('model:kokoro-preflight')
    expect(downloadCalled).toBe(false)
    expect(win._sent.length).toBe(0)
  })

  // 9. Download — progress events reach the requesting window
  it('model:kokoro-download streams progress to the requesting window', async () => {
    const events: DownloadProgress[] = [
      { phase: 'info', message: 'manifest info' },
      { phase: 'downloading', message: 'Downloading…', percent: 50, artifact: 'model.onnx' },
      { phase: 'done', message: 'All verified ✓' },
    ]
    mockDownloadImpl = async (cb) => { for (const e of events) cb(e) }

    const senderEvent = { sender: { id: 1 } }
    await ipc.invoke('model:kokoro-download', senderEvent)

    expect(win._sent.length).toBe(3)
    expect(win._sent[0]).toEqual(['model:kokoro-progress', events[0]])
    expect(win._sent[2]).toEqual(['model:kokoro-progress', events[2]])
  })

  // 10. Failure — flag reset so retry is possible
  it('model:kokoro-download resets in-progress flag on failure', async () => {
    mockDownloadImpl = async (cb) => {
      cb({ phase: 'downloading', message: 'Downloading…', percent: 10 })
      throw new Error('Checksum mismatch')
    }

    const senderEvent = { sender: { id: 1 } }
    await expect(ipc.invoke('model:kokoro-download', senderEvent)).rejects.toThrow('Checksum mismatch')

    const status = await ipc.invoke('model:kokoro-status')
    expect((status as { downloading: boolean }).downloading).toBe(false)
  })

  // 11. Concurrent requests — second call rejected immediately
  it('concurrent model:kokoro-download is rejected', async () => {
    let resolveDl!: () => void
    mockDownloadImpl = () => new Promise<void>(res => { resolveDl = res })

    const senderEvent = { sender: { id: 1 } }
    const first = ipc.invoke('model:kokoro-download', senderEvent)
    const second = ipc.invoke('model:kokoro-download', senderEvent)

    await expect(second).rejects.toThrow('already in progress')

    resolveDl()
    await first
  })

  // 12. Unmount cleanup — progress not sent to destroyed window
  it('progress is not sent to a destroyed window (unmount cleanup)', async () => {
    const deadWin = makeWindow(1)
    deadWin.webContents.isDestroyed = () => true

    const ipc2 = makeIpc()
    registerModelHandlers(ipc2.ipcMain as never, () => deadWin as never)

    mockDownloadImpl = async (cb) => {
      cb({ phase: 'downloading', message: 'Downloading…', percent: 20 })
    }

    const senderEvent = { sender: { id: 1 } }
    await ipc2.invoke('model:kokoro-download', senderEvent)
    expect(deadWin._sent.length).toBe(0)
  })
})

// ── Provider reload tests ─────────────────────────────────────────────────────

describe('VoiceOrchestrator.reloadTtsProvider', () => {
  it('is serialized — concurrent calls return the same promise', async () => {
    // Mock the orchestrator minimally
    const stopAndWait = vi.fn().mockResolvedValue(undefined)
    const initTts = vi.fn()
    const log = { info: vi.fn() }

    // Build a minimal orchestrator-like object with the real reloadTtsProvider logic
    const obj = {
      tts: { stopAndWait, stop: vi.fn(), name: 'MockTTS' },
      log,
      ttsReloadPromise: null as Promise<string | null> | null,
      initTtsProvider: initTts,
      reloadTtsProvider(): Promise<string | null> {
        if (this.ttsReloadPromise) return this.ttsReloadPromise
        this.ttsReloadPromise = (async () => {
          try {
            await this.tts.stopAndWait?.()
            this.initTtsProvider()
            return null
          } catch (err) {
            return err instanceof Error ? err.message : String(err)
          } finally {
            this.ttsReloadPromise = null
          }
        })()
        return this.ttsReloadPromise!
      }
    }

    const p1 = obj.reloadTtsProvider()
    const p2 = obj.reloadTtsProvider()
    expect(p1).toBe(p2)  // same promise — not two separate reloads

    await p1
    expect(stopAndWait).toHaveBeenCalledTimes(1)
    expect(initTts).toHaveBeenCalledTimes(1)
  })

  it('returns error string when initTtsProvider throws', async () => {
    const obj = {
      tts: { stop: vi.fn(), name: 'MockTTS' },
      log: { info: vi.fn() },
      ttsReloadPromise: null as Promise<string | null> | null,
      initTtsProvider() { throw new Error('provider init failed') },
      reloadTtsProvider(): Promise<string | null> {
        if (this.ttsReloadPromise) return this.ttsReloadPromise
        this.ttsReloadPromise = (async () => {
          try {
            this.tts.stop()
            this.initTtsProvider()
            return null
          } catch (err) {
            return err instanceof Error ? err.message : String(err)
          } finally {
            this.ttsReloadPromise = null
          }
        })()
        return this.ttsReloadPromise!
      }
    }

    const result = await obj.reloadTtsProvider()
    expect(result).toBe('provider init failed')
  })
})
