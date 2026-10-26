import { describe, expect, it, vi } from 'vitest'
vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => ({}) }) } }))
import { LocalLlamaService } from '../localLlama'

function loadingService() {
  const svc = new (LocalLlamaService as any)() as LocalLlamaService
  let finish!: () => void
  ;(svc as any).state = { status: 'loading', modelPath: 'fixture.gguf' }
  ;(svc as any).initPromise = new Promise<void>(resolve => {
    finish = () => { (svc as any).state = { status: 'ready', modelPath: 'fixture.gguf' }; resolve() }
  })
  return { svc, finish }
}

describe('LocalLlamaService.waitWhileLoading', () => {
  it('resolves true as soon as the load finishes', async () => {
    const { svc, finish } = loadingService()
    const waiting = svc.waitWhileLoading(10_000)
    finish()
    await expect(waiting).resolves.toBe(true)
  })

  it('gives up after the timeout while still loading', async () => {
    const { svc } = loadingService()
    await expect(svc.waitWhileLoading(20)).resolves.toBe(false)
  })

  it('returns promptly on Stop', async () => {
    const { svc } = loadingService()
    const abort = new AbortController()
    const waiting = svc.waitWhileLoading(10_000, abort.signal)
    abort.abort()
    await expect(waiting).resolves.toBe(false)
  })

  it('does not wait when nothing is loading', async () => {
    const svc = new (LocalLlamaService as any)() as LocalLlamaService
    await expect(svc.waitWhileLoading(10_000)).resolves.toBe(false)
  })
})
