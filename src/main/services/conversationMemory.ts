import fs from 'fs'
import type { ChatMessage, GogaFact } from '../../shared/types'
import { keywordScore, recallFacts, type StoredEmbedding } from './semanticRecall'

/**
 * Remembers past conversations. The chat history keeps only the last 40 messages; older
 * talks were lost. Here every conversation is kept on disk, and once one is over (a long
 * pause, or enough messages) the local brain writes a short dated note about it. Notes
 * relevant to a new message, or to the day it asks about, go back into the brain's context.
 */

export interface MemoryNote { id: string; from: number; to: number; text: string }

interface ArchivedMessage { role: 'user' | 'assistant'; content: string; timestamp: number }

interface MemoryFile {
  pending: ArchivedMessage[]          // not yet written up as a note
  notes: MemoryNote[]
  embeddings: Record<string, StoredEmbedding>
}

type ChatFn = (messages: { role: 'system' | 'user'; content: string }[]) => Promise<string>

export interface ConversationMemoryDeps {
  chat: ChatFn
  userName: () => string
  /** Embedding model for recall by meaning; keyword matching when absent or failing. */
  embed?: { model: () => string | undefined; run: (model: string, texts: string[]) => Promise<number[][]> }
  log: { info: (m: string) => void; warn: (m: string) => void }
  now?: () => number
  delayMs?: number
}

// A pause this long ends a conversation.
export const CONVERSATION_GAP_MS = 30 * 60_000
// A long conversation is written up in parts of this many messages.
export const NOTE_BATCH_MESSAGES = 12
const NOTE_DELAY_MS = 20_000
const MESSAGE_CHARS = 1500
const NOTE_CHARS = 900
const NOTES_IN_PROMPT = 3
const MEMORY_PROMPT_CHARS = 2400
// Same rule as fact learning: secrets never go into memory.
const SECRET = /\b(password|passcode|pin\b|otp|one[- ]time code|verification code|api[- ]?key|secret|card number|cvv|iban|account number|routing number|ssn|social security)\b/i
const DAY_MS = 86_400_000
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export function notePrompt(userName: string): string {
  return `You keep the memory of ${userName}'s personal assistant, Goga. Read one conversation between ${userName} and Goga and write a short note Goga can read later to remember it.

Write 2 to 5 short bullet points ("- ..."):
- what it was about and what was worked on,
- what was decided or agreed,
- what is still open or planned next.

Be specific (names, projects, numbers that matter). Leave out greetings and small talk. Never include passwords, codes, card or account numbers, keys or tokens.
If nothing worth remembering happened, write only: NOTHING`
}

/** Bullet lines of a note, without secrets; empty when there is nothing to keep. */
export function cleanNote(raw: string): string {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (/^nothing\b/i.test(text)) return ''
  return text.split('\n').map(l => l.trim()).filter(l => l && !SECRET.test(l)).join('\n').slice(0, NOTE_CHARS).trim()
}

/** The time span a message asks about ("yesterday", "last week", "on Monday"), if any. */
export function askedPeriod(message: string, now: number): { from: number; to: number } | undefined {
  const m = message.toLowerCase()
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0)
  const today = midnight.getTime()
  if (/\btoday\b|\bthis morning\b|\bearlier\b/.test(m)) return { from: today, to: now }
  if (/\byesterday\b|\blast night\b/.test(m)) return { from: today - DAY_MS, to: today }
  if (/\b(this|past) week\b|\bfew days ago\b/.test(m)) return { from: now - 7 * DAY_MS, to: now }
  if (/\blast week\b/.test(m)) return { from: now - 14 * DAY_MS, to: now - 7 * DAY_MS + DAY_MS }
  if (/\blast month\b|\b(this|past) month\b/.test(m)) return { from: now - 31 * DAY_MS, to: now }
  const day = WEEKDAYS.findIndex(d => new RegExp(`\\b(on |last )?${d}\\b`).test(m))
  if (day >= 0) {
    const back = ((midnight.getDay() - day + 7) % 7) || 7
    const from = today - back * DAY_MS
    return { from, to: from + DAY_MS }
  }
  return undefined
}

function noteDate(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(ms))
}

export class ConversationMemory {
  private data: MemoryFile = { pending: [], notes: [], embeddings: {} }
  private writing = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private now: () => number

