import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { LONG_TEXT_CHARS, NotesStore, asNotes, fitHistory, splitIntoParts, takeNotes, rewriteRequest, rewriteInParts } from '../longText'
import { looksLikeAgentTask, planNeedsComputer, startsWithAgreement } from '../agentRouting'

const paragraph = (i: number) => `Section ${i}. ` + 'The ring measures bioimpedance at several frequencies. '.repeat(20)
const longDoc = Array.from({ length: 12 }, (_, i) => paragraph(i)).join('\n\n')   // ~13,000 chars

describe('reading a long document in parts', () => {
  it('splits at paragraph boundaries, keeping every part under the size', () => {
    const parts = splitIntoParts(longDoc, 3000)
    expect(parts.length).toBeGreaterThan(3)
    expect(parts.every(p => p.length <= 3000)).toBe(true)
    expect(parts.every(p => p.startsWith('Section'))).toBe(true)
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(longDoc.replace(/\s+/g, ' ').trim())   // nothing lost
  })

  it('takes notes on each part, then merges them until they fit', async () => {
    const chat = vi.fn(async (messages: { content: string }[]) =>
      messages[1].content.startsWith('Merge') ? 'merged notes' : 'n'.repeat(2000))
    const progress = vi.fn()
    const notes = await takeNotes(longDoc, 'Ace', chat, progress)
    const reads = chat.mock.calls.filter(c => c[0][1].content.startsWith('Part ')).length
    expect(reads).toBe(splitIntoParts(longDoc).length)
    expect(chat.mock.calls.some(c => c[0][1].content.startsWith('Merge'))).toBe(true)
    expect(notes).toContain('merged notes')
    expect(progress).toHaveBeenCalledWith(0, reads)
  })

  it('remembers notes on disk so a document is read only once', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'goga-notes-')), 'notes.json')
    new NotesStore(file).set(longDoc, 'the notes')
    expect(new NotesStore(file).get(longDoc)).toBe('the notes')
    expect(fs.readFileSync(file, 'utf8')).not.toContain('bioimpedance at several')
  })

  it('shows the brain the notes instead of the document, and keeps history within budget', () => {
    const history = [
      { role: 'user', content: longDoc },
      { role: 'assistant', content: 'x'.repeat(4000) },
      ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'y'.repeat(800) })),
    ]
    const fitted = fitHistory(history, t => t === longDoc ? 'NOTES' : undefined)
    const total = fitted.reduce((n, m) => n + m.content.length, 0)
    expect(total).toBeLessThanOrEqual(9000)
    expect(fitted[fitted.length - 1].content).toContain('turn 9')                     // newest kept
    expect(fitted.every(m => m.content.length < LONG_TEXT_CHARS)).toBe(true)
    expect(fitHistory(history.slice(0, 1), () => 'NOTES')[0].content).toBe(asNotes(longDoc, 'NOTES'))
  })
})

describe('routing a discussed plan', () => {
  it('treats a pasted document as material to discuss, not a PC task', () => {
    expect(looksLikeAgentTask(`help me organize this information ${longDoc}`)).toBe(false)
  })

  it('keeps writing and planning requests in chat, even when they mention building', () => {
    expect(looksLikeAgentTask('Yes, please draft the executive summary and the technical approach section from my Viora notes. And also make a list of what needs to be purchased to build it.')).toBe(false)
    expect(looksLikeAgentTask('Write an email to my landlord about the heater')).toBe(false)
    expect(looksLikeAgentTask('Write the summary into a file on my desktop')).toBe(true)
    expect(looksLikeAgentTask('organize my downloads files')).toBe(true)
    expect(looksLikeAgentTask('build the project')).toBe(true)
  })

  it('accepts agreement that adds more to do', () => {
    expect(startsWithAgreement('Yes, please do that. And also, can you help me make a list of parts to buy?')).toBe(true)
    expect(startsWithAgreement('Sure. Also add a budget.')).toBe(true)
    expect(startsWithAgreement('Yes, but first tell me the risks.')).toBe(false)
    expect(startsWithAgreement('Ok wait, not yet.')).toBe(false)
    expect(startsWithAgreement('Can you make a list?')).toBe(false)
  })

  it('sends writing plans to chat and computer plans to tasks', () => {
    expect(planNeedsComputer('I can draft the executive summary and the technical approach section first, pulling directly from your notes. Want me to go ahead?')).toBe(false)
    expect(planNeedsComputer("I'll open hackerone.com, wait while you log in, then list the programs. Want me to go ahead?")).toBe(true)
    expect(planNeedsComputer('I can save it to a file on your desktop. Shall I?')).toBe(true)
  })
})

describe('rewriting a long pasted text (rephrase / make it sound human)', () => {
  const body = 'My scope and success target\n\nV1 scope and success target. Include in V1 four-contact BioZ measurement: Drive 1, Sense 1, Sense 2, Drive 2. '
    + 'Budget estimate for the year: Windows laptop $350–900; general tools $150–400; ISFET supplies $700–2,500+. '.repeat(110)
    + '\n\nMain technical gates: BioZ bench gate, BioZ wear gate, ISFET bench gate, cartridge gate, comfort gate.'

  it("splits Ace's instruction from the pasted text", () => {
    const r = rewriteRequest(`rephrase it to sound humane ${body}`)
    expect(r?.instruction).toBe('rephrase it to sound humane')
    expect(r?.text.startsWith('My scope and success target')).toBe(true)
  })

  it('also finds the instruction at the end, and ignores short or non-rewrite messages', () => {
    const r = rewriteRequest(`${body}\nPlease make it sound more professional.`)
    expect(r?.instruction).toBe('Please make it sound more professional.')
    expect(r?.text.endsWith('comfort gate.')).toBe(true)
    expect(rewriteRequest('rephrase this: hello there')).toBeNull()          // short — normal chat handles it
    expect(rewriteRequest(`what does this say? ${body}`)).toBeNull()          // understanding, not rewriting
  })

  it('rewrites EVERY part (no summary) and streams each part', async () => {
    const seenParts: string[] = []
    const streamed: string[] = []
    const chat = async (msgs: { role: string; content: string }[], onTok: (t: string) => void) => {
      const part = msgs[1].content.split('"""')[1]
      seenParts.push(part)
      const out = `[rewritten ${part.length} chars]`
      onTok(out)
      return out
    }
    const text = rewriteRequest(`rephrase it to sound humane ${body}`)!.text
    const result = await rewriteInParts(text, 'rephrase it to sound humane', 'Ace', chat, t => streamed.push(t))
    expect(seenParts.length).toBeGreaterThan(1)
    expect(seenParts.join('').replace(/\s/g, '').length).toBe(text.replace(/\s/g, '').length)   // all text sent, none dropped
    expect(result.split('\n\n')).toHaveLength(seenParts.length)
    expect(streamed.join('')).toBe(result)
  })
})

describe('short rewrite requests take the rewrite path too', () => {
  it("parses Ace's short 'sound like me' request", () => {
    const msg = 'rephrase it to sound like me Can multi-frequency bioimpedance measured at the finger produce sufficiently repeatable, longitudinal measurements to distinguish fluid-related physiological change from the variability caused by electrode contact, motion, temperature, perfusion, anatomy, placement, and mixed-signal electronic interference in a wearable'
    const r = rewriteRequest(msg)
    expect(r?.instruction).toBe('rephrase it to sound like me')
    expect(r?.text.startsWith('Can multi-frequency bioimpedance')).toBe(true)
  })
})
