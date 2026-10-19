import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { plannerDiagnostic, redactDiagnosticText, redactDiagnosticValue } from '../plannerDiagnostics'

describe('local planner diagnostics', () => {
  it('uses recursive redaction for fenced JSON and every NDJSON record in actual trace output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-wrapped-trace-'))
    const file = path.join(dir, 'trace.jsonl')
    const previous = process.env.GOGA_PLANNER_TRACE
    const secretValues = ['fixture-fenced-token', 'fixture-fenced-auth', 'fixture-fenced-cookie', 'fixture-fenced-private']
    const value = { nested: [{ token: secretValues[0], Authorization: secretValues[1], cookie: secretValues[2],
      private_key: secretValues[3], label: 'keep-safe-evidence' }] }
    const json = JSON.stringify(value)
    const ndjson = json + '\r\n' + JSON.stringify([value]) + '\r\n'
    const fixtures = ['```json\n' + JSON.stringify(value, null, 2) + '\n```', '```JSON\n' + json + '\n```',
      '```\n' + json + '\n```', ndjson, '```ndjson\n' + ndjson + '```', '```jsonl\n' + ndjson + '```',
      JSON.stringify({ nestedText: '```json\n' + json + '\n```', nestedBody: { body: ndjson } })]
    try {
      process.env.GOGA_PLANNER_TRACE = file
      for (const raw of fixtures) plannerDiagnostic('planner.initialResponse', { raw, body: raw, nested: [{ body: raw }] })
      const written = fs.readFileSync(file, 'utf8')
      for (const secret of secretValues) expect(written).not.toContain(secret)
      const records = written.trim().split('\n').map(line => JSON.parse(line))
      expect(records).toHaveLength(fixtures.length)
      for (const record of records) {
        expect(record.raw).toContain('keep-safe-evidence')
        expect(record.raw).toContain('[REDACTED]')
        expect(record.body).toBe(record.raw)
        expect(record.nested[0].body).toBe(record.raw)
      }
      const fenced = records[0].raw.replace(/^```json\n|\n```$/g, '')
      expect(JSON.parse(fenced).nested[0]).toEqual({ token: '[REDACTED]', Authorization: '[REDACTED]',
        cookie: '[REDACTED]', private_key: '[REDACTED]', label: 'keep-safe-evidence' })
      expect(records[3].body.split('\n').map((line: string) => JSON.parse(line))).toHaveLength(2)
    } finally {
      if (previous === undefined) delete process.env.GOGA_PLANNER_TRACE
      else process.env.GOGA_PLANNER_TRACE = previous
      if (fs.existsSync(file)) fs.unlinkSync(file)
      fs.rmdirSync(dir)
    }
  })
  it('omits unsafe raw/body content, including malformed fenced and NDJSON records, without dropping the event', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-unsafe-trace-'))
    const file = path.join(dir, 'trace.jsonl')
    const previous = process.env.GOGA_PLANNER_TRACE
    const json = JSON.stringify({ nested: [{ token: 'fixture-malformed-token', authorization: 'fixture-malformed-auth', cookie: 'fixture-malformed-cookie' }] })
    const broken = json.slice(0, -1)
    const fixtures = [broken, '```json\n' + broken + '\n```', json + '\n' + broken, broken + '\n' + json,
      '```ndjson\n' + json + '\n' + broken + '\n```', '```json\n' + json,
      'prefix ' + json + ' suffix', 'token=fixture-malformed-token authorization=fixture-malformed-auth cookie=fixture-malformed-cookie']
    try {
      process.env.GOGA_PLANNER_TRACE = file
      for (const body of fixtures) plannerDiagnostic('unsafe-fixture', { body, raw: body, nested: [{ body }], reason: 'Invalid backend JSON' })
      const written = fs.readFileSync(file, 'utf8')
      for (const secret of ['fixture-malformed-token', 'fixture-malformed-auth', 'fixture-malformed-cookie']) expect(written).not.toContain(secret)
      const records = written.trim().split('\n').map(line => JSON.parse(line))
      expect(records).toHaveLength(fixtures.length)
      for (const record of records) {
        expect(record.body).toBe('[OMITTED: unsafe diagnostic payload]')
        expect(record.raw).toBe(record.body)
        expect(record.nested[0].body).toBe(record.body)
        expect(record.reason).toBe('Invalid backend JSON')
      }
    } finally {
      if (previous === undefined) delete process.env.GOGA_PLANNER_TRACE
      else process.env.GOGA_PLANNER_TRACE = previous
      if (fs.existsSync(file)) fs.unlinkSync(file)
      fs.rmdirSync(dir)
    }
  })
  it('does not let JSON-string encoding bypass omission of unstructured payloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-encoded-trace-'))
    const file = path.join(dir, 'trace.jsonl')
    const previous = process.env.GOGA_PLANNER_TRACE
    let raw = 'token=fixture-encoded-token authorization=fixture-encoded-auth cookie=fixture-encoded-cookie'
    try {
      process.env.GOGA_PLANNER_TRACE = file
      for (let i = 0; i < 3; i++) {
        raw = JSON.stringify(raw)
        plannerDiagnostic('encoded-fixture', { raw, body: raw })
      }
      const output = fs.readFileSync(file, 'utf8')
      for (const secret of ['fixture-encoded-token', 'fixture-encoded-auth', 'fixture-encoded-cookie']) expect(output).not.toContain(secret)
      const records = output.trim().split('\n').map(line => JSON.parse(line))
      expect(records).toHaveLength(3)
      records.forEach(record => expect(record.raw).toContain('[OMITTED: unsafe diagnostic payload]'))
    } finally {
      if (previous === undefined) delete process.env.GOGA_PLANNER_TRACE
      else process.env.GOGA_PLANNER_TRACE = previous
      if (fs.existsSync(file)) fs.unlinkSync(file)
      fs.rmdirSync(dir)
    }
  })
  it('redacts credential fixtures in serialized raw/body JSON before writing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-serialized-trace-'))
    const file = path.join(dir, 'trace.log')
    const previous = process.env.GOGA_PLANNER_TRACE
    const credentials = { nested: [{ token: 'fixture-token-01', Authorization: 'fixture-auth-02',
      cookie: 'fixture-cookie-03', credentials: { value: 'fixture-credential-04' }, label: 'keep' }] }
    const serialized = JSON.stringify(credentials)
    const fixtures = [serialized, JSON.stringify([credentials]), JSON.stringify(serialized),
      JSON.stringify({ nestedBody: serialized })]
    try {
      process.env.GOGA_PLANNER_TRACE = file
      for (const body of fixtures) plannerDiagnostic('serialized-fixture', { raw: body, body, nested: [{ body }] })
      const output = fs.readFileSync(file, 'utf8')
      for (const secret of ['fixture-token-01', 'fixture-auth-02', 'fixture-cookie-03', 'fixture-credential-04']) {
        expect(output).not.toContain(secret)
      }
      const records = output.trim().split('\n').map(line => JSON.parse(line))
      expect(JSON.parse(records[0].raw).nested[0]).toEqual({ token: '[REDACTED]', Authorization: '[REDACTED]',
        cookie: '[REDACTED]', credentials: '[REDACTED]', label: 'keep' })
      expect(records).toHaveLength(fixtures.length)
      for (const record of records) {
        expect(typeof record.body).toBe('string')
        expect(record.body).toContain('keep')
        expect(() => JSON.parse(record.body)).not.toThrow()
      }
      expect(JSON.stringify(credentials)).toBe(serialized)
    } finally {
      if (previous === undefined) delete process.env.GOGA_PLANNER_TRACE
      else process.env.GOGA_PLANNER_TRACE = previous
      if (fs.existsSync(file)) fs.unlinkSync(file)
      fs.rmdirSync(dir)
    }
  })
  it('bounds nested serialized JSON without leaking its credentials', () => {
    let body = JSON.stringify({ token: 'fixture-deep-token' })
    for (let i = 0; i < 12; i++) body = JSON.stringify({ body })
    const output = redactDiagnosticText(body)
    expect(output).not.toContain('fixture-deep-token')
    expect(output).toContain('nested JSON limit')
    expect(() => JSON.parse(output)).not.toThrow()
  })
  it('recursively redacts structured native tool secrets before writing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-structured-trace-'))
    const file = path.join(dir, 'trace.log')
    const previous = process.env.GOGA_PLANNER_TRACE
    const input = { toolCall: { function: { arguments: {
      password: 'structured-password', nested: [{ api_key: 'structured-key', label: 'keep' },
        [{ clientSecret: 'structured-secret', accessToken: 'structured-token' }]],
      credentials: { arbitrary: 'credential-object' }, Authorization: 'structured-auth'
    } } } }
    const original = JSON.stringify(input)
    try {
      process.env.GOGA_PLANNER_TRACE = file
      plannerDiagnostic('native-response', input)
      const text = fs.readFileSync(file, 'utf8')
      expect(JSON.parse(text).toolCall.function.arguments.nested[0]).toEqual({ api_key: '[REDACTED]', label: 'keep' })
      for (const secret of ['structured-password', 'structured-key', 'structured-secret', 'structured-token', 'credential-object', 'structured-auth']) expect(text).not.toContain(secret)
      expect(JSON.stringify(input)).toBe(original)
    } finally {
      if (previous === undefined) delete process.env.GOGA_PLANNER_TRACE
      else process.env.GOGA_PLANNER_TRACE = previous
      fs.unlinkSync(file)
      fs.rmdirSync(dir)
    }
  })
  it('handles arrays and cyclic diagnostic values without dropping the trace', () => {
    const value: Record<string, unknown> = { items: [{ password: 'sensitive' }] }
    value.self = value
    expect(redactDiagnosticValue(value)).toEqual({items:[{password:'[REDACTED]'}],self:'[Circular]'})
  })
  it('requires opt-in and redacts credentials from raw responses', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-trace-'))
    const file = path.join(dir, 'trace.log')
    const previous = process.env.GOGA_PLANNER_TRACE
    const previousSecret = process.env.GOGA_TEST_SECRET
    try {
      delete process.env.GOGA_PLANNER_TRACE
      plannerDiagnostic('disabled', { raw: 'no trace' })
      expect(fs.existsSync(file)).toBe(false)
      process.env.GOGA_PLANNER_TRACE = file
      process.env.GOGA_TEST_SECRET = 'test-secret-123'
      plannerDiagnostic('response', { raw: 'test-secret-123 Bearer abc.def password=hidden https://user:pass@example.com', content: 'routing check' })
      const trace = fs.readFileSync(file, 'utf8')
      expect(() => JSON.parse(trace)).not.toThrow()
      for (const secret of ['test-secret-123', 'abc.def', 'hidden', 'user:pass']) expect(trace).not.toContain(secret)
      expect(trace).toContain('routing check')
    } finally {
      if (previous === undefined) delete process.env.GOGA_PLANNER_TRACE
      else process.env.GOGA_PLANNER_TRACE = previous
      if (previousSecret === undefined) delete process.env.GOGA_TEST_SECRET
      else process.env.GOGA_TEST_SECRET = previousSecret
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
