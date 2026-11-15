/**
 * Redaction for OSINT results.
 *
 * Everything that leaves the OSINT code — to the UI or into a model prompt — goes through
 * `redact()`. It removes, by pattern and in code rather than by instruction:
 *
 *   - passwords and password-like values ("password: hunter2", "pwd=…")
 *   - financial account numbers (card numbers that pass Luhn, IBANs, bank account lines)
 *   - government identifiers (US SSN, UK NI, passport/licence-shaped values)
 *   - health data (diagnosis/medication/allergy statements, and disability/medical labels)
 *
 * The counters are reported back so the UI can say "3 values removed" instead of silently
 * dropping something. Nothing is re-invented: a redacted value becomes `[redacted: kind]`.
 */

export interface RedactionHit { kind: string; count: number }

interface Rule { kind: string; match: RegExp; replace?: (m: string, ...groups: string[]) => string }

const PASSWORD_KEYS = /(?:pass(?:word|wd|phrase)?|pwd|secret|api[_-]?key|token|auth[_-]?key)\s*[:=]\s*("?)([^\s"'<>,;]{3,})\1/gi

interface Luhnish { digits: string; ok: boolean }

/** Luhn check, so an order number is not mistaken for a card. */
export function luhn(digits: string): boolean {
  const clean = digits.replace(/\D/g, '')
  if (clean.length < 13 || clean.length > 19) return false
  let sum = 0
  let double = false
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = clean.charCodeAt(i) - 48
    if (double) { d *= 2; if (d > 9) d -= 9 }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

function looksLikeCard(m: string): Luhnish {
  const digits = m.replace(/[\s-]/g, '')
  return { digits, ok: /^\d{13,19}$/.test(digits) && luhn(digits) }
}

const RULES: Rule[] = [
  { kind: 'password', match: PASSWORD_KEYS },
  // Card numbers, with or without spaces/dashes. Only replaced when the check digit passes.
  {
    kind: 'financial account number',
    match: /\b(?:\d[ -]?){12,18}\d\b/g,
    replace: m => (looksLikeCard(m).ok ? '[redacted: financial account number]' : m),
  },
  // IBAN
  { kind: 'financial account number', match: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  // Bank routing/account wording
  { kind: 'financial account number', match: /\b(?:account|acct|routing|sort\s?code)\s*(?:no\.?|number|#)?\s*[:=]?\s*\d{6,17}\b/gi },
  // US SSN
  { kind: 'government identifier', match: /\b\d{3}-\d{2}-\d{4}\b/g },
  // UK National Insurance
  { kind: 'government identifier', match: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g },
  // Passport / driving licence shaped values with an explicit label
  { kind: 'government identifier', match: /\b(?:passport|licen[cs]e|national\s?id|ssn|tax\s?id|itin)\s*(?:no\.?|number|#)?\s*[:=]?\s*[A-Z0-9]{6,12}\b/gi },
  // Health statements
  { kind: 'health data', match: /\b(?:diagnos(?:is|ed)|prescri(?:bed|ption)|medication|allerg(?:y|ies)|medical\s+condition|treatment\s+for|suffers?\s+from|disabilit(?:y|ies)|hiv|hepatitis|therapy)\b[^.\n]{0,80}/gi },
  // Insurance / patient identifiers
  { kind: 'health data', match: /\b(?:patient|mrn|insurance)\s*(?:id|no\.?|number|#)\s*[:=]?\s*[A-Z0-9-]{5,20}\b/gi },
]

/** Remove the categories above. Returns the cleaned text plus what was removed. */
export function redact(input: string): { text: string; hits: RedactionHit[] } {
  let text = String(input ?? '')
  const counts = new Map<string, number>()
  for (const rule of RULES) {
    text = text.replace(rule.match, (...args: unknown[]) => {
      const whole = String(args[0])
      const replaced = rule.replace ? rule.replace(whole, ...(args.slice(1, -2).map(String))) : `[redacted: ${rule.kind}]`
      if (replaced !== whole) counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1)
      return replaced
    })
  }
  return { text, hits: [...counts.entries()].map(([kind, count]) => ({ kind, count })) }
}

/** Merge hit lists from several redactions into one per-kind total. */
export function mergeHits(lists: RedactionHit[][]): RedactionHit[] {
  const totals = new Map<string, number>()
  for (const list of lists) for (const h of list) totals.set(h.kind, (totals.get(h.kind) ?? 0) + h.count)
  return [...totals.entries()].map(([kind, count]) => ({ kind, count }))
}

/** Redact every string in a JSON-shaped value, keeping the structure. */
export function redactDeep<T>(value: T): { value: T; hits: RedactionHit[] } {
  const hits: RedactionHit[][] = []
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redact(v)
      hits.push(r.hits)
      return r.text
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val)
      return out
    }
    return v
  }
  const out = walk(value) as T
  return { value: out, hits: mergeHits(hits) }
}
