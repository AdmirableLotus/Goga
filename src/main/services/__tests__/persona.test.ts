import { describe, expect, it } from 'vitest'
import { MAX_PERSONALITY_CHARS } from '../../../shared/types'
import { gogaIdentity, personalitySection } from '../persona'

describe('personality from Settings', () => {
  it('adds nothing when the box is empty or blank', () => {
    expect(personalitySection('Ace', '')).toBe('')
    expect(personalitySection('Ace', '   \n ')).toBe('')
    expect(personalitySection('Ace', undefined)).toBe('')
    expect(gogaIdentity('Ace', '')).toBe(gogaIdentity('Ace'))
  })

  it("puts the user's words after the core identity, which keeps priority", () => {
    const prompt = gogaIdentity('Ace', '  Be playful and joke a little.  ')
    expect(prompt).toContain('"""\nBe playful and joke a little.\n"""')
    expect(prompt.indexOf('Honest above all')).toBeLessThan(prompt.indexOf('Be playful'))
    expect(prompt).toContain('except where it would mean being dishonest or getting around a safety limit')
  })

  it('caps very long text so the brain keeps room to think', () => {
    const section = personalitySection('Ace', 'a'.repeat(MAX_PERSONALITY_CHARS + 500))
    expect(section).toContain('a'.repeat(MAX_PERSONALITY_CHARS))
    expect(section).not.toContain('a'.repeat(MAX_PERSONALITY_CHARS + 1))
  })
})
