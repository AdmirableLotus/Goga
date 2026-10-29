import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { chatHonestyNote, claimsAction, parseRoute, routeQuestion } from '../replyHonesty'
import { APPROVE_REPLY, DENY_REPLY } from '../agentRouting'
import { CONVERSATION_GAP_MS, ConversationMemory, notePrompt } from '../conversationMemory'

describe('a chat answer that claims an action', () => {
  it('is caught when it says it did or is doing something on the computer', () => {
    for (const claim of [
      'I’ve opened the GitHub repository for Omarchy in the browser.',
      'Ace, I’m initiating the fetch now.',
      'I have downloaded the file to your desktop.',
      'I just sent the email.',
      'I am opening Notepad for you.',
    ]) expect(claimsAction(claim)).toBe(true)
    expect(chatHonestyNote('I’ve opened it.')).toContain('nothing was done on the computer')
  })

  it('is left alone when it advises, plans or offers', () => {
    for (const fine of [
      'Here is a draft of your pitch.',
      'I can open it for you if you want. Want me to go ahead?',
      'I would start by checking the sudo rules.',
      'I’ve read your message: the policy asks for a working proof-of-concept.',
      'You opened the file earlier.',
    ]) expect(claimsAction(fine)).toBe(false)
    expect(chatHonestyNote('Here is the plan.')).toBe('')
  })
})

describe('the brain deciding between talking and acting', () => {
  it('asks a one-word question and reads the answer, ignoring its thinking', () => {
    const messages = routeQuestion('grab the latest Omarchy release notes', 'Anything else?')
    expect(messages[0].content).toContain('ACT or TALK')
    expect(messages[1].content).toContain('grab the latest Omarchy release notes')
    expect(parseRoute('ACT')).toBe('act')
    expect(parseRoute(' talk.')).toBe('talk')
    expect(parseRoute('<think>maybe ACT? no</think>TALK')).toBe('talk')
    expect(parseRoute('<think>it could be ACT')).toBeNull()
    expect(parseRoute('hmm')).toBeNull()
  })
})

describe('answering an approval in chat', () => {
  it('takes only plain, whole replies', () => {
    for (const yes of ['approve', 'Approved.', 'yes', 'go ahead', 'OK']) expect(APPROVE_REPLY.test(yes)).toBe(true)
    for (const no of ['deny', 'No', 'cancel', 'reject!']) expect(DENY_REPLY.test(no)).toBe(true)
    for (const neither of ['yes but first tell me what it does', 'should I approve?', 'no idea']) {
      expect(APPROVE_REPLY.test(neither)).toBe(false)
      expect(DENY_REPLY.test(neither)).toBe(false)
    }
  })
})

describe('memory notes', () => {
  it('label chat claims, tool results and caught claims so notes keep only what happened', async () => {
    const chat = vi.fn(async () => '- Reviewed the Omarchy repository.')
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'goga-honesty-')), 'memory.json')
    const t = new Date(2026, 9, 28, 15).getTime()
    const mem = new ConversationMemory({ chat, userName: () => 'Ace', log: { info: vi.fn(), warn: vi.fn() }, now: () => t + 86_400_000, delayMs: 60_000 }, file)
    mem.record({ id: '1', role: 'user', content: 'review omarchy', timestamp: t })
    mem.record({ id: '2', role: 'assistant', content: 'I found an IDOR in handlers.go.\n\n⚠️ Goga\'s check: made up', timestamp: t + 1000 })
    mem.record({ id: '3', role: 'assistant', content: 'Searched: install/helpers/logging.sh:17 chmod 666', timestamp: t + 2000, fromTools: true })
    mem.record({ id: '4', role: 'assistant', content: 'Sounds good.', timestamp: t + 3000 })
    mem.record({ id: '5', role: 'user', content: 'later', timestamp: t + CONVERSATION_GAP_MS * 3 })
    await mem.writeNote()
    const transcript = chat.mock.calls[0][0][1].content
    expect(transcript).toContain('Goga (chat, UNVERIFIED): I found an IDOR')
    expect(transcript).toContain('Goga (from its tools): Searched')
    expect(transcript).toContain('Goga (chat): Sounds good.')
    expect(notePrompt('Ace')).toContain('never write from them that anything was opened, fetched, scanned, found')
  })
})
