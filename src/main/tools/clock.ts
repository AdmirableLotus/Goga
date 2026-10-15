import { ToolRegistry } from './registry'

const reg = ToolRegistry.getInstance()

reg.register({
  name: 'clock.now',
  description: 'Returns the current local date, time, day of week, and timezone from the computer\'s system clock. Use this whenever the user asks what time or date it is.',
  parameters: { type: 'object', properties: {}, required: [] },
  riskLevel: 'low', reversible: true, category: 'system'
}, async () => {
  const now = new Date()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    success: true,
    data: {
      iso:      now.toISOString(),
      date:     new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz }).format(now),
      time:     new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZone: tz }).format(now),
      timezone: tz,
    }
  }
})
