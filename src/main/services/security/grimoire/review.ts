import fs from 'fs'
import path from 'path'
import type { Hypothesis, ReviewRun, Specialist, SpecialistId, SpecialistReview } from '../../../../shared/grimoire'
import { SPECIALISTS, specialistById } from './specialists'
import { applyValidation } from './validator'
import { candidateKey, dedupe, sampleText } from './reading'
import { alreadySettled, remember } from './memory'
import { nanoid } from '../../../utils/nanoid'

/**
 * The review engine: run the specialists over material the user already has.
 *
 * No network. No shell. No subprocess. This module imports `fs` (to read the file the user
 * named) and nothing else that can leave the machine. That is not a policy statement in a
 * comment — the test suite asserts that this file's import list contains no fetch, http,
 * https, net, dns, child_process or tls, and that `runReview` never calls a global fetch even
 * when one is installed and watching.
 *
 * What a run produces:
 *   - one SpecialistReview per specialist that had something to say, including the ones that
 *     deliberately stood down, so the user can see which classes were considered and dismissed;
 *   - Hypotheses, each carrying the validator's independent verdict;
 *   - nothing that presents itself as a finding.
 */

/** A line-oriented hit, so a specialist's claim always points at a line the user can open. */
interface LineHit { line: number; label: string; excerpt: string; why: string }

const MAX_HITS_PER_SPECIALIST = 6

function hitsFor(spec: Specialist, material: string): LineHit[] {
  const lines = material.split(/\r?\n/)
  const hits: LineHit[] = []
  for (const signal of spec.signals) {
    let re: RegExp
    try { re = new RegExp(signal.pattern, 'i') } catch { continue }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!re.test(line)) continue
      if (line.trim().length < 4) continue
      // One hit per label per line, and never the same line twice for the same label.
      if (hits.some(h => h.line === i + 1 && h.label === signal.label)) continue
      hits.push({ line: i + 1, label: signal.label, excerpt: line.trim().slice(0, 300), why: signal.why })
      if (hits.filter(h => h.label === signal.label).length >= 2) break
    }
    if (hits.length >= MAX_HITS_PER_SPECIALIST) break
  }
  return hits.slice(0, MAX_HITS_PER_SPECIALIST).sort((a, b) => a.line - b.line)
}

/**
 * The specialist's prose. Written as reasoning addressed to the user, not as a list of matches:
 * what it looked for, what it found that matters, and what it cannot tell without evidence.
 * A specialist with no hits still speaks, because "I looked at this file for SQL injection and
 * there is no query in it" is information.
 */
function reasoningFor(spec: Specialist, hits: LineHit[], material: 'code_audit' | 'web', sampled: boolean): string {
  const lines: string[] = []
  if (!hits.length) {
    lines.push(`I read the ${material === 'code_audit' ? 'code' : 'page description'} for ${spec.bugClass.toLowerCase()} and found nothing I would argue about here.`)
    if (sampled) lines.push('I only saw a sample of the file, so this is a statement about the sample, not about the whole file.')
    lines.push(`That is a clean result for this class, not a clean bill of health for the file.`)
    return lines.join(' ')
  }

  lines.push(`I look for ${spec.looksFor[0].charAt(0).toLowerCase()}${spec.looksFor[0].slice(1)}`)
  lines.push(`Here, ${hits.length === 1 ? 'one line is worth reading' : `${hits.length} lines are worth reading`}:`)
  for (const h of hits) {
    lines.push(`  line ${h.line} — ${h.why}. ${h.excerpt.length > 160 ? `${h.excerpt.slice(0, 160)}…` : h.excerpt}`)
  }
  lines.push(`What I would need to call this real: ${spec.wouldConfirm[0]}${spec.wouldConfirm[1] ? ` ${spec.wouldConfirm[1]}` : ''}`)
  lines.push(`I stand down if ${spec.standDown[0].charAt(0).toLowerCase()}${spec.standDown[0].slice(1)} That is for the validator and for you to decide, not for me.`)
  if (sampled) lines.push('I read a sample, so a line outside the sample was not seen by me.')
  return lines.join('\n')
}

/**
 * Turn a specialist's hits into hypotheses. Importance ordering is impact first, then how cheap
 * the check is — the "impact first" and "5-minute rule" ordering principles, applied to the
 * order a user reads the list in.
 */
