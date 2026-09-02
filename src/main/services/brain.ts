import path from 'path'
import { app } from 'electron'
import type { GogaFact, ChatMessage } from '../../shared/types'
import { nanoid } from '../utils/nanoid'
import { LogService } from './logs'

// Use a simple JSON file for persistence — no extra deps beyond what's built in
import fs from 'fs'

interface BrainStore {
  facts: GogaFact[]
  conversationHistory: ChatMessage[]
  learnedTopics: string[]
}

const HISTORY_LIMIT = 40   // messages kept in rolling context
const FACTS_IN_PROMPT = 12 // max facts injected per request

export class BrainService {
  private static instance: BrainService
  private store: BrainStore = { facts: [], conversationHistory: [], learnedTopics: [] }
  private filePath: string
  private log = LogService.getInstance()

  static getInstance() {
    if (!BrainService.instance) BrainService.instance = new BrainService()
    return BrainService.instance
  }

  constructor() {
    const dataDir = app.getPath('userData')
    this.filePath = path.join(dataDir, 'goga-brain.json')
    this.load()
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.store = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
        this.log.info(`Brain loaded: ${this.store.facts.length} facts, ${this.store.conversationHistory.length} messages`)
      }
    } catch { this.store = { facts: [], conversationHistory: [], learnedTopics: [] } }
  }

  private save() {
    try { fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2)) }
    catch (e) { this.log.error(`Brain save failed: ${e}`) }
  }

  // Add a message to rolling conversation history
  addMessage(msg: ChatMessage) {
    this.store.conversationHistory.push(msg)
    if (this.store.conversationHistory.length > HISTORY_LIMIT) {
      this.store.conversationHistory = this.store.conversationHistory.slice(-HISTORY_LIMIT)
    }
    this.save()
  }

  // Store a fact Goga learned
  addFact(content: string, category: GogaFact['category'], source: GogaFact['source'] = 'conversation') {
    // Avoid exact duplicates
    if (this.store.facts.some(f => f.content.toLowerCase() === content.toLowerCase())) return
    const fact: GogaFact = { id: nanoid(), category, content, source, createdAt: Date.now() }
    this.store.facts.push(fact)
    this.save()
    this.log.info(`Brain learned: [${category}] ${content.slice(0, 80)}`)
  }

  // Mark a topic as learned from a book
  addLearnedTopic(topic: string) {
    if (!this.store.learnedTopics.includes(topic)) {
      this.store.learnedTopics.push(topic)
      this.save()
    }
  }

  getHistory() { return [...this.store.conversationHistory] }
  getFacts() { return [...this.store.facts] }
  getLearnedTopics() { return [...this.store.learnedTopics] }

  // Get the most relevant facts for a given message (simple keyword match)
  getRelevantFacts(query: string): GogaFact[] {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)
    const scored = this.store.facts.map(f => ({
      fact: f,
      score: terms.filter(t => f.content.toLowerCase().includes(t)).length
    }))
    const relevant = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => s.fact)
    // Always include about_user facts
    const aboutUser = this.store.facts.filter(f => f.category === 'about_user' && !relevant.includes(f))
    return [...aboutUser, ...relevant].slice(0, FACTS_IN_PROMPT)
  }

  clearHistory() { this.store.conversationHistory = []; this.save() }
  deleteFact(id: string) { this.store.facts = this.store.facts.filter(f => f.id !== id); this.save() }
}
