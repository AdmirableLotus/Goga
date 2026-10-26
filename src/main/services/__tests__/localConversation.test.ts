import { expect, it, vi } from 'vitest'
import { prepareLocalConversation, runLocalConversation } from '../localConversation'

function setup() {
  const context = { getSequence: () => 'sequence', dispose: vi.fn().mockResolvedValue(undefined) }
  const model = { createContext: vi.fn().mockResolvedValue(context) }
  const history = vi.fn(), options = vi.fn(), dispose = vi.fn()
  const prompt = vi.fn().mockResolvedValue(' A real answer ')
  class Session {
    constructor(value: unknown) { options(value) }
    setChatHistory = history
    prompt = prompt
    dispose = dispose
  }
  return { context, model, Session, history, options, dispose, prompt }
}
const conversation = [
  { role: 'system' as const, content: 'You are Goga.' },
  { role: 'user' as const, content: 'Remember the project name.' },
  { role: 'assistant' as const, content: 'The project is ReaperCoin.' },
  { role: 'user' as const, content: 'What project are we building?' },
]

it('restores actual assistant answers and generates only the new response', async () => {
  const test = setup()
  expect(await runLocalConversation(test.model, test.Session, conversation, 4096)).toBe('A real answer')
  expect(test.history).toHaveBeenCalledWith([
    { type: 'system', text: 'You are Goga.' },
    { type: 'user', text: 'Remember the project name.' },
    { type: 'model', response: ['The project is ReaperCoin.'] },
  ])
  expect(test.prompt).toHaveBeenCalledOnce()
  expect(test.prompt.mock.calls[0][0]).toBe('What project are we building?')
  expect(test.options).toHaveBeenCalledWith({ contextSequence: 'sequence', systemPrompt: 'You are Goga.' })
  expect(test.dispose).toHaveBeenCalledOnce()
  expect(test.context.dispose).toHaveBeenCalledOnce()
})

it('removes the current-turn duplicate without discarding real previous answers or mutating input', () => {
  const duplicate = [...conversation, conversation[conversation.length - 1]]
  const request = prepareLocalConversation(duplicate)
  expect(request.history).toHaveLength(3)
  expect(duplicate).toHaveLength(5)
  expect(request.prompt).toBe('What project are we building?')
})

it('passes Stop to the native generator and rejects the interrupted request', async () => {
  const test = setup(), abort = new AbortController()
  test.prompt.mockImplementation((_text, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('native generation cancelled')), { once: true })
  }))
  const call = runLocalConversation(test.model, test.Session, conversation, 4096, undefined, abort.signal)
  const assertion = expect(call).rejects.toThrow('cancelled')
  await vi.waitFor(() => expect(test.prompt).toHaveBeenCalledOnce())
  expect(test.prompt.mock.calls[0][1]).toMatchObject({ signal: abort.signal, stopOnAbortSignal: false })
  abort.abort()
  await assertion
  expect(test.context.dispose).toHaveBeenCalledOnce()
})

it('pre-aborted requests allocate no model context', async () => {
  const test = setup(), abort = new AbortController(); abort.abort()
  await expect(runLocalConversation(test.model, test.Session, conversation, 4096, undefined, abort.signal)).rejects.toThrow()
  expect(test.model.createContext).not.toHaveBeenCalled()
})

it('cancellation during context creation prevents generation and releases the context', async () => {
  const test = setup(), abort = new AbortController()
  test.model.createContext.mockImplementation(async () => { abort.abort(); return test.context })
  await expect(runLocalConversation(test.model, test.Session, conversation, 4096, undefined, abort.signal)).rejects.toThrow()
  expect(test.prompt).not.toHaveBeenCalled()
  expect(test.context.dispose).toHaveBeenCalledOnce()
})

it('does not return late success or stream late tokens after Stop', async () => {
  const test = setup(), abort = new AbortController(), token = vi.fn()
  test.prompt.mockImplementation(async (_text, options) => { abort.abort(); options.onTextChunk('late'); return 'late answer' })
  await expect(runLocalConversation(test.model, test.Session, conversation, 4096, token, abort.signal)).rejects.toThrow()
  expect(token).not.toHaveBeenCalled()
  expect(test.context.dispose).toHaveBeenCalledOnce()
})

it('releases model resources after failure, even if session cleanup also fails', async () => {
  const test = setup()
  test.prompt.mockRejectedValue(new Error('model failed'))
  test.dispose.mockImplementation(() => { throw new Error('session disposal failed') })
  await expect(runLocalConversation(test.model, test.Session, conversation, 4096)).rejects.toThrow('model failed')
  expect(test.context.dispose).toHaveBeenCalledOnce()
})

it('rejects malformed conversation state instead of inventing another user turn', () => {
  expect(() => prepareLocalConversation(conversation.slice(0, -1))).toThrow('final user message')
})
