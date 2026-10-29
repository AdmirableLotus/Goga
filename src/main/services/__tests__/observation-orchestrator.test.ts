import { beforeEach, describe, expect, it, vi } from 'vitest'
const boundary = vi.hoisted(() => ({ chat: vi.fn(), getHistory: vi.fn(), addMessage: vi.fn(), agent: vi.fn(), observation: vi.fn(), active: vi.fn(), legacyActive: vi.fn(), ui: vi.fn(), legacyUi: vi.fn(), ollama: vi.fn(), vision: vi.fn(), available: vi.fn() }))
vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../settings', () => ({ SettingsService: { getInstance: () => ({ get: () => ({ primaryModel: 'local', userName: 'Fixture' }) }) } }))
vi.mock('../brain', () => ({ BrainService: { getInstance: () => ({ getHistory: boundary.getHistory, addMessage: boundary.addMessage }) } }))
vi.mock('../library', () => ({ LibraryService: { getInstance: () => ({}) } }))
vi.mock('../actionStore', () => ({ ActionStore: { getInstance: () => ({}) } }))
vi.mock('../localLlama', () => ({ LocalLlamaService: { getInstance: () => ({ isReady: () => true, chat: boundary.chat }) } }))
vi.mock('../ollamaClient', () => ({ OllamaClient: vi.fn(() => ({ chat: boundary.ollama, chatWith: boundary.vision, isAvailable: boundary.available })) }))
vi.mock('../agentLoop', () => ({ AgentLoop: { getInstance: () => ({ run: boundary.agent, runObservation: boundary.observation, getState: () => ({ status: 'idle', task: '', steps: [] }) }) } }))
vi.mock('../focusManager', () => ({ FocusManager: { getInstance: () => ({}) } }))
vi.mock('../../adapters/desktop', () => ({ DesktopAdapter: vi.fn(() => ({ activeWindow: boundary.legacyActive, observeWindowIdentity: boundary.active, observeWindowText: boundary.ui, uiElements: boundary.legacyUi })) }))
vi.mock('../../index', () => ({ getMainWindow: () => null }))
import '../../tools/computer'
import { ToolRegistry } from '../../tools/registry'
import { OrchestratorService } from '../orchestrator'

beforeEach(() => {
  vi.clearAllMocks()
  boundary.observation.mockImplementation((_task, observe, signal) => observe(signal ?? new AbortController().signal, {}))
  boundary.chat.mockResolvedValue('{"textIds":[0]}')
  boundary.active.mockResolvedValue({ title: 'Actual editor', owner: 'Actual.exe', pid: 42, hwnd: 100 })
  boundary.ui.mockResolvedValue({ window: { hwnd: 100, pid: 42, title: 'Actual editor' }, texts: ['Actual editor', 'Live UI text'], truncated: false })
  boundary.getHistory.mockReturnValue([{ role: 'assistant', content: 'Old invented terminal description' }])
})
describe('real orchestrator and registered observation tools', () => {
  it('routes attachments to vision with actual image bytes and omits media from persisted history', async () => {
    boundary.available.mockResolvedValue(true)
    boundary.vision.mockResolvedValue('An orange rectangle')
    const attachment = { id: 'media', name: 'image.jpg', kind: 'image' as const, images: ['data:image/jpeg;base64,/9j/AAAA'] }
    const result = await new OrchestratorService().process({ id: 'request', role: 'user', content: 'What is in this image?', attachments: [attachment], timestamp: 1 })
    expect(boundary.vision).toHaveBeenCalledOnce()
    const messages = boundary.vision.mock.calls[0][1]
    expect(messages[messages.length - 1].images).toEqual(['/9j/AAAA'])
    expect(boundary.addMessage.mock.calls[0][0].attachments).toBeUndefined()
    expect(boundary.chat).not.toHaveBeenCalled()
    expect(boundary.agent).not.toHaveBeenCalled()
    expect(result.content).toBe('An orange rectangle')
  })
  it('reports unavailable vision rather than pretending to see the attachment', async () => {
    boundary.available.mockResolvedValue(false)
    const result = await new OrchestratorService().process({ id: 'request', role: 'user', content: '', attachments: [{ id: 'media', name: 'image.jpg', kind: 'image', images: ['data:image/jpeg;base64,/9j/AAAA'] }], timestamp: 1 })
    expect(result.content).toContain('could not analyze the attachments')
    expect(result.content).toContain('Ollama is not running')
    expect(boundary.vision).not.toHaveBeenCalled()
  })
  it.each([
    'Tell me which window is active and describe what you can actually observe in it. Do not click, type, or change anything.',
    "What is in my active window? Don't click, type, or change anything.",
    'What is in my active window? Don\u2019t click, type, or change anything.',
    'What is in my active window? Do not click, type, or change anything.',
  ])('routes the original request through only the two read-only handlers: %s', async content => {
    const dispatch = vi.spyOn(ToolRegistry.getInstance(), 'execute')
    const result = await new OrchestratorService().process({ id: 'request', role: 'user', content, timestamp: 1 })
    expect(boundary.addMessage.mock.calls[0][0].content).toBe(content)
    expect(dispatch.mock.calls.map(([name]) => name)).toEqual(['computer.activeWindow', 'computer.uiElements'])
    expect(dispatch.mock.calls.every(([, , context]) => context.mode === 'read-only-observation')).toBe(true)
    expect(boundary.active).toHaveBeenCalledOnce()
    expect(boundary.ui).toHaveBeenCalledWith('Actual editor', 42, 100, expect.any(AbortSignal))
    expect(boundary.legacyUi).not.toHaveBeenCalled()
    expect(boundary.getHistory).not.toHaveBeenCalled()
    expect(boundary.agent).not.toHaveBeenCalled()
    expect(boundary.observation).toHaveBeenCalledOnce()
    expect(boundary.ollama).not.toHaveBeenCalled()
    expect(boundary.chat).toHaveBeenCalledOnce()
    const delivered = boundary.chat.mock.calls[0][0]
    expect(JSON.parse(delivered[1].content).request).toBe(content)
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
