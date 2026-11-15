import { ToolRegistry } from './registry'
import { SelfWorkService } from '../services/selfwork/service'
import { summariseDiff } from '../services/selfwork/diff'

/**
 * The code-work tools, so a chat request can reach Goga's own source the same way the page
 * can. Reading and searching are read-only. Proposing is read-only too — it writes nothing
 * and only offers a diff. Applying is the one that changes the source, and it is on the
 * always-approve list *and* behind the single-use gate, so it takes both.
 */

const reg = ToolRegistry.getInstance()
const work = () => SelfWorkService.getInstance()

reg.register({
  name: 'selfwork.list',
  description: 'List the files of Goga\'s own source code repository (TypeScript under src/ and anywhere else in the project). Read-only.',
  parameters: { type: 'object', properties: {}, required: [] },
  riskLevel: 'low', reversible: true, category: 'selfwork',
}, async () => {
  const files = work().listFiles()
  return { success: true, data: files.map(f => `${f.path} (${f.lines} lines)`) }
})

reg.register({
  name: 'selfwork.read',
  description: 'Read lines of one file of Goga\'s own source code, with line numbers. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repo-relative path such as src/main/services/orchestrator.ts.' },
      start: { type: 'number', description: 'First line, 1-based. Default 1.' },
      count: { type: 'number', description: 'How many lines. Default 160, maximum 400.' },
    },
    required: ['path'],
  },
  riskLevel: 'low', reversible: true, category: 'selfwork',
}, async p => {
  const r = work().read(String(p.path ?? ''), Number(p.start) || 1, Number(p.count) || 160)
  return { success: true, data: `${r.path} lines ${r.from}-${r.to} of ${r.total}\n${r.text}` }
})

reg.register({
  name: 'selfwork.search',
  description: 'Search Goga\'s own source code for a string. Read-only. Use this to find where something is implemented before proposing a change.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Plain text to look for, at least two characters.' },
      max: { type: 'number', description: 'Maximum hits. Default 40.' },
    },
    required: ['query'],
  },
  riskLevel: 'low', reversible: true, category: 'selfwork',
}, async p => {
  const hits = work().search(String(p.query ?? ''), Number(p.max) || 40)
  return {
    success: true,
    data: hits.length
      ? hits.map(h => `${h.path}:${h.line}: ${h.text}`).join('\n')
      : `Nothing in Goga's source matches "${String(p.query ?? '')}".`,
  }
})

reg.register({
  name: 'selfwork.proposePatch',
  description: 'Propose a change to one file of Goga\'s own source by replacing an exact block of existing text. Writes NOTHING: it offers a diff for the user to approve. Refused if the file is protected, is outside the repo, or the text does not occur exactly once.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repo-relative path, e.g. src/main/services/replyHonesty.ts.' },
      summary: { type: 'string', description: 'One or two sentences: what changes and why, in plain words.' },
      find: { type: 'string', description: 'The exact existing text to replace. Must occur exactly once in the file — copy it from selfwork.read.' },
      replace: { type: 'string', description: 'The text that replaces it.' },
    },
    required: ['path', 'summary', 'find', 'replace'],
  },
  riskLevel: 'low', reversible: true, category: 'selfwork',
}, async p => {
  const proposal = work().proposePatch({
    path: String(p.path ?? ''), summary: String(p.summary ?? ''),
    find: String(p.find ?? ''), replace: String(p.replace ?? ''),
  })
  const { added, removed } = summariseDiff(proposal.diff)
  return {
    success: true,
    data: `Proposed for ${proposal.path} (+${added} −${removed}). Nothing has been written yet.`
      + `\nId: ${proposal.id}\n\n${proposal.diff}`,
  }
})

reg.register({
  name: 'selfwork.proposeWrite',
  description: 'Propose a change to one file of Goga\'s own source by giving the whole new body. Writes NOTHING: it offers a diff for the user to approve. Refused for protected files such as the approval gate, the security scope checks, or the broker credentials.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repo-relative path under src/, e.g. src/main/services/foo.ts.' },
      summary: { type: 'string', description: 'One or two sentences: what changes and why.' },
      after: { type: 'string', description: 'The complete new file body.' },
    },
    required: ['path', 'summary', 'after'],
  },
  riskLevel: 'low', reversible: true, category: 'selfwork',
}, async p => {
  const proposal = work().propose({
    path: String(p.path ?? ''), summary: String(p.summary ?? ''), after: String(p.after ?? ''),
  })
  const { added, removed } = summariseDiff(proposal.diff)
  return {
    success: true,
    data: `Proposed for ${proposal.path} (+${added} −${removed}). Nothing has been written yet.`
      + `\nId: ${proposal.id}\n\n${proposal.diff}`,
  }
})

reg.register({
  name: 'selfwork.apply',
  description: 'Apply ONE change that the user has approved, by its proposal id. Refused unless that exact proposal was approved and has not been used. Does not run the checks — call selfwork.check afterwards.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The proposal id from selfwork.proposePatch or selfwork.proposeWrite.' } },
    required: ['id'],
  },
  riskLevel: 'critical', reversible: true, category: 'selfwork',
}, async p => {
  const r = work().apply(String(p.id ?? ''))
  return { success: r.ok, data: r.message, error: r.ok ? undefined : r.message }
})

reg.register({
  name: 'selfwork.check',
  description: 'Run the project\'s own checks on Goga\'s source — the build, the typecheck and the full test suite — and report exactly what they said. A failed check is reported as broken, never as done.',
  parameters: {
    type: 'object',
    properties: {
      only: {
        type: 'string',
        description: 'Optional subset: "build", "typecheck" or "tests". Omit to run all three in that order.',
      },
    },
    required: [],
  },
  riskLevel: 'low', reversible: true, category: 'selfwork',
}, async p => {
  const only = ['build', 'typecheck', 'tests'].includes(String(p.only ?? ''))
    ? [String(p.only) as 'build' | 'typecheck' | 'tests']
    : undefined
  const report = await work().runChecks(undefined, only)
  return { success: report.ok, data: report.summary, error: report.ok ? undefined : report.summary }
})

reg.register({
  name: 'selfwork.state',
  description: 'What Goga has proposed, what the user approved, what was applied and the audit trail. Read-only.',
  parameters: { type: 'object', properties: {}, required: [] },
  riskLevel: 'low', reversible: true, category: 'selfwork',
}, async () => {
  const s = work().state()
  const lines = [
    `Repo: ${s.repoRoot}`,
    `Waiting for approval: ${s.proposals.length === 0 ? 'none' : s.proposals.map(p => `${p.id} ${p.path}`).join('; ')}`,
    `Applied: ${s.applied.length === 0 ? 'none' : s.applied.map(p => `${p.path} — ${p.summary}`).join('; ')}`,
    `Last check: ${s.lastCheck ? s.lastCheck.summary.split('\n')[0] : 'none run yet'}`,
  ]
  return { success: true, data: lines.join('\n') }
})

export function registerSelfWorkTools() { return ToolRegistry.getInstance() }
