import type { IpcMain } from 'electron'
import type { GateAnswer, GateResult, Hypothesis, SpecialistId } from '../../shared/grimoire'
import { GATE_QUESTIONS, SPECIALISTS } from '../services/security/grimoire/specialists'
import { knowledgeBase } from '../services/security/grimoire/knowledge'
import { runReview, indexLocalTarget, readForReview } from '../services/security/grimoire/review'
import { memoryEntries, memorySummary, markDead, markUserConfirmed, forgetMemory } from '../services/security/grimoire/memory'
import { headersOfInterest, jsEndpoints, sampleText } from '../services/security/grimoire/reading'
import { importCantina } from '../services/security/cantina'
import { fetchBountyFeed } from '../services/security/bountyFinder'
import { activeProgram, addProgram, audit, listPrograms } from '../services/security/store'

/**
 * Grimoire IPC.
 *
 * Every handler here is read-only with respect to the outside world. The two that touch a
 * network at all are `grimoire:importCantina` and `grimoire:bountyFeed`, and both are GETs
 * against a fixed public host that publish a page — the same class of read as importing a
 * HackerOne program, and neither sends anything to a program's own assets.
 *
 * Nothing here issues a grant, sends a request at a target, or writes a report. The single
 * approved GET is still `security:approveRequest` plus `security.probe`, unchanged.
 */

