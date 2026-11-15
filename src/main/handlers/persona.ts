import type { IpcMain } from 'electron'
import { BrainService } from '../services/brain'
import { SettingsService } from '../services/settings'
import { gogaIdentity } from '../services/persona'
import { MAX_PERSONALITY_CHARS } from '../../shared/types'
import type { PersonaState } from '../../shared/persona'

/**
 * Persona bridge.
 *
 * The identity text is code and is shown read-only, so the user can see exactly what Goga
 * starts from. The personality notes are the user's own words, saved through the same
 * settings store the rest of the app uses, and capped at MAX_PERSONALITY_CHARS.
 */

export function registerPersonaHandlers(ipcMain: IpcMain) {
  ipcMain.handle('persona:state', async (): Promise<PersonaState> => {
    const settings = SettingsService.getInstance().get()
    const facts = BrainService.getInstance().getFacts()
    return {
      userName: settings.userName,
      personality: settings.personality ?? '',
      maxChars: MAX_PERSONALITY_CHARS,
      identity: gogaIdentity(settings.userName, settings.personality),
      facts: facts.map(f => ({ id: f.id, category: f.category, content: f.content, source: f.source, createdAt: f.createdAt })),
    }
  })

  ipcMain.handle('persona:save', async (_e, text: string): Promise<PersonaState> => {
    const trimmed = String(text ?? '').slice(0, MAX_PERSONALITY_CHARS)
    SettingsService.getInstance().set({ personality: trimmed })
    const settings = SettingsService.getInstance().get()
    return {
      userName: settings.userName,
      personality: settings.personality ?? '',
      maxChars: MAX_PERSONALITY_CHARS,
      identity: gogaIdentity(settings.userName, settings.personality),
      facts: BrainService.getInstance().getFacts().map(f => ({ id: f.id, category: f.category, content: f.content, source: f.source, createdAt: f.createdAt })),
    }
  })

  ipcMain.handle('persona:forgetFact', async (_e, id: string) => {
    BrainService.getInstance().deleteFact(String(id))
    return true
  })
}
