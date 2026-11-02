import fs from 'fs'
import path from 'path'
import type { BookMeta, BookChunk } from '../../shared/types'
import { nanoid } from '../utils/nanoid'
import { LogService } from './logs'

const CHUNK_SIZE = 800   // characters per chunk
const CHUNK_OVERLAP = 100

/** "Learn from the book I gave you" — about books already in the Library, not finding new ones. */
export const BOOK_STUDY_REQUEST = /^(?!.*\b(search|find|download|look for|get me|buy)\b).*(\b(learn|study|read|absorb)\b.{0,60}\b(book|books|pdf|guide|document)\b|\b(book|books|pdf|guide|document)\b.{0,60}\b(learn|study|absorb)\b)/i

/** An honest answer: what is in the Library and how Goga actually uses it. */
export function studyReport(books: BookMeta[]): string {
  if (books.length === 0) return 'My Library is empty right now, so there is no book for me to learn from. Add one on the Library page (PDF, EPUB, Word, text, Markdown or CSV) and I\'ll read it straight away.'
  const list = books.map(b => `- "${b.title}" (${b.chunkCount.toLocaleString('en-US')} passages)`).join('\n')
  return `I've already read ${books.length === 1 ? 'the book' : 'these books'} in my Library:\n${list}\n\nTo be straight about how I learn: reading a book doesn't retrain my brain. I keep every passage and look up the right ones whenever you ask about the topic, so my answers quote the book instead of guessing. Ask me anything from ${books.length === 1 ? 'it' : 'them'}, for example "what does ${books[0].title} say about …?"`
}

export class LibraryService {
  private static instance: LibraryService
  private books: Map<string, BookMeta> = new Map()
  private chunks: BookChunk[] = []
  private log = LogService.getInstance()
  private indexFile?: string

  static getInstance() {
    if (!LibraryService.instance) LibraryService.instance = new LibraryService()
    return LibraryService.instance
  }

  /** Keep books across restarts: load the saved index now and save it after every change. */
  open(indexFile: string) {
    this.indexFile = indexFile
    try {
      const saved = JSON.parse(fs.readFileSync(indexFile, 'utf-8')) as { books?: BookMeta[]; chunks?: BookChunk[] }
      const books = Array.isArray(saved.books) ? saved.books : []
      const known = new Set(books.map(b => b.id))
      for (const b of books) this.books.set(b.id, b)
      this.chunks.push(...(Array.isArray(saved.chunks) ? saved.chunks : []).filter(c => known.has(c.bookId)))
      this.log.info(`Library: ${books.length} book(s) loaded`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`Library index unreadable: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private save() {
    if (!this.indexFile) return
    try {
      const tmp = `${this.indexFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, books: this.list(), chunks: this.chunks }))
      fs.renameSync(tmp, this.indexFile)
    } catch (err) {
      this.log.warn(`Library index not saved: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async ingest(filePath: string): Promise<BookMeta> {
    const ext = path.extname(filePath).toLowerCase().slice(1) as BookMeta['format']
    if (!['pdf', 'txt', 'epub', 'docx', 'md', 'csv'].includes(ext)) throw new Error(`Unsupported format: ${ext}`)

    const filename = path.basename(filePath)
    const title = path.basename(filePath, path.extname(filePath))
    const sizeBytes = fs.statSync(filePath).size

    this.log.info(`Ingesting: ${filename}`)

    const text = await this.extractText(filePath, ext)
    const bookId = nanoid()
    const newChunks = this.chunkText(text, bookId)

    // Remove old version if re-ingesting same filename
    const existing = Array.from(this.books.values()).find(b => b.filename === filename)
    if (existing) this.delete(existing.id)

    const meta: BookMeta = { id: bookId, title, filename, format: ext, chunkCount: newChunks.length, ingestedAt: Date.now(), sizeBytes }
    this.books.set(bookId, meta)
    this.chunks.push(...newChunks)
    this.save()

    this.log.info(`Ingested "${title}" — ${newChunks.length} chunks`)
    return meta
  }

  /** The plain text of a supported document (pdf, docx, txt, md, csv, epub). */
  async readText(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase().slice(1) as BookMeta['format']
    if (!['pdf', 'txt', 'epub', 'docx', 'md', 'csv'].includes(ext)) throw new Error(`Unsupported format: ${ext}`)
    return this.extractText(filePath, ext)
  }

  private async extractText(filePath: string, format: BookMeta['format']): Promise<string> {
    if (format === 'txt' || format === 'md' || format === 'csv') {
      return fs.readFileSync(filePath, 'utf-8')
    }

    if (format === 'docx') {
      // A .docx is a zip; the text lives in word/document.xml wrapped in XML tags.
      const AdmZip = require('adm-zip')
      const xml = new AdmZip(filePath).readAsText('word/document.xml')
      const text = xml
        .replace(/<\/w:p>/g, '\n')
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<[^>]+>/g, '')
      return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\n{3,}/g, '\n\n').trim()
    }

    if (format === 'pdf') {
      const { PDFParse } = require('pdf-parse')
      const buffer = fs.readFileSync(filePath)
      const pdf = new PDFParse({ data: new Uint8Array(buffer), verbosity: 0 })
      await pdf.load()
      const result = await pdf.getText()
      return result.text
    }

    if (format === 'epub') {
      const { EPub } = require('epub2')
      return new Promise((resolve, reject) => {
        const epub = new EPub(filePath)
        epub.on('end', async () => {
          const chapters: string[] = []
          for (const chapter of epub.flow) {
            await new Promise<void>((res, rej) => {
              epub.getChapter(chapter.id, (err: Error, text: string) => {
                if (err) { rej(err); return }
                // Strip HTML tags
                chapters.push(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
                res()
              })
            })
          }
          resolve(chapters.join('\n\n'))
        })
        epub.on('error', reject)
        epub.parse()
      })
    }

    throw new Error(`Unhandled format: ${format}`)
  }

  private chunkText(text: string, bookId: string): BookChunk[] {
    const chunks: BookChunk[] = []
    let i = 0, index = 0
    const clean = text.replace(/\s+/g, ' ').trim()
    while (i < clean.length) {
      chunks.push({ bookId, chunkIndex: index++, text: clean.slice(i, i + CHUNK_SIZE) })
      i += CHUNK_SIZE - CHUNK_OVERLAP
    }
    return chunks
  }

  // Keyword-based search — scores chunks by term frequency
  search(query: string, topK = 5): BookChunk[] {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 3)
    if (terms.length === 0) return []

    const scored = this.chunks.map(chunk => {
      const lower = chunk.text.toLowerCase()
      const score = terms.reduce((s, t) => {
        let count = 0, pos = 0
        while ((pos = lower.indexOf(t, pos)) !== -1) { count++; pos++ }
        return s + count
      }, 0)
      return { chunk, score }
    })

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(s => s.chunk)
  }

  list() { return Array.from(this.books.values()) }

  delete(bookId: string) {
    this.books.delete(bookId)
    this.chunks = this.chunks.filter(c => c.bookId !== bookId)
    this.save()
  }

  /** A book's passages in reading order. */
  chunksOf(bookId: string): string[] {
    return this.chunks.filter(c => c.bookId === bookId).sort((a, b) => a.chunkIndex - b.chunkIndex).map(c => c.text)
  }

  getBookTitle(bookId: string) { return this.books.get(bookId)?.title ?? bookId }
}