function hypothesesFor(spec: Specialist, hits: LineHit[], location: string, material: string): Hypothesis[] {
  return hits.map(h => {
    const key = candidateKey('local', location, h.line, spec.id)
    return {
      id: nanoid(),
      specialist: spec.id,
      key,
      title: `${spec.name}: ${h.label} at ${location.split(/[\\/]/).pop()}:${h.line}`,
      location,
      line: h.line,
      excerpt: h.excerpt,
      argument: `${h.why}. ${spec.looksFor[0]}`,
      ifTrue: spec.wouldConfirm[0] ?? 'It would need an observable on your own copy.',
      impact: impactFor(spec.id, h.label),
      state: 'hypothesis' as const,
      validation: {
        outcome: 'cannot-confirm' as const,
        observable: null,
        observableAt: null,
        wouldConfirm: spec.wouldConfirm,
        why: 'not yet validated',
        check: 'not yet run',
      },
      seenBefore: false,
      firstSeen: null,
    }
  })
}

/** A first-pass severity, deliberately conservative, and clearly labelled as a first pass. */
function impactFor(id: SpecialistId, label: string): Hypothesis['impact'] {
  if (id === 'rce') return 'critical'
  if (id === 'sqli') return 'critical'
  if (id === 'idor') return 'high'
  if (id === 'auth') return 'high'
  if (id === 'ssrf') return 'high'
  if (id === 'xss') return label.includes('admin') ? 'high' : 'medium'
  if (id === 'secrets') return 'high'
  if (id === 'integrity') return 'high'
  if (id === 'pii') return 'medium'
  if (id === 'logic') return 'medium'
  if (id === 'xxe' || id === 'ssti') return 'high'
  if (id === 'redirect') return 'low'
  if (id === 'enumeration') return 'low'
  if (id === 'recon') return 'low'
  return 'medium'
}

export interface RunOptions {
  /** The material to review, already read by the caller. */
  text: string
  /** Where it came from: a file path or "page description". */
  location: string
  /** `code_audit` for a local source file, `web` for a pasted page description. */
  material: 'code_audit' | 'web'
  /** Optional marker to sample around. */
  marker?: string
  /** Restrict to some specialists. */
  specialists?: SpecialistId[]
  /** Record against this program in memory. */
  programId?: string
  programName?: string
}

/**
 * Review material. Pure apart from the memory writes, which are local files.
 *
 * Note the absence of any async work: there is no await in this function because there is
 * nothing here that could wait on a network. That is deliberate — a review that cannot wait
 * cannot be waiting on a target.
 */
export function runReview(opts: RunOptions): ReviewRun {
  const startedAt = new Date().toISOString()
  const sample = sampleText(opts.text, { marker: opts.marker })
  const chosen = opts.specialists?.length
    ? SPECIALISTS.filter(s => opts.specialists!.includes(s.id))
    : SPECIALISTS

  const reviews: SpecialistReview[] = []
  const allHypotheses: Hypothesis[] = []

  for (const spec of chosen) {
    const sampleHits = hitsFor(spec, sample.text)
    // A hit line is a line of the SAMPLE. Translate it to the original file's line, and drop any
    // hit that landed on a gap marker (line 0), which the specialist never actually saw.
    const originalLines = opts.text.split(/\r?\n/)
    const hits = sampleHits
      .map(h => {
        const originalLine = sample.lineMap[h.line - 1] ?? 0
        if (!originalLine) return null
        const text = (originalLines[originalLine - 1] ?? '').trim().slice(0, 300)
        return text ? { ...h, line: originalLine, excerpt: text } : null
      })
      .filter((h): h is LineHit => h !== null)
    reviews.push({
      specialist: spec.id,
      name: spec.name,
      quiet: hits.length === 0,
      reasoning: reasoningFor(spec, hits, opts.material, sample.sampled),
      hits,
      material: opts.material,
      budget: hits.length ? 'stopped at six lines, which is enough to argue from' : 'read the whole sample once',
    })
    allHypotheses.push(...hypothesesFor(spec, hits, opts.location, opts.text))
  }

  // De-duplicate by location plus class before anything is shown.
  const { unique, merged } = dedupe(allHypotheses)

  // Validate every survivor independently, and remember each outcome.
  const validated = unique.map(h => {
    const prior = opts.programId ? alreadySettled(h.key) : null
    const v = applyValidation(h, opts.text)
    const withPrior: Hypothesis = {
      ...v,
      seenBefore: Boolean(prior),
      firstSeen: prior?.firstSeen ?? null,
    }
    if (opts.programId) {
      remember({
        key: h.key,
        programId: opts.programId,
        programName: opts.programName ?? '',
        specialist: h.specialist,
        title: h.title,
        location: h.location,
        outcome: withPrior.state === 'hypothesis' ? 'raised' : 'dropped',
        reason: v.validation.outcome === 'confirmed-observable'
          ? `observable present: ${(v.validation.observable ?? '').slice(0, 160)}`
          : v.validation.why.slice(0, 200),
      })
    }
    return withPrior
  })

  const finishedAt = new Date().toISOString()
  const confirmed = validated.filter(h => h.state === 'hypothesis').length
  const dropped = validated.length - confirmed

  return {
    id: nanoid(),
    startedAt,
    finishedAt,
    read: opts.location,
    bytes: Buffer.byteLength(opts.text, 'utf8'),
    sample: {
      sampled: sample.sampled,
      originalChars: sample.originalChars,
      kept: sample.kept.map(k => `${k.region} (${k.chars} chars)`),
      note: sample.note,
    },
    modelSecondOpinion: {
      used: false,
      model: null,
      note: 'Deterministic review only. The specialists are pattern-driven readers with written reasoning; no model was asked, so nothing was invented and nothing was sent anywhere.',
    },
    reviews,
    hypotheses: validated,
    guarantee: [
      `${chosen.length} specialists read this material; ${reviews.filter(r => r.quiet).length} of them had nothing to argue about.`,
      `${validated.length} candidate(s) survived de-duplication${merged ? ` (${merged} duplicate(s) merged)` : ''}.`,
      `${confirmed} had a confirming observable present; ${dropped} could not be confirmed from what we have and were dropped.`,
      'Nothing in this review contacted a target. There is no network client in the review code, and the run sends nothing.',
    ].join(' '),
  }
}

