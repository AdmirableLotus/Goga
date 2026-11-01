import fs from 'fs'
import path from 'path'
import { ToolRegistry } from './registry'
import { LibraryService } from '../services/library'
import { queryVision } from './vision'
import { LogService } from '../services/logs'

const reg = ToolRegistry.getInstance()
const library = LibraryService.getInstance()
const log = LogService.getInstance()

const DOC = /\.(pdf|docx|txt|md|csv)$/i
const IMG = /\.(png|jpe?g|webp|gif|bmp)$/i
const VIDEO = /\.(mov|mp4|avi|mkv|webm|m4v)$/i
const MODEL3D = /\.(stl|step|stp|obj|3mf|f3d)$/i
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_FILES = 60

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`

// Per-file guard so one slow file (a big PDF, or the vision model loading on a small GPU)
// can never hang the whole review. Resolves to a marker string instead of hanging forever.
const INGEST_TIMEOUT_MS = 60_000
const VISION_TIMEOUT_MS = 90_000
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve(onTimeout()) } }, ms)
    work.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(onTimeout()) } },
    )
  })
}

reg.register({
  name: 'files.reviewFolder',
  description: 'Go through a folder and check everything: read each document (pdf, docx, txt, md, csv) into the Library, look at each image with the vision model and describe it, and list videos, 3D models and other files. Returns a summary of the whole folder. Use when asked to review or go through a folder.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The folder to review, e.g. "C:/Users/me/Desktop/project".' },
      question: { type: 'string', description: 'Optional focus for the image descriptions, e.g. "what does this show about the device?".' },
    },
    required: ['path'],
  },
  riskLevel: 'low', reversible: true, category: 'filesystem',
}, async (p, ctx) => {
  try {
    const dir = String(p.path ?? '')
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { success: false, error: `Not a folder: ${dir}` }
    const prompt = `Describe this image in 2-3 sentences for a project review.${p.question ? ` Focus: ${String(p.question)}` : ''}`
    const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_FILES)

    const docs: string[] = [], images: string[] = [], other: string[] = [], subfolders: string[] = []
    for (const e of entries) {
      if (ctx.abortSignal.aborted) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { subfolders.push(e.name + '/'); continue }
      const size = fs.statSync(full).size
      try {
        if (DOC.test(e.name)) {
          const meta = await withTimeout(library.ingest(full), INGEST_TIMEOUT_MS, () => null)
          if (meta) docs.push(`${e.name} → read into Library (${meta.chunkCount} sections)`)
          else other.push(`${e.name} (${mb(size)}) — skipped, too slow to read (timed out)`)
        } else if (IMG.test(e.name)) {
          if (size > MAX_IMAGE_BYTES) { images.push(`${e.name} (${mb(size)}) — too large to view`); continue }
          const b64 = fs.readFileSync(full).toString('base64')
          const desc = await withTimeout(
            queryVision(b64, prompt).catch(err => `(could not view: ${err instanceof Error ? err.message : String(err)})`),
            VISION_TIMEOUT_MS, () => '(skipped — vision model too slow to respond)')
          images.push(`${e.name}: ${desc.replace(/\s+/g, ' ').trim().slice(0, 400)}`)
        } else if (VIDEO.test(e.name)) {
          other.push(`${e.name} (video, ${mb(size)}) — Goga can't watch video yet`)
        } else if (MODEL3D.test(e.name)) {
          other.push(`${e.name} (3D model, ${mb(size)})`)
        } else {
          other.push(`${e.name} (${mb(size)})`)
        }
      } catch (err) { other.push(`${e.name}: could not read (${err instanceof Error ? err.message : String(err)})`) }
    }

    const sections = [
      `Reviewed folder: ${dir}`,
      docs.length ? `\nDocuments read (${docs.length}):\n- ${docs.join('\n- ')}` : '',
      images.length ? `\nImages seen (${images.length}):\n- ${images.join('\n- ')}` : '',
      other.length ? `\nOther files:\n- ${other.join('\n- ')}` : '',
      subfolders.length ? `\nSubfolders (not opened): ${subfolders.join(', ')}` : '',
      `\nThe documents are now in the Library — ask about them in chat.`,
    ].filter(Boolean)
    log.info(`files.reviewFolder: ${docs.length} docs, ${images.length} images, ${other.length} other`)
    return { success: true, data: { readable: sections.join('\n') } }
  } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
})
