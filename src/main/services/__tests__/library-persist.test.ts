import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOOK_STUDY_REQUEST, LibraryService, studyReport } from '../library'
import type { BookMeta } from '../../../shared/types'

// Books used to vanish on every restart, so "learn from the book I gave you" found nothing.

const dirs: string[] = []
const tempIndex = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-lib-'))
  dirs.push(dir)
  return path.join(dir, 'library-index.json')
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

describe('keeping books across restarts', () => {
  it('saves a new book and loads it in a fresh library', async () => {
    const index = tempIndex()
    const book = path.join(path.dirname(index), 'notes.md')
    fs.writeFileSync(book, 'Bioimpedance repeatability depends on electrode contact pressure. '.repeat(30))

    const first = new (LibraryService as any)() as LibraryService
    first.open(index)
    await first.ingest(book)

    const second = new (LibraryService as any)() as LibraryService
    second.open(index)
    expect(second.list().map(b => b.title)).toEqual(['notes'])
    expect(second.search('electrode contact pressure').length).toBeGreaterThan(0)

    second.delete(second.list()[0].id)
    const third = new (LibraryService as any)() as LibraryService
    third.open(index)
    expect(third.list()).toEqual([])
  })

  it('reads the index an earlier version saved, and starts empty with none', () => {
    const index = tempIndex()
    fs.writeFileSync(index, JSON.stringify({ version: 1, books: [{ id: 'b1', title: 'Guide', filename: 'Guide.pdf', format: 'pdf', contentHash: 'x', chunkCount: 1, ingestedAt: 1, sizeBytes: 1 }],
      chunks: [{ bookId: 'b1', chunkIndex: 0, text: 'session tokens rotate after login' }, { bookId: 'gone', chunkIndex: 0, text: 'orphan passage' }] }))
    const lib = new (LibraryService as any)() as LibraryService
    lib.open(index)
    expect(lib.list()).toHaveLength(1)
    expect(lib.search('session tokens')).toHaveLength(1)
    expect(lib.search('orphan passage')).toHaveLength(0)

    const empty = new (LibraryService as any)() as LibraryService
    empty.open(tempIndex())
    expect(empty.list()).toEqual([])
  })
})

describe('"learn from the book I gave you"', () => {
  it('recognizes study requests about the Library, not searches for new books', () => {
    expect(BOOK_STUDY_REQUEST.test('please learn security from the book i gave you')).toBe(true)
    expect(BOOK_STUDY_REQUEST.test('i added book for you please learn from it')).toBe(true)
    expect(BOOK_STUDY_REQUEST.test('study the pdf I uploaded')).toBe(true)
    expect(BOOK_STUDY_REQUEST.test('search for books that can help you learn')).toBe(false)
    expect(BOOK_STUDY_REQUEST.test('book a table for two')).toBe(false)
    expect(BOOK_STUDY_REQUEST.test('what time is it')).toBe(false)
  })

  it('says honestly what is read and how it is used', () => {
    const books = [{ id: 'b', title: 'OWASP_WSTG_v4.2', chunkCount: 1582 } as BookMeta]
    expect(studyReport(books)).toMatch(/"OWASP_WSTG_v4\.2" \(1,582 passages\)/)
    expect(studyReport(books)).toMatch(/doesn't retrain/)
    expect(studyReport([])).toMatch(/Library is empty/)
  })
})
