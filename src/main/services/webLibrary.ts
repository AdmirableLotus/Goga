import fs from 'fs'
import os from 'os'
import path from 'path'

// Bring a document in from the web so Goga can read it: a direct PDF/EPUB/TXT link
// is downloaded into a temp file for the Library to ingest. Listing a GitHub repo's
// documents is metadata only.

const MAX_BYTES = 80 * 1024 * 1024   // 80 MB — big enough for a scanned book
const DOC_EXT = /\.(pdf|epub|txt)$/i

export interface RepoDoc { name: string; path: string; sizeBytes: number; downloadUrl: string }

/**
 * "https://d2l.ai/ read and learn", "learn from https://…/book.pdf", "add this book https://…",
 * "read everything on this site and use it to work in trading".
 * "open https://… and read the article/comments" is not a book: it needs learn/study, a book
 * word, or an ask to read the whole thing (everything / all of it / the whole site).
 */
export function isLearnFromLink(text: string): boolean {
  return /https:\/\/\S+/.test(text)
    && (/\b(learn|study)\b/i.test(text)
      || /\b(read|import|add)\b[\s\S]*\b(book|library|pdf|epub|textbook)\b/i.test(text)
      || /\bread\b[\s\S]{0,40}\b(everything|all of it|it all|the whole|the entire)\b/i.test(text)
      // "go over all modules https://…", "go through every point on this link and learn"
      || /\b(go (?:over|through)|read|study|learn|cover)\b[\s\S]{0,60}\b(every|all|each)\b[\s\S]{0,20}\b(module|chapter|section|page|point|article|lesson|part|topic)s?\b/i.test(text))
}

/**
 * The book behind a web page: "https://d2l.ai/" links its PDF edition from the home page.
 * Prefers a document on the same site, then the plainest name (d2l-en.pdf over
 * d2l-en-mxnet.pdf). A direct document link is returned as it is.
 */
export function pickDocumentLink(pageUrl: string, html: string): string | null {
  const base = new URL(pageUrl)
  const links = [...html.matchAll(/href\s*=\s*["']([^"'#]+?\.(?:pdf|epub))(?:[?#][^"']*)?["']/gi)]
    .map(m => { try { return new URL(m[1], base) } catch { return null } })
    .filter((u): u is URL => !!u && u.protocol === 'https:')
  if (links.length === 0) return null
  const name = (u: URL) => u.pathname.split('/').pop() ?? ''
  links.sort((a, b) => Number(b.host === base.host) - Number(a.host === base.host) || name(a).length - name(b).length)
  return links[0].href
}

export async function findDocumentLink(url: string, signal?: AbortSignal): Promise<string> {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('That is not a valid URL.') }
  if (parsed.protocol !== 'https:') throw new Error('Only https links are allowed.')
  if (DOC_EXT.test(parsed.pathname) || /\.epub$/i.test(parsed.pathname)) return parsed.href
  const res = await fetch(parsed, { redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), headers: { 'User-Agent': 'Goga-Library' } })
  if (!res.ok) throw new Error(`The link returned HTTP ${res.status}.`)
  if (/pdf|epub/i.test(res.headers.get('content-type') ?? '')) return parsed.href
  const html = (await res.text()).slice(0, 3_000_000)
  const doc = pickDocumentLink(res.url || parsed.href, html)
  if (!doc) throw new Error("that link is a web page, not a single book file. I can't crawl a whole website or read it page by page — I study one document at a time. Send me a direct link to the file (ending in .pdf or .epub), or upload the file to me here, and I'll read it properly. Many course sites have a “Download PDF” button; that link is what I need.")
  return doc
}

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

/**
 * A download error that retrying cannot fix: a bad URL, a file over the size limit, or a file
 * whose contents are the wrong type. These are thrown as-is; anything else (a dropped
 * connection, an HTTP 5xx, a cut-off stream) is treated as transient and retried once.
 */
class PermanentDownloadError extends Error {}

/** Download a PDF/EPUB/TXT from an https URL to a temp file; returns its path. */
export async function downloadDocument(url: string, signal?: AbortSignal): Promise<string> {
  try {
    return await downloadOnce(url, signal)
  } catch (err) {
    if (err instanceof PermanentDownloadError || signal?.aborted) throw err
    // A transient hiccup (network reset, 5xx, cut-off stream): wait a moment and try once more.
    await new Promise<void>(resolve => setTimeout(resolve, 1500))
    return downloadOnce(url, signal)
  }
}

async function downloadOnce(url: string, signal?: AbortSignal): Promise<string> {
  let parsed: URL
  // A GitHub page link points at HTML; turn it into the raw file link first.
  try { parsed = new URL(rawGithubUrl(String(url))) } catch { throw new PermanentDownloadError('That is not a valid URL.') }
  if (parsed.protocol !== 'https:') throw new PermanentDownloadError('Only https links are allowed.')
  const res = await fetch(parsed, { redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000), headers: { 'User-Agent': 'Goga-Library' } })
  if (!res.ok || !res.body) throw new Error(`The link returned HTTP ${res.status}.`)
  const type = (res.headers.get('content-type') || '').toLowerCase()
  const nameFromUrl = decodeURIComponent(parsed.pathname.split('/').pop() || '')
  let ext = (nameFromUrl.match(DOC_EXT)?.[1] || '').toLowerCase()
  if (!ext) {
    if (type.includes('pdf')) ext = 'pdf'
    else if (type.includes('epub')) ext = 'epub'
    else if (type.includes('text/plain')) ext = 'txt'
    else throw new PermanentDownloadError('That link is not a PDF, EPUB or TXT document.')
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
      if (size > MAX_BYTES) { out.destroy(); throw new PermanentDownloadError('That document is larger than the 80 MB limit.') }
      if (!out.write(chunk)) await new Promise<void>(resolve => out.once('drain', () => resolve()))
    }
  } finally { reader.releaseLock() }
  // Wait until every byte is on disk: reading the file before this gave big books a cut-off
  // end ("Invalid PDF structure" on the 45 MB d2l.ai book; small files happened to finish in time).
  if (!out.destroyed) await new Promise<void>((resolve, reject) => { out.once('error', reject); out.end(() => resolve()) })
  // Reject an HTML error page saved under a .pdf name — the usual cause of "Invalid PDF structure".
  const head = (first ?? Buffer.alloc(0)).subarray(0, 64)
  const looksHtml = /^\s*(<!doctype|<html|<\?xml)/i.test(head.toString('utf8'))
  if (ext === 'pdf' && head.subarray(0, 4).toString() !== '%PDF') {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
    throw new PermanentDownloadError(looksHtml ? 'That link returned a web page, not a PDF. Use the direct raw file link (library.listRepo gives the right links).' : 'That file is not a valid PDF.')
  }
  if (ext === 'epub' && head.subarray(0, 2).toString() !== 'PK') {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
    throw new PermanentDownloadError('That file is not a valid EPUB.')
  }
  return file
}
