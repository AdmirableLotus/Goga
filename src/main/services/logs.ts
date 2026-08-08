import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { LogEntry } from '../../shared/types'
import { nanoid } from '../utils/nanoid'

const MAX_ENTRIES = 2000

export class LogService {
  private static instance: LogService
  private entries: LogEntry[] = []
  private filePath: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  static getInstance() {
    if (!LogService.instance) LogService.instance = new LogService()
    return LogService.instance
  }

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'goga-logs.json')
    this.load()
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.entries = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      }
    } catch { this.entries = [] }
  }

  // Debounced save — logs can be high-frequency, avoid hammering disk
  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      try { fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2)) } catch { /* ignore */ }
    }, 2000)
  }

  private add(level: LogEntry['level'], message: string, meta?: Record<string, unknown>, actionId?: string) {
    const entry: LogEntry = { id: nanoid(), level, message, timestamp: Date.now(), actionId, meta }
    this.entries.unshift(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES
    this.scheduleSave()
    return entry
  }

  info(message: string, meta?: Record<string, unknown>, actionId?: string) { return this.add('info', message, meta, actionId) }
  warn(message: string, meta?: Record<string, unknown>, actionId?: string) { return this.add('warn', message, meta, actionId) }
  error(message: string, meta?: Record<string, unknown>, actionId?: string) { return this.add('error', message, meta, actionId) }

  list() { return [...this.entries] }

  clear() {
    this.entries = []
    try { fs.writeFileSync(this.filePath, '[]') } catch { /* ignore */ }
  }
}
