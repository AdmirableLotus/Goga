import { ToolRegistry } from './registry'
import { evolution } from '../services/evolution/instance'
import { deleteSkill, forgetNote, notes, promptBlock, recordSkill, remember, skills, touchSkill } from '../services/evolution/learning'

/**
 * Tools for the supervised self-improvement loop and the learning layer.
 *
 * Starting a run is `critical` because the run ends with a change to Goga's own source
 * waiting for approval; installing it is `critical` and reversible only because the
 * snapshot is kept. Recording a note or a skill is cheap and does not change code.
 */

const reg = ToolRegistry.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

reg.register({
  name: 'evolution.status',
  description: 'Where the self-improvement loop stands: whether a run is in progress, its stage, and the last runs with what they changed, whether they passed, and whether they were installed or rolled back.',
  parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many past runs (default 5).' } } },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const s = evolution().state()
  const runs = s.history.slice(0, Number(p.limit) || 5)
  return { success: true, data: [
    `Loop: ${s.running ? `running (stage ${s.stage})` : 'idle'}`,
    s.current ? `Current: ${s.current.goal} — ${s.current.stage}${s.current.summary ? ` — ${s.current.summary}` : ''}` : '',
    ...(runs.length ? ['', 'Past runs:', ...runs.map(r => `  ${r.startedAt.slice(0, 16).replace('T', ' ')} [${r.stage}] ${r.goal}\n     ${r.summary || r.error || 'no summary'}${r.files.length ? ` (${r.files.join(', ')})` : ''}`)] : ['', 'No runs yet.']),
  ].filter(Boolean).join('\n') }
})

reg.register({
  name: 'evolution.start',
  description: 'Start a self-improvement run: Goga reads his own source read-only, writes up concrete weaknesses, proposes one specific change, applies it on a private copy, and proves it with the typecheck and the full test suite. It STOPS there — nothing in the running code changes until the user approves. Never commits, pushes or reloads itself.',
  parameters: { type: 'object', properties: { goal: { type: 'string', description: 'The specific weakness to close, e.g. "browser.open retries the same failing page".' } }, required: ['goal'] },
  riskLevel: 'critical', reversible: true, category: 'system',
}, async (p, ctx) => {
  try {
    const run = await evolution().run(String(p.goal ?? ''), ctx.abortSignal)
    return { success: true, data: [
      `Run finished at stage "${run.stage}".`,
      run.weaknesses.length ? `Weaknesses named in the review:\n${run.weaknesses.map(w => `  • ${w.title}${w.files.length ? ` (${w.files.join(', ')})` : ''}`).join('\n')}` : '',
      `Change: ${run.summary}`,
      `Files: ${run.files.join(', ')}`,
      `Typecheck and tests: ${run.testsPassed ? 'passed on a private copy' : 'not reached'}.`,
      'Nothing in the running code has changed. The user reviews the diff in the Self-improve page and approves it there.',
    ].filter(Boolean).join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'evolution.skills',
  description: 'The procedures recorded as reusable skills, and how to record a new one. Reading is free; recording stores a named procedure with its steps so it survives restarts.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read', 'record', 'delete'], description: 'list (default), read one, record a new one, or delete one.' },
      name: { type: 'string', description: 'Skill name, for read/record/delete.' },
      whenToUse: { type: 'string', description: 'For record: when this skill applies.' },
      steps: { type: 'array', description: 'For record: the ordered steps.' },
      tools: { type: 'array', description: 'For record: the tool names the skill uses.' },
    },
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const action = String(p.action ?? 'list')
  if (action === 'record') {
    try {
      const skill = recordSkill({
        name: String(p.name ?? ''), whenToUse: String(p.whenToUse ?? ''), steps: Array.isArray(p.steps) ? (p.steps as unknown[]).map(String) : [],
        origin: 'recorded in chat', tools: Array.isArray(p.tools) ? (p.tools as unknown[]).map(String) : [],
      })
      return { success: true, data: `Recorded skill "${skill.name}" with ${skill.steps.length} step(s). It is injected into my context from now on.` }
    } catch (err) { return failure(err) }
  }
  if (action === 'delete') {
    const match = skills().find(s => s.name.toLowerCase() === String(p.name ?? '').toLowerCase())
    if (!match) return { success: false, error: `no skill named "${p.name}"` }
    deleteSkill(match.id)
    return { success: true, data: `Deleted skill "${match.name}".` }
  }
  if (action === 'read') {
    const match = skills().find(s => s.name.toLowerCase() === String(p.name ?? '').toLowerCase())
    if (!match) return { success: false, error: `no skill named "${p.name}". Known: ${skills().map(s => s.name).join(', ') || 'none'}` }
    touchSkill(match.id)
    return { success: true, data: [`${match.name}${match.whenToUse ? ` — ${match.whenToUse}` : ''}`, ...match.steps.map((s, i) => `  ${i + 1}. ${s}`), match.tools.length ? `Tools: ${match.tools.join(', ')}` : ''].filter(Boolean).join('\n') }
  }
  const list = skills()
  return { success: true, data: list.length ? list.map(s => `${s.name} (${s.steps.length} steps, used ${s.used}×)${s.whenToUse ? ` — ${s.whenToUse}` : ''}`).join('\n') : 'No skills recorded yet. Use action "record" with a name, whenToUse and steps to save one.' }
})

