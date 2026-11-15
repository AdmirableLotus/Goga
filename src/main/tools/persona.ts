import { ToolRegistry } from './registry'
import { BrainService } from '../services/brain'
import { SettingsService } from '../services/settings'
import { gogaIdentity } from '../services/persona'
import { MAX_PERSONALITY_CHARS } from '../../shared/types'

/**
 * Persona tools.
 *
 * Goga's identity text lives in code and stays there; the user's own words about how Goga
 * should behave are a setting, capped at MAX_PERSONALITY_CHARS, and always come after the
 * honesty and safety rules rather than replacing them. These tools read both and can change
 * the user's part only.
 */

const reg = ToolRegistry.getInstance()

reg.register({
  name: 'persona.read',
  description:
    'How Goga is configured to be: the identity text his prompts actually start from, the user\'s own personality notes, and the facts Goga has learned about the user. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => {
  const settings = SettingsService.getInstance().get()
  const facts = BrainService.getInstance().getFacts()
  return {
    success: true,
    data: [
      `User: ${settings.userName}`,
      '',
      'Personality notes (the user\'s own words):',
      settings.personality?.trim() || '  (none yet)',
      '',
      `Identity text Goga starts from (${gogaIdentity(settings.userName, settings.personality).length} characters):`,
      gogaIdentity(settings.userName, settings.personality),
      '',
      `Learned facts (${facts.length}):`,
      ...(facts.length ? facts.map(f => `  [${f.category}/${f.source}] ${f.content}`) : ['  none yet']),
    ].join('\n'),
  }
})

reg.register({
  name: 'persona.setPersonality',
  description:
    'Replace the user\'s personality notes — how Goga should talk and behave, in the user\'s own words. Capped at ' + MAX_PERSONALITY_CHARS + ' characters. This cannot change Goga\'s honesty rules or any safety limit; an instruction that tries to is ignored by the prompt and should be said so to the user.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The new personality text. Empty clears it.' } },
    required: ['text'],
  },
  riskLevel: 'medium', reversible: true, category: 'filesystem',
}, async p => {
  const raw = String(p.text ?? '')
  const text = raw.trim().slice(0, MAX_PERSONALITY_CHARS)
  SettingsService.getInstance().set({ personality: text })
  return {
    success: true,
    data: [
      text ? `Saved ${text.length} character(s) of personality notes.` : 'Cleared the personality notes.',
      raw.trim().length > MAX_PERSONALITY_CHARS ? `Shortened to the ${MAX_PERSONALITY_CHARS}-character limit.` : '',
    ].filter(Boolean).join(' '),
  }
})
