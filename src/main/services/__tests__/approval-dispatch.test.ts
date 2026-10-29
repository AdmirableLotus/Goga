/**
 * approval-dispatch.test.ts
 *
 * Tests for the approval ownership fix in handlers/actions.ts:
 *
 *   A1 — agent-owned approval → one resolveApproval call, zero executeAction calls
 *   A2 — repeated approval of same action → second call is a no-op
 *   A3 — approval after Stop → zero execution (action already rejected by stopAll)
 *   A4 — old-run approval (agent not running) → zero execution
 *   A5 — valid legacy action → one executeAction call, zero resolveApproval calls
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../missionEngine', () => ({ MissionEngine: { getInstance: () => ({ listMissions: () => [], stop: vi.fn() }) } }))
vi.mock('../../handlers/developer', () => ({ stopDeveloperTask: vi.fn() }))

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  mockResolveApproval,
  mockIsRunning,
  mockStop,
  mockExecuteAction,
  mockStoreGet,
  mockStoreApprove,
  mockStoreReject,
  mockStoreStopAll,
  mockSend,
} = vi.hoisted(() => ({
  mockResolveApproval: vi.fn(),
  mockIsRunning:       vi.fn().mockReturnValue(true),
  mockStop:            vi.fn(),
  mockExecuteAction:   vi.fn().mockResolvedValue({}),
  mockStoreGet:        vi.fn(),
  mockStoreApprove:    vi.fn(),
  mockStoreReject:     vi.fn(),
  mockStoreStopAll:    vi.fn(),
  mockSend:            vi.fn(),
}))

vi.mock('../../services/actionStore', () => ({
  ActionStore: {
    getInstance: () => ({
      get:      mockStoreGet,
      approve:  mockStoreApprove,
      reject:   mockStoreReject,
      stopAll:  mockStoreStopAll,
      list:     vi.fn().mockReturnValue([]),
    })
  }
}))

vi.mock('../../services/agentLoop', () => ({
  AgentLoop: {
    getInstance: () => ({
      resolveApproval: mockResolveApproval,
      isRunning:       mockIsRunning,
      stop:            mockStop,
    })
  }
}))

vi.mock('../../services/orchestrator', () => ({
  OrchestratorService: vi.fn().mockImplementation(() => ({
    executeAction: mockExecuteAction,
  }))
}))

vi.mock('../../services/logs', () => ({
  LogService: {
    getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
  }
}))

vi.mock('../../index', () => ({
  getMainWindow: () => ({ webContents: { send: mockSend } })
}))

// ── Load handler under test ───────────────────────────────────────────────────

import { registerActionHandlers } from '../../handlers/actions'

// ── IpcMain stub ──────────────────────────────────────────────────────────────

type IpcHandler = (_e: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, IpcHandler>()

const fakeIpcMain = {
  handle: (channel: string, fn: IpcHandler) => { handlers.set(channel, fn) }
} as unknown as import('electron').IpcMain

registerActionHandlers(fakeIpcMain)

async function approve(actionId: string) {
  return handlers.get('action:approve')!({}, actionId)
}
async function reject(actionId: string) {
  return handlers.get('action:reject')!({}, actionId)
}
async function stop() {
  return handlers.get('action:stop')!({})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<{
  id: string; status: string; agentOwned: boolean; label: string
}> = {}) {
  return {
    id:           overrides.id      ?? 'action-1',
    type:         'computer.type',
    label:        overrides.label   ?? 'computer.type: test',
    params:       { text: 'hello', pid: 1, hwnd: 2 },
    status:       overrides.status  ?? 'pending',
    createdAt:    Date.now(),
    requiresApproval: true,
    riskLevel:    'high' as const,
    agentOwned:   overrides.agentOwned ?? false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsRunning.mockReturnValue(true)
  mockExecuteAction.mockResolvedValue({})
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('A1 — agent-owned approval: one resolveApproval, zero executeAction', () => {
  it('calls resolveApproval(id, true) exactly once and never calls executeAction', async () => {
    const action = makeAction({ agentOwned: true })
    mockStoreGet.mockReturnValue(action)
    mockStoreApprove.mockImplementation(() => { action.status = 'approved'; return action })

    await approve(action.id)

    expect(mockResolveApproval).toHaveBeenCalledOnce()
    expect(mockResolveApproval).toHaveBeenCalledWith(action.id, true)
    expect(mockExecuteAction).not.toHaveBeenCalled()
  })
})

describe('A2 — repeated approval: second call is a no-op', () => {
  it('first approval succeeds; second approval on already-approved action is dropped', async () => {
    const action = makeAction({ agentOwned: true })
    mockStoreGet.mockReturnValue(action)
    mockStoreApprove.mockImplementation(() => { action.status = 'approved'; return action })

    // First approval
    await approve(action.id)
    expect(mockResolveApproval).toHaveBeenCalledOnce()

    // Second approval — action.status is now 'approved', not 'pending'
    vi.clearAllMocks()
    await approve(action.id)

    expect(mockResolveApproval).not.toHaveBeenCalled()
    expect(mockExecuteAction).not.toHaveBeenCalled()
  })
})

describe('A3 — approval after Stop: zero execution', () => {
  it('agent-owned action that was stopped (status=rejected) is dropped on approve', async () => {
    // stopAll sets status to 'rejected'
    const action = makeAction({ agentOwned: true, status: 'rejected' })
    mockStoreGet.mockReturnValue(action)

    await approve(action.id)

    expect(mockResolveApproval).not.toHaveBeenCalled()
    expect(mockExecuteAction).not.toHaveBeenCalled()
  })
})

describe('A4 — old-run approval (agent not running): zero execution', () => {
  it('agent-owned approval arriving after agent stopped is rejected without execution', async () => {
    mockIsRunning.mockReturnValue(false)
    const action = makeAction({ agentOwned: true })
    mockStoreGet.mockReturnValue(action)
    mockStoreReject.mockImplementation(() => { action.status = 'rejected'; return action })

    await approve(action.id)

    expect(mockResolveApproval).not.toHaveBeenCalled()
    expect(mockExecuteAction).not.toHaveBeenCalled()
    expect(mockStoreReject).toHaveBeenCalledWith(action.id)
  })
})

describe('A5 — valid legacy action: one executeAction, zero resolveApproval', () => {
  it('non-agent-owned action calls executeAction exactly once and never resolveApproval', async () => {
    const action = makeAction({ agentOwned: false })
    mockStoreGet.mockReturnValue(action)
    mockStoreApprove.mockImplementation(() => { action.status = 'approved'; return action })

    await approve(action.id)

    // Wait for the async executeAction promise to settle
    await vi.waitFor(() => expect(mockExecuteAction).toHaveBeenCalledOnce())
    expect(mockExecuteAction).toHaveBeenCalledWith(action)
    expect(mockResolveApproval).not.toHaveBeenCalled()
  })
})

describe('Edge cases', () => {
  it('unknown actionId returns null without throwing', async () => {
    mockStoreGet.mockImplementation(() => { throw new Error('Action not found: bad-id') })
    const result = await approve('bad-id')
    expect(result).toBeNull()
    expect(mockResolveApproval).not.toHaveBeenCalled()
    expect(mockExecuteAction).not.toHaveBeenCalled()
  })

  it('reject on pending agent-owned action calls resolveApproval(id, false)', async () => {
    const action = makeAction({ agentOwned: true })
    mockStoreGet.mockReturnValue(action)
    mockStoreReject.mockImplementation(() => { action.status = 'rejected'; return action })

    await reject(action.id)

    expect(mockResolveApproval).toHaveBeenCalledWith(action.id, false)
    expect(mockExecuteAction).not.toHaveBeenCalled()
  })

  it('stop calls AgentLoop.stop and ActionStore.stopAll', async () => {
    await stop()
    expect(mockStoreStopAll).toHaveBeenCalledOnce()
    expect(mockStop).toHaveBeenCalledWith('Stopped by user')
  })
})