export function registerGrimoireHandlers(ipcMain: IpcMain) {
  /* ── the specialists and the knowledge base ── */
  ipcMain.handle('grimoire:specialists', async () => SPECIALISTS)
  ipcMain.handle('grimoire:knowledge', async () => knowledgeBase())
  ipcMain.handle('grimoire:gate', async () => GATE_QUESTIONS)

  /* ── local target mode ── */
  ipcMain.handle('grimoire:indexTarget', async (_e, root: string) => {
    const folder = String(root ?? '').trim()
    if (!folder) throw new Error('give the folder that holds your local copy')
    const indexed = indexLocalTarget(folder)
    audit('note', `grimoire: indexed local target ${folder} — ${indexed.files.length} readable file(s)`)
    return { root: folder, label: folder.split(/[\\/]/).filter(Boolean).pop() ?? folder, files: indexed.files, indexedAt: new Date().toISOString(), findings: indexed.findings }
  })

  /**
   * Review one file. This is the whole of local-target mode: read a file the user named, inside
   * the folder they named, and let the specialists argue about it.
   */
  ipcMain.handle('grimoire:reviewFile', async (_e, input: { root: string; path: string; marker?: string; specialists?: SpecialistId[] }) => {
    const root = String(input?.root ?? '').trim()
    const target = String(input?.path ?? '').trim()
    if (!root || !target) throw new Error('give the folder and the file to review')
    const read = readForReview(root, target)
    const program = activeProgram()
    const run = runReview({
      text: read.text,
      location: read.rel,
      material: 'code_audit',
      marker: input.marker,
      specialists: input.specialists,
      programId: program?.id,
      programName: program?.name,
    })
    audit('note', `grimoire: reviewed ${read.rel} (${read.size} bytes) — ${run.hypotheses.filter(h => h.state === 'hypothesis').length} candidate(s) with an observable, ${run.hypotheses.filter(h => h.state === 'dropped').length} dropped. No request was sent.`)
    return run
  })

  /** Review a page description the user pasted. Same engine, `web` material. */
  ipcMain.handle('grimoire:reviewText', async (_e, input: { text: string; label?: string; marker?: string; specialists?: SpecialistId[] }) => {
    const text = String(input?.text ?? '')
    if (text.trim().length < 20) throw new Error('paste at least a sentence of the page or code you want reviewed')
    const program = activeProgram()
    const run = runReview({
      text,
      location: String(input.label ?? 'pasted material'),
      material: 'web',
      marker: input.marker,
      specialists: input.specialists,
      programId: program?.id,
      programName: program?.name,
    })
    audit('note', `grimoire: reviewed pasted material (${text.length} chars) — nothing was sent anywhere`)
    return run
  })

  /* ── reading evidence well ── */
  ipcMain.handle('grimoire:sample', async (_e, input: { text: string; marker?: string }) => sampleText(String(input?.text ?? ''), { marker: input?.marker }))
  ipcMain.handle('grimoire:headers', async (_e, headers: Record<string, string>) => headersOfInterest(headers ?? {}))
  ipcMain.handle('grimoire:jsEndpoints', async (_e, source: string) => jsEndpoints(String(source ?? '')))

  /* ── memory ── */
  ipcMain.handle('grimoire:memory', async (_e, programId?: string) => ({ entries: memoryEntries(programId), summary: memorySummary(programId) }))
  ipcMain.handle('grimoire:forget', async (_e, key: string) => { forgetMemory(String(key ?? '')); return { entries: memoryEntries(), summary: memorySummary() } })

  /* ── the 7-question gate ── */
  ipcMain.handle('grimoire:gateDecide', async (_e, input: { hypothesis: Hypothesis; answers: GateAnswer[] }): Promise<GateResult> => {
    const answers = Array.isArray(input?.answers) ? input.answers : []
    const byId = new Map(answers.map(a => [a.questionId, a]))
    // The first four questions are fatal on a "no". The rest are advisory but still recorded.
    const fatal = ['observed', 'scope', 'attacker', 'impact']
    let killedBy: string | null = null
    for (const q of GATE_QUESTIONS) {
      const a = byId.get(q.id)
      if (!a || a.answer === null) continue
      if (a.answer === 'no' && fatal.includes(q.id)) { killedBy = q.question; break }
    }
    const unanswered = GATE_QUESTIONS.some(q => !byId.get(q.id) || byId.get(q.id)!.answer === null)
    const outcome: GateResult['outcome'] = killedBy ? 'fail' : unanswered ? 'unanswered' : 'pass'
    const decidedAt = new Date().toISOString()

    // The hypothesis is passed along so the memory entry is complete even when no program was
    // active at review time — otherwise the decision would have nothing to write.
    const seed = {
      programId: activeProgram()?.id,
      programName: activeProgram()?.name,
      specialist: input.hypothesis.specialist,
      title: input.hypothesis.title,
      location: input.hypothesis.location,
    }

    if (killedBy) {
      markDead(input.hypothesis.key, `failed the gate: ${killedBy}`, seed)
      audit('note', `grimoire: "${input.hypothesis.title}" marked dead — failed the gate at "${killedBy}"`)
    } else if (outcome === 'pass') {
      markUserConfirmed(input.hypothesis.key, 'passed all seven questions', seed)
      audit('note', `grimoire: "${input.hypothesis.title}" passed the seven-question gate. It is still your job to write and submit the report.`)
    }
    return { hypothesisId: input.hypothesis.id, answers, outcome, killedBy, decidedAt }
  })

  /* ── Cantina scope import ── */
  ipcMain.handle('grimoire:importCantina', async (_e, url: string) => {
    const imported = await importCantina(String(url ?? ''))
    const { bar, ...program } = imported
    const stored = addProgram({ ...program, entryBar: bar })
    audit('note', `grimoire: imported Cantina program ${stored.name} (${stored.handle}) — ${stored.assets.length} asset(s). Nothing was joined, paid or submitted.`)
    return { program: stored, bar }
  })

  /* ── the bounty finder ── */
  ipcMain.handle('grimoire:bountyFeed', async (_e, query?: string) => {
    const feed = await fetchBountyFeed({ query })
    audit('note', `grimoire: bounty feed read — ${feed.items.length} item(s)${feed.error ? ` (${feed.error})` : ''}`)
    return feed
  })

  /* ── what the page needs to state plainly ── */
  ipcMain.handle('grimoire:state', async () => ({
    programs: listPrograms(),
    active: activeProgram(),
    specialists: SPECIALISTS.length,
    memory: memorySummary(),
  }))
}
