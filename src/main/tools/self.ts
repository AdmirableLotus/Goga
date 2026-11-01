import path from 'path'
import { app } from 'electron'
import { ToolRegistry } from './registry'
import { readSource, searchSource, sourceOverview } from '../services/selfCode'
import { gapJournal } from '../services/gapJournal'

// Goga reading his own code and his own failure record. All read-only.

const reg = ToolRegistry.getInstance()
export const sourceRoot = () => path.join(app.getAppPath(), 'src')
const fail = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

reg.register({
  name: 'self.overview',
  description: 'Lists your own source code: every folder and file with its size, plus the names of all your registered tools. Use it to see how you are built before reading a file.',
  parameters: { type: 'object', properties: {}, required: [] },
  riskLevel: 'low', reversible: true, category: 'filesystem',
}, async () => {
  try {
    return { success: true, data: { code: sourceOverview(sourceRoot()), tools: reg.list().map(t => t.name).join(', ') } }
  } catch (err) { return fail(err) }
})

reg.register({
  name: 'self.search',
  description: 'Searches your own source code for a word or phrase (plain text, not a regex) and returns file:line matches. Use it to find where a feature or tool is implemented.',
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'text to look for, e.g. "trade watcher" or "wakeWord"' } }, required: ['query'] },
  riskLevel: 'low', reversible: true, category: 'filesystem',
}, async params => {
  try {
    const hits = searchSource(sourceRoot(), String(params.query ?? ''))
    return { success: true, data: hits.length ? hits.map(h => `src/${h.file}:${h.line}: ${h.text}`).join('\n') : `No matches for "${params.query}" in my code.` }
  } catch (err) { return fail(err) }
})

reg.register({
  name: 'self.read',
  description: 'Reads lines from one of your own source files (path like "main/services/brain.ts", from self.search or self.overview). Returns numbered lines; read in parts with start and count (max 300).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'file inside src, e.g. main/tools/clock.ts' },
      start: { type: 'number', description: 'first line (default 1)' },
      count: { type: 'number', description: 'how many lines (default 150, max 300)' },
    },
    required: ['path'],
  },
  riskLevel: 'low', reversible: true, category: 'filesystem',
}, async params => {
  try {
    const r = readSource(sourceRoot(), String(params.path ?? ''), Number(params.start ?? 1), Number(params.count ?? 150))
    return { success: true, data: `src/${r.file} lines ${r.from}-${r.to} of ${r.total}:\n${r.text}` }
  } catch (err) { return fail(err) }
})

reg.register({
  name: 'self.gaps',
  description: 'Your own record of what you could not do (failed tasks, missing tools, loops, "I can\'t" answers), grouped by what would fix it. Use it when asked what tools you need or how to improve you.',
  parameters: { type: 'object', properties: { days: { type: 'number', description: 'how far back to look (default 30)' } }, required: [] },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async params => {
  const journal = gapJournal()
  if (!journal) return { success: false, error: 'the gap journal is not running' }
  return { success: true, data: journal.report(Number(params.days ?? 30)) }
})
