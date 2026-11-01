import { SettingsService } from './settings'
import { OllamaClient } from './ollamaClient'
import { LocalLlamaService } from './localLlama'

type Messages = { role: 'system' | 'user' | 'assistant'; content: string }[]

const ollama = new OllamaClient()

/**
 * Background thinking (conversation notes, learning facts about the user) on whichever brain
 * is actually running. It used to require the built-in model, which is never loaded when
 * Ollama is the primary brain — so Goga silently stopped remembering and learning.
 * Never delays a reply: rejects ("brain busy") while the user is being answered.
 */
export async function backgroundChat(messages: Messages): Promise<string> {
  const llama = LocalLlamaService.getInstance()
  if (SettingsService.getInstance().get().primaryModel === 'ollama' && await ollama.isAvailable()) {
    return ollama.chatIfIdle(messages)
  }
  if (llama.isReady()) return llama.chat(messages, undefined, undefined, { ifIdle: true })
  throw new Error('no brain is running')
}
