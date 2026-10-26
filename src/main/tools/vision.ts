import http from 'http'
import { ToolRegistry } from './registry'
import { SettingsService } from '../services/settings'
import { LogService } from '../services/logs'
import { DesktopAdapter } from '../adapters/desktop'

const reg = ToolRegistry.getInstance()
const log = LogService.getInstance()

interface OllamaVisionResponse {
  response: string
  done: boolean
}

const desktop = new DesktopAdapter()

function visionModel(): string {
  return SettingsService.getInstance().get().visionModelName || 'qwen3-vl:4b'
}

async function queryVision(base64Image: string, prompt: string): Promise<string> {
  const settings = SettingsService.getInstance().get()
  const endpoint = new URL(settings.modelEndpoint)

  const body = JSON.stringify({
    model: visionModel(),
    prompt,
    images: [base64Image],
    stream: false,
    think: false,
    // Free the GPU soon after a look: the local brain and Whisper share the same 10 GB.
    keep_alive: '2m'
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

/** The given screenshot, or a fresh capture of the screen when none was passed —
 *  the planner can only send text, so it calls these tools with just a question. */
async function screenshotOrCapture(given: unknown): Promise<string> {
  if (typeof given === 'string' && given.length > 0) return given
  return (await desktop.screenshot()).base64
}

/** Pixel size of a PNG or JPEG image, or null if it can't be read. */
export function imageSize(base64: string): { width: number; height: number } | null {
  const b = Buffer.from(base64.slice(0, 200_000), 'base64')
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    // SOF0–SOF15 (except DHT/JPG/DAC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
    }
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}

/** Qwen3-VL answers positions on a 0–1000 grid; older models (Qwen2.5-VL, LLaVA) in pixels. */
export function toScreenPixels(model: string, x: number, y: number, size: { width: number; height: number } | null): { x: number; y: number } {
  if (!/qwen3[.-]?\d*-?vl/i.test(model) || !size) return { x, y }
  return { x: Math.round(x / 1000 * size.width), y: Math.round(y / 1000 * size.height) }
}

reg.register({
  name: 'vision.analyze',
  description: 'Look at the screen with the local vision model and answer a question about it — read text, check what is open, understand the UI, or confirm an action worked. Pass just a question; the current screen is captured automatically.',
  parameters: {
    type: 'object',
    properties: {
      question:         { type: 'string', description: 'What to find out about the screen.' },
      screenshotBase64: { type: 'string', description: 'Optional. Omit to use the current screen.' }
    },
    required: ['question']
  },
  riskLevel: 'low', reversible: true, category: 'vision'
}, async (p) => {
  try {
    const answer = await queryVision(await screenshotOrCapture(p.screenshotBase64), p.question as string)
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
  description: 'Find a UI element on the screen by description and return its screen pixel coordinates { found, x, y, description }. The current screen is captured automatically.',
  parameters: {
    type: 'object',
    properties: {
      description:      { type: 'string', description: 'Description of the element to find, e.g. "the Submit button" or "the search input field".' },
      screenshotBase64: { type: 'string', description: 'Optional. Omit to use the current screen.' }
    },
    required: ['description']
  },
  riskLevel: 'low', reversible: true, category: 'vision'
}, async (p) => {
  const prompt = `Look at this screenshot. Find "${p.description}".
If you can see it, respond with ONLY a JSON object like: {"found": true, "x": 450, "y": 320, "description": "brief description of what you see"}
If you cannot find it, respond with ONLY: {"found": false, "description": "what you see instead"}
Do not include any other text.`

  try {
    const image = await screenshotOrCapture(p.screenshotBase64)
    const raw = await queryVision(image, prompt)
    // Extract JSON from response — model may wrap it in markdown
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { success: true, data: { found: false, description: raw.slice(0, 200) } }
    const parsed = JSON.parse(jsonMatch[0])
    if (parsed.found && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      Object.assign(parsed, toScreenPixels(visionModel(), parsed.x, parsed.y, imageSize(image)))
    }
    return { success: true, data: parsed }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

export function registerVisionTools() {
  return ToolRegistry.getInstance()
}
