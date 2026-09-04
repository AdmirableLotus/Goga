import type { LogEntry } from '../../shared/types'
import { nanoid } from '../utils/nanoid'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Store = require('electron-store')

const MAX_ENTRIES = 2000

export class LogService {
  private static instance: LogService
  private store: ReturnType<typeof Store>
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  // In-memory buffer — flushed to store on debounced timer
  private buffer: LogEntry[] = []

  static getInstance() {
    if (!LogService.instance) LogService.instance = new LogService()
    return LogService.instance
  }

  constructor() {
    this.store = new Store({ name: 'logs', defaults: { entries: [] } })
    this.buffer = this.store.get('entries') as LogEntry[]
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.store.set('entries', this.buffer)
    }, 2000)
  }

  private add(level: LogEntry['level'], message: string, meta?: Record<string, unknown>, actionId?: string): LogEntry {
    const entry: LogEntry = { id: nanoid(), level, message, timestamp: Date.now(), actionId, meta }
    this.buffer.unshift(entry)
    if (this.buffer.length > MAX_ENTRIES) this.buffer.length = MAX_ENTRIES
    this.scheduleSave()
    return entry
  }

  info(message: string, meta?: Record<string, unknown>, actionId?: string)  { return this.add('info',  message, meta, actionId) }
  warn(message: string, meta?: Record<string, unknown>, actionId?: string)  { return this.add('warn',  message, meta, actionId) }
  error(message: string, meta?: Record<string, unknown>, actionId?: string) { return this.add('error', message, meta, actionId) }

  list() { return [...this.buffer] }

  clear() {
    this.buffer = []
    this.store.set('entries', [])
  }
}
