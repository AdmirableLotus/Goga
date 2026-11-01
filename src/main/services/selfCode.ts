import fs from 'fs'
import path from 'path'

/**
 * Self-reading: Goga can look through his own source code — search it, read it, list it —
 * so he can explain how he works and see where a missing ability would go. Read-only, and
 * only inside the app's src folder (nothing outside it, no settings, keys or user data).
 */

const SOURCE_EXT = /\.(ts|tsx)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])
const MAX_READ_LINES = 300

export interface SourceHit { file: string; line: number; text: string }

/** Every source file under root, as paths relative to it with forward slashes. */
export function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)) }
      else if (SOURCE_EXT.test(e.name)) out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

/** A path inside root, or an error — never a way out of the source folder. */
export function insideRoot(root: string, rel: string): string {
  const full = path.resolve(root, String(rel ?? '').replace(/^src[\\/]/, ''))
  const r = path.resolve(root)
  if (full !== r && !full.startsWith(r + path.sep)) throw new Error('that path is outside my source code')
  return full
}

/** Lines that contain the query (case-insensitive, plain text — not a regex). */
export function searchSource(root: string, query: string, max = 30): SourceHit[] {
  const q = String(query ?? '').trim().toLowerCase()
  if (q.length < 2) throw new Error('give at least two characters to search for')
  const hits: SourceHit[] = []
  // Tests repeat the names they test; the real code comes first.
  for (const file of sourceFiles(root).filter(f => !f.includes('__tests__'))) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length && hits.length < max; i++) {
      if (lines[i].toLowerCase().includes(q)) hits.push({ file, line: i + 1, text: lines[i].trim().slice(0, 200) })
    }
    if (hits.length >= max) break
  }
  return hits
}

/** Numbered lines from one file. */
export function readSource(root: string, rel: string, start = 1, count = 150): { file: string; from: number; to: number; total: number; text: string } {
  const full = insideRoot(root, rel)
  if (!SOURCE_EXT.test(full)) throw new Error('I only read my own .ts/.tsx source files')
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/)
  const from = Math.max(1, Math.floor(start) || 1)
  const to = Math.min(lines.length, from + Math.min(Math.max(1, Math.floor(count) || 150), MAX_READ_LINES) - 1)
  return {
    file: path.relative(root, full).split(path.sep).join('/'), from, to, total: lines.length,
    text: lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n'),
  }
}

/** Folders with their files and sizes — a map of Goga. */
export function sourceOverview(root: string): string {
  const byDir = new Map<string, string[]>()
  let totalLines = 0
  for (const file of sourceFiles(root)) {
    if (file.includes('__tests__')) continue
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n').length
    totalLines += lines
    const dir = path.posix.dirname(file)
    byDir.set(dir, [...(byDir.get(dir) ?? []), `${path.posix.basename(file)} (${lines})`])
  }
  const parts = [...byDir.entries()].map(([dir, files]) => `${dir}/: ${files.join(', ')}`)
  return `My source code: ${[...byDir.values()].flat().length} files, about ${totalLines.toLocaleString('en-US')} lines (line counts in brackets).\n${parts.join('\n')}`
}

const STOP = new Set('the and you your how does do what why where when goga code source own work works working analyze analyse look explain tell about with that this from into can could would please show read yourself part file files'.split(' '))

/** Words worth searching the code for in a question about it. */
export function codeKeywords(question: string): string[] {
  const words = question.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w))
  return [...new Set(words)].slice(0, 6)
}

/**
 * The parts of Goga's code that best match a question: files ranked by how often the
 * question's words appear (a name match counts most), with their opening lines.
 */
export function codeContext(root: string, question: string, maxChars = 7000): { files: string[]; text: string } {
  const words = codeKeywords(question)
  if (!words.length) return { files: [], text: '' }
  const scored = sourceFiles(root).filter(f => !f.includes('__tests__')).map(file => {
    const body = fs.readFileSync(path.join(root, file), 'utf8').toLowerCase()
    const name = file.toLowerCase()
    let score = 0
    for (const w of words) {
      const stem = w.replace(/(ing|ers|er|es|s)$/, '')
      if (name.includes(stem)) score += 20
      score += Math.min(body.split(stem).length - 1, 15)
    }
    return { file, score }
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3)
  let text = ''
  const files: string[] = []
  for (const { file } of scored) {
    const room = maxChars - text.length
    if (room < 800) break
    const body = fs.readFileSync(path.join(root, file), 'utf8')
    text += `\n--- src/${file} ---\n${body.slice(0, Math.min(room - 100, 4000))}\n`
    files.push(`src/${file}`)
  }
  return { files, text }
}

/** Questions that ask Goga about his own code. */
export const SELF_CODE_QUESTION = /\b(your|goga'?s) (own )?(code|source(?: code)?|codebase|programming)\b|\bin your code\b|\banaly[sz]e (your ?self|your own)\b|\bhow (is|are) your \w+( \w+)? (built|programmed|coded|written)\b/i
