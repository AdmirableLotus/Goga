import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'

const OMITTED_PAYLOAD = '[OMITTED: unsafe diagnostic payload]'

export function redactDiagnosticText(text: string): string {
    return redactText(text, new WeakSet<object>(), 0)
}

/** Raw/backend bodies are retained only when every record can be sanitized. */
export function redactDiagnosticPayload(text: string): string {
    return redactPayload(text, new WeakSet<object>(), 0)
}

function redactPayload(text: string, seen: WeakSet<object>, serializedDepth: number): string {
    try { return redactSerialized(text, seen, serializedDepth, true) ?? OMITTED_PAYLOAD }
    catch { return OMITTED_PAYLOAD }
}

function redactSerialized(text: string, seen: WeakSet<object>, serializedDepth: number, stringPayloads = false): string | undefined {
    if (text === OMITTED_PAYLOAD) return text
    if (serializedDepth >= 8) return '[REDACTED: nested JSON limit]'
    const trimmed = text.trim()
    const fence = trimmed.match(/^```(jsonl?|ndjson)?\s*([\s\S]*?)\s*```$/i)
    const content = fence ? fence[2] : trimmed
    let records: unknown[]
    try {
      records = [JSON.parse(content)]
    } catch {
      // Parse all NDJSON records before retaining any content. A malformed line
      // must not fall back to a partial regex scrub of a credential-bearing body.
      const lines = content.split(/\r?\n/).filter(line => line.trim())
      if (lines.length < 2) return undefined
      try { records = lines.map(line => JSON.parse(line)) } catch { return undefined }
    }
    const redacted = records.map(value => JSON.stringify(
      stringPayloads && typeof value === 'string' ? redactPayload(value, seen, serializedDepth + 1)
        : redactValue(value, seen, serializedDepth + 1),
    )).join('\n')
    return fence ? '```' + (fence[1] ?? '') + '\n' + redacted + '\n```' : redacted
}

function redactText(text: string, seen: WeakSet<object>, serializedDepth: number): string {
    const serialized = redactSerialized(text, seen, serializedDepth)
    if (serialized !== undefined) return serialized
    // A malformed structured value can also occur inside an error or nested
    // diagnostic string. Do not expose its contents through the text fallback.
    if (/^\s*(?:[\[{]|```)/.test(text)) return OMITTED_PAYLOAD
    let line = text
    for (const [key, value] of Object.entries(process.env)) {
      if (/key|token|secret|password|credential/i.test(key) && value && value.length >= 4) {
        line = line.split(value).join('[REDACTED]')
      }
    }
    line = line.replace(/Bearer\s+[\w.\-]+/gi, 'Bearer [REDACTED]')
      .replace(/((?:api[_-]?key|password|secret|access[_-]?token)[\\"'\s:=]+)[^\s,;"}]+/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    return line
}

// Inspect keys before serialization so secrets remain redacted inside native
// tool-call objects, arrays, and credentials whose values are not in the env.
export function redactDiagnosticValue(value: unknown, seen = new WeakSet<object>()): unknown {
  return redactValue(value, seen, 0)
}

function redactValue(value: unknown, seen: WeakSet<object>, serializedDepth: number): unknown {
  if (typeof value === 'string') return redactText(value, seen, serializedDepth)
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => redactValue(item, seen, serializedDepth))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
      const secret = /password|passwd|passphrase|secret|token|credential|authorization|cookie|apikey|privatekey|accesskey|sessionkey/.test(normalized)
      return [key, secret ? '[REDACTED]' :
        typeof item === 'string' && /^(raw|body)$/.test(normalized)
          ? redactPayload(item, seen, serializedDepth) : redactValue(item, seen, serializedDepth)]
    }))
  } finally { seen.delete(value) }
}

// Opt-in, local-only trace. Never record settings, environment, images or headers.
export function plannerDiagnostic(event: string, data: Record<string, unknown>) {
  const destination = process.env.GOGA_PLANNER_TRACE
  if (!destination || !path.isAbsolute(destination)) return
  try {
    const line = JSON.stringify(redactDiagnosticValue({ timestamp: new Date().toISOString(), pid: process.pid, event, ...data }))
    fs.appendFileSync(destination, line + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch { /* Diagnostics must not change execution behavior. */ }
}

export function loadedModuleIdentity(filename: string) {
  try {
    return { path: filename, sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }
  } catch { return { path: filename, sha256: 'unavailable' } }
}

// PowerShell emits metadata on stdout even when the helper subsequently fails.
// Route it through the same opt-in recursive redactor; never write raw PS JSON.
export function consumePowerShellDiagnostics(output: string): string {
  return output.replace(/^GOGA_FILENAME_DIAGNOSTIC:([^\r\n]*)(?:\r?\n|$)/gm, (_line, json: string) => {
    try {
      const data = JSON.parse(json)
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected diagnostic object')
      plannerDiagnostic('filename.input.check', data)
    } catch {
      // JSON parser messages can echo malformed secret-bearing input.
      plannerDiagnostic('filename.input.diagnostic_error', { error: 'Invalid filename diagnostic record' })
    }
    return ''
  })
}
