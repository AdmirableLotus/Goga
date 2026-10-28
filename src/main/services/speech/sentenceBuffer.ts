/**
 * Cuts a reply that is still being written into whole sentences, so Goga can start
 * speaking the first one while the brain writes the rest.
 */

// Words whose trailing dot does not end a sentence.
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'approx', 'no'])
const MIN_SENTENCE_CHARS = 3

export class SentenceBuffer {
  private text = ''
  private carry = ''   // a piece too short to say alone ("!", "Ok.") — joins the next sentence

  /** Add a streamed chunk; returns the sentences it completed, in order. */
  push(chunk: string): string[] {
    this.text += chunk
    const out: string[] = []
    let cut: number
    while ((cut = this.nextBoundary()) > 0) {
      const sentence = [this.carry, this.text.slice(0, cut).trim()].filter(Boolean).join(' ')
      this.text = this.text.slice(cut)
      if (sentence.length < MIN_SENTENCE_CHARS) { this.carry = sentence; continue }
      this.carry = ''
      out.push(sentence)
    }
    return out
  }

  /** Whatever is left once the reply is complete. */
  flush(): string {
    const rest = [this.carry, this.text.trim()].filter(Boolean).join(' ')
    this.text = ''
    this.carry = ''
    return rest
  }

  /** Index just past the first sentence end, or -1. Never cuts inside a code block. */
  private nextBoundary(): number {
    const t = this.text
    let inCode = false
    for (let i = 0; i < t.length; i++) {
      if (t.startsWith('```', i)) { inCode = !inCode; i += 2; continue }
      if (inCode) continue
      const c = t[i]
      if (c === '\n') { if (t.slice(0, i).trim()) return i + 1; continue }
      if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue
      // Run of end punctuation and closing quotes/brackets, then whitespace.
      let j = i + 1
      while (j < t.length && /[.!?…"'”’)\]]/.test(t[j])) j++
      if (j >= t.length || !/\s/.test(t[j])) { i = j - 1; continue }
      if (c === '.' && this.isAbbreviationOrNumber(t.slice(0, i))) { i = j - 1; continue }
      return j
    }
    return -1
  }

  private isAbbreviationOrNumber(before: string): boolean {
    const word = before.match(/(\S+)$/)?.[1] ?? ''
    if (/^\d+$/.test(word)) return true                       // "1." in a numbered list
    if (/^[A-Z]$/.test(word)) return true                     // an initial: "J. Smith"
    return ABBREVIATIONS.has(word.toLowerCase().replace(/^[("']+/, ''))
  }
}
