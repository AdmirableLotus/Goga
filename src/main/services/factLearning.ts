import type { GogaFact } from '../../shared/types'

/**
 * Learns durable facts about the user from what they say, using the local brain.
 * Replaces keyword patterns that saved nonsense ("I'm hoping…" → "User's name is hoping").
 * Runs after the reply is sent, so it never slows a conversation down.
 */

export type LearnedFact = { category: Extract<GogaFact['category'], 'about_user' | 'preference' | 'event'>; content: string }

type ChatFn = (messages: { role: 'system' | 'user'; content: string }[]) => Promise<string>

export interface FactLearnerDeps {
  chat: ChatFn
  knownFacts: (message: string) => Promise<GogaFact[]>
  addFact: (content: string, category: GogaFact['category']) => void
  userName: () => string
  log: { info: (m: string) => void; warn: (m: string) => void }
}

const MAX_FACTS_PER_MESSAGE = 3
const MAX_FACT_CHARS = 200
const CATEGORIES = new Set(['about_user', 'preference', 'event'])
// Things that must never be stored, even if the user mentions them.
const SECRET = /\b(password|passcode|pin\b|otp|one[- ]time code|verification code|api[- ]?key|token|secret|card number|cvv|iban|account number|routing number|ssn|social security)\b/i

/** Cheap gate so the brain isn't asked about "open google.com": the user must talk about themself. */
export function worthLearningFrom(message: string): boolean {
  const m = message.trim()
  if (m.length < 12 || m.length > 2000) return false
  return /\b(i|i'm|im|i've|i'd|i'll|my|me|mine|we|our|remember)\b/i.test(m.replace(/’/g, "'"))
}

export function parseLearnedFacts(raw: string): LearnedFact[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim()
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { return [] }
  const list = (parsed as { facts?: unknown })?.facts
  if (!Array.isArray(list)) return []
  return list
    .filter((f): f is LearnedFact => !!f && typeof f === 'object'
      && CATEGORIES.has((f as LearnedFact).category) && typeof (f as LearnedFact).content === 'string')
    .map(f => ({ category: f.category, content: f.content.trim().replace(/\s+/g, ' ') }))
    .filter(f => f.content.length >= 8 && f.content.length <= MAX_FACT_CHARS && !SECRET.test(f.content))
    .slice(0, MAX_FACTS_PER_MESSAGE)
}

export function factPrompt(userName: string, known: GogaFact[]): string {
  return `You help ${userName}'s personal assistant remember ${userName}. Read ONE message ${userName} wrote and list the lasting facts it states about ${userName}.

Save only what ${userName} plainly says about:
- themself (name, home, work, studies, projects, health, routines),
- their preferences (likes, dislikes, how they want things done),
- people, pets and places in their life,
- upcoming plans or events with a time,
- anything they explicitly ask you to remember.

Do NOT save: questions, requests or tasks, guesses, passing moods, things about the assistant, or general knowledge. Never save passwords, codes, card or account numbers, keys or tokens.

Write each fact as one short sentence starting with "${userName}" (for example "${userName}'s mom lives in Kyiv." or "${userName} prefers short answers.").
${known.length > 0 ? `\nAlready known — don't repeat these:\n${known.map(f => `- ${f.content}`).join('\n')}\n` : ''}
Respond with ONLY JSON: {"facts":[{"category":"about_user"|"preference"|"event","content":"..."}]}
If nothing qualifies, respond {"facts":[]}.`
}

export class FactLearner {
  private busy = false

  constructor(private deps: FactLearnerDeps) {}

  /** Fire-and-forget: returns what was saved (for tests and logs); never throws. */
  async learnFrom(message: string): Promise<LearnedFact[]> {
    // One extraction at a time: a burst of messages shouldn't queue up brain work.
    if (this.busy || !worthLearningFrom(message)) return []
    this.busy = true
    try {
      const known = await this.deps.knownFacts(message)
      const raw = await this.deps.chat([
        { role: 'system', content: factPrompt(this.deps.userName(), known) },
        { role: 'user', content: message },
      ])
      const knownText = new Set(known.map(f => f.content.toLowerCase()))
      const facts = parseLearnedFacts(raw).filter(f => !knownText.has(f.content.toLowerCase()))
      for (const f of facts) this.deps.addFact(f.content, f.category)
      if (facts.length > 0) this.deps.log.info(`Learned ${facts.length} fact(s) from conversation`)
      return facts
    } catch (err) {
      this.deps.log.warn(`Fact learning skipped: ${err instanceof Error ? err.message : String(err)}`)
      return []
    } finally {
      this.busy = false
    }
  }
}
