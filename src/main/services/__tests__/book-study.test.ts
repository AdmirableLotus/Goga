import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BookStudy, SECTION_CHARS, matchSkills, parseNotes, sections, skillsForPrompt, STUDY_QUESTION, type StudyDeps } from '../bookStudy'
import { isLearnFromLink, pickDocumentLink } from '../webLibrary'
import { parseFolderReview } from '../fileCommand'

// "https://d2l.ai/ read and learn" was read as a folder named "s://d2l.ai/"; and books
// were only ever keyword-searched, never studied.

describe('"https://d2l.ai/ read and learn"', () => {
  it('is a link to learn from, not a folder', () => {
    expect(parseFolderReview('https://d2l.ai/ read and learn')).toBeNull()
    expect(parseFolderReview('review C:/Users/me/Desktop/notes')).toEqual({ path: 'C:/Users/me/Desktop/notes' })
    expect(isLearnFromLink('https://d2l.ai/ read and learn')).toBe(true)
    expect(isLearnFromLink('add this book to your library https://example.org/guide.pdf')).toBe(true)
    expect(isLearnFromLink('open this website and read everything on it and use it to work in trading https://zerodha.com/varsity/modules/')).toBe(true)
    expect(isLearnFromLink('go over all modules https://zerodha.com/varsity/modules/')).toBe(true)
    expect(isLearnFromLink('every day go through every point on this link and learn https://archive.org/details/texts')).toBe(true)
    expect(isLearnFromLink('open https://youtube.com and read the comments')).toBe(false)
  })

  it('finds the book PDF on the page, preferring the plain edition on the same site', () => {
    const html = '<a href="https://d2l.ai/d2l-en-mxnet.pdf">PDF (MXNet)</a> <a href="/d2l-en.pdf">PDF</a> <a href="https://mirror.example.com/a.pdf">x</a>'
    expect(pickDocumentLink('https://d2l.ai/', html)).toBe('https://d2l.ai/d2l-en.pdf')
    expect(pickDocumentLink('https://d2l.ai/', '<a href="/index.html">home</a>')).toBeNull()
  })
})

describe('studying a book', () => {
  it('groups passages into sections', () => {
    const parts = sections(Array.from({ length: 20 }, () => 'x'.repeat(800)))
    expect(parts.length).toBe(3)
    expect(parts.every(p => p.length <= SECTION_CHARS + 50)).toBe(true)
  })

  it('keeps usable notes and skills, and drops vague ones', () => {
    const raw = 'Here you go: {"summary":"Gradient descent.","ideas":["Step against the gradient"],"terms":[{"term":"learning rate","meaning":"step size"}],"skills":[{"name":"Tune the learning rate","when":"training diverges","steps":["Start at 0.1","Divide by 10 until loss falls"]},{"name":"Vague","steps":["think"]}]}'
    const { notes, skills } = parseNotes(raw, 'Dive into Deep Learning', 4)
    expect(notes).toMatchObject({ section: 4, summary: 'Gradient descent.', terms: [{ term: 'learning rate', meaning: 'step size' }] })
    expect(skills).toEqual([{ name: 'Tune the learning rate', when: 'training diverges', steps: ['Start at 0.1', 'Divide by 10 until loss falls'], book: 'Dive into Deep Learning', section: 4 }])
    expect(() => parseNotes('I cannot', 'b', 1)).toThrow()
  })

  it('brings up the right skill for a question', () => {
    const skills = [
      { name: 'Tune the learning rate', when: 'training diverges', steps: ['Start at 0.1', 'Lower it until the loss falls'], book: 'D2L', section: 4 },
      { name: 'Test for SQL injection', when: 'a form takes input', steps: ['Send a quote', 'Watch for errors'], book: 'OWASP', section: 9 },
    ]
    expect(matchSkills(skills, 'my training loss explodes, how should I set the learning rate?').map(s => s.book)).toEqual(['D2L'])
    expect(matchSkills(skills, 'what time is it')).toEqual([])
    expect(skillsForPrompt(skills.slice(0, 1))).toMatch(/Tune the learning rate \(from "D2L"; use when training diverges\): 1\. Start at 0\.1 2\./)
  })

  it('answers "what skills have you learned"', () => {
    expect(STUDY_QUESTION.test('what skills have you learned?')).toBe(true)
    expect(STUDY_QUESTION.test('how is your studying going')).toBe(true)
  })
})

describe('the study loop', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
  const reply = (n: number) => JSON.stringify({ summary: `part ${n}`, ideas: [], terms: [], skills: [{ name: `Method ${n}`, when: 'always', steps: ['a', 'b'] }] })

  const setup = (over: Partial<StudyDeps> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-study-'))
    dirs.push(dir)
    let n = 0
    const deps: StudyDeps = {
      chat: vi.fn(async () => reply(++n)), idle: () => true, report: vi.fn(),
      books: () => [{ id: 'b1', title: 'D2L' }], chunks: () => Array.from({ length: 8 }, () => 'y'.repeat(2900)), ...over,
    }
    const file = path.join(dir, 'book-study.json')
    return { study: new BookStudy(file, deps), deps, file }
  }

  it('studies section by section, reports progress and the finish, and remembers it', async () => {
    const { study, deps, file } = setup()
    for (let i = 0; i < 6; i++) await study.step()
    const p = study.all()[0]
    expect(p).toMatchObject({ title: 'D2L', sections: 4, done: 4 })
    expect(p.finishedAt).toBeDefined()
    expect(study.skills().map(s => s.name)).toEqual(['Method 1', 'Method 2', 'Method 3', 'Method 4'])
    expect(deps.chat).toHaveBeenCalledTimes(4)
    const said = (deps.report as any).mock.calls.map((c: string[]) => c[0]).join('\n')
    expect(said).toMatch(/started studying "D2L" \(4 sections\)/)
    expect(said).toMatch(/finished studying "D2L": 4 sections of notes and 4 skills/)
    expect(new BookStudy(file, deps).report()).toMatch(/"D2L": studied — 4 skills[\s\S]*Method 4 \(from "D2L"\)/)
  })

  it('waits while Goga is busy, and retries when the brain is in use', async () => {
    let idle = false
    const chat = vi.fn().mockRejectedValueOnce(new Error('brain busy')).mockResolvedValue(reply(1))
    const { study } = setup({ idle: () => idle, chat })
    await study.step()
    expect(chat).not.toHaveBeenCalled()
    idle = true
    await study.step()
    expect(study.all()[0].done).toBe(0)
    await study.step()
    expect(study.all()[0].done).toBe(1)
  })

  it('skips a section the brain keeps garbling instead of stalling', async () => {
    const { study } = setup({ chat: vi.fn(async () => 'not json') })
    for (let i = 0; i < 3; i++) await study.step()
    expect(study.all()[0]).toMatchObject({ done: 1, notes: [] })
  })
})
