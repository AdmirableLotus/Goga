import type { MemoryEntry } from '../../shared/types'
import { nanoid } from '../utils/nanoid'

export class MemoryService {
  private static instance: MemoryService
  private store: Map<string, MemoryEntry> = new Map()

  static getInstance() {
    if (!MemoryService.instance) MemoryService.instance = new MemoryService()
    return MemoryService.instance
  }

  get(key: string) { return this.store.get(key) ?? null }

  set(key: string, value: unknown): MemoryEntry {
    const existing = this.store.get(key)
    const entry: MemoryEntry = {
      id: existing?.id ?? nanoid(),
      key,
      value,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    }
    this.store.set(key, entry)
    return entry
  }

  list() { return Array.from(this.store.values()) }
  delete(key: string) { this.store.delete(key) }
}
