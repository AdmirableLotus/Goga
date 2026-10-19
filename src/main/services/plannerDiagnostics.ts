import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'

export function redactDiagnosticText(text: string): string {
    return redactText(text, new WeakSet<object>(), 0)
}

function redactText(text: string, seen: WeakSet<object>, serializedDepth: number): string {
    // Raw planner/backend bodies can contain JSON (including JSON inside JSON
    // strings). Inspect its keys just as we do native diagnostic objects.
    if (serializedDepth >= 8) return '[REDACTED: nested JSON limit]'
    try {
      const parsed: unknown = JSON.parse(text)
      if ((parsed && typeof parsed === 'object') || typeof parsed === 'string') {
        return JSON.stringify(redactValue(parsed, seen, serializedDepth + 1))
      }
    } catch { /* Non-JSON text still receives the existing text redaction. */ }
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
      return [key, secret ? '[REDACTED]' : redactValue(item, seen, serializedDepth)]
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
