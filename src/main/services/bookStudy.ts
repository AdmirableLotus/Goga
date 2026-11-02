import fs from 'fs'

/**
 * Goga studies the books in his Library: section by section, while nobody is chatting, he
 * writes notes (the key ideas, terms) and skills (step-by-step methods he can follow later).
 * This doesn't retrain the model; the 14B can't be fine-tuned on this PC. What he learns is
 * kept here and put in front of him when a question or task matches, so he answers and
 * works the way the book teaches instead of improvising.
 */

export interface Skill { name: string; when: string; steps: string[]; book: string; section: number }
export interface SectionNotes { section: number; summary: string; ideas: string[]; terms: { term: string; meaning: string }[] }
export interface BookProgress {
  bookId: string
  title: string
  sections: number
  done: number
  notes: SectionNotes[]
  skills: Skill[]
  failures: number
  startedAt: number
  finishedAt?: number
}

type Messages = { role: 'system' | 'user' | 'assistant'; content: string }[]

export interface StudyDeps {
  /** The background brain; rejects while a reply is being written (try again later). */
  chat: (messages: Messages) => Promise<string>
  /** True when nobody is chatting and no task is running. */
  idle: () => boolean
  books: () => { id: string; title: string }[]
  chunks: (bookId: string) => string[]
  report: (text: string) => void
}

export const SECTION_CHARS = 6000
const MAX_SECTION_FAILURES = 3
const STEP_MS = 30_000
const MAX_SKILLS_PER_SECTION = 3

/** Consecutive passages grouped into sections of about SECTION_CHARS. */
export function sections(chunks: string[]): string[] {
  const out: string[] = []
  let current = ''
  for (const c of chunks) {
    if (current && current.length + c.length > SECTION_CHARS) { out.push(current); current = '' }
    current += (current ? '\n' : '') + c
  }
  if (current.trim()) out.push(current)
  return out
}

export const STUDY_SYSTEM = `You are Goga, studying a book so you can use it later. Read the section and reply with ONLY a JSON object:
{"summary": "2-3 sentences on what this section teaches",
 "ideas": ["key idea, in your own words", ...],
 "terms": [{"term": "...", "meaning": "..."}],
 "skills": [{"name": "short name of a method", "when": "when to use it", "steps": ["step 1", "step 2", ...]}]}
Rules: up to 5 ideas, up to 5 terms, up to ${MAX_SKILLS_PER_SECTION} skills. A skill is a concrete method someone could follow (a procedure, a checklist, a formula with how to apply it) — not a topic. If the section is front matter, an index, references or code listings with no method, return empty lists. Use only what the section says; do not add outside knowledge.`

const str = (v: unknown, max = 400) => typeof v === 'string' ? v.trim().slice(0, max) : ''
const strList = (v: unknown, n: number, max = 300) => Array.isArray(v) ? v.map(x => str(x, max)).filter(Boolean).slice(0, n) : []

/** The model's notes for one section, cleaned; throws when there's no usable JSON. */
export function parseNotes(raw: string, book: string, section: number): { notes: SectionNotes; skills: Skill[] } {
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  if (!json) throw new Error('no JSON in the notes')
  const o = JSON.parse(json) as Record<string, unknown>
  const terms = Array.isArray(o.terms) ? (o.terms as Record<string, unknown>[]).map(t => ({ term: str(t?.term, 80), meaning: str(t?.meaning, 300) })).filter(t => t.term && t.meaning).slice(0, 5) : []
  const skills = Array.isArray(o.skills) ? (o.skills as Record<string, unknown>[]).map(s => ({
    name: str(s?.name, 100), when: str(s?.when, 300), steps: strList(s?.steps, 10), book, section,
  })).filter(s => s.name && s.steps.length >= 2).slice(0, MAX_SKILLS_PER_SECTION) : []
  return { notes: { section, summary: str(o.summary, 600), ideas: strList(o.ideas, 5), terms }, skills }
}

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])

/** Skills whose name, use and steps share the most words with the request. */
export function matchSkills(all: Skill[], request: string, limit = 3): Skill[] {
  const wanted = words(request)
  if (wanted.size === 0) return []
  return all.map(skill => {
    const name = words(skill.name), rest = words(`${skill.when} ${skill.steps.join(' ')}`)
    let score = 0
    for (const w of wanted) score += (name.has(w) ? 3 : 0) + (rest.has(w) ? 1 : 0)
    return { skill, score }
  }).filter(s => s.score >= 3).sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.skill)
}

/** Skills written as instructions to follow, for the brain's prompt. */
export function skillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return ''
  return `Methods you learned from your books (follow them when they fit, and say which book they come from):\n${skills.map(s => `- ${s.name} (from "${s.book}"; use when ${s.when || 'it fits'}): ${s.steps.map((x, i) => `${i + 1}. ${x}`).join(' ')}`).join('\n')}`
}

