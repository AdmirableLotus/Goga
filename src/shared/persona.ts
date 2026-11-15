/**
 * Persona types: what Goga starts from, and what the user has told him about how to be.
 *
 * The identity text is generated in main from `services/persona.ts` and shown read-only.
 * The personality notes are the user's own words, saved in the app's settings store.
 */

export interface PersonaFact {
  id: string
  category: 'about_user' | 'learned' | 'preference' | 'event'
  content: string
  source: 'conversation' | 'book' | 'observation'
  createdAt: number
}

export interface PersonaState {
  userName: string
  personality: string
  maxChars: number
  /** The exact text every prompt starts from, with the personality notes already in it. */
  identity: string
  /** What Goga remembers about the user, which is the "what Goga remembers" check-in. */
  facts: PersonaFact[]
}