  constructor(private deps: ConversationMemoryDeps, private file?: string) {
    this.now = deps.now ?? Date.now
    try {
      if (file && fs.existsSync(file)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
    } catch (err) {
      deps.log.warn(`Conversation memory unreadable, starting fresh: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  getNotes(): MemoryNote[] { return [...this.data.notes] }
  isEmpty(): boolean { return this.data.notes.length === 0 && this.data.pending.length === 0 }

  /**
   * Keep a chat message. A while after Goga answers, a finished conversation is written up;
   * waiting lets the reply be spoken and fact learning run first, and a note is never
   * written while the user is waiting for an answer.
   */
  record(msg: ChatMessage): void {
    if (msg.role !== 'user' && msg.role !== 'assistant') return
    this.data.pending.push({ role: msg.role, content: msg.content.slice(0, MESSAGE_CHARS), timestamp: msg.timestamp })
    this.save()
    if (msg.role !== 'assistant') return
    this.scheduleNote()
  }

  private scheduleNote(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      // Several finished conversations (say, after a first run) are written one after another.
      const before = this.data.pending.length
      void this.writeNote().then(() => { if (this.data.pending.length < before && this.dueBatch().length > 0) this.scheduleNote() })
    }, this.deps.delayMs ?? NOTE_DELAY_MS)
    this.timer.unref?.()
  }

  /** The oldest finished conversation: messages before a long pause, or a full batch. */
  private dueBatch(): ArchivedMessage[] {
    const pending = this.data.pending
    const gap = pending.findIndex((m, i) => i > 0 && m.timestamp - pending[i - 1].timestamp > CONVERSATION_GAP_MS)
    if (gap > 0) return pending.slice(0, Math.min(gap, NOTE_BATCH_MESSAGES))
    return pending.length >= NOTE_BATCH_MESSAGES ? pending.slice(0, NOTE_BATCH_MESSAGES) : []
  }

  /** Write up a finished conversation as a note, if one is due. Background work: never throws. */
  async writeNote(): Promise<MemoryNote | undefined> {
    if (this.writing) return undefined
    const batch = this.dueBatch()
    if (batch.length === 0) return undefined
    this.writing = true
    try {
      const userName = this.deps.userName()
      const transcript = batch.map(m => `${m.role === 'user' ? userName : 'Goga'}: ${m.content}`).join('\n\n')
      const raw = await this.deps.chat([
        { role: 'system', content: notePrompt(userName) },
        { role: 'user', content: `Conversation on ${noteDate(batch[0].timestamp)}:\n\n${transcript}` },
      ])
      // Messages that arrived while the note was being written stay pending.
      this.data.pending = this.data.pending.slice(batch.length)
      const text = cleanNote(raw)
      let note: MemoryNote | undefined
      if (text) {
        note = { id: `${batch[0].timestamp}-${batch.length}`, from: batch[0].timestamp, to: batch[batch.length - 1].timestamp, text }
        this.data.notes.push(note)
        this.deps.log.info(`Remembered a conversation from ${noteDate(note.from)} (${batch.length} messages)`)
      }
      this.save()
      return note
    } catch (err) {
      // Usually the brain was busy with the user; the messages stay pending for next time.
      this.deps.log.warn(`Conversation note skipped: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    } finally {
      this.writing = false
    }
  }

  /** Notes worth showing the brain for this message: the day it asks about, else by topic. */
  async recall(message: string): Promise<MemoryNote[]> {
    const notes = this.data.notes
    if (notes.length === 0) return []
    const period = askedPeriod(message, this.now())
    if (period) {
      const inPeriod = notes.filter(n => n.to >= period.from && n.from < period.to)
      if (inPeriod.length > 0) return inPeriod.slice(-NOTES_IN_PROMPT)
    }
    const relevant = await this.byTopic(message)
    // The latest note keeps "where were we?" and "continue" working.
    const latest = notes[notes.length - 1]
    const chosen = relevant.includes(latest) ? relevant : [...relevant.slice(0, NOTES_IN_PROMPT - 1), latest]
    return chosen.slice(0, NOTES_IN_PROMPT).sort((a, b) => a.from - b.from)
  }

  /** The notes as a block for the system prompt. */
  async promptBlock(message: string): Promise<string> {
    const notes = await this.recall(message)
    if (notes.length === 0) return ''
    const lines = notes.map(n => `${noteDate(n.from)}:\n${n.text}`).join('\n\n').slice(0, MEMORY_PROMPT_CHARS)
    return `Your notes from earlier conversations with ${this.deps.userName()}:\n${lines}`
  }

  private async byTopic(message: string): Promise<MemoryNote[]> {
    const notes = this.data.notes
    // recallFacts ranks any short texts; notes are passed as facts that are never "about_user".
    const asFacts: GogaFact[] = notes.map(n => ({ id: n.id, category: 'event', content: n.text, source: 'conversation', createdAt: n.from }))
    const model = this.deps.embed?.model()
    if (model && this.deps.embed) {
      try {
        const found = await recallFacts({
          query: message, facts: asFacts, limit: NOTES_IN_PROMPT, model,
          embed: texts => this.deps.embed!.run(model, texts),
          cache: this.data.embeddings,
          saveCache: updates => { this.data.embeddings = { ...this.data.embeddings, ...updates }; this.save() },
        })
        return found.map(f => notes.find(n => n.id === f.id)!).filter(Boolean)
      } catch { /* keyword matching below */ }
    }
    return notes
      .map(n => ({ n, score: keywordScore(message, n.text) }))
      .filter(s => s.score >= 2)
      .sort((a, b) => b.score - a.score)
      .map(s => s.n)
      .slice(0, NOTES_IN_PROMPT)
  }

  private save(): void {
    if (!this.file) return
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 })
    } catch (err) {
      this.deps.log.warn(`Could not save conversation memory: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
