import http from 'http'
import { SettingsService } from './settings'
import type { ToolDefinition } from '../tools/registry'

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]  // base64 images for vision models
}

export interface OllamaResponse {
  message: { content: string; tool_calls?: OllamaToolCall[] }
  done: boolean
}

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> }
}

// Ollama native tool format (OpenAI-compatible)
export interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolDefinition['parameters']
  }
}

export class OllamaClient {
  private get endpoint() { return SettingsService.getInstance().get().modelEndpoint }
  private get model() { return SettingsService.getInstance().get().modelName }
  private get visionModel() { return SettingsService.getInstance().get().visionModelName || 'llava:13b' }

  private getPort(url: URL): number {
    const p = parseInt(url.port)
    if (!isNaN(p)) return p
    return url.protocol === 'https:' ? 443 : 11434
  }

  async isAvailable(): Promise<boolean> {
    return new Promise(resolve => {
      const url = new URL(this.endpoint)
      const req = http.get({
        hostname: url.hostname,
        port: this.getPort(url),
        path: '/api/tags',
        timeout: 5000
      }, res => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.setTimeout(5000, () => { req.destroy(); resolve(false) })
      req.on('error', () => resolve(false))
    })
  }

  async listModels(): Promise<string[]> {
    return new Promise(resolve => {
      const url = new URL(this.endpoint)
      const req = http.get({
        hostname: url.hostname,
        port: this.getPort(url),
        path: '/api/tags',
        timeout: 5000
      }, res => {
        let raw = ''
        res.on('data', (chunk: Buffer) => { raw += chunk.toString() })
        res.on('end', () => {
          try {
            const json = JSON.parse(raw)
            resolve((json.models as Array<{ name: string }>).map(m => m.name))
          } catch { resolve([]) }
        })
        res.on('error', () => resolve([]))
      })
      req.setTimeout(5000, () => { req.destroy(); resolve([]) })
      req.on('error', () => resolve([]))
    })
  }

  async chat(messages: OllamaMessage[], onToken?: (token: string) => void, signal?: AbortSignal): Promise<string> {
    const url = new URL(this.endpoint)
    const body = JSON.stringify({ model: this.model, messages, stream: !!onToken })
    return this.postJson(url, '/api/chat', body, onToken, signal)
  }

  async chatWith(model: string, messages: OllamaMessage[], onToken?: (token: string) => void, signal?: AbortSignal): Promise<string> {
    const url = new URL(this.endpoint)
    const body = JSON.stringify({ model, messages, stream: !!onToken })
    return this.postJson(url, '/api/chat', body, onToken, signal)
  }

  /** Send messages with native Ollama tool definitions. Returns either a text reply
   *  or a parsed tool call. stream=false is required for tool calls. */
  async chatWithTools(
    messages: OllamaMessage[],
    tools: OllamaTool[],
    signal?: AbortSignal
  ): Promise<{ text: string; toolCall?: OllamaToolCall }> {
    const url = new URL(this.endpoint)
    const body = JSON.stringify({ model: this.model, messages, tools, stream: false })
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return }
      const req = http.request({
        hostname: url.hostname,
        port: this.getPort(url),
        path: '/api/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let raw = ''
        res.on('data', (chunk: Buffer) => { raw += chunk.toString() })
        res.on('end', () => {
          try {
            const json: OllamaResponse = JSON.parse(raw)
            const toolCall = json.message?.tool_calls?.[0]
            resolve({ text: json.message?.content ?? '', toolCall })
          } catch { resolve({ text: raw }) }
        })
        res.on('error', reject)
      })
      const onAbort = () => { try { req.destroy(new Error('aborted')) } catch { } }
      signal?.addEventListener('abort', onAbort, { once: true })
      req.on('close', () => signal?.removeEventListener('abort', onAbort))
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  private postJson(url: URL, path: string, body: string, onToken?: (token: string) => void, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return }
      const req = http.request({
        hostname: url.hostname,
        port: this.getPort(url),
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let full = ''
        res.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split('\n').filter(Boolean)
          for (const line of lines) {
            try {
              const json: OllamaResponse = JSON.parse(line)
              const token = json.message?.content ?? ''
              full += token
              if (onToken && token) onToken(token)
            } catch { /* partial chunk */ }
          }
        })
        res.on('end', () => resolve(full))
        res.on('error', reject)
      })
      const onAbort = () => { try { req.destroy(new Error('aborted')) } catch { } }
      signal?.addEventListener('abort', onAbort, { once: true })
      req.on('close', () => signal?.removeEventListener('abort', onAbort))
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}
