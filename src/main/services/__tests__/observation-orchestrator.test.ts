import { beforeEach, describe, expect, it, vi } from 'vitest'
const boundary = vi.hoisted(() => ({ chat: vi.fn(), getHistory: vi.fn(), addMessage: vi.fn(), agent: vi.fn(), active: vi.fn(), legacyActive: vi.fn(), ui: vi.fn(), legacyUi: vi.fn(), ollama: vi.fn() }))
vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => ({ primaryModel: 'local', userName: 'Fixture' }) }) } }))
vi.mock('../brain', () => ({ BrainService: { getInstance: () => ({ getHistory: boundary.getHistory, addMessage: boundary.addMessage }) } }))
vi.mock('../library', () => ({ LibraryService: { getInstance: () => ({}) } }))
vi.mock('../actionStore', () => ({ ActionStore: { getInstance: () => ({}) } }))
vi.mock('../localLlama', () => ({ LocalLlamaService: { getInstance: () => ({ isReady: () => true, chat: boundary.chat }) } }))
vi.mock('../ollamaClient', () => ({ OllamaClient: vi.fn(() => ({ chat: boundary.ollama })) }))
vi.mock('../agentLoop', () => ({ AgentLoop: { getInstance: () => ({ run: boundary.agent }) } }))
vi.mock('../focusManager', () => ({ FocusManager: { getInstance: () => ({}) } }))
vi.mock('../../adapters/desktop', () => ({ DesktopAdapter: vi.fn(() => ({ activeWindow: boundary.legacyActive, observeWindowIdentity: boundary.active, observeWindowText: boundary.ui, uiElements: boundary.legacyUi })) }))
vi.mock('../../index', () => ({ getMainWindow: () => null }))
import '../../tools/computer'
import { ToolRegistry } from '../../tools/registry'
import { OrchestratorService } from '../orchestrator'

beforeEach(() => {
  vi.clearAllMocks()
  boundary.chat.mockResolvedValue('{"textIds":[0]}')
  boundary.active.mockResolvedValue({ title: 'Actual editor', owner: 'Actual.exe', pid: 42, hwnd: 100 })
  boundary.ui.mockResolvedValue({ window: { hwnd: 100, pid: 42, title: 'Actual editor' }, texts: ['Actual editor', 'Live UI text'], truncated: false })
  boundary.getHistory.mockReturnValue([{ role: 'assistant', content: 'Old invented terminal description' }])
})
describe('real orchestrator and registered observation tools', () => {
  it('routes the exact request to real read-only tool handlers, then passes live data rather than history', async () => {
    const result = await new OrchestratorService().process({ id: 'request', role: 'user', content: 'Tell me which window is active and describe what you can actually observe in it. Do not click, type, or change anything.', timestamp: 1 })
    expect(boundary.active).toHaveBeenCalledOnce()
    expect(boundary.ui).toHaveBeenCalledWith('Actual editor', 42, 100, expect.any(AbortSignal))
    expect(boundary.legacyUi).not.toHaveBeenCalled()
    expect(boundary.getHistory).not.toHaveBeenCalled()
    expect(boundary.agent).not.toHaveBeenCalled()
    expect(boundary.ollama).not.toHaveBeenCalled()
    expect(boundary.chat).toHaveBeenCalledOnce()
    const delivered = boundary.chat.mock.calls[0][0]
    expect(delivered.map((m: any) => m.content).join('\n')).toContain('Live UI text')
    expect(delivered.map((m: any) => m.content).join('\n')).not.toContain('Old invented terminal')
    expect(result.content).toContain('Live UI text')
    expect(result.content).toContain('No image was analyzed')
  })
  it('does not fall back to ordinary chat when an observation tool fails', async () => {
    boundary.active.mockRejectedValue(new Error('native reader failed'))
    const result = await new OrchestratorService().process({ id: 'request', role: 'user', content: 'Which window is active?', timestamp: 1 })
    expect(result.content).toContain('could not observe')
    expect(boundary.chat).not.toHaveBeenCalled()
    expect(boundary.getHistory).not.toHaveBeenCalled()
    expect(boundary.agent).not.toHaveBeenCalled()
  })
  it('keeps ordinary computer.uiElements dispatch on the existing implementation', async () => {
    boundary.legacyUi.mockResolvedValue([])
    await ToolRegistry.getInstance().execute('computer.uiElements', { windowTitle: 'Fixture' }, { abortSignal: new AbortController().signal })
    expect(boundary.legacyUi).toHaveBeenCalledWith('Fixture')
    expect(boundary.ui).not.toHaveBeenCalled()
  })
  it('keeps ordinary computer.activeWindow dispatch on its existing reader and result shape', async () => {
    const legacy = { title: 'Legacy editor', owner: 'Fixture', pid: 42 }
    boundary.legacyActive.mockResolvedValue(legacy)
    expect(await ToolRegistry.getInstance().execute('computer.activeWindow', {}, { abortSignal: new AbortController().signal })).toEqual({ success: true, data: legacy })
    expect(boundary.legacyActive).toHaveBeenCalledOnce()
    expect(boundary.active).not.toHaveBeenCalled()
  })
})
