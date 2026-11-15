import type { IpcMain } from 'electron'
import { evolution } from '../services/evolution/instance'
import { deleteSkill, forgetNote, notes, recordSkill, remember, skills } from '../services/evolution/learning'

/**
 * Self-improvement IPC.
 *
 * `evolution:install` is the only handler that writes to the running source tree, and it
 * only does so for a change that was proved on a private copy and is waiting for exactly
 * this approval. There is deliberately no handler that commits, pushes, deploys or
 * restarts the app.
 */

export function registerEvolutionHandlers(ipcMain: IpcMain) {
  ipcMain.handle('evolution:state', async () => ({ ...evolution().state(), learning: notes(), skills: skills() }))
  ipcMain.handle('evolution:start', async (_e, goal: string) => evolution().run(String(goal ?? '')))
  ipcMain.handle('evolution:install', async () => evolution().install())
  ipcMain.handle('evolution:discard', async () => { evolution().discard(); return evolution().state() })
  ipcMain.handle('evolution:notes', async () => notes())
  ipcMain.handle('evolution:remember', async (_e, kind: 'taught' | 'worked' | 'failed' | 'code', text: string, source: string) => remember(kind, text, source))
  ipcMain.handle('evolution:forget', async (_e, id: string) => { forgetNote(id) })
  ipcMain.handle('evolution:skills', async () => skills())
  ipcMain.handle('evolution:recordSkill', async (_e, input: { name: string; whenToUse: string; steps: string[]; tools?: string[] }) =>
    recordSkill({ ...input, origin: 'recorded in the Self-improve page' }))
  ipcMain.handle('evolution:deleteSkill', async (_e, id: string) => { deleteSkill(id) })
}
