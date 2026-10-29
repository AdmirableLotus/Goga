import fs from 'fs'
import path from 'path'
import { ToolRegistry } from './registry'
import { LibraryService } from '../services/library'
import { downloadDocument, githubDocs } from '../services/webLibrary'

const reg = ToolRegistry.getInstance()
const library = LibraryService.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

reg.register({
  name: 'library.import',
  description: 'Read a document from the web: download a PDF, EPUB or TXT from a direct https link into Goga\'s Library so it can be asked about afterwards. Use for a book, paper or guide the user points to by URL.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'A direct https link ending in .pdf, .epub or .txt.' } },
    required: ['url'],
  },
  riskLevel: 'low', reversible: true, category: 'web',
}, async (p, ctx) => {
  let file: string | null = null
  try {
    file = await downloadDocument(String(p.url ?? ''), ctx.abortSignal)
    const meta = await library.ingest(file)
    return { success: true, data: { title: meta.title, chunks: meta.chunkCount, note: `Added "${meta.title}" to the Library. Ask about it in chat.` } }
  } catch (err) { return failure(err) }
  finally { if (file) try { fs.rmSync(path.dirname(file), { recursive: true, force: true }) } catch { /* temp */ } }
})

reg.register({
  name: 'library.listRepo',
  description: 'List the PDF/EPUB/TXT documents in a public GitHub repository (names, sizes and direct links). Use before library.import to see what a repo offers.',
  parameters: {
    type: 'object',
    properties: { repo: { type: 'string', description: 'https://github.com/owner/name' } },
    required: ['repo'],
  },
  riskLevel: 'low', reversible: true, category: 'web',
}, async (p, ctx) => {
  try {
    const docs = await githubDocs(String(p.repo ?? ''), ctx.abortSignal)
    return { success: true, data: docs.map(d => ({ name: d.name, sizeMB: Math.round(d.sizeBytes / 1e5) / 10, url: d.downloadUrl })) }
  } catch (err) { return failure(err) }
})
