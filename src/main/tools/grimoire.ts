import path from 'path'
import { ToolRegistry } from './registry'
import { SPECIALISTS, GATE_QUESTIONS, specialistById } from '../services/security/grimoire/specialists'
import { knowledgeBase, knowledgeFor } from '../services/security/grimoire/knowledge'
import { runReview, indexLocalTarget, readForReview } from '../services/security/grimoire/review'
import { memoryEntries, memorySummary } from '../services/security/grimoire/memory'
import { headersOfInterest, jsEndpoints, sampleText } from '../services/security/grimoire/reading'
import { importCantina } from '../services/security/cantina'
import { fetchBountyFeed } from '../services/security/bountyFinder'
import { activeProgram, addProgram, audit } from '../services/security/store'

/**
 * Grimoire tools, for chat.
 *
 * Every one of these is `low` risk and read-only with respect to any target: they read a file
 * the user names, argue about it, and return text. The two that reach a network read a public
 * page (Cantina's bounty page, GitHub's search API) and send nothing to a program's assets.
 *
 * There is deliberately no tool here that sends a request at a target. That remains
 * `security.probe`, `critical`, behind the single-use grant.
 */

const reg = ToolRegistry.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

reg.register({
  name: 'security.specialists',
  description: 'List the specialist reviewers: one per vulnerability class, each with what it looks for, what evidence would confirm a real issue on your own local copy, and when it must stand down. Read-only. Use this to explain how the review works, or to pick a class to focus on.',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'Optional specialist id, e.g. "idor", "xss", "ssrf", "sqli".' } } },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  if (p.id) {
    const s = specialistById(String(p.id))
    if (!s) return { success: false, error: `no specialist "${p.id}". Known: ${SPECIALISTS.map(x => x.id).join(', ')}` }
    return { success: true, data: [
      `${s.name} — ${s.bugClass}`,
      '',
      'What it looks for:',
      ...s.looksFor.map(l => `  • ${l}`),
      '',
      'What would confirm it on your own copy:',
      ...s.wouldConfirm.map(l => `  • ${l}`),
      '',
      'When it stands down:',
      ...s.standDown.map(l => `  • ${l}`),
      '',
      'It reasons. It never contacts a target.',
    ].join('\n') }
  }
  return { success: true, data: [
    `${SPECIALISTS.length} specialist reviewers, one per vulnerability class. Each argues what it would look for and why; none of them sends a request.`,
    '',
    ...SPECIALISTS.map(s => `${s.id} — ${s.name}: ${s.bugClass}`),
    '',
    'A specialist\'s output is a HYPOTHESIS, not a finding. The validator decides whether it survives.',
  ].join('\n') }
})

