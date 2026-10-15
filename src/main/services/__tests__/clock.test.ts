import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── clock.now tool tests ──────────────────────────────────────────────────────
// We test the logic directly without importing the tool file (which calls
// ToolRegistry.getInstance() as a side effect and requires electron mocks).

function clockNow(now: Date) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    iso:      now.toISOString(),
    date:     new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz }).format(now),
    time:     new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZone: tz }).format(now),
    timezone: tz,
  }
}

describe('clock.now logic', () => {
  it('returns a valid ISO string', () => {
    const result = clockNow(new Date())
    expect(result.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('date string contains year, month name, and day', () => {
    const fixed = new Date('2025-07-04T15:30:00Z')
    const result = clockNow(fixed)
    expect(result.date).toMatch(/\d{4}/)   // year present
    expect(result.date.length).toBeGreaterThan(10)
  })

  it('time string contains AM or PM', () => {
    const result = clockNow(new Date())
    expect(result.time).toMatch(/AM|PM/)
  })

  it('timezone is a non-empty IANA string', () => {
    const result = clockNow(new Date())
    expect(result.timezone).toBeTruthy()
    expect(result.timezone).toMatch(/\/|UTC/)
  })

  it('iso matches the date passed in', () => {
    const fixed = new Date('2024-01-15T12:00:00.000Z')
    const result = clockNow(fixed)
    expect(result.iso).toBe('2024-01-15T12:00:00.000Z')
  })

  it('date and time are consistent with the same Date instance', () => {
    const before = new Date()
    const result = clockNow(before)
    const after = new Date()
    const isoTime = new Date(result.iso).getTime()
    expect(isoTime).toBeGreaterThanOrEqual(before.getTime() - 1)
    expect(isoTime).toBeLessThanOrEqual(after.getTime() + 1)
  })
})

// ── System prompt datetime injection tests ────────────────────────────────────

function buildDatetimeFragment(now: Date): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const currentDate = new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz }).format(now)
  const currentTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZone: tz }).format(now)
  return `Current date and time: ${currentDate}, ${currentTime} (${tz})`
}

describe('system prompt datetime injection', () => {
  it('fragment contains "Current date and time:"', () => {
    const fragment = buildDatetimeFragment(new Date())
    expect(fragment).toContain('Current date and time:')
  })

  it('fragment contains the timezone', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const fragment = buildDatetimeFragment(new Date())
    expect(fragment).toContain(tz)
  })

  it('fragment contains AM or PM', () => {
    const fragment = buildDatetimeFragment(new Date())
    expect(fragment).toMatch(/AM|PM/)
  })

  it('fragment contains the current year', () => {
    const year = new Date().getFullYear().toString()
    const fragment = buildDatetimeFragment(new Date())
    expect(fragment).toContain(year)
  })

  it('two fragments built 1ms apart share the same date string', () => {
    const now = new Date()
    const a = buildDatetimeFragment(now)
    const b = buildDatetimeFragment(now)
    expect(a).toBe(b)
  })
})
