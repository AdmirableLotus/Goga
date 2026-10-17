import http from 'http'
import { SettingsService } from './settings'
import { plannerDiagnostic, redactDiagnosticText } from './plannerDiagnostics'
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
    const json = await this.requestChat(url, body, undefined, signal)
    return { text: json.message?.content ?? '', toolCall: json.message?.tool_calls?.[0] }
  }

  private async postJson(url: URL, _path: string, body: string, onToken?: (token: string) => void, signal?: AbortSignal): Promise<string> {
    const json = await this.requestChat(url, body, onToken, signal)
    return json.message?.content ?? ''
  }

  private requestChat(url: URL, body: string, onToken?: (token: string) => void, signal?: AbortSignal): Promise<OllamaResponse> {
    const model = JSON.parse(body).model as string
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return }
      let settled = false
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      }
      const backendError = (status: number, raw: string, reason: string) => {
        const safeBody = redactDiagnosticText(raw).slice(0, 4096)
        plannerDiagnostic('ollama.error', { model, status, body: safeBody, reason })
        return new Error(`Ollama model "${redactDiagnosticText(model)}" (HTTP ${status}): ${reason}: ${safeBody}`)
      }
      const req = http.request({
        hostname: url.hostname,
        port: this.getPort(url),
        path: '/api/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        const status = res.statusCode ?? 0
        const httpFailed = status < 200 || status >= 300
        let pending = ''
        let raw = ''
        let full = ''
        let last: OllamaResponse | undefined
        const consume = (line: string) => {
          if (!line.trim() || settled) return
          let json: OllamaResponse & { error?: unknown }
          try { json = JSON.parse(line) } catch {
            fail(backendError(status, line, 'Invalid backend JSON'))
            res.destroy()
            return
          }
          if (json.error !== undefined) {
            fail(backendError(status, line, 'Backend API error'))
            res.destroy()
            return
          }
          last = json
          const token = json.message?.content ?? ''
          full += token
          if (onToken && token && !signal?.aborted) onToken(token)
        }
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          if (settled) return
          if (httpFailed) { raw += chunk; return }
          pending += chunk
          let newline: number
          while ((newline = pending.indexOf('\n')) >= 0) {
            consume(pending.slice(0, newline))
            pending = pending.slice(newline + 1)
          }
        })
        res.on('end', () => {
          if (settled) return
          if (httpFailed) { fail(backendError(status, raw, 'Backend HTTP error')); return }
          consume(pending)
          if (settled) return
          if (!last?.message) { fail(backendError(status, pending, 'Backend returned no message')); return }
          settled = true
          cleanup()
          resolve({ ...last, message: { ...last.message, content: full } })
        })
        res.on('error', fail)
        res.on('aborted', () => fail(new Error('Ollama response aborted')))
      })
      const onAbort = () => {
        fail(new Error('aborted'))
        req.destroy(new Error('aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      req.on('error', fail)
      // Cover cancellation between the initial check and listener registration.
      if (signal?.aborted) { onAbort(); return }
      req.write(body)
      req.end()
    })
  }
}
