import { describe, expect, it, vi } from 'vitest'
vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => ({}) }) } }))
const conversation = vi.hoisted(() => vi.fn())
vi.mock('../localConversation', () => ({ runLocalConversation: conversation }))
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

describe('LocalLlamaService.chat queue', () => {
  function readyService() {
    const svc = new (LocalLlamaService as any)() as LocalLlamaService
    ;(svc as any).state = { status: 'ready', modelPath: 'fixture.gguf' }
    ;(svc as any).model = {}
    ;(svc as any).chatSessionClass = async () => class {}
    return svc
  }

  it('runs one conversation at a time, in order, so contexts never share the GPU', async () => {
    const svc = readyService()
    const order: string[] = []
    const gates: Record<string, () => void> = {}
    conversation.mockImplementation(async (_m: unknown, _s: unknown, messages: { content: string }[]) => {
      const name = messages[0].content
      order.push(`start ${name}`)
      await new Promise<void>(r => { gates[name] = r })
      order.push(`end ${name}`)
      return name
    })
    const a = svc.chat([{ role: 'user', content: 'a' }])
    const b = svc.chat([{ role: 'user', content: 'b' }])
    await vi.waitFor(() => expect(gates.a).toBeDefined())
    await new Promise(r => setTimeout(r, 20))
    expect(order).toEqual(['start a'])
    gates.a()
    await vi.waitFor(() => expect(gates.b).toBeDefined())
    gates.b()
    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b'])
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  it('turns background work away while the brain is busy, and lets a stopped caller leave the line', async () => {
    const svc = readyService()
    let finish!: () => void
    conversation.mockImplementationOnce(() => new Promise(r => { finish = () => r('done') }))
    const first = svc.chat([{ role: 'user', content: 'chat' }])
    await expect(svc.chat([{ role: 'user', content: 'facts' }], undefined, undefined, { ifIdle: true })).rejects.toThrow('busy')

    const stop = new AbortController()
    const waiting = svc.chat([{ role: 'user', content: 'task' }], undefined, stop.signal)
    stop.abort()
    await expect(waiting).rejects.toThrow()
    await vi.waitFor(() => expect(finish).toBeDefined())
    finish()
    await expect(first).resolves.toBe('done')
  })
})
