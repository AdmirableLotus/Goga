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

// ── Rewriting a long text (rephrase, polish, translate…) ─────────────────────
// Notes are right for understanding a document but wrong for transforming it: a rewrite
// made from notes silently drops details. These requests rewrite the full text part by part.

const REWRITE_VERB = /\b(re-?phrase|re-?write|re-?word|paraphrase|proof-?read|polish|copy-?edit|clean (it |this )?up|fix (the |my )?(grammar|spelling|wording|tone)|translate|simplify|make (it|this|the text|my text) (sound|more|less|clearer|simpler|shorter|better|human|professional|friendlier|formal|casual)|sound (more )?(human|humane|natural|professional|friendly|formal|casual|warm))\b/i

/** For a message that asks to transform its own pasted text: the instruction and the text. */
export function rewriteRequest(message: string): { instruction: string; text: string } | null {
  if (message.length < 120) return null
  const head = message.slice(0, 300)
  const m = REWRITE_VERB.exec(head)
  if (m) {
    // The instruction runs to the end of its clause: a line break, '.', ':' or the first
    // capitalised word that starts the pasted text ("…sound humane My scope…").
    const after = message.slice(m.index)
    const words = after.split(/(\s+)/)
    let end = m.index, count = 0
    for (let i = 0; i < words.length && count < 30; i++) {
      const w = words[i]
      if (/\n/.test(w)) break
      if (!/^\s+$/.test(w)) {
        count++
        if (count > 1 && /^[A-Z]/.test(w)) break
        end += w.length
        if (/[.:]$/.test(w)) break
        continue
      }
      end += w.length
    }
    const instruction = message.slice(0, end).trim()
    return { instruction, text: message.slice(end).trim() }
  }
  const tail = message.slice(-300)
  const t = REWRITE_VERB.exec(tail)
  if (t) {
    // Instruction at the end: "…<text>… Please rephrase this to sound human."
    const start = message.length - 300 + t.index
    const sentenceStart = Math.max(message.lastIndexOf('\n', start), message.lastIndexOf('. ', start) + 1, 0)
    return { instruction: message.slice(sentenceStart).trim(), text: message.slice(0, sentenceStart).trim() }
  }
  return null
}

type StreamChat = (messages: { role: 'system' | 'user'; content: string }[], onToken: (t: string) => void, signal?: AbortSignal) => Promise<string>

const REWRITER = 'You rewrite text exactly as asked. Keep EVERY fact, number, dollar amount, name, part, heading, ' +
  'list item and step — do not summarise, merge away, skip or add anything, and do not comment on the text. ' +
  'If asked to make it sound human or humane, write it the way a real person would: warm, natural, first person ' +
  'where it fits, plain words and varied sentences, never stiff or robotic. Output only the rewritten text.'

/** Rewrite a long text in parts, streaming each part as it is written. */
export async function rewriteInParts(text: string, instruction: string, userName: string, chat: StreamChat,
  onToken?: (t: string) => void, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<string> {
  const parts = splitIntoParts(text, 4500)
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    signal?.throwIfAborted()
    onProgress?.(i, parts.length)
    if (i > 0) onToken?.('\n\n')
    const piece = await chat([
      { role: 'system', content: REWRITER },
      { role: 'user', content: `${userName}'s instruction: "${instruction}"\nThis is part ${i + 1} of ${parts.length} of their text. Rewrite this part in full:\n"""\n${parts[i]}\n"""` },
    ], tok => onToken?.(tok), signal)
    out.push(piece.trim())
  }
  onProgress?.(parts.length, parts.length)
  return out.join('\n\n')
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