/* ─────────────────── reading one file the user named ─────────────────── */

const MAX_FILE_BYTES = 2_000_000
const READABLE_EXT = new Set(['.php', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.htm', '.css', '.xml', '.yml', '.yaml', '.md', '.txt', '.sql', '.sh', '.py'])

/** Refuse anything that is not a regular file inside the folder the user pointed at. */
export function assertReadable(root: string, target: string): { ok: true; rel: string; size: number } | { ok: false; reason: string } {
  let realRoot: string, realTarget: string
  try { realRoot = fs.realpathSync(root) } catch { return { ok: false, reason: `the folder ${root} cannot be read` } }
  try { realTarget = fs.realpathSync(target) } catch { return { ok: false, reason: `the file ${target} does not exist` } }
  const relToRoot = path.relative(realRoot, realTarget)
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return { ok: false, reason: `${target} is outside the folder you pointed Goga at (${root}). Nothing outside it is read.` }
  let stat: fs.Stats
  try { stat = fs.statSync(realTarget) } catch { return { ok: false, reason: `${target} cannot be read` } }
  if (!stat.isFile()) return { ok: false, reason: `${target} is not a regular file` }
  if (stat.size > MAX_FILE_BYTES) return { ok: false, reason: `${target} is ${(stat.size / 1_048_576).toFixed(1)} MB — larger than the 2 MB a review reads` }
  const ext = path.extname(realTarget).toLowerCase()
  if (ext && !READABLE_EXT.has(ext)) return { ok: false, reason: `${ext} is not a text format a reviewer can read` }
  return { ok: true, rel: relToRoot.split(path.sep).join('/'), size: stat.size }
}

export function readForReview(root: string, target: string): { rel: string; text: string; size: number } {
  const check = assertReadable(root, target)
  if (!check.ok) throw new Error(check.reason)
  const text = fs.readFileSync(target, 'utf8')
  return { rel: check.rel, text, size: Buffer.byteLength(text, 'utf8') }
}

/**
 * Index a local source tree: a bounded list of readable files, plus a few facts worth knowing
 * about it (which WordPress version, whether a config exists). Read-only, and bounded so it
 * cannot turn into a tour of the whole disk.
 */
export function indexLocalTarget(root: string, limit = 5000): { files: string[]; findings: string[] } {
  const files: string[] = []
  const findings: string[] = []
  const skip = new Set(['.git', 'node_modules', 'vendor', '.svn', 'dist', 'build', '__pycache__'])
  const walk = (dir: string, depth: number) => {
    if (files.length >= limit || depth > 12) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (files.length >= limit) return
      if (skip.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile() && READABLE_EXT.has(path.extname(e.name).toLowerCase())) {
        files.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  walk(root, 0)
  findings.push(`${files.length} readable text file(s) found${files.length >= limit ? ` (stopped at the ${limit} limit)` : ''}.`)

  const versionFile = path.join(root, 'wp-includes', 'version.php')
  try {
    const v = fs.readFileSync(versionFile, 'utf8')
    const m = /\$wp_version\s*=\s*'([^']+)'/.exec(v)
    if (m) findings.push(`WordPress core version ${m[1]}, read from wp-includes/version.php.`)
  } catch { /* not a WordPress tree, or unreadable */ }

  if (!files.length) findings.push('No readable files were found. Point Goga at the folder that holds the extracted copy.')
  return { files, findings }
}
