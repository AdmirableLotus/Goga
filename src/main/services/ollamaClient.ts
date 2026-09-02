import http from 'http'
import { SettingsService } from './settings'

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  images?: string[]  // base64 images for vision models
}

export interface OllamaResponse {
  message: { content: string }
  done: boolean
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
        // Drain the response so the socket closes cleanly
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.setTimeout(5000, () => { req.destroy(); resolve(false) })
      req.on('error', () => resolve(false))
    })
  }

  async chat(messages: OllamaMessage[], onToken?: (token: string) => void): Promise<string> {
    const url = new URL(this.endpoint)
    const body = JSON.stringify({ model: this.model, messages, stream: !!onToken })
    return this.postJson(url, '/api/chat', body, onToken)
  }

  async chatWith(model: string, messages: OllamaMessage[], onToken?: (token: string) => void): Promise<string> {
    const url = new URL(this.endpoint)
    const body = JSON.stringify({ model, messages, stream: !!onToken })
    return this.postJson(url, '/api/chat', body, onToken)
  }

  private postJson(url: URL, path: string, body: string, onToken?: (token: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
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
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}
