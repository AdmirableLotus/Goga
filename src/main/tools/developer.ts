import { app } from 'electron'
import { ToolRegistry } from './registry'
import { developerService } from '../services/developerInstance'

/**
 * Developer tools: Goga working on his own source with the coding agent.
 *
 * The Developer page could start a Codex run and nothing else could. This is that same run,
 * through the same service instance, so a request in chat appears on the page and the page's
 * Stop button stops it.
 *
 * `developer.start` is `critical`: a build-mode run edits source files. The agent loop's
 * approval gate stops it every time, and the user sees the task before it starts. Plan mode
 * only reads, but it is still gated — a run that reads the whole tree is not something to
 * start on a guess.
 */

const reg = ToolRegistry.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

reg.register({
  name: 'developer.start',
  description: 'Start a coding-agent run on Goga\'s own source: read the code, find a concrete weakness, and either propose a plan (mode "plan", read-only) or implement and verify a fix (mode "build", edits files). Needs the Codex CLI signed in. The run appears on the Developer page and can be stopped there.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'What to work on, in full sentences. Be specific: the file, the symptom, what a fix would have to preserve.' },
      mode: { type: 'string', enum: ['plan', 'build'], description: 'plan reads and proposes; build edits and verifies. Default plan.' },
    },
    required: ['task'],
  },
  riskLevel: 'critical', reversible: true, category: 'selfwork',
}, async p => {
  try {
    const service = developerService()
    const state = service.getState()
    if (state.status === 'running' || state.status === 'stopping') {
      return { success: false, error: `A developer run is already ${state.status}. Stop it on the Developer page first, or wait for it to finish.` }
    }
    if (!state.project) {
      if (app.isPackaged) {
        return { success: false, error: 'No source project is selected, and the installed app contains compiled files. Choose Goga\'s source folder on the Developer page first.' }
      }
      await service.selectProject(app.getAppPath())
    }
    const next = await service.start(String(p.task ?? ''), p.mode === 'build' ? 'build' : 'plan')
    return {
      success: true,
      data: [
        `Started a ${next.mode} run on ${next.project?.name ?? 'the source'}.`,
        `Status: ${next.status}. Watch it on the Developer page — findings, commands and file changes appear there as they happen.`,
        next.status === 'failed' ? `It stopped: ${next.summary || 'no summary'}` : '',
      ].filter(Boolean).join('\n'),
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'developer.state',
  description: 'What the coding-agent run is doing: its status, the events so far, its report, and the diff this run changed. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'selfwork',
}, async () => {
  const s = developerService().getState()
  return {
    success: true,
    data: [
      `Status: ${s.status}${s.project ? ` on ${s.project.name}` : ' (no project selected)'}`,
      s.task ? `Task: ${s.task.slice(0, 400)}` : '',
      s.events.length ? `Events (${s.events.length}):\n${s.events.slice(-12).map(e => `  [${e.kind}] ${e.text.slice(0, 300)}`).join('\n')}` : 'No events yet.',
      s.summary ? `\nReport:\n${s.summary.slice(0, 4000)}` : '',
      s.runDiff ? `\nThis run's diff: ${s.runDiff.available ? (s.runDiff.stat || 'no tracked files changed') : (s.runDiff.reason || 'not available')}` : '',
    ].filter(Boolean).join('\n'),
  }
})

reg.register({
  name: 'developer.stop',
  description: 'Stop the coding-agent run that is in progress. It keeps the events it already recorded.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'medium', reversible: false, category: 'selfwork',
}, async () => {
  developerService().stop()
  return { success: true, data: 'Stopping the developer run.' }
})
