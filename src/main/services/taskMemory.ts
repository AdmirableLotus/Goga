import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { nanoid } from '../utils/nanoid'
import { LogService } from './logs'

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
  private patterns: TaskPattern[] = []
  private filePath: string
  private log = LogService.getInstance()

  static getInstance() {
    if (!TaskMemoryService.instance) TaskMemoryService.instance = new TaskMemoryService()
    return TaskMemoryService.instance
  }

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'goga-tasks.json')
    this.load()
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.patterns = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
        this.log.info(`Task memory loaded: ${this.patterns.length} patterns`)
      }
    } catch { this.patterns = [] }
  }

  private save() {
    try { fs.writeFileSync(this.filePath, JSON.stringify(this.patterns, null, 2)) } catch { /* ignore */ }
  }

  // Find patterns relevant to a goal using keyword overlap
  findRelevant(goal: string, limit = 3): TaskPattern[] {
    const terms = goal.toLowerCase().split(/\s+/).filter(t => t.length > 3)
    const scored = this.patterns.map(p => ({
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
    // Update existing if same goal, otherwise create new
    const existing = this.patterns.find(p =>
      p.goal.toLowerCase() === goal.toLowerCase() && p.appContext === appContext
    )
    if (existing) {
      existing.steps = steps
      existing.successCount++
      existing.lastUsed = Date.now()
      this.save()
      return existing
    }
    const pattern: TaskPattern = {
      id: nanoid(), goal, appContext, steps,
      successCount: 1, lastUsed: Date.now(), createdAt: Date.now()
    }
    this.patterns.push(pattern)
    // Keep bounded
    if (this.patterns.length > 200) {
      this.patterns.sort((a, b) => b.lastUsed - a.lastUsed)
      this.patterns = this.patterns.slice(0, 200)
    }
    this.save()
    this.log.info(`Task pattern saved: "${goal}"`)
    return pattern
  }

  list() { return [...this.patterns] }
  delete(id: string) { this.patterns = this.patterns.filter(p => p.id !== id); this.save() }
}
