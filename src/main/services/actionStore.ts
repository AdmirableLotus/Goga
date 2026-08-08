import type { Action } from '../../shared/types'

export class ActionStore {
  private static instance: ActionStore
  private actions: Map<string, Action> = new Map()

  static getInstance() {
    if (!ActionStore.instance) ActionStore.instance = new ActionStore()
    return ActionStore.instance
  }

  add(action: Action) { this.actions.set(action.id, action) }

  get(id: string) {
    const a = this.actions.get(id)
    if (!a) throw new Error(`Action not found: ${id}`)
    return a
  }

  list() { return Array.from(this.actions.values()).sort((a, b) => b.createdAt - a.createdAt) }

  approve(id: string) {
    const a = this.get(id)
    a.status = 'approved'
    a.resolvedAt = Date.now()
    return a
  }

  reject(id: string) {
    const a = this.get(id)
    a.status = 'rejected'
    a.resolvedAt = Date.now()
    return a
  }

  stopAll() {
    for (const a of this.actions.values()) {
      if (a.status === 'pending' || a.status === 'running') {
        a.status = 'rejected'
        a.resolvedAt = Date.now()
      }
    }
  }

  setStatus(id: string, status: Action['status']) {
    this.get(id).status = status
  }

  setResult(id: string, result: unknown) {
    const a = this.get(id)
    a.status = 'done'
    a.result = result
    a.resolvedAt = Date.now()
  }

  setError(id: string, error: string) {
    const a = this.get(id)
    a.status = 'error'
    a.error = error
    a.resolvedAt = Date.now()
  }
}