reg.register({
  name: 'security.reviewFile',
  description: 'Run the specialist reviewers over ONE file on this machine, inside a folder you name, and return their reasoning plus the independent validator\'s verdict on each candidate. Reads the file only: no network, no shell, nothing sent anywhere. Use this for a local copy of source code you are allowed to read.',
  parameters: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'The folder that holds the local copy, e.g. C:\\Users\\you\\Downloads\\wordpress.' },
      path: { type: 'string', description: 'The file to review, inside that folder.' },
      marker: { type: 'string', description: 'Optional unique string to sample around, if you are looking at a specific value.' },
      specialists: { type: 'array', items: { type: 'string' }, description: 'Optional list of specialist ids to restrict to.' },
    },
    required: ['root', 'path'],
  },
  riskLevel: 'low', reversible: true, category: 'filesystem',
}, async p => {
  try {
    // `path` may be relative to `root` (the natural way to name a file in a tree) or already
    // absolute (what the Grimoire page sends). Resolve it against the root either way.
    const root = String(p.root ?? '')
    const named = String(p.path ?? '')
    const target = path.isAbsolute(named) ? named : path.join(root, named)
    const read = readForReview(root, target)
    const program = activeProgram()
    const run = runReview({
      text: read.text,
      location: read.rel,
      material: 'code_audit',
      marker: p.marker ? String(p.marker) : undefined,
      specialists: Array.isArray(p.specialists) ? p.specialists as never : undefined,
      programId: program?.id,
      programName: program?.name,
    })
    const confirmed = run.hypotheses.filter(h => h.state === 'hypothesis')
    const dropped = run.hypotheses.filter(h => h.state === 'dropped')
    return { success: true, data: [
      `Reviewed ${read.rel} (${read.size} bytes). ${run.sample.note}`,
      '',
      ...run.reviews.filter(r => !r.quiet).map(r => `## ${r.name}\n${r.reasoning}`),
      '',
      `Candidates with a confirming observable (${confirmed.length}):`,
      ...(confirmed.length ? confirmed.map(h => `  • [${h.specialist}] ${h.title}\n    observable: ${h.validation.observable}\n    at: ${h.validation.observableAt}`) : ['  none']),
      '',
      `Dropped by the validator (${dropped.length}):`,
      ...(dropped.length ? dropped.map(h => `  • [${h.specialist}] ${h.title} — ${h.validation.why}`) : ['  none']),
      '',
      'These are hypotheses. Nothing here contacted a target, and nothing is a finding until you reproduce it yourself.',
    ].join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.reviewText',
  description: 'Run the specialist reviewers over a page description or code snippet you paste, and return their reasoning plus the validator\'s verdict. Nothing is sent anywhere.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The page description or code to review.' },
      label: { type: 'string', description: 'Optional label, e.g. "login page description".' },
      marker: { type: 'string', description: 'Optional unique string to sample around.' },
    },
    required: ['text'],
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  try {
    const text = String(p.text ?? '')
    if (text.trim().length < 20) return { success: false, error: 'paste at least a sentence to review' }
    const program = activeProgram()
    const run = runReview({ text, location: String(p.label ?? 'pasted material'), material: 'web', marker: p.marker ? String(p.marker) : undefined, programId: program?.id, programName: program?.name })
    const confirmed = run.hypotheses.filter(h => h.state === 'hypothesis')
    return { success: true, data: [
      run.sample.note,
      '',
      ...run.reviews.filter(r => !r.quiet).map(r => `## ${r.name}\n${r.reasoning}`),
      '',
      confirmed.length
        ? `Candidates with a confirming observable:\n${confirmed.map(h => `  • [${h.specialist}] ${h.title} — ${h.validation.observable}`).join('\n')}`
        : 'No candidate survived the validator. That is a real answer, not a failure: it means nothing in what you pasted settles the question.',
      '',
      'Hypotheses, not findings. Nothing was sent anywhere.',
    ].join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.knowledge',
  description: 'The disclosure-derived knowledge base: real bug classes and their fixes, each citing the HackerOne report id it came from. Records classes and fixes, never payloads. With no argument, lists the entries; with a specialist id, returns that class in full.',
  parameters: { type: 'object', properties: { specialist: { type: 'string', description: 'Optional specialist id, e.g. "xss", "idor".' } } },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const kb = knowledgeBase()
  if (p.specialist) {
    const entries = knowledgeFor(String(p.specialist) as never)
    if (!entries.length) return { success: false, error: `no knowledge entry for "${p.specialist}". Known: ${[...new Set(kb.entries.map(e => e.specialist))].join(', ')}` }
    return { success: true, data: entries.map(e => [
      `${e.bugClass}`,
      e.what,
      `Fix: ${e.fix}`,
      e.citations.length
        ? `Drawn from:\n${e.citations.map(c => `  • report ${c.reportId} — ${c.title} (${c.severity ?? 'severity not stated'}, ${c.cwe ?? 'CWE not stated'}, disclosed ${c.disclosed ?? 'date not stated'})\n    ${c.url}${c.bodyUnread ? '\n    body not read — metadata only' : ''}`).join('\n')}`
        : 'No disclosed report for this class was found in the readable set. Said plainly rather than padded.',
      e.limit ? `Limit: ${e.limit}` : '',
    ].filter(Boolean).join('\n')).join('\n\n---\n\n') }
  }
  return { success: true, data: [
    kb.note,
    '',
    ...kb.entries.map(e => `${e.specialist} — ${e.bugClass} (${e.citations.length} citation(s))`),
  ].join('\n') }
})

reg.register({
  name: 'security.memory',
  description: 'What has already been tried and what turned out to be nothing, per program, so the same candidate is not re-argued. Read-only.',
  parameters: { type: 'object', properties: { programId: { type: 'string', description: 'Optional program id to filter to.' } } },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const entries = memoryEntries(p.programId ? String(p.programId) : undefined)
  const summary = memorySummary(p.programId ? String(p.programId) : undefined)
  if (!entries.length) return { success: true, data: 'Nothing in memory yet. A review records each candidate and what happened to it.' }
  return { success: true, data: [
    `${summary.total} candidate(s) remembered: ${summary.raised} still open, ${summary.dropped} dropped by the validator, ${summary.dead} killed by the gate, ${summary.confirmed} you confirmed.`,
    '',
    ...entries.slice(-40).map(e => `[${e.outcome}] ${e.specialist} — ${e.title}\n  ${e.reason}`),
  ].join('\n') }
})

reg.register({
  name: 'security.gate',
  description: 'The seven-question validation gate: the checklist a finding must pass before a report is drafted. With no argument, lists the questions; a "no" on any of the first four kills the finding and records it as dead.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => ({
  success: true,
  data: [
    'The seven-question gate. A "no" on any of the first four kills the finding, and it is kept in memory as dead so it is never raised again.',
    '',
    ...GATE_QUESTIONS.map((q, i) => `${i + 1}. ${q.question}\n   Passes when: ${q.passing}\n   Why it matters: ${q.why}`),
  ].join('\n'),
}))

