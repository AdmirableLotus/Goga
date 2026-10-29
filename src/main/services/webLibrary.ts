import fs from 'fs'
import os from 'os'
import path from 'path'

// Bring a document in from the web so Goga can read it: a direct PDF/EPUB/TXT link
// is downloaded into a temp file for the Library to ingest. Listing a GitHub repo's
// documents is metadata only.

const MAX_BYTES = 80 * 1024 * 1024   // 80 MB — big enough for a scanned book
const DOC_EXT = /\.(pdf|epub|txt)$/i

export interface RepoDoc { name: string; path: string; sizeBytes: number; downloadUrl: string }

/** owner/repo from a github.com URL (or "owner/repo"), else null. */
export function githubRepoRef(input: string): { owner: string; repo: string } | null {
  const m = String(input ?? '').trim().match(/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git|\/.*)?$/i)
  return m && m[2] !== '.' && m[2] !== '..' ? { owner: m[1], repo: m[2] } : null
}

/** The PDF/EPUB/TXT files in a public GitHub repo (names and sizes only). */
export async function githubDocs(repoUrl: string, signal?: AbortSignal): Promise<RepoDoc[]> {
  const ref = githubRepoRef(repoUrl)
  if (!ref) throw new Error('Give a GitHub repository as https://github.com/owner/name.')
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Goga-Library' }
  const meta = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, { headers, signal })
  if (!meta.ok) throw new Error(`GitHub returned HTTP ${meta.status} for that repository.`)
  const branch = ((await meta.json()) as { default_branch?: string }).default_branch || 'main'
  const tree = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${branch}?recursive=1`, { headers, signal })
  if (!tree.ok) throw new Error(`Could not list the repository (HTTP ${tree.status}).`)
  const entries = ((await tree.json()) as { tree?: Array<{ path: string; type: string; size?: number }> }).tree ?? []
  return entries
    .filter(e => e.type === 'blob' && DOC_EXT.test(e.path))
    .map(e => ({
      name: e.path.split('/').pop() || e.path,
      path: e.path,
      sizeBytes: e.size ?? 0,
      downloadUrl: `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${branch}/${e.path.split('/').map(encodeURIComponent).join('/')}`,
    }))
}

/** A github.com/.../blob/... page URL rewritten to its raw file URL; otherwise unchanged. */
export function rawGithubUrl(url: string): string {
  const m = String(url).match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i)
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : String(url)
}

/** Download a PDF/EPUB/TXT from an https URL to a temp file; returns its path. */
export async function downloadDocument(url: string, signal?: AbortSignal): Promise<string> {
  let parsed: URL
  // A GitHub page link points at HTML; turn it into the raw file link first.
  try { parsed = new URL(rawGithubUrl(String(url))) } catch { throw new Error('That is not a valid URL.') }
  if (parsed.protocol !== 'https:') throw new Error('Only https links are allowed.')
  const res = await fetch(parsed, { redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000), headers: { 'User-Agent': 'Goga-Library' } })
  if (!res.ok || !res.body) throw new Error(`The link returned HTTP ${res.status}.`)
  const type = (res.headers.get('content-type') || '').toLowerCase()
  const nameFromUrl = decodeURIComponent(parsed.pathname.split('/').pop() || '')
  let ext = (nameFromUrl.match(DOC_EXT)?.[1] || '').toLowerCase()
  if (!ext) {
    if (type.includes('pdf')) ext = 'pdf'
    else if (type.includes('epub')) ext = 'epub'
    else if (type.includes('text/plain')) ext = 'txt'
    else throw new Error('That link is not a PDF, EPUB or TXT document.')
  }
  const safeBase = (nameFromUrl.replace(DOC_EXT, '') || 'document').replace(/[^A-Za-z0-9 ._-]/g, '_').slice(0, 120) || 'document'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-weblib-'))
  const file = path.join(dir, `${safeBase}.${ext}`)
  const reader = res.body.getReader()
  const out = fs.createWriteStream(file)
  let size = 0
  let first: Buffer | null = null
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      if (!first) first = chunk
      size += chunk.length
      if (size > MAX_BYTES) { out.destroy(); throw new Error('That document is larger than the 80 MB limit.') }
      out.write(chunk)
    }
  } finally { out.end(); reader.releaseLock() }
  // Reject an HTML error page saved under a .pdf name — the usual cause of "Invalid PDF structure".
  const head = (first ?? Buffer.alloc(0)).subarray(0, 64)
  const looksHtml = /^\s*(<!doctype|<html|<\?xml)/i.test(head.toString('utf8'))
  if (ext === 'pdf' && head.subarray(0, 4).toString() !== '%PDF') {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
    throw new Error(looksHtml ? 'That link returned a web page, not a PDF. Use the direct raw file link (library.listRepo gives the right links).' : 'That file is not a valid PDF.')
  }
  if (ext === 'epub' && head.subarray(0, 2).toString() !== 'PK') {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
    throw new Error('That file is not a valid EPUB.')
  }
  return file
}
