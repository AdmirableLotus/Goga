import { nanoid } from '../utils/nanoid'
import { LogService } from './logs'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Store = require('electron-store')

export interface TaskPattern {
  id: string
  goal: string               // e.g. "open VS Code and create a new file"
  appContext: string          // e.g. "VS Code", "Brave", "File Explorer"
  steps: PatternStep[]
  successCount: number
  lastUsed: number
  createdAt: number
}

export interface PatternStep {
  description: string        // human-readable: "click File menu"
  tool: string               // "computer.click"
  paramTemplate: Record<string, unknown>  // params with placeholders like "{x}", "{y}"
  verifyCondition?: string   // what to check after: "menu appeared", "file created"
}

export class TaskMemoryService {
  private static instance: TaskMemoryService
  private store: ReturnType<typeof Store>
  private log = LogService.getInstance()

  static getInstance() {
    if (!TaskMemoryService.instance) TaskMemoryService.instance = new TaskMemoryService()
    return TaskMemoryService.instance
  }

  constructor() {
    this.store = new Store({ name: 'tasks', defaults: { patterns: [] } })
    this.log.info(`Task memory loaded: ${this.list().length} patterns`)
  }

  private getPatterns(): TaskPattern[] { return this.store.get('patterns') }
  private setPatterns(p: TaskPattern[]) { this.store.set('patterns', p) }

  findRelevant(goal: string, limit = 3): TaskPattern[] {
    const terms = goal.toLowerCase().split(/\s+/).filter(t => t.length > 3)
    const patterns = this.getPatterns()
    const scored = patterns.map(p => ({
      pattern: p,
      score: terms.filter(t =>
        p.goal.toLowerCase().includes(t) ||
        p.appContext.toLowerCase().includes(t)
      ).length
    }))
    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || b.pattern.successCount - a.pattern.successCount)
      .slice(0, limit)
      .map(s => s.pattern)
  }

  save_pattern(goal: string, appContext: string, steps: PatternStep[]): TaskPattern {
    const patterns = this.getPatterns()
    const existing = patterns.find(p =>
      p.goal.toLowerCase() === goal.toLowerCase() && p.appContext === appContext
    )
    if (existing) {
      existing.steps = steps
      existing.successCount++
      existing.lastUsed = Date.now()
      this.setPatterns(patterns)
      return existing
    }
    const pattern: TaskPattern = {
      id: nanoid(), goal, appContext, steps,
      successCount: 1, lastUsed: Date.now(), createdAt: Date.now()
    }
    let updated = [...patterns, pattern]
    if (updated.length > 200) {
      updated = updated.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 200)
    }
    this.setPatterns(updated)
    this.log.info(`Task pattern saved: "${goal}"`)
    return pattern
  }

  list() { return this.getPatterns() }
  delete(id: string) { this.setPatterns(this.getPatterns().filter(p => p.id !== id)) }
}
