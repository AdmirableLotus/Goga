/**
 * A small unified diff, so a proposed change can be read before it is approved.
 *
 * This is not a general-purpose diff library: it handles the one job it has, which is
 * showing a reviewer what a single file's change does, with a little context around it.
 * A bad diff would be worse than none — it is the thing the user approves — so the tests
 * cover insertion, deletion, replacement and the no-change case.
 */

const CONTEXT = 3

type LineOp = { kind: ' ' | '-' | '+'; text: string }

/**
 * Longest-common-subsequence table is O(n·m); a whole-file replacement is a perfectly
 * honest fallback and far cheaper. Real edits here are small, so this only trips on a
 * pathological rewrite — and then the diff says so plainly instead of guessing.
 */
const MAX_LINES = 4000

function ops(before: string[], after: string[]): LineOp[] {
  if (before.length > MAX_LINES || after.length > MAX_LINES) {
    return [
      ...before.map(text => ({ kind: '-' as const, text })),
      ...after.map(text => ({ kind: '+' as const, text })),
    ]
  }
  const n = before.length, m = after.length
  // DP over (n+1)×(m+1). Sizes are bounded above, so this stays modest.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: LineOp[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) { out.push({ kind: ' ', text: before[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: '-', text: before[i] }); i++ }
    else { out.push({ kind: '+', text: after[j] }); j++ }
  }
  while (i < n) { out.push({ kind: '-', text: before[i] }); i++ }
  while (j < m) { out.push({ kind: '+', text: after[j] }); j++ }
  return out
}

/** Split preserving nothing: a trailing newline is not a line of its own. */
function lines(text: string): string[] {
  const normal = String(text ?? '').replace(/\r\n/g, '\n')
  if (normal === '') return []
  const parts = normal.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

/**
 * A unified diff of one file, with hunk headers and context.
 *
 * Returns an empty string when the two bodies are identical, so a no-op change is visible
 * as a no-op rather than as a diff that says nothing.
 */
export function unifiedDiff(before: string, after: string, filePath: string): string {
  const a = lines(before), b = lines(after)
  if (a.length === 0 && b.length === 0) return ''
  const all = ops(a, b)
  if (all.every(o => o.kind === ' ')) return ''

  // Group the ops into hunks with context around each run of changes.
  const changed = all.map(o => o.kind !== ' ')
  const hunks: { start: number; end: number }[] = []
  for (let i = 0; i < all.length; i++) {
    if (!changed[i]) continue
    const start = Math.max(0, i - CONTEXT)
    const end = Math.min(all.length - 1, i + CONTEXT)
    const last = hunks[hunks.length - 1]
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end)
    else hunks.push({ start, end })
  }

  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`]
  for (const hunk of hunks) {
    // Line numbers are counted in the *original* and *new* files separately.
    let aLine = 1, bLine = 1
    for (let i = 0; i < hunk.start; i++) {
      if (all[i].kind !== '+') aLine++
      if (all[i].kind !== '-') bLine++
    }
    const body: string[] = []
    let aCount = 0, bCount = 0
    for (let i = hunk.start; i <= hunk.end; i++) {
      const op = all[i]
      body.push(`${op.kind}${op.text}`)
      if (op.kind !== '+') aCount++
      if (op.kind !== '-') bCount++
    }
    const aStart = aCount === 0 ? aLine - 1 : aLine
    const bStart = bCount === 0 ? bLine - 1 : bLine
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`)
    out.push(...body)
  }
  return out.join('\n')
}

/** A few lines of the change in words, for a chat reply that must stay short. */
export function summariseDiff(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}
