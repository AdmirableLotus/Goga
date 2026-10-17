import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { plannerDiagnostic, redactDiagnosticValue } from '../plannerDiagnostics'

describe('local planner diagnostics', () => {
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
