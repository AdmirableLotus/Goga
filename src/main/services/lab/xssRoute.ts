import fs from 'fs'
import path from 'path'
import { CONTEXT_LABEL, readSinks } from './wpXss'

/**
 * Choosing the route for an XSS request.
 *
 * "do one xss bounty for me" reached `lab.scan` in a live run, three times, against a target id
 * that was never declared. Scanning is not how an XSS is proven: a scan says a host is reachable
 * and its headers look a certain way; it never shows a value reaching the DOM unescaped. The
 * route that can produce evidence is the local WordPress path — a specialist reads the source, the
 * validator states the observable, the payload is dispatched at a reproduction on 127.0.0.1, and
 * execution is confirmed against a benign control.
 *
 * This module decides that route and says why, so the page can show which route was taken. It
 * reads the file system only to check whether a local tree is there; it sends nothing.
 */

/** A request that asks for an XSS to be found or proven. */
export const XSS_REQUEST = /\b(?:do|find|prove|get|hunt|run|work (?:on|an?)|attempt)\b[^.!?\n]{0,40}\b(?:xss|cross[- ]site scripting)\b|\b(?:xss|cross[- ]site scripting)\b[^.!?\n]{0,30}\b(?:bounty|bounties|finding|bug|for me)\b/i

export type XssRouteId = 'wp-local' | 'no-tree' | 'no-sink-file'

export interface XssRouteDecision {
  route: XssRouteId
  /** The folder the local path would run against, when one was found. */
  root: string | null
  /** The file that path would read first, when one was found. */
  file: string | null
  /** Why this route, in the user's words. Shown on screen. */
  why: string
  /** What the caller should do next, when the route is not runnable. */
  next: string
}

/** Files worth trying first: each has a known echo of request data in core WordPress. */
const PREFERRED_FILES = [
  'wp-includes/blocks/legacy-widget.php',
  'wp-admin/includes/template.php',
  'wp-includes/class-wp-customize-manager.php',
  'wp-admin/edit-tag-form.php',
]

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/**
 * Pick a file to read in a tree.
 *
 * The preferred list first, since those are known echoes; otherwise any PHP file the XSS
 * specialist is likely to have something to say about, found in a bounded walk. Nothing here
 * opens a file — `readSinks` does, and it is the specialist that decides.
 */
export function pickSinkFile(root: string): string | null {
  for (const rel of PREFERRED_FILES) {
    if (isFile(path.join(root, rel))) return rel
  }
  let visited = 0
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 3 || visited > 600) return null
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const entry of entries) {
      if (visited++ > 600) return null
      if (entry.isFile() && /\.php$/i.test(entry.name)) {
        return path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/')
      }
      if (entry.isDirectory() && !/^(node_modules|\.git|dist|build)$/i.test(entry.name)) {
        const found = walk(path.join(dir, entry.name), depth + 1)
        if (found) return found
      }
    }
    return null
  }
  return walk(root, 0)
}

/**
 * Decide where an XSS request goes.
 *
 * `roots` is what the caller could find — the remembered folder first, then anything discovered
 * in the user's workspace. Exactly one usable tree is a decision; zero or several is not, and the
 * caller is told what to say to resolve it.
 */
export function decideXssRoute(roots: string[]): XssRouteDecision {
  const usable = roots.filter(r => {
    try { return fs.statSync(r).isDirectory() } catch { return false }
  })
  if (usable.length === 1) {
    const root = usable[0]
    const file = pickSinkFile(root)
    if (!file) {
      return {
        route: 'no-sink-file',
        root, file: null,
        why: `I found a local copy at ${root}, but no PHP file in it to read.`,
        next: `Tell me a file to read in it, for example "review wp-admin/edit-tag-form.php in ${root}".`,
      }
    }
    return {
      route: 'wp-local', root, file,
      why: 'The local WordPress path is the one that can produce evidence: a specialist reads the source, the validator '
        + 'states the observable, the payload is sent at a reproduction on this machine, and execution is confirmed by the '
        + 'page title against a benign control. A scanner cannot show any of that, so I did not start one.',
      next: `Run the path against ${path.join(root, file)}.`,
    }
  }
  if (usable.length > 1) {
    return {
      route: 'no-tree', root: null, file: null,
      why: `I found ${usable.length} local copies (${usable.join('; ')}), so I will not guess which one to read.`,
      next: 'Tell me which one to use: "use C:\\path\\to\\wordpress as my local copy".',
    }
  }
  return {
    route: 'no-tree', root: null, file: null,
    why: 'There is no local source tree to read on this machine, and an XSS cannot be proven from a scan.',
    next: 'Put a copy of the source on this machine and tell me its folder, or declare a host you own to test against. '
      + 'A public bounty target also needs an imported program first, because only its published scope can authorise a request.',
  }
}

/** The sink the path will argue about, for the page to show before the run starts. */
export function previewSink(root: string, file: string): { file: string; line: number; context: string; excerpt: string } | null {
  try {
    const reading = readSinks(root, file)
    const first = reading.candidates[0]
    if (!first) return null
    return { file: reading.file, line: first.line, context: CONTEXT_LABEL[first.context], excerpt: first.excerpt }
  } catch { return null }
}
