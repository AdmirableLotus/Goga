import http from 'http'
import { ToolRegistry } from './registry'
import { SettingsService } from '../services/settings'
import { LogService } from '../services/logs'

const reg = ToolRegistry.getInstance()
const log = LogService.getInstance()

interface OllamaVisionResponse {
  response: string
  done: boolean
}

async function queryVision(base64Image: string, prompt: string): Promise<string> {
  const settings = SettingsService.getInstance().get()
  const endpoint = new URL(settings.modelEndpoint)
  const model = settings.visionModelName || 'llava:13b'

  const body = JSON.stringify({
    model,
    prompt,
    images: [base64Image],
    stream: false
  })

  const port = parseInt(endpoint.port)
  const resolvedPort = !isNaN(port) ? port : 11434

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: endpoint.hostname,
      port: resolvedPort,
      path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60_000
    }, (res) => {
      let raw = ''
      res.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      res.on('end', () => {
        try {
          // Ollama streams newline-delimited JSON even with stream:false for generate
          const lines = raw.trim().split('\n').filter(Boolean)
          let full = ''
          for (const line of lines) {
            const json: OllamaVisionResponse = JSON.parse(line)
            full += json.response ?? ''
          }
          resolve(full.trim())
        } catch (e) {
          reject(new Error(`Vision parse error: ${e}`))
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Vision request timed out')) })
    req.write(body)
    req.end()
  })
}

reg.register({
  name: 'vision.analyze',
  description: 'Send a screenshot to the local LLaVA vision model and ask a question about what is on screen. Use this to understand UI state, read text, identify elements, or verify actions.',
  parameters: {
    type: 'object',
    properties: {
      screenshotBase64: { type: 'string', description: 'Base64-encoded PNG screenshot.' },
      question:         { type: 'string', description: 'Question to ask about the screenshot.' }
    },
    required: ['screenshotBase64', 'question']
  },
  riskLevel: 'low', reversible: true, category: 'vision'
}, async (p) => {
  try {
    const answer = await queryVision(p.screenshotBase64 as string, p.question as string)
    log.info(`Vision analysis complete (${answer.length} chars)`)
    return { success: true, data: { answer } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`Vision failed: ${msg}`)
    return { success: false, error: msg }
  }
})

reg.register({
  name: 'vision.findElement',
  description: 'Ask the vision model to locate a UI element by description and return its approximate screen coordinates. Returns { found, x, y, description }.',
  parameters: {
    type: 'object',
    properties: {
      screenshotBase64: { type: 'string', description: 'Base64-encoded PNG screenshot.' },
      description:      { type: 'string', description: 'Description of the element to find, e.g. "the Submit button" or "the search input field".' }
    },
    required: ['screenshotBase64', 'description']
  },
  riskLevel: 'low', reversible: true, category: 'vision'
}, async (p) => {
  const prompt = `Look at this screenshot. Find "${p.description}". 
If you can see it, respond with ONLY a JSON object like: {"found": true, "x": 450, "y": 320, "description": "brief description of what you see"}
If you cannot find it, respond with ONLY: {"found": false, "description": "what you see instead"}
Do not include any other text.`

  try {
    const raw = await queryVision(p.screenshotBase64 as string, prompt)
    // Extract JSON from response — model may wrap it in markdown
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { success: true, data: { found: false, description: raw.slice(0, 200) } }
    const parsed = JSON.parse(jsonMatch[0])
    return { success: true, data: parsed }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

export function registerVisionTools() {
  return ToolRegistry.getInstance()
}