reg.register({
  name: 'evolution.remember',
  description: 'Store something that should survive a restart: what the user taught you, an approach that worked, a failure and why, or a note from your own code work. These are injected into your context automatically.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['taught', 'worked', 'failed', 'code'], description: 'taught (from the user), worked, failed, or code.' },
      text: { type: 'string', description: 'The thing to remember, in plain words.' },
      source: { type: 'string', description: 'Where it came from.' },
    },
    required: ['kind', 'text'],
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  try {
    const note = remember((['taught', 'worked', 'failed', 'code'] as const).includes(p.kind as 'taught') ? p.kind as 'taught' : 'code', String(p.text ?? ''), String(p.source ?? 'chat'))
    return { success: true, data: `Remembered (${note.kind}): ${note.text}` }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'evolution.learning',
  description: 'What has been learned and is currently injected into the prompt, plus how many notes of each kind are stored. Use it when asked what you remember learning.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => {
  const all = notes()
  const block = promptBlock()
  const counts = ['taught', 'worked', 'failed', 'code'].map(k => `${k}: ${all.filter(n => n.kind === k).length}`).join(', ')
  const recent = all.slice(-10).map(n => `  [${n.kind}] ${n.text}`)
  return { success: true, data: [`${all.length} note(s) — ${counts}`, '', block || '(nothing injected yet)', '', recent.length ? 'Most recent:' : '', ...recent].filter(Boolean).join('\n') }
})

reg.register({
  name: 'evolution.forget',
  description: 'Forget one stored learning note by id (from evolution.learning).',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'The note id.' } }, required: ['id'] },
  riskLevel: 'low', reversible: false, category: 'memory',
}, async p => {
  forgetNote(String(p.id))
  return { success: true, data: 'Forgotten.' }
})


// ── Finishing a run, from chat ───────────────────────────────────────────────
//
// `evolution.start` could begin a run and stop at "awaiting", and then the only way to accept
// or throw away what it produced was a button on the Self-improve page. These two tools are
// that button. Installing is `critical` because it writes to the running source tree, so the
// agent loop's approval gate stops it every time; discarding touches nothing.

reg.register({
  name: 'evolution.install',
  description: 'Install the change a self-improvement run is holding: apply its patch to the real source tree, rebuild and retest, and roll back automatically if either fails. Only valid when a run is waiting for approval. It never commits, pushes, deploys or restarts Goga — the user restarts when they choose.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'critical', reversible: true, category: 'system',
}, async (_p, ctx) => {
  try {
    const run = await evolution().install(ctx.abortSignal)
    return {
      success: true,
      data: [
        `Installed: ${run.summary}`,
        `Files: ${run.files.join(', ')}`,
        run.installNote ?? 'Installed and rebuilt.',
      ].filter(Boolean).join('\n'),
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'evolution.discard',
  description: 'Throw away the change a self-improvement run is holding. Nothing was ever in the running tree, so this only deletes the private copy and records the run as refused.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: false, category: 'system',
}, async () => {
  try {
    evolution().discard()
    return { success: true, data: 'Discarded. The running code was never touched.' }
  } catch (err) { return failure(err) }
})
