import type { MemoryEntry } from '../../shared/types'
import { nanoid } from '../utils/nanoid'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Store = require('electron-store')

export class MemoryService {
  private static instance: MemoryService
  private store: ReturnType<typeof Store>

  static getInstance() {
    if (!MemoryService.instance) MemoryService.instance = new MemoryService()
    return MemoryService.instance
  }

  constructor() {
    this.store = new Store({ name: 'memory', defaults: { entries: {} } })
  }

  private entries(): Record<string, MemoryEntry> {
    return this.store.get('entries') as Record<string, MemoryEntry>
  }

  get(key: string): MemoryEntry | null {
    return this.entries()[key] ?? null
  }

  set(key: string, value: unknown): MemoryEntry {
    const existing = this.entries()[key]
    const entry: MemoryEntry = {
      id:        existing?.id ?? nanoid(),
      key,
      value,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    }
    this.store.set(`entries.${key}`, entry)
    return entry
  }

  list(): MemoryEntry[] {
    return Object.values(this.entries())
  }

  delete(key: string): void {
    this.store.delete(`entries.${key}`)
  }
}
