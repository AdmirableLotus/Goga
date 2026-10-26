export interface LocalMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type HistoryItem = { type: 'system' | 'user'; text: string } | { type: 'model'; response: string[] }
interface LocalContext { getSequence(): unknown; dispose(): Promise<void> }
interface LocalSession {
  setChatHistory(history: HistoryItem[]): void
  prompt(text: string, options: { signal?: AbortSignal; stopOnAbortSignal: false; onTextChunk: (chunk: string) => void; budgets?: { thoughtTokens?: number } }): Promise<string>
  dispose(): void
}
// Reasoning models (Qwen 3.5) think before answering. Uncapped, a planner step took ~19s on an
// RTX 3080; 512 thought tokens gave the same action in ~2.4s. Ignored by non-thinking models.
const THOUGHT_TOKEN_BUDGET = 512

type SessionConstructor = new (options: { contextSequence: unknown; systemPrompt: string }) => LocalSession

export function prepareLocalConversation(messages: LocalMessage[]) {
  const turns = messages.filter(message => message.role !== 'system')
  const current = turns[turns.length - 1]
  if (!current || current.role !== 'user') throw new Error('Local chat requires a final user message')
  const prior = turns.slice(0, -1)
  // The orchestrator has already recorded the current user message before
  // building the request. Do not replay an adjacent duplicate as a new turn.
  if (prior[prior.length - 1]?.role === 'user' && prior[prior.length - 1]?.content === current.content) prior.pop()
  const systemPrompt = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n')
  const history: HistoryItem[] = systemPrompt ? [{ type: 'system', text: systemPrompt }] : []
  for (const message of prior) {
    history.push(message.role === 'user' ? { type: 'user', text: message.content } : { type: 'model', response: [message.content] })
  }
  return { systemPrompt, history, prompt: current.content }
}

/** Restore actual turns, generate only the new answer, and propagate native cancellation. */
export async function runLocalConversation(
  model: { createContext(options: { contextSize: number }): Promise<LocalContext> },
  Session: SessionConstructor,
  messages: LocalMessage[],
  contextSize: number,
  onToken?: (token: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const conversation = prepareLocalConversation(messages)
  const context = await model.createContext({ contextSize })
  let session: LocalSession | undefined
  try {
    signal?.throwIfAborted()
    session = new Session({ contextSequence: context.getSequence(), systemPrompt: conversation.systemPrompt })
    session.setChatHistory(conversation.history)
    const result = await session.prompt(conversation.prompt, {
      signal,
      stopOnAbortSignal: false,
      budgets: { thoughtTokens: THOUGHT_TOKEN_BUDGET },
      onTextChunk: chunk => { if (!signal?.aborted) onToken?.(chunk) },
    })
    // Do not accept a late successful response from a backend that ignored Stop.
    signal?.throwIfAborted()
    return result.trim()
  } finally {
    try { session?.dispose() } catch { /* Context disposal still runs. */ }
    await context.dispose().catch(() => {})
  }
}
