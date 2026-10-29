import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { SecurityWorkspaceService } from './securityWorkspace'
import { repoFolder } from './securityCode'

// The local brain, asked about a review, invents files, endpoints and findings that
// sound right for "a bounty". A report built on them gets the user rejected, so every
// reply in security mode is checked against the real copy before it is shown.

export const codeRoot = () => path.join(app.getPath('userData'), 'security-code')

const FILE_LIKE = /(?<![\w/:.-])((?:[\w.-]+\/)*[\w-][\w.-]*\.(?:go|py|js|mjs|ts|tsx|jsx|rb|php|java|kt|rs|c|h|cpp|cs|sh|bash|zsh|json|ya?ml|toml|conf|ini|lua|sql))(?![\w/])/g
const REPO_PATH = /(?<![\w/:.-])((?:bin|install|config|default|migrations|etc|shell|applications|themes|scripts|test|agents)\/[\w./-]*[\w-])(?![\w/])/g
const ENDPOINT = /(?<![\w.])(\/api\/[\w/{}:-]+)/g
const CLAIMS_PROGRESS = /\bI(?:['’]ve| have| am|['’]m)?\s+(?:now\s+|just\s+|already\s+)?(fetched|cloned|copied|scanned|found|completed|drafted|initiat\w*|start\w*|begin\w*|review\w*|analy[sz]\w*|identified|prepared)\b/i

function repoFiles(folder: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { out.push(path.relative(folder, full).split(path.sep).join('/') + '/'); walk(full) }
      else out.push(path.relative(folder, full).split(path.sep).join('/'))
    }
  }
  walk(folder)
  return out
}

/** Files, folders and endpoints `reply` names that are not in the copy at `folder`. */
export function unknownNames(reply: string, folder: string): string[] {
  const files = repoFiles(folder)
  const exists = (name: string) => {
    const clean = name.replace(/^\.?\//, '').replace(/\/$/, '')
    return files.some(f => { const g = f.replace(/\/$/, ''); return g === clean || g.endsWith('/' + clean) })
  }
  const named = new Set<string>()
  for (const re of [FILE_LIKE, REPO_PATH]) for (const m of reply.matchAll(re)) if (!/^https?:/.test(m[1])) named.add(m[1])
  const missing = [...named].filter(n => !exists(n))
  // A web endpoint can only come from code that serves one; it is never a file to look up.
  for (const m of reply.matchAll(ENDPOINT)) if (!files.some(f => /\.(go|py|js|ts|rb|php|java|kt|rs|cs)$/.test(f))) missing.push(m[1])
  return [...new Set(missing)]
}

/** `reply` with a warning added when, in security mode, it names things the code does not have
 *  or claims review progress that no tool made. `usedTools` is false for a chat answer. */
export function groundSecurityReply(reply: string, usedTools: boolean): string {
  const security = SecurityWorkspaceService.getInstance()
  const ws = security.getActive()
  if (!ws || !reply) return reply
  const repo = security.codeRepos(ws)[0]
  const notes: string[] = []
  const folder = repo ? repoFolder(codeRoot(), ws.id, repo) : ''
  if (folder && fs.existsSync(folder)) {
    const missing = unknownNames(reply, folder)
    if (missing.length) notes.push(`These are not in the copy of ${repo}: ${missing.slice(0, 8).map(m => `\`${m}\``).join(', ')}. That part was made up, not read from the code. Do not put it in a report.`)
  }
  if (!usedTools && CLAIMS_PROGRESS.test(reply)) notes.push('This answer came from chat, not from Goga\'s tools: nothing was fetched, scanned or verified in it. To really review the code, ask: "review the repository for the bounty".')
  return notes.length ? `${reply}\n\n⚠️ Goga's check: ${notes.join(' ')}` : reply
}
