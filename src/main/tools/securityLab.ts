import { ToolRegistry } from './registry'
import { SecurityWorkspaceService } from '../services/securityWorkspace'
import { practiceLab, LAB_ACCOUNTS } from '../services/practiceLab'
import { LabClient, labAccount } from '../services/securityHttp'

const reg = ToolRegistry.getInstance()
let client: LabClient | null = null
const lab = () => client ??= new LabClient(practiceLab())

const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

/** The lab tools only work while a workspace scoped to the lab is active. Checked here too. */
function requireLab() {
  const ws = SecurityWorkspaceService.getInstance().getActive()
  if (!ws) throw new Error('Activate the practice lab workspace first (Security tab).')
  if (!ws.authorizedAssets.some(a => /127\.0\.0\.1|localhost/i.test(a))) throw new Error('The active workspace is not the practice lab.')
  if (!practiceLab().running) throw new Error('Start the practice lab in the Security tab first.')
}

const accountParam = { type: 'string' as const, enum: [...LAB_ACCOUNTS], description: `Which test account to act as: ${LAB_ACCOUNTS.join(' or ')}.` }

reg.register({
  name: 'security.lab.request',
  description: 'Practice lab: make one GET request to a lab path as a test account, and get back the status and body. Use this to learn how the app behaves. Start at "/" to see the endpoints.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A path on the lab, e.g. "/api/notes" or "/api/notes/101".' },
      as: accountParam,
    },
    required: ['path'],
  },
  riskLevel: 'low', reversible: true, category: 'web',
}, async (p, ctx) => {
  try {
    requireLab()
    return { success: true, data: await lab().get(String(p.path ?? ''), labAccount(p.as), ctx.abortSignal) }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.lab.verify',
  description: 'Practice lab verification runner: check whether one account can read another account\'s resource at a path. It requests as the owner and the other account, twice each, and reports whether the evidence supports a real access-control bug. Use this before reporting.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The owner\'s resource, e.g. "/api/notes/102".' },
      owner: { ...accountParam, description: 'The account the resource belongs to.' },
      other: { ...accountParam, description: 'The account that should NOT be able to read it.' },
    },
    required: ['path', 'owner', 'other'],
  },
  riskLevel: 'low', reversible: true, category: 'web',
}, async (p, ctx) => {
  try {
    requireLab()
    const owner = labAccount(p.owner), other = labAccount(p.other)
    if (!owner || !other) throw new Error(`Name two test accounts: ${LAB_ACCOUNTS.join(', ')}.`)
    const result = await lab().verifyAccess(String(p.path ?? ''), owner, other, ctx.abortSignal)
    return { success: true, data: { supported: result.supported, reason: result.reason, evidence: result.responses } }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.lab.report',
  description: 'Practice lab: save a VERIFIED access-control finding to the workspace Findings. Only call this after security.lab.verify returned supported:true for this exact path and accounts; it re-runs the check and refuses if the evidence does not hold.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title, e.g. "Any user can read any note".' },
      path: { type: 'string', description: 'The vulnerable path, e.g. "/api/notes/102".' },
      owner: accountParam,
      other: accountParam,
      impact: { type: 'string', description: 'What the other account gained that it should not have.' },
    },
    required: ['title', 'path', 'owner', 'other', 'impact'],
  },
  riskLevel: 'low', reversible: true, category: 'web',
}, async (p, ctx) => {
  try {
    requireLab()
    const owner = labAccount(p.owner), other = labAccount(p.other)
    if (!owner || !other) throw new Error(`Name two test accounts: ${LAB_ACCOUNTS.join(', ')}.`)
    const check = await lab().verifyAccess(String(p.path ?? ''), owner, other, ctx.abortSignal)
    if (!check.supported) throw new Error(`Not verified, so not saved: ${check.reason}`)
    const ws = SecurityWorkspaceService.getInstance().getActive()!
    const evidence = check.responses.map(r => `${r.as} → ${r.method} ${r.path} → HTTP ${r.status}: ${r.body.slice(0, 200)}`).join('\n')
    const finding = SecurityWorkspaceService.getInstance().addFinding(ws.id, {
      title: String(p.title ?? '').slice(0, 120),
      severity: 'high',
      target: `${practiceLab().baseUrl}${String(p.path ?? '')}`,
      description: `${String(p.impact ?? '').slice(0, 2000)}\n\nVerified: ${check.reason}\n\nEvidence:\n${evidence}`,
      steps: `1. Sign in as ${other}.\n2. GET ${p.path} (it belongs to ${owner}).\n3. The response is ${owner}'s data, with HTTP 200.`,
      evidenceIds: [],
      status: 'draft',
    })
    return { success: true, data: { saved: finding.title, verified: true } }
  } catch (err) { return failure(err) }
})
