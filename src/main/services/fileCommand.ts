import { app } from 'electron'
import path from 'path'

// Turn "make a file called X with content Y" into a direct filesystem.write — reliable,
// instead of automating Notepad's GUI (which can fail to launch or find its window).

const DOC_EXT = /\.(txt|md|csv|json|log|text|ini|yaml|yml|xml|html?)$/i

function resolveDir(text: string): string {
  const m = text.match(/\b(documents|desktop|downloads)\b/i)
  try { return app.getPath((m ? m[1].toLowerCase() : 'documents') as 'documents') } catch { return process.cwd() }
}

/** {path, content} for a plain "write/create a text file" request, else null. */
export function parseFileWrite(task: string): { path: string; content: string } | null {
  const t = task.trim()
  if (t.length > 4000 || !/\b(make|create|write|save|put|new|generate)\b/i.test(t)) return null
  const fileM = t.match(/\b([\w.-]+\.(?:txt|md|csv|json|log|text|ini|ya?ml|xml|html?))\b/i)
  if (!fileM) return null
  const filename = path.basename(fileM[1])   // no directory traversal from the name
  if (!DOC_EXT.test(filename)) return null

  let content: string | null = null
  // 1. A quoted string that is not the filename — the clearest signal.
  for (const q of t.matchAll(/["'“”]([^"'“”]{0,4000})["'“”]/g)) {
    if (q[1].trim() && q[1].trim() !== filename) { content = q[1]; break }
  }
  // 2. "...with (the) content/text <rest>" or "that says <rest>" to the end.
  if (content === null) {
    const m = t.match(/(?:the content|content[:=]|with the text|with text|saying|that (?:says|reads))\s+(.+?)\s*$/i)
    if (m) content = m[1]
  }
  // 3. "...with <rest>" to the end (strip a location clause).
  if (content === null) {
    const m = t.match(/\bwith\s+(?:the\s+)?(.+?)\s*$/i)
    if (m) content = m[1].replace(/\s+in (?:my )?(documents|desktop|downloads).*$/i, '')
  }
  if (content === null) return null
  content = content.replace(/\s+in (?:my )?(documents|desktop|downloads)\b.*$/i, '').trim()

  return { path: path.join(resolveDir(t), filename), content }
}
