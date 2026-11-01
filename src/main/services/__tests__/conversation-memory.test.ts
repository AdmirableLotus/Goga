import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { CONVERSATION_GAP_MS, ConversationMemory, NOTE_BATCH_MESSAGES, askedPeriod, cleanNote } from '../conversationMemory'

const log = { info: vi.fn(), warn: vi.fn() }
const DAY = 86_400_000
// Tue Oct 27 2026, 15:00 local time
const tuesday = new Date(2026, 9, 27, 15, 0).getTime()

const msg = (role: 'user' | 'assistant', content: string, timestamp: number) => ({ id: `${timestamp}`, role, content, timestamp })
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'goga-memory-')), 'memory.json')

function memory(chat = vi.fn(async () => '- Worked on the Viora NSF pitch.\n- Decided to apply in November.'), file?: string, now = tuesday + DAY) {
  return { chat, mem: new ConversationMemory({ chat, userName: () => 'Ace', log, now: () => now, delayMs: 60_000 }, file) }
}

describe('remembering conversations', () => {
  it('writes a note about a conversation once a long pause ends it', async () => {
    const { chat, mem } = memory()
    mem.record(msg('user', 'Help me with the Viora NSF pitch', tuesday))
    mem.record(msg('assistant', 'Sure, here is a draft...', tuesday + 60_000))
    expect(await mem.writeNote()).toBeUndefined()          // still going: nothing to write yet
    mem.record(msg('user', 'Good morning', tuesday + CONVERSATION_GAP_MS * 3))
    mem.record(msg('assistant', 'Morning, Ace!', tuesday + CONVERSATION_GAP_MS * 3 + 1000))
    const note = await mem.writeNote()
    expect(note?.text).toContain('Viora NSF pitch')
    expect(chat.mock.calls[0][0][1].content).toContain('Ace: Help me with the Viora NSF pitch')
    expect(chat.mock.calls[0][0][1].content).not.toContain('Good morning')   // the new conversation waits
  })

  it('writes long conversations up in parts', async () => {
    const { mem } = memory()
    for (let i = 0; i < NOTE_BATCH_MESSAGES; i++) mem.record(msg(i % 2 ? 'assistant' : 'user', `turn ${i}`, tuesday + i * 1000))
    expect(await mem.writeNote()).toBeDefined()
    expect(await mem.writeNote()).toBeUndefined()
  })

  it('keeps the messages when the brain is busy, and tries again later', async () => {
    const chat = vi.fn().mockRejectedValueOnce(new Error('local brain busy')).mockResolvedValue('- Planned the R1 link.')
    const { mem } = memory(chat)
    mem.record(msg('user', 'Let us plan the R1 link', tuesday))
    mem.record(msg('assistant', 'Plan: ...', tuesday + 1000))
    mem.record(msg('user', 'hi', tuesday + CONVERSATION_GAP_MS * 2))
    expect(await mem.writeNote()).toBeUndefined()
    expect((await mem.writeNote())?.text).toContain('R1 link')
  })

  it('never keeps secrets, and skips conversations with nothing worth remembering', () => {
    expect(cleanNote('- Ace set up HackerOne.\n- Ace\'s password is hunter2.')).toBe('- Ace set up HackerOne.')
    expect(cleanNote('NOTHING')).toBe('')
    expect(cleanNote('<think>hmm</think>\n- Talked about dinner plans.')).toBe('- Talked about dinner plans.')
  })

  it('recalls by topic, and always offers the latest conversation', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce('- Drafted the Viora NSF SBIR pitch sections.')
      .mockResolvedValueOnce('- Talked about pairing the Rabbit R1 with OpenClaw.')
    const { mem } = memory(chat)
    mem.record(msg('user', 'pitch', tuesday)); mem.record(msg('assistant', 'ok', tuesday + 1))
    mem.record(msg('user', 'r1', tuesday + CONVERSATION_GAP_MS * 2)); mem.record(msg('assistant', 'ok', tuesday + CONVERSATION_GAP_MS * 2 + 1))
    mem.record(msg('user', 'now', tuesday + CONVERSATION_GAP_MS * 4)); mem.record(msg('assistant', 'ok', tuesday + CONVERSATION_GAP_MS * 4 + 1))
    await mem.writeNote(); await mem.writeNote()
    const recalled = await mem.recall('what did we write for the Viora pitch sections?')
    expect(recalled.map(n => n.text)).toEqual(['- Drafted the Viora NSF SBIR pitch sections.', '- Talked about pairing the Rabbit R1 with OpenClaw.'])
    expect(await mem.promptBlock('continue')).toContain('Rabbit R1')
  })

  it('understands "yesterday", "last week" and weekdays', () => {
    const now = new Date(2026, 9, 28, 10, 0).getTime()   // Wednesday
    const y = askedPeriod('what did we talk about yesterday?', now)!
    expect(new Date(y.from).getDate()).toBe(27)
    expect(y.to - y.from).toBe(DAY)
    expect(new Date(askedPeriod('on Monday we said', now)!.from).getDate()).toBe(26)
    expect(new Date(askedPeriod('last wednesday', now)!.from).getDate()).toBe(21)
    expect(askedPeriod('open youtube', now)).toBeUndefined()
  })

  it('remembers across restarts, privately', async () => {
    const file = tempFile()
    const { mem } = memory(undefined, file)
    mem.record(msg('user', 'pitch', tuesday)); mem.record(msg('assistant', 'ok', tuesday + 1))
    mem.record(msg('user', 'later', tuesday + CONVERSATION_GAP_MS * 2))
    await mem.writeNote()
    const reopened = memory(undefined, file).mem
    expect(reopened.getNotes()).toHaveLength(1)
    expect(reopened.isEmpty()).toBe(false)
    expect(await reopened.promptBlock('what did we do yesterday?')).toContain('Viora NSF pitch')
  })
})

describe('catching up on unwritten conversations', () => {
  it('starts writing a saved backlog at launch, without waiting for a new message', async () => {
    vi.useFakeTimers()
    try {
      const file = tempFile()
      const pending = [
        msg('user', 'Help me with the Alma budget', tuesday), msg('assistant', 'Here it is', tuesday + 1000),
        msg('user', 'Good morning', tuesday + CONVERSATION_GAP_MS * 3),
      ].map(({ role, content, timestamp }) => ({ role, content, timestamp }))
      fs.writeFileSync(file, JSON.stringify({ pending, notes: [], embeddings: {} }))
      const { chat } = memory(undefined, file)
      expect(chat).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(chat).toHaveBeenCalledTimes(1)
      expect(chat.mock.calls[0][0][1].content).toContain('Alma budget')
    } finally { vi.useRealTimers() }
  })

  it('retries later when the brain was busy, instead of waiting for the next message', async () => {
    vi.useFakeTimers()
    try {
      const chat = vi.fn().mockRejectedValueOnce(new Error('brain busy')).mockResolvedValue('- Planned the Alma budget.')
      const { mem } = memory(chat)
      mem.record(msg('user', 'Plan the Alma budget', tuesday))
      mem.record(msg('assistant', 'Done', tuesday + 1000))
      mem.record(msg('user', 'Next day', tuesday + CONVERSATION_GAP_MS * 3))
      mem.record(msg('assistant', 'Hi', tuesday + CONVERSATION_GAP_MS * 3 + 1000))
      await vi.advanceTimersByTimeAsync(60_000)        // first try: busy
      expect(chat).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000 * 15)   // retry later
      expect(chat).toHaveBeenCalledTimes(2)
      expect(mem.getNotes()[0]?.text).toContain('Alma budget')
    } finally { vi.useRealTimers() }
  })
})
