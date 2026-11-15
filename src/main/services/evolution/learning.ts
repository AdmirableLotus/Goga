import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { LearningNote, SkillRecord } from '../../../shared/evolution'
import { nanoid } from '../../utils/nanoid'

/**
 * The persistent learning layer.
 *
 * What the user taught, what worked, what failed and why, and notes from Goga's own code
 * work. Stored in one JSON file under the Goga user-data folder so it survives restarts,
 * and rendered into a short block that is injected into the planner prompt.
 */

interface Store {
  notes: LearningNote[]
  skills: SkillRecord[]
}

const MAX_NOTES = 400
const MAX_PROMPT_CHARS = 1800

function file(): string { return path.join(app.getPath('userData'), 'goga-learning.json') }

function load(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Store>
    return { notes: raw.notes ?? [], skills: raw.skills ?? [] }
  } catch { return { notes: [], skills: [] } }
}

function save(s: Store): void {
  const target = file()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(s, null, 2), { mode: 0o600 })
}

export function notes(): LearningNote[] { return load().notes }

/** Store one note. Identical text in the same kind is merged rather than duplicated. */
export function remember(kind: LearningNote['kind'], text: string, source: string): LearningNote {
  const clean = String(text ?? '').trim().slice(0, 1200)
  if (clean.length < 6) throw new Error('a learning note needs at least a few words')
  const s = load()
  const existing = s.notes.find(n => n.kind === kind && n.text.toLowerCase() === clean.toLowerCase())
  if (existing) { existing.used += 1; save(s); return existing }
  const note: LearningNote = { id: nanoid(), kind, text: clean, source: String(source ?? '').slice(0, 200), createdAt: new Date().toISOString(), used: 0 }
  s.notes = [...s.notes.slice(-(MAX_NOTES - 1)), note]
  save(s)
  return note
}

export function forgetNote(id: string): void {
  const s = load()
  s.notes = s.notes.filter(n => n.id !== id)
  save(s)
}

export function skills(): SkillRecord[] { return load().skills }

export function recordSkill(input: { name: string; whenToUse: string; steps: string[]; origin: string; tools?: string[] }): SkillRecord {
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('a skill needs a name')
  const steps = (input.steps ?? []).map(s => String(s).trim()).filter(Boolean)
  if (steps.length === 0) throw new Error('a skill needs at least one step')
  const s = load()
  const existing = s.skills.find(k => k.name.toLowerCase() === name.toLowerCase())
  if (existing) {
    existing.whenToUse = String(input.whenToUse ?? existing.whenToUse).slice(0, 400)
    existing.steps = steps
    existing.tools = input.tools ?? existing.tools
    save(s)
    return existing
  }
  const skill: SkillRecord = {
    id: nanoid(), name: name.slice(0, 80), whenToUse: String(input.whenToUse ?? '').slice(0, 400),
    steps: steps.slice(0, 20), origin: String(input.origin ?? '').slice(0, 200),
    createdAt: new Date().toISOString(), used: 0, tools: input.tools ?? [],
  }
  s.skills = [...s.skills, skill]
  save(s)
  return skill
}

export function deleteSkill(id: string): void {
  const s = load()
  s.skills = s.skills.filter(k => k.id !== id)
  save(s)
}

export function touchSkill(id: string): void {
  const s = load()
  const skill = s.skills.find(k => k.id === id)
  if (skill) { skill.used += 1; save(s) }
}

/**
 * The block injected into the planner prompt. Deliberately short: what was taught, what
 * failed and why, and the names of recorded skills — not their full text, which the model
 * can fetch with a tool when it matters.
 */
export function promptBlock(): string {
  const s = load()
  if (!s.notes.length && !s.skills.length) return ''
  const pick = (kind: LearningNote['kind'], n: number) => s.notes.filter(x => x.kind === kind).slice(-n).map(x => `- ${x.text}`)
  const parts = [
    s.notes.length ? 'What you have learned that still applies:' : '',
    ...pick('taught', 6),
    ...pick('worked', 4),
    ...pick('failed', 4),
    ...pick('code', 3),
    s.skills.length ? `Procedures you recorded as skills (call evolution.skill to read one): ${s.skills.slice(-8).map(k => k.name).join(', ')}` : '',
  ].filter(Boolean)
  const text = parts.join('\n')
  return text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}…` : text
}
