import { ToolRegistry } from './registry'
import { SecurityCodeService } from '../services/securityCode'
import { SecurityWorkspaceService } from '../services/securityWorkspace'
import { codeRoot } from '../services/securityGrounding'

const reg = ToolRegistry.getInstance()
let code: SecurityCodeService | null = null
const service = () => code ??= new SecurityCodeService(codeRoot())

const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

/** The active workspace and the in-scope repository, or an error. Checked here too, not only at dispatch. */
function target(params: Record<string, unknown>): { workspaceId: string; repo: string } {
  const security = SecurityWorkspaceService.getInstance()
  const ws = security.getActive()
  if (!ws) throw new Error('Activate a security workspace first (Security tab).')
  const { repo, reason } = security.codeRepo(ws, params.repo)
  if (!repo) throw new Error(reason)
  return { workspaceId: ws.id, repo }
}

const repoParam = { type: 'string' as const, description: 'Optional. https://github.com/owner/name; omit when the workspace has one repository.' }

reg.register({
  name: 'security.code.fetch',
  description: 'Security review: copy the in-scope GitHub repository of the active workspace onto this PC to read it. Nothing from it is run. Needs approval.',
  parameters: { type: 'object', properties: { repo: repoParam }, required: [] },
  riskLevel: 'high', reversible: true, category: 'web',
}, async (p, ctx) => {
  try {
    const { workspaceId, repo } = target(p)
    const { files } = await service().fetch(workspaceId, repo, ctx.abortSignal)
    return { success: true, data: { repo, files, next: 'Use security.code.search for risky patterns, then security.code.read to check them.' } }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.code.list',
  description: 'Security review: list a folder of the copied repository ("" for the top).',
  parameters: { type: 'object', properties: { dir: { type: 'string', description: 'Folder inside the repository, e.g. "bin".' }, repo: repoParam }, required: [] },
  riskLevel: 'low', reversible: true, category: 'filesystem',
}, async (p) => {
  try {
    const { workspaceId, repo } = target(p)
    return { success: true, data: { dir: p.dir ?? '', entries: service().list(workspaceId, repo, String(p.dir ?? '')) } }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.code.search',
  description: 'Security review: search the copied repository for a pattern (regex, case-insensitive) and get file:line matches. Optional "path" keeps files whose path contains it.',
  parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'e.g. "NOPASSWD|chmod 666|eval ".' }, path: { type: 'string', description: 'e.g. "bin/" or ".sh".' }, repo: repoParam }, required: ['pattern'] },
  riskLevel: 'low', reversible: true, category: 'filesystem',
}, async (p) => {
  try {
    const { workspaceId, repo } = target(p)
    return { success: true, data: service().search(workspaceId, repo, String(p.pattern ?? ''), String(p.path ?? '')) }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.code.read',
  description: 'Security review: read lines of a file in the copied repository (up to 200 at a time).',
  parameters: { type: 'object', properties: { file: { type: 'string', description: 'Path inside the repository, e.g. "bin/omarchy-dns".' }, startLine: { type: 'number', description: 'First line, default 1.' }, lines: { type: 'number', description: 'How many lines, at most 200.' }, repo: repoParam }, required: ['file'] },
  riskLevel: 'low', reversible: true, category: 'filesystem',
}, async (p) => {
  try {
    const { workspaceId, repo } = target(p)
    return { success: true, data: service().read(workspaceId, repo, String(p.file ?? ''), Number(p.startLine ?? 1), Number(p.lines ?? 200)) }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.code.draftFinding',
  description: 'Security review: save a suspicious line as an UNVERIFIED draft in the workspace Findings, after checking the quote is really at that file and line. Use only for code you read with security.code.read.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title, e.g. "Install log is world-writable".' },
      file: { type: 'string', description: 'Path inside the repository.' },
      line: { type: 'number', description: 'Line number from security.code.read.' },
      quote: { type: 'string', description: 'The suspicious code, copied exactly.' },
      why: { type: 'string', description: 'Who could exploit it and what they would gain that they did not have.' },
      severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'], description: 'Your guess; the program decides.' },
      repo: repoParam,
    },
    required: ['title', 'file', 'line', 'quote', 'why'],
  },
  riskLevel: 'low', reversible: true, category: 'filesystem',
}, async (p) => {
  try {
    const { workspaceId, repo } = target(p)
    const at = service().quoteAt(workspaceId, repo, String(p.file ?? ''), Number(p.line), String(p.quote ?? ''))
    const severity = ['info', 'low', 'medium', 'high', 'critical'].includes(String(p.severity)) ? p.severity as 'info' : 'low'
    const finding = SecurityWorkspaceService.getInstance().addFinding(workspaceId, {
      title: `[UNVERIFIED] ${String(p.title ?? '').slice(0, 120)}`,
      severity,
      target: `${repo}/blob/HEAD/${at.file}#L${at.line}`,
      description: `${String(p.why ?? '').slice(0, 2000)}\n\nCode (${at.file}:${at.line}):\n${at.text}\n\nFound by Goga's code review. Not verified: reproduce it in a test machine and write a working proof-of-concept before reporting.`,
      steps: '',
      evidenceIds: [],
      status: 'draft',
    })
    return { success: true, data: { saved: finding.title, at: `${at.file}:${at.line}`, note: 'Saved as an unverified draft in Findings. The user must reproduce it.' } }
  } catch (err) { return failure(err) }
})