export class BookStudy {
  private progress: Record<string, BookProgress> = {}
  private timer?: ReturnType<typeof setInterval>
  private working = false

  constructor(private file: string, private deps: StudyDeps) {
    try { this.progress = JSON.parse(fs.readFileSync(file, 'utf-8')) ?? {} } catch { /* nothing studied yet */ }
  }

  start(): void { if (!this.timer) this.timer = setInterval(() => { void this.step() }, STEP_MS) }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  all(): BookProgress[] { return Object.values(this.progress) }
  skills(): Skill[] { return this.all().flatMap(p => p.skills) }

  /** The next book with sections left, in the order the books were added. */
  private nextBook(): { id: string; title: string } | undefined {
    return this.deps.books().find(b => {
      const p = this.progress[b.id]
      return !p || (!p.finishedAt && p.done < p.sections)
    })
  }

  /** Study one section of the next unfinished book, when Goga is idle. */
  async step(): Promise<void> {
    if (this.working || !this.deps.idle()) return
    const book = this.nextBook()
    if (!book) return
    this.working = true
    try {
      const parts = sections(this.deps.chunks(book.id))
      const p = this.progress[book.id] ??= { bookId: book.id, title: book.title, sections: parts.length, done: 0, notes: [], skills: [], failures: 0, startedAt: Date.now() }
      if (p.done === 0 && p.notes.length === 0) this.deps.report(`📚 I've started studying "${book.title}" (${parts.length} sections). I study while you're not chatting with me and will tell you when I'm done.`)
      const index = p.done
      let raw: string
      try {
        raw = await this.deps.chat([{ role: 'system', content: STUDY_SYSTEM }, { role: 'user', content: `Book: "${book.title}", section ${index + 1} of ${parts.length}:\n\n${parts[index]}` }])
      } catch { return } // brain busy: try again on the next step
      try {
        const { notes, skills } = parseNotes(raw, book.title, index + 1)
        p.notes.push(notes)
        p.skills.push(...skills)
        p.failures = 0
        p.done++
      } catch {
        // Unreadable notes: retry, then skip the section rather than stall the whole book.
        if (++p.failures >= MAX_SECTION_FAILURES) { p.failures = 0; p.done++ }
      }
      const quarter = (n: number) => Math.floor((n / p.sections) * 4)
      if (p.done >= p.sections) {
        p.finishedAt = Date.now()
        this.deps.report(`📚 I finished studying "${book.title}": ${p.notes.length} sections of notes and ${p.skills.length} skills learned. Ask me "what skills have you learned" to see them.`)
      } else if (quarter(p.done) > quarter(index)) {
        this.deps.report(`📚 Studying "${book.title}": ${Math.round((p.done / p.sections) * 100)}% done, ${p.skills.length} skills so far.`)
      }
      this.save()
    } finally {
      this.working = false
    }
  }

  /** Forget a book's study when the book is removed from the Library. */
  forget(bookId: string): void { delete this.progress[bookId]; this.save() }

  /** Progress and skills, for chat. */
  report(): string {
    const books = this.deps.books()
    if (books.length === 0) return 'My Library is empty, so I have nothing to study. Give me a book (the Library page, or "read and learn" with a link to a PDF).'
    const lines = books.map(b => {
      const p = this.progress[b.id]
      if (!p) return `- "${b.title}": not started yet`
      if (p.finishedAt) return `- "${b.title}": studied — ${p.skills.length} skills, ${p.notes.length} sections of notes`
      return `- "${b.title}": ${Math.round((p.done / p.sections) * 100)}% studied (${p.done}/${p.sections} sections), ${p.skills.length} skills so far`
    })
    const recent = this.skills().slice(-8).map(s => `- ${s.name} (from "${s.book}")`)
    return `My studying:\n${lines.join('\n')}${recent.length ? `\n\nSkills I learned most recently:\n${recent.join('\n')}` : ''}\n\nHonestly: studying doesn't retrain my brain. I keep notes and step-by-step methods from each book, and I follow them when a question or task matches.`
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.progress))
      fs.renameSync(tmp, this.file)
    } catch { /* best effort */ }
  }
}

let instance: BookStudy | undefined
export function initBookStudy(file: string, deps: StudyDeps): BookStudy { return instance = new BookStudy(file, deps) }
export function bookStudy(): BookStudy | undefined { return instance }

export const STUDY_QUESTION = /\b(what (skills|have you learned|did you learn)|(your|my) (studying|study progress|learned skills)|how('s| is) (your )?(studying|the studying|reading) going|skills (have you|did you) learn)/i
