import type { IpcMain } from 'electron'
import type { Finding, ProgramSource } from '../../shared/security'
import type { ToolboxCatalog } from '../../shared/toolboxTypes'
import {
  HACKERONE_TOKEN_PAGE, checkHackerOneConnection, clearCredentials, credentialStatus, importBugcrowd, importHackerOne,
  listHackerOnePrograms, saveCredentials,
} from '../services/security/programs'
import {
  activeProgram, addFinding, addProgram, audit, clearConnectionRecord, connections, deleteFinding, getProgram, issueGrant, listFindings,
  listPrograms, readAudit, recordConnection, recordListing, removeProgram, setActiveProgram, updateFinding,
} from '../services/security/store'
import { curriculum, lessonById } from '../services/security/curriculum'
import { decideScope } from '../services/security/scope'
import { toolboxCatalog } from '../services/security/toolbox'
import { findTool, searchToolbox } from '../services/security/toolboxQuery'

/**
 * Security page IPC.
 *
 * The grant that `security:approveRequest` issues is the only way an active request can be
 * made, and the tool that makes it is still gated on the approval gate. Two locks, on
 * purpose, for the one thing in this app that reaches a third party on purpose.
 */

/**
 * The connection view for a platform. A stored token alone is never reported as connected:
 * until a live call has run, the state says so and the detail says what to do.
 */
function connectionView(source: ProgramSource) {
  const recorded = connections()[source]
  if (recorded) return recorded
  const status = credentialStatus(source)
  return {
    source,
    state: status.configured ? ('unchecked' as const) : ('not-connected' as const),
    detail: status.configured
      ? 'A token is stored but has not been checked against the API yet. Press Check connection.'
      : `No ${source === 'hackerone' ? 'HackerOne' : 'Bugcrowd'} token is stored.`,
    account: null,
    checkedAt: null,
    where: source === 'hackerone' ? HACKERONE_TOKEN_PAGE : 'https://tracker.bugcrowd.com/settings/api',
    programs: [],
    listedAt: null,
  }
}

export function registerSecurityHandlers(ipcMain: IpcMain) {
  ipcMain.handle('security:programs', async () => ({
    programs: listPrograms(),
    active: activeProgram(),
    credentials: { hackerone: credentialStatus('hackerone'), bugcrowd: credentialStatus('bugcrowd') },
    connections: { hackerone: connectionView('hackerone'), bugcrowd: connectionView('bugcrowd') },
  }))
  ipcMain.handle('security:checkConnection', async (_e, source: ProgramSource) => {
    if (source !== 'hackerone') {
      // Bugcrowd's API has no documented credential-check endpoint; a program read is the check.
      return connectionView('bugcrowd')
    }
    const result = await checkHackerOneConnection()
    const previous = connections().hackerone
    return recordConnection({
      source: 'hackerone',
      state: result.state,
      detail: result.detail,
      account: result.account,
      checkedAt: result.checkedAt,
      where: result.where,
      programs: previous?.programs ?? [],
      listedAt: previous?.listedAt ?? null,
    })
  })
  ipcMain.handle('security:listPrograms', async (_e, source: ProgramSource) => {
    if (source !== 'hackerone') throw new Error('listing every program is only implemented for HackerOne so far')
    const listed = await listHackerOnePrograms()
    const view = recordListing('hackerone', listed.programs, listed.pages, listed.participating)
    return { programs: listed.programs, pages: listed.pages, participating: listed.participating, connection: view ?? connectionView('hackerone') }
  })
  ipcMain.handle('security:importMany', async (_e, source: ProgramSource, handles: string[]) => {
    const list = [...new Set((Array.isArray(handles) ? handles : []).map(h => String(h ?? '').trim()).filter(Boolean))]
    if (!list.length) throw new Error('no program handles were given')
    if (list.length > 25) throw new Error('import at most 25 programs at a time')
    const results: { handle: string; ok: boolean; program: import('../../shared/security').ProgramImport | null; error: string | null }[] = []
    for (const handle of list) {
      try {
        const imported = source === 'bugcrowd' ? await importBugcrowd(handle) : await importHackerOne(handle)
        results.push({ handle, ok: true, program: addProgram(imported), error: null })
      } catch (err) {
        results.push({ handle, ok: false, program: null, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { results, programs: listPrograms(), active: activeProgram() }
  })
  ipcMain.handle('security:credentials', async (_e, source: ProgramSource, user: string, token: string) => {
    saveCredentials(source, user, token)
    // A new token has not been checked yet, so the old verdict is dropped rather than shown.
    clearConnectionRecord(source)
    audit('note', `${source} API token saved (encrypted) — not yet checked against the API`)
    return { hackerone: credentialStatus('hackerone'), bugcrowd: credentialStatus('bugcrowd') }
  })
  ipcMain.handle('security:clearCredentials', async (_e, source: ProgramSource) => {
    clearCredentials(source)
    clearConnectionRecord(source)
    return { hackerone: credentialStatus('hackerone'), bugcrowd: credentialStatus('bugcrowd') }
  })
  ipcMain.handle('security:import', async (_e, source: ProgramSource, handle: string) => {
    const imported = source === 'bugcrowd' ? await importBugcrowd(handle) : await importHackerOne(handle)
    return addProgram(imported)
  })
  ipcMain.handle('security:setActive', async (_e, id: string | null) => { setActiveProgram(id); return { programs: listPrograms(), active: activeProgram() } })
  ipcMain.handle('security:remove', async (_e, id: string) => { removeProgram(id); return { programs: listPrograms(), active: activeProgram() } })
  ipcMain.handle('security:checkTarget', async (_e, target: string, technique?: string) => {
    const program = activeProgram()
    return { decision: decideScope(program, target, technique), program: program ? { id: program.id, name: program.name } : null }
  })
  ipcMain.handle('security:approveRequest', async (_e, target: string, method: string) => {
    const program = activeProgram()
    const decision = decideScope(program, target)
    if (!decision.inScope) {
      audit('blocked', `approval refused for ${target}: ${decision.reason}`)
      throw new Error(`out of scope — ${decision.reason}`)
    }
    const grantId = issueGrant(target, method || 'GET')
    audit('approve', `user approved one ${(method || 'GET').toUpperCase()} to ${target} (${decision.matchedRule})`)
    return { grantId, decision }
  })
  ipcMain.handle('security:findings', async () => listFindings())
  ipcMain.handle('security:addFinding', async (_e, input: Omit<Finding, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'programId'>) => {
    const program = activeProgram()
    if (!program) throw new Error('import and activate a program first')
    return addFinding({ ...input, programId: program.id })
  })
  ipcMain.handle('security:updateFinding', async (_e, id: string, patch: Partial<Finding>) => updateFinding(id, patch))
  ipcMain.handle('security:deleteFinding', async (_e, id: string) => { deleteFinding(id) })
  ipcMain.handle('security:audit', async (_e, limit?: number) => readAudit(limit ?? 200))
  ipcMain.handle('security:curriculum', async () => curriculum())
  ipcMain.handle('security:lesson', async (_e, id: string) => lessonById(id))
  ipcMain.handle('security:program', async (_e, id: string) => getProgram(id))
  // The Toolbox is reference text. Reading it changes nothing and reaches no network.
  ipcMain.handle('security:toolbox', async (): Promise<ToolboxCatalog> => toolboxCatalog())
  ipcMain.handle('security:toolboxSearch', async (_e, query: string) => searchToolbox(String(query ?? '')))
  ipcMain.handle('security:toolboxTool', async (_e, identifier: string) => findTool(String(identifier ?? '')))
}
