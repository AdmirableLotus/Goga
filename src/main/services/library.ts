import fs from 'fs'
import path from 'path'
import type { BookMeta, BookChunk } from '../../shared/types'
import { nanoid } from '../utils/nanoid'
import { LogService } from './logs'

const CHUNK_SIZE = 800   // characters per chunk
const CHUNK_OVERLAP = 100

export class LibraryService {
  private static instance: LibraryService
  private books: Map<string, BookMeta> = new Map()
  private chunks: BookChunk[] = []
  private log = LogService.getInstance()

  static getInstance() {
    if (!LibraryService.instance) LibraryService.instance = new LibraryService()
    return LibraryService.instance
  }

  async ingest(filePath: string): Promise<BookMeta> {
    const ext = path.extname(filePath).toLowerCase().slice(1) as BookMeta['format']
    if (!['pdf', 'txt', 'epub'].includes(ext)) throw new Error(`Unsupported format: ${ext}`)

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

    this.log.info(`Ingested "${title}" — ${newChunks.length} chunks`)
    return meta
  }

  private async extractText(filePath: string, format: BookMeta['format']): Promise<string> {
    if (format === 'txt') {
      return fs.readFileSync(filePath, 'utf-8')
    }

    if (format === 'pdf') {
      const pdfParse = require('pdf-parse')
      const buffer = fs.readFileSync(filePath)
      const data = await pdfParse(buffer)
      return data.text
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
  }

  getBookTitle(bookId: string) { return this.books.get(bookId)?.title ?? bookId }
}