reg.register({
  name: 'security.importCantina',
  description: 'Import a Cantina bounty\'s published scope from its public page, read-only, and record its entry bar (deposit, KYC, findings already submitted, asset count, scope kind) beside the reward. Does not join the program, pay a deposit or complete KYC.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'A Cantina bounty URL, e.g. https://bounties.cantina.xyz/cantina/bug-bounty or https://cantina.xyz/bounties/<id>.' } },
    required: ['url'],
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  try {
    const imported = await importCantina(String(p.url ?? ''))
    const { bar, ...program } = imported
    const stored = addProgram({ ...program, entryBar: bar })
    audit('note', `imported Cantina program ${stored.name} (${stored.handle}) — ${stored.assets.length} asset(s)`)
    return { success: true, data: [
      `Imported ${stored.name} (${stored.handle}) from ${stored.url}.`,
      `${stored.assets.length} in-scope asset(s):`,
      ...stored.assets.map(a => `  • ${a.identifier}${a.instruction ? ` — ${a.instruction}` : ''}`),
      '',
      'The entry bar, as the page states it:',
      `  top reward: ${bar.topReward ?? 'not stated'}`,
      `  identity verification: ${bar.kycRequired === false ? 'not required' : bar.kycRequired === true ? 'REQUIRED to join' : 'not stated'}`,
      `  deposit: ${bar.depositUsd ? `$${bar.depositUsd}` : 'none stated'}`,
      `  findings already submitted: ${bar.findingsSubmitted ?? 'not stated'}`,
      `  scope: ${bar.scopeKind}`,
      bar.automatedTestingRule ? `  the program's own rule on automated testing: "${bar.automatedTestingRule}"` : '',
      '',
      `Assessment (not the program's words): ${bar.entry.why}`,
      '',
      'Nothing was joined, paid or submitted. Importing a page is not permission to test: any request still needs your approval of that exact URL.',
    ].filter(Boolean).join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.bountyFeed',
  description: 'Read a public feed of open, bounty-labelled work from GitHub, with a difficulty estimate and a hidden-gem flag computed from the issue\'s own facts. Read-only, no token needed, nothing joined. Use it to find smaller targets where a first real finding is reachable.',
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'Optional GitHub search query. Default: label:bounty state:open is:issue' } } },
  riskLevel: 'low', reversible: true, category: 'web',
}, async p => {
  try {
    const feed = await fetchBountyFeed({ query: p.query ? String(p.query) : undefined })
    if (feed.error) return { success: false, error: feed.error }
    if (!feed.items.length) return { success: true, data: `No open bounty-labelled issues matched "${feed.query}".` }
    return { success: true, data: [
      feed.note,
      '',
      ...feed.items.slice(0, 25).map(i => `${i.hiddenGem ? '★ ' : '  '}${i.title}\n    ${i.repo} · ${i.difficulty} · ${i.comments} comment(s) · ${i.ageDays}d old\n    ${i.hint}\n    ${i.url}`),
      '',
      'A bounty label is not permission. Each of these has its own rules.',
    ].join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'security.readEvidence',
  description: 'Read evidence well: sample a long text so a model sees the start, the region around your marker and the tail; pull out the headers that carry signal; and list endpoints found in JavaScript you already hold. Read-only, no network.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to sample or scan.' },
      marker: { type: 'string', description: 'Optional unique string to keep the region around.' },
      mode: { type: 'string', enum: ['sample', 'endpoints'], description: 'sample (default) or endpoints.' },
      headers: { type: 'object', description: 'Optional headers object to surface, as name/value pairs.' },
    },
    required: ['text'],
  },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const text = String(p.text ?? '')
  if (p.mode === 'endpoints') {
    const found = jsEndpoints(text)
    if (!found.length) return { success: true, data: 'No endpoints were found in that JavaScript.' }
    return { success: true, data: [`${found.length} endpoint(s) found:`, ...found.map(e => `  line ${e.line} [${e.kind}] ${e.value}  (via ${e.via})`)].join('\n') }
  }
  const sample = sampleText(text, { marker: p.marker ? String(p.marker) : undefined })
  const lines = [sample.note, '', sample.text.slice(0, 4000)]
  if (p.headers && typeof p.headers === 'object') {
    const h = headersOfInterest(p.headers as Record<string, string>)
    if (h.length) lines.push('', 'Headers of interest:', ...h.map(x => `  ${x.name}: ${x.value}\n    ${x.why}`))
  }
  return { success: true, data: lines.join('\n') }
})

reg.register({
  name: 'security.indexTarget',
  description: 'Index a local source tree you point Goga at: a bounded list of readable files and a few facts about the tree (for example the WordPress version). Read-only, and nothing outside the folder you name is read.',
  parameters: { type: 'object', properties: { root: { type: 'string', description: 'The folder holding the local copy.' } }, required: ['root'] },
  riskLevel: 'low', reversible: true, category: 'filesystem',
}, async p => {
  try {
    const indexed = indexLocalTarget(String(p.root ?? ''))
    return { success: true, data: [
      `${indexed.files.length} readable file(s) under ${p.root}.`,
      ...indexed.findings.map(f => `  ${f}`),
      '',
      'Ask me to review one of them with security.reviewFile.',
    ].join('\n') }
  } catch (err) { return failure(err) }
})
