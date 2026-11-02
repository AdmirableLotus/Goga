import { ToolRegistry } from './registry'
import { describeSchedule, MIN_EVERY_MINUTES, scheduler } from '../services/scheduler'

// Goga's own recurring tasks. A scheduled request later runs as an ordinary chat message,
// so approvals and safety rules still apply each time it runs.

const reg = ToolRegistry.getInstance()

const notRunning = () => ({ success: false as const, error: 'The scheduler is not running yet.' })

reg.register({
  name: 'schedule.create',
  description: `Set up a recurring task for yourself: a request (written exactly as the user would type it, e.g. "check alpaca" or "news on AAPL") that you will run on a schedule and report in chat. Give everyMinutes (at least ${MIN_EVERY_MINUTES}) OR dailyAt ("HH:MM", 24-hour local time). Use kind "reminder" to only remind the user of something.`,
  parameters: {
    type: 'object',
    properties: {
      request: { type: 'string', description: 'What to do each time, as a chat request.' },
      everyMinutes: { type: 'number', description: `How often, in minutes (at least ${MIN_EVERY_MINUTES}).` },
      dailyAt: { type: 'string', description: 'A time each day, "HH:MM" 24-hour.' },
      kind: { type: 'string', enum: ['task', 'reminder'], description: 'task (run it) or reminder (just remind the user).' },
    },
    required: ['request'],
  },
  riskLevel: 'medium', reversible: true, category: 'system',
}, async p => {
  const s = scheduler()
  if (!s) return notRunning()
  const dailyAt = typeof p.dailyAt === 'string' && /^\d{1,2}:\d{2}$/.test(p.dailyAt) ? p.dailyAt.padStart(5, '0') : undefined
  const everyMinutes = dailyAt ? undefined : Number(p.everyMinutes) || 60
  try {
    const task = s.add({ request: String(p.request ?? ''), kind: p.kind === 'reminder' ? 'reminder' : 'task', everyMinutes, dailyAt }, 'goga')
    return { success: true, data: { readable: `Scheduled task ${task.id}: "${task.request}" ${describeSchedule(task)}.`, id: task.id } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

reg.register({
  name: 'schedule.list',
  description: 'List your scheduled recurring tasks with their ids.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'system',
}, async () => {
  const s = scheduler()
  return s ? { success: true, data: { readable: s.summary() } } : notRunning()
})

reg.register({
  name: 'schedule.delete',
  description: 'Remove one of your scheduled tasks by its id (from schedule.list).',
  parameters: { type: 'object', properties: { id: { type: 'number', description: 'The task id.' } }, required: ['id'] },
  riskLevel: 'low', reversible: false, category: 'system',
}, async p => {
  const s = scheduler()
  if (!s) return notRunning()
  const task = s.remove(Number(p.id))
  return task ? { success: true, data: { readable: `Removed scheduled task ${task.id} ("${task.request}").` } } : { success: false, error: `No scheduled task ${p.id}.` }
})
