import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ screenshot: vi.fn(), visionAnswer: '', sentBodies: [] as any[], model: 'qwen3-vl:4b' }))
vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => ({ modelEndpoint: 'http://localhost:11434', visionModelName: boundary.model }) }) } }))
vi.mock('../../adapters/desktop', () => ({ DesktopAdapter: vi.fn(() => ({ screenshot: boundary.screenshot })) }))
vi.mock('http', () => ({ default: { request: (_opts: unknown, onResponse: (res: EventEmitter) => void) => {
  const req = new EventEmitter() as EventEmitter & { write: (b: string) => void; end: () => void }
  req.write = body => { boundary.sentBodies.push(JSON.parse(body)) }
  req.end = () => {
    const res = new EventEmitter()
    onResponse(res)
    res.emit('data', Buffer.from(JSON.stringify({ response: boundary.visionAnswer, done: true })))
    res.emit('end')
  }
  return req
} } }))
import { ToolRegistry } from '../../tools/registry'
import { imageSize, toScreenPixels } from '../../tools/vision'

// Minimal image headers: enough for the size reader, not a full decodable image.
function png(width: number, height: number): string {
  const b = Buffer.alloc(33)
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.write('IHDR', 12)
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20)
  return b.toString('base64')
}
function jpeg(width: number, height: number): string {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00])           // a segment to skip
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]).toString('base64')
}
const run = (tool: string, params: Record<string, unknown>) =>
  ToolRegistry.getInstance().execute(tool, params, { abortSignal: new AbortController().signal })

beforeEach(() => {
  boundary.screenshot.mockReset().mockResolvedValue({ base64: jpeg(1920, 1080), timestamp: 0 })
  boundary.sentBodies = []
  boundary.model = 'qwen3-vl:4b'
})

describe('vision helpers', () => {
  it('reads PNG and JPEG sizes, and rejects other data', () => {
    expect(imageSize(png(1280, 720))).toEqual({ width: 1280, height: 720 })
    expect(imageSize(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(imageSize(Buffer.from('not an image').toString('base64'))).toBeNull()
  })

  it('converts Qwen3-VL 0–1000 positions to screen pixels and leaves pixel-based models alone', () => {
    // Measured on a real 1920×1080 screenshot: the button centre was at about (1486, 383).
    expect(toScreenPixels('qwen3-vl:4b', 771, 352, { width: 1920, height: 1080 })).toEqual({ x: 1480, y: 380 })
    expect(toScreenPixels('qwen2.5vl:3b', 1500, 384, { width: 1920, height: 1080 })).toEqual({ x: 1500, y: 384 })
    expect(toScreenPixels('qwen3-vl:4b', 771, 352, null)).toEqual({ x: 771, y: 352 })
  })
})

describe('vision tools capture the screen when the planner sends only text', () => {
  it('vision.analyze takes a screenshot itself and asks the configured model', async () => {
    boundary.visionAnswer = 'Browse Apps page on get12testers.com'
    const result = await run('vision.analyze', { question: 'What page is open?' })
    expect(result).toMatchObject({ success: true, data: { answer: 'Browse Apps page on get12testers.com' } })
    expect(boundary.screenshot).toHaveBeenCalledOnce()
    expect(boundary.sentBodies[0]).toMatchObject({ model: 'qwen3-vl:4b', think: false, keep_alive: '2m', images: [jpeg(1920, 1080)] })
  })

  it('vision.analyze uses a supplied screenshot without capturing again', async () => {
    boundary.visionAnswer = 'ok'
    await run('vision.analyze', { question: 'q', screenshotBase64: png(10, 10) })
    expect(boundary.screenshot).not.toHaveBeenCalled()
    expect(boundary.sentBodies[0].images).toEqual([png(10, 10)])
  })

  it('vision.findElement returns screen pixels for Qwen3-VL answers', async () => {
    boundary.visionAnswer = '{"found": true, "x": 771, "y": 352, "description": "Complete Setup button"}'
    const result = await run('vision.findElement', { description: 'the green Complete Setup button' })
    expect(result).toMatchObject({ success: true, data: { found: true, x: 1480, y: 380 } })
  })
})
