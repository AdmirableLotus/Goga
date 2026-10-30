import path from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: (k: string) => k === 'desktop' ? '/Users/x/Desktop' : k === 'downloads' ? '/Users/x/Downloads' : '/Users/x/Documents' } }))
import { parseFileWrite, parseFolderReview } from '../fileCommand'

const norm = (p: string) => p.split(path.sep).join('/')

describe('file write parsing', () => {
  it('handles the "make a file called X in my Documents with the content Y" form', () => {
    const r = parseFileWrite('make a text file called llm-routing-check-01.txt in my Documents with the content "routing check"')!
    expect(norm(r.path)).toBe('/Users/x/Documents/llm-routing-check-01.txt')
    expect(r.content).toBe('routing check')
  })

  it('handles "write Y to X.txt" and "save Y as X.md"', () => {
    expect(parseFileWrite('write "hello world" to notes.txt')!.content).toBe('hello world')
    expect(parseFileWrite('save "shopping list" as list.md')!.content).toBe('shopping list')
  })

  it('resolves desktop and downloads locations', () => {
    expect(norm(parseFileWrite('create a file called todo.txt on my Desktop with "do laundry"')!.path)).toBe('/Users/x/Desktop/todo.txt')
    expect(norm(parseFileWrite('make report.csv in Downloads with a,b,c')!.path)).toBe('/Users/x/Downloads/report.csv')
  })

  it('takes content after "with" when unquoted, dropping the location clause', () => {
    const r = parseFileWrite('create a file called out.txt in my Documents with hello there')!
    expect(r.content).toBe('hello there')
  })

  it('blocks directory traversal in the filename', () => {
    const r = parseFileWrite('write "x" to ../../evil.txt')!
    expect(norm(r.path)).toBe('/Users/x/Documents/evil.txt')
  })

  it('ignores non-file requests', () => {
    for (const s of ['analyze AAPL', 'hello', 'what is the weather', 'open notepad'])
      expect(parseFileWrite(s)).toBeNull()
  })
})

describe('folder review parsing', () => {
  it('extracts the folder path from review requests, quoted or bare', () => {
    expect(parseFolderReview('review the folder "C:\\Users\\redre\\Desktop\\paper work for ring"')!.path).toBe('C:\\Users\\redre\\Desktop\\paper work for ring')
    expect(parseFolderReview('go through C:\\Users\\redre\\Desktop\\paper work for ring and check everything')!.path).toBe('C:\\Users\\redre\\Desktop\\paper work for ring')
    expect(parseFolderReview('check everything in C:/Users/redre/Desktop/paper work for ring')!.path).toBe('C:/Users/redre/Desktop/paper work for ring')
  })

  it('ignores requests with no folder', () => {
    for (const s of ['analyze AAPL', 'what is the weather', 'review my trading']) expect(parseFolderReview(s)).toBeNull()
  })
})
