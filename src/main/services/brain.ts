import type { GogaFact, ChatMessage } from '../../shared/types'
import { nanoid } from '../utils/nanoid'
import { LogService } from './logs'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Store = require('electron-store')

interface BrainStore {
  facts: GogaFact[]
  conversationHistory: ChatMessage[]
  learnedTopics: string[]
}

const DEFAULTS: BrainStore = { facts: [], conversationHistory: [], learnedTopics: [] }
const HISTORY_LIMIT = 40
const FACTS_IN_PROMPT = 12

export class BrainService {
  private static instance: BrainService
  private store: ReturnType<typeof Store>
  private log = LogService.getInstance()

  static getInstance() {
    if (!BrainService.instance) BrainService.instance = new BrainService()
    return BrainService.instance
  }

  constructor() {
    this.store = new Store({ name: 'brain', defaults: DEFAULTS })
    this.log.info(`Brain loaded: ${this.getFacts().length} facts, ${this.getHistory().length} messages`)
  }

  addMessage(msg: ChatMessage) {
    let history: ChatMessage[] = this.store.get('conversationHistory')
    history.push(msg)
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT)
    this.store.set('conversationHistory', history)
  }

  addFact(content: string, category: GogaFact['category'], source: GogaFact['source'] = 'conversation') {
    const facts: GogaFact[] = this.store.get('facts')
    if (facts.some(f => f.content.toLowerCase() === content.toLowerCase())) return
    const fact: GogaFact = { id: nanoid(), category, content, source, createdAt: Date.now() }
    this.store.set('facts', [...facts, fact])
    this.log.info(`Brain learned: [${category}] ${content.slice(0, 80)}`)
  }

  addLearnedTopic(topic: string) {
    const topics: string[] = this.store.get('learnedTopics')
    if (!topics.includes(topic)) this.store.set('learnedTopics', [...topics, topic])
  }

  getHistory(): ChatMessage[]  { return this.store.get('conversationHistory') }
  getFacts(): GogaFact[]       { return this.store.get('facts') }
  getLearnedTopics(): string[] { return this.store.get('learnedTopics') }

  getRelevantFacts(query: string): GogaFact[] {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)
    const facts = this.getFacts()
    const scored = facts.map(f => ({
      fact: f,
      score: terms.filter(t => f.content.toLowerCase().includes(t)).length
    }))
    const relevant = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => s.fact)
    const aboutUser = facts.filter(f => f.category === 'about_user' && !relevant.includes(f))
    return [...aboutUser, ...relevant].slice(0, FACTS_IN_PROMPT)
  }

  clearHistory() { this.store.set('conversationHistory', []) }
  deleteFact(id: string) { this.store.set('facts', this.getFacts().filter(f => f.id !== id)) }
}
