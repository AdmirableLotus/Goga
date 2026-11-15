import fs from 'fs'
import path from 'path'
import { app } from 'electron'

/**
 * The folder a local code review runs against.
 *
 * "review wp-includes/class-wp-http.php in the local WordPress copy" names a file but not a
 * folder. Rather than guess one, Goga remembers the folder the user pointed at once
 * ("use C:\src\wordpress as my local copy") and uses it from then on.
 *
 * When nothing has been remembered, it looks for a WordPress tree in the user's own OS3
 * workspace — a bounded search, at most four levels deep, for a folder named `wordpress` that
 * actually holds `wp-includes/version.php`. If it finds exactly one it uses it and says which;
 * if it finds none or several it says so and asks, rather than picking one.
 */

function file(): string | null {
  try { return path.join(app.getPath('userData'), 'local-target.json') } catch { return null }
}

const SOURCE_FILE = /\.(php|js|mjs|cjs|ts|tsx|jsx|py|rb|go|java|cs|c|h|cpp|hpp|rs|kt|swift|sql|sh|ps1|json|xml|html|vue|svelte|txt|md)$/i

/**
 * The remembered folder, if it is still a usable folder.
 *
 * A root is only returned when it is a path that exists and is a directory. An earlier
 * version of the parser could store a FILE as the root ("/class-wp-http.php"), and a value
 * already on disk would keep failing every review after the parser was fixed — which is
 * exactly what happened on the live run. So the check is on the way out, not only on the way
 * in: a stored value that is a file, or that no longer exists, is ignored and the caller falls
 * back to asking or to discovery.
 */
export function rememberedRoot(): string | null {
  const f = file()
  if (!f) return null
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as { root?: unknown }
    const root = typeof raw.root === 'string' ? raw.root.trim() : ''
    if (!root) return null
    if (SOURCE_FILE.test(root)) return null
    try { if (!fs.statSync(root).isDirectory()) return null } catch { return null }
    return root
  } catch { return null }
}

export function rememberRoot(root: string): string {
  const f = file()
  const clean = String(root ?? '').trim().replace(/[\\/]+$/, '')
  // Never remember a source file as a folder. The caller gets the bad value back and its
  // tool call fails loudly, which is better than every later review pointing at nothing.
  if (SOURCE_FILE.test(clean)) return clean
  if (f) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, JSON.stringify({ root: clean, setAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
    } catch { /* the review still works for this turn; it just will not be remembered */ }
  }
  return clean
}

/** A WordPress tree is one that has wp-includes/version.php. */
function isWordPressTree(dir: string): boolean {
  try { return fs.existsSync(path.join(dir, 'wp-includes', 'version.php')) } catch { return false }
}

/**
 * Find a local WordPress copy under the user's OS3 workspace.
 *
 * Bounded on purpose: four levels, a cap on directories visited, and it only ever looks under
 * the user's own workspace root. It returns every match so the caller can refuse to choose
 * between two.
 */
export function findWordPressCopies(limit = 4000): string[] {
  const roots: string[] = []
  try { roots.push(path.join(app.getPath('home'), 'OS3')) } catch { /* no home */ }
  const found: string[] = []
  let visited = 0

  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || visited > limit) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (visited++ > limit) return
      if (!entry.isDirectory()) continue
      // Skip the folders that are never a source tree and are expensive to walk.
      if (/^(node_modules|\.git|dist|build|out|\.cache|AppData)$/i.test(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (isWordPressTree(full)) { found.push(full); continue }
      walk(full, depth + 1)
    }
  }

  for (const root of roots) {
    try { if (fs.existsSync(root)) walk(root, 0) } catch { /* unreadable */ }
  }
  return found
}
