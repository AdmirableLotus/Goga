import { createHash } from 'crypto'
import fs from 'fs'

/**
 * Long documents and the brain's 8K-token context.
 *
 * A pasted document (an R&D plan, a contract) can be several times larger than the
 * context. Goga reads it in parts, takes compact notes on each part, and from then on
 * uses those notes wherever the document appears in the conversation. Notes are kept
 * on disk, so a document is read only once, not again after every restart.
 */

/** Messages longer than this are read in parts instead of being sent whole. */
export const LONG_TEXT_CHARS = 6000
const PART_CHARS = 6000
const MAX_NOTES_CHARS = 5000
const CONDENSE_BATCH_CHARS = 14000
const MAX_STORED_DOCUMENTS = 20

type Chat = (messages: { role: 'system' | 'user'; content: string }[], signal?: AbortSignal) => Promise<string>

const NOTE_TAKER = 'You take compact, faithful notes. Keep every specific fact, number, name, component, date, ' +
  'target and heading. Use short bullet points under the document\'s own headings. ' +
  'Do not add, judge or summarise away anything that is in the text, and add nothing that is not.'

/** Split at paragraph, then sentence, boundaries so no part ends mid-thought. */
export function splitIntoParts(text: string, size = PART_CHARS): string[] {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > size) {
    const window = rest.slice(0, size)
    let cut = window.lastIndexOf('\n\n')
    if (cut < size * 0.5) cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'))
    if (cut < size * 0.5) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = size
    parts.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

/** Read a long text in parts and return notes small enough to fit in a conversation. */
export async function takeNotes(text: string, userName: string, chat: Chat,
  onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<string> {
  const parts = splitIntoParts(text)
  let notes: string[] = []
  for (let i = 0; i < parts.length; i++) {
    signal?.throwIfAborted()
    onProgress?.(i, parts.length)
    notes.push((await chat([
      { role: 'system', content: NOTE_TAKER },
      { role: 'user', content: `Part ${i + 1} of ${parts.length} of a document from ${userName}:\n"""\n${parts[i]}\n"""\nWrite the notes for this part.` },
    ], signal)).trim())
  }
  onProgress?.(parts.length, parts.length)

  // Merge in batches until the notes fit.
  for (let round = 0; round < 3 && notes.join('\n\n').length > MAX_NOTES_CHARS; round++) {
    const batches: string[][] = [[]]
    for (const n of notes) {
      const last = batches[batches.length - 1]
      if (last.length && [...last, n].join('\n\n').length > CONDENSE_BATCH_CHARS) batches.push([n])
      else last.push(n)
    }
    const target = Math.floor(MAX_NOTES_CHARS / batches.length)
    const merged: string[] = []
    for (const batch of batches) {
      signal?.throwIfAborted()
      merged.push((await chat([
        { role: 'system', content: NOTE_TAKER },
        { role: 'user', content: `Merge these notes into one set of at most ${target} characters, keeping the specific facts and numbers:\n"""\n${batch.join('\n\n')}\n"""` },
      ], signal)).trim())
    }
    notes = merged
  }
  return notes.join('\n\n').slice(0, MAX_NOTES_CHARS + 1000)
}

/** Notes for documents already read, keyed by a hash of the document. */
export class NotesStore {
  private notes = new Map<string, string>()

  constructor(private file?: string) {
    if (!file) return
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (saved && typeof saved === 'object') for (const [k, v] of Object.entries(saved)) if (typeof v === 'string') this.notes.set(k, v)
    } catch { /* nothing read yet */ }
  }

  static key(text: string): string { return createHash('sha256').update(text).digest('hex') }

  get(text: string): string | undefined { return this.notes.get(NotesStore.key(text)) }

  set(text: string, notes: string): void {
    this.notes.set(NotesStore.key(text), notes)
    while (this.notes.size > MAX_STORED_DOCUMENTS) this.notes.delete(this.notes.keys().next().value!)
    if (!this.file) return
    try { fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.notes)), { mode: 0o600 }) } catch { /* keep in memory */ }
  }
}

/** How a long message appears to the brain: its opening words, then the notes on all of it. */
export function asNotes(text: string, notes: string): string {
  return `${text.slice(0, 600).trim()}…\n\n[The full message is ${text.length} characters long. Notes on all of it:]\n${notes}`
}

const HISTORY_MESSAGE_CHARS = 1500
const HISTORY_BUDGET_CHARS = 9000

/**
 * Fit earlier turns into the context: long documents become their notes, other long
 * messages are shortened, and the oldest turns are dropped first once over budget.
 */
export function fitHistory<M extends { role: string; content: string }>(history: M[], notesFor: (text: string) => string | undefined): M[] {
  const shaped = history.map(m => {
    const notes = m.content.length > LONG_TEXT_CHARS ? notesFor(m.content) : undefined
    const content = notes ? asNotes(m.content, notes)
      : m.content.length > HISTORY_MESSAGE_CHARS ? `${m.content.slice(0, HISTORY_MESSAGE_CHARS)}… [shortened]` : m.content
    return { ...m, content }
  })
  const kept: M[] = []
  let total = 0
  for (let i = shaped.length - 1; i >= 0; i--) {
    total += shaped[i].content.length
    if (total > HISTORY_BUDGET_CHARS && kept.length > 0) break
    kept.unshift(shaped[i])
  }
  return kept
}
