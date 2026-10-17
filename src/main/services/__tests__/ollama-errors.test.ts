import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import { once } from 'events'
import { OllamaClient } from '../ollamaClient'

const config = vi.hoisted(() => ({ modelEndpoint: '', modelName: 'missing-model' }))
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => config }) } }))

const servers: http.Server[] = []
async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  config.modelEndpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

describe('Ollama response errors and cancellation', () => {
  const calls = {
    chat: (c: OllamaClient, signal?: AbortSignal) => c.chat([], undefined, signal),
    chatWith: (c: OllamaClient, signal?: AbortSignal) => c.chatWith('missing-model', [], undefined, signal),
    tools: (c: OllamaClient, signal?: AbortSignal) => c.chatWithTools([], [], signal),
    streaming: (c: OllamaClient, signal?: AbortSignal) => c.chat([], () => {}, signal)
  }
  for (const [name, call] of Object.entries(calls)) {
    it(`${name}: rejects non-2xx with model/status and redacted body`, async () => {
      await serve((_req, res) => { res.writeHead(404); res.end(JSON.stringify({error:'model missing password=hidden'})) })
      await expect(call(new OllamaClient())).rejects.toThrow('Ollama model "missing-model" (HTTP 404): Backend HTTP error: {"error":"model missing password=[REDACTED]"}')
    })
    it(`${name}: rejects API error even with HTTP 200`, async () => {
      await serve((_req, res) => res.end(JSON.stringify({error:'model not found'})))
      await expect(call(new OllamaClient())).rejects.toThrow('HTTP 200): Backend API error')
    })
    it(`${name}: preserves cancellation before request`, async () => {
      const requests = vi.fn()
      await serve(requests)
      const controller = new AbortController()
      controller.abort()
      await expect(call(new OllamaClient(), controller.signal)).rejects.toThrow('aborted')
      expect(requests).not.toHaveBeenCalled()
    })
    it(`${name}: cancels an in-flight response`, async () => {
      const controller = new AbortController()
      await serve((_req, res) => { res.writeHead(200); res.flushHeaders(); controller.abort() })
      await expect(call(new OllamaClient(), controller.signal)).rejects.toThrow('aborted')
    })
  }
  it('buffers split NDJSON and surfaces a later streamed API error', async () => {
    const tokens: string[] = []
    await serve((_req, res) => {
      res.write('{"message":{"content":"hello"}}\n{"er')
      setTimeout(() => res.end('ror":"generation failed"}\n'), 5)
    })
    await expect(new OllamaClient().chat([], t => tokens.push(t))).rejects.toThrow('generation failed')
    expect(tokens).toEqual(['hello'])
  })
  it('preserves valid native tool calls split across transport chunks', async () => {
    await serve((_req, res) => {
      res.write('{"message":{"con')
      setTimeout(() => res.end('tent":"","tool_calls":[{"function":{"name":"notepad.saveText","arguments":{"text":"routing check"}}}]},"done":true}'), 5)
    })
    expect((await new OllamaClient().chatWithTools([], [])).toolCall?.function.name).toBe('notepad.saveText')
  })
  it('preserves streamed text across transport chunk boundaries', async () => {
    const tokens: string[] = []
    await serve((_req, res) => {
      res.write('{"message":{"content":"one"}}\n{"mes')
      setTimeout(() => res.end('sage":{"content":"two"},"done":true}\n'), 5)
    })
    expect(await new OllamaClient().chat([], t => tokens.push(t))).toBe('onetwo')
    expect(tokens).toEqual(['one','two'])
  })
})
