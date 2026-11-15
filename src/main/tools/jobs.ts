import { ToolRegistry } from './registry'
import { jobs } from '../services/jobs/instance'

/**
 * Job tools.
 *
 * These let Goga start and watch jobs from chat, the same way the board does. They cannot
 * answer a question on the user's behalf: `jobs.answer` is deliberately absent, because an
 * answer has to come from the person, not from the model that asked.
 */

const reg = ToolRegistry.getInstance()

reg.register({
  name: 'jobs.start',
  description:
    'Hand a large, multi-step request to its own worker as a job. Use this for work that will take many steps or a long time (build something, research something thoroughly, work through a list) instead of doing it all in one chat turn. The job runs in the background, survives the window closing, and reports back. Returns the job id.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What the job must achieve, in full sentences. The worker sees only this.' },
      title: { type: 'string', description: 'A short name for the board, at most a few words.' },
      maxSteps: { type: 'number', description: 'How many steps it may take (default 12, at most 60).' },
      maxMinutes: { type: 'number', description: 'How long it may run (default 30, at most 600).' },
    },
    required: ['goal'],
  },
  riskLevel: 'medium', reversible: true, category: 'system',
}, async p => {
  const job = jobs().create({
    goal: String(p.goal ?? ''),
    title: p.title ? String(p.title) : undefined,
    bounds: {
      ...(typeof p.maxSteps === 'number' ? { maxSteps: p.maxSteps } : {}),
      ...(typeof p.maxMinutes === 'number' ? { maxMinutes: p.maxMinutes } : {}),
    },
  })
  return {
    success: true,
    data: `Started job ${job.id} ("${job.title}"). It is ${job.state}. Watch it on the Jobs page; it will ask you if it needs a decision.`,
  }
})

reg.register({
  name: 'jobs.list',
  description: 'Every job and its state: queued, running, waiting on you, done, failed, canceled or interrupted. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'system',
}, async () => {
  const view = jobs().view()
  if (view.jobs.length === 0) return { success: true, data: 'No jobs yet.' }
  const lines = view.jobs.map(j =>
    `${j.id} [${j.state}] ${j.title} — ${j.progress}${j.question && j.state === 'waiting' ? `\n   ASKING: ${j.question.text}` : ''}`)
  return {
    success: true,
    data: `${view.running} running, ${view.queued} queued, ${view.waiting} waiting on you (limit ${view.cap}).\n\n${lines.join('\n')}`,
  }
})

reg.register({
  name: 'jobs.read',
  description: 'One job in full: its steps, its question if it is waiting, and its report — what you get, what happened, and what it did not do. Read-only.',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'The job id.' } }, required: ['id'] },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  const job = jobs().get(String(p.id ?? ''))
  if (!job) return { success: false, error: `no job with id ${String(p.id ?? '')}` }
  const parts = [
    `${job.title} [${job.state}]`,
    `Goal: ${job.goal}`,
    `Progress: ${job.progress}`,
    job.question && job.state === 'waiting' ? `Waiting on you: ${job.question.text}${job.question.detail ? `\n${job.question.detail}` : ''}` : '',
    job.steps.length ? `Steps:\n${job.steps.map(s => `  ${s.index + 1}. ${s.ok ? 'ok' : 'FAILED'} ${s.tool}: ${s.detail}`).join('\n')}` : 'No steps yet.',
    job.report ? `\nWHAT YOU GET:\n${job.report.result.map(r => `- ${r}`).join('\n')}\n\nWHAT HAPPENED:\n${job.report.operations.map(r => `- ${r}`).join('\n')}\n\nNOT DONE:\n${job.report.notDone.length ? job.report.notDone.map(r => `- ${r}`).join('\n') : '- nothing was left undone'}` : '',
  ].filter(Boolean)
  return { success: true, data: parts.join('\n\n') }
})

reg.register({
  name: 'jobs.cancel',
  description: 'Stop a job. It keeps the steps it already recorded and writes a report saying it was stopped.',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'The job id.' } }, required: ['id'] },
  riskLevel: 'medium', reversible: false, category: 'system',
}, async p => {
  const job = jobs().cancel(String(p.id ?? ''))
  return { success: true, data: `Job ${job.id} is now ${job.state}.` }
})
