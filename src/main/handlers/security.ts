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
import { BOUNTY_BOUNDS, automationRule, bountyPreview, buildBountyGoal, inScopeHosts } from '../services/security/bounty'
import { declareTarget } from '../services/lab/targets'
import { toolAvailability } from '../services/lab/scanner'
import { jobs } from '../services/jobs/instance'
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
  // The effective, server-validated scope a run WOULD use, so the user can review and confirm
  // it before anything starts. Read-only: it declares nothing and reaches no network. The
  // scope here is computed with the same decideScope the launch and every tool action use, so
  // what the user confirms is exactly what the run can reach — never wider.
  ipcMain.handle('security:previewBounty', async () => {
    const program = activeProgram()
    if (!program) throw new Error('select and activate a program first — there is nothing to preview')
    const preview = bountyPreview(program)
    let tools: { id: string; name: string; installed: boolean }[] = []
    try { tools = (await toolAvailability()).map(t => ({ id: t.id, name: t.name, installed: t.installed })) } catch { tools = [] }
    return { ...preview, tools }
  })
  // Start one watched, hands-off bounty run on the active program. This is the handoff the
  // Security page was missing: it declares ONLY the hosts decideScope proves are in scope,
  // then creates a 'bounty'-mode job so the scope-checked tools run without a per-step prompt
  // while every step streams to the Jobs board. Out-of-scope hosts are never declared, so the
  // run can reach nothing the program did not authorize.
  ipcMain.handle('security:startBounty', async (_e, focus?: string, acknowledgeAutomationRule?: boolean) => {
    const program = activeProgram()
    if (!program) throw new Error('select and activate a program first — there is nothing to run against')

    // A program that restricts automated testing (Cantina states one) must not start a
    // hands-off run until the user has seen that rule and acknowledged it. Enforced on the
    // server at launch, not only in the UI.
    const rule = automationRule(program)
    if (rule && acknowledgeAutomationRule !== true) {
      throw new Error(`"${program.name}" restricts automated testing — its rule is: "${rule}". Review the scope and acknowledge this rule before starting a run.`)
    }

    const hosts = inScopeHosts(program)
    const declared: { host: string; targetId: string }[] = []
    for (const h of hosts) {
      const result = declareTarget({
        host: h.host,
        ports: '',
        kind: 'authorized-engagement',
        note: `in scope for "${program.name}" (${program.source}) — autonomous bounty run`,
      })
      if (result.ok && result.target) {
        declared.push({ host: h.host, targetId: result.target.id })
        audit('approve', `declared in-scope target ${h.host} for autonomous run on "${program.name}"`)
      }
    }

    const goal = buildBountyGoal(program, hosts, typeof focus === 'string' ? focus.trim() : undefined)
    const job = jobs().create({
      goal,
      title: `Bounty run — ${program.name}`,
      mode: 'bounty',
      bounds: BOUNTY_BOUNDS,
    })
    audit('note', `started hands-off bounty run "${job.id}" on "${program.name}" — ${declared.length} host(s) declared in scope`)
    return { jobId: job.id, declared, program: { id: program.id, name: program.name } }
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
