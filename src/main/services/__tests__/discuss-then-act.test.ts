import { describe, expect, it } from 'vitest'
import { isActionProposal, isConfirmation } from '../agentRouting'

describe('discuss, then act', () => {
  it('recognises agreement in everyday words', () => {
    for (const yes of ['yes', 'Yes please', 'ok, go ahead', 'sure do it', 'go for it!', 'Yeah. Do it.', 'sounds good', "let's do it", 'okay go ahead'])
      expect(isConfirmation(yes), yes).toBe(true)
  })

  it('treats anything more than a short agreement as a new request', () => {
    for (const other of ['no', 'not yet', 'yes but use Firefox instead', 'ok so what is the best program?', 'open youtube', '', 'sure, but first tell me the risks of logging in'])
      expect(isConfirmation(other), other).toBe(false)
  })

  it('spots a reply that offers to act and asks for the go-ahead', () => {
    expect(isActionProposal("I'll open HackerOne, wait while you log in, then list programs with wide scope. Want me to go ahead?")).toBe(true)
    expect(isActionProposal('I can sort your downloads by type. Shall I start?')).toBe(true)
    expect(isActionProposal('Would you like me to open Notepad and save it?')).toBe(true)
  })

  it('does not mistake ordinary conversation for a proposal', () => {
    expect(isActionProposal('How are you feeling now?')).toBe(false)
    expect(isActionProposal('Done. The file is saved.')).toBe(false)
    expect(isActionProposal(undefined)).toBe(false)
  })
})
