import { describe, expect, it } from 'vitest'
import { parsePivexAccount, parsePivexPositions } from '../venues/pivex'
import type { PageRead } from '../../../shared/browser'

/**
 * The Pivex page reader.
 *
 * These tests use page text and table cells shaped like the real terminal, so the parser
 * is checked against the thing it will actually meet — and so a change that starts
 * inventing a balance, or reading a column out of line, fails here.
 */

function page(over: Partial<PageRead> = {}): PageRead {
  return {
    url: 'https://app.pivex.com/trading-platform',
    title: 'Pivex — Prop Trading Dashboard',
    text: '',
    elements: [],
    textClipped: false,
    ...over,
  }
}

describe('Pivex account reader', () => {
  it('recognises the sign-in wall instead of reporting an empty account', () => {
    const result = parsePivexAccount(page({
      url: 'https://app.pivex.com/login?redirect=%2Ftrading-platform',
      text: 'Login to Pivex Enter your email to continue Email Login',
    }))
    expect(result.needsSignIn).toBe(true)
    expect(result.account).toBeNull()
    expect(result.gaps.join(' ')).toContain('sign-in page')
  })

  it('reads the balance and says plainly that it is simulated', () => {
    const result = parsePivexAccount(page({
      text: '10k – Challenge #1102947 Balance 10,007.32 Progress 0.07% / 10% Profit 155.98',
    }))
    expect(result.needsSignIn).toBe(false)
    expect(result.account?.equity).toBeCloseTo(10007.32, 2)
    expect(result.account?.cash).toBeCloseTo(10007.32, 2)
    const notes = result.account?.notes.join(' ') ?? ''
    expect(notes).toContain('simulated')
    expect(notes).toContain('cannot be withdrawn')
    // It must never call the balance money the user owns.
    expect(notes).not.toMatch(/\byour money\b|\bearnings\b|\bincome\b/i)
  })

  it('reports a gap rather than inventing a balance when none is on the page', () => {
    const result = parsePivexAccount(page({ text: 'Loading…' }))
    expect(result.account).toBeNull()
    expect(result.gaps.join(' ')).toContain('could not find a balance')
  })

  it('reads positions from a table by its header, not by column order', () => {
    const tables = [[
      ['Symbol', 'Side', 'Volume', 'Open', 'Price', 'Profit'],
      ['EURUSD', 'Buy', '0.01', '1.0850', '1.0862', '12.00'],
      ['XAUUSD', 'Sell', '0.10', '2400.50', '2398.10', '24.00'],
    ]]
    const { positions, gaps } = parsePivexPositions(page(), tables)
    expect(positions).toHaveLength(2)
    expect(positions[0].symbol).toBe('EURUSD')
    expect(positions[0].side).toBe('long')
    expect(positions[0].size).toBeCloseTo(0.01, 5)
    expect(positions[0].unrealizedPl).toBeCloseTo(12, 2)
    expect(positions[1].symbol).toBe('XAUUSD')
    expect(positions[1].side).toBe('short')
    expect(gaps.join(' ')).toContain('2 open positions')
  })

  it('handles a table whose columns are in a different order', () => {
    const tables = [[
      ['Profit', 'Volume', 'Symbol'],
      ['-5.50', '0.02', 'GBPUSD'],
    ]]
    const { positions } = parsePivexPositions(page(), tables)
    expect(positions).toHaveLength(1)
    expect(positions[0].symbol).toBe('GBPUSD')
    expect(positions[0].size).toBeCloseTo(0.02, 5)
    expect(positions[0].unrealizedPl).toBeCloseTo(-5.5, 2)
  })

  it('says so when there is no table at all', () => {
    const { positions, gaps } = parsePivexPositions(page(), [])
    expect(positions).toHaveLength(0)
    expect(gaps.join(' ')).toContain('No positions table')
  })

  it('does not turn a header-only table into fake positions', () => {
    const tables = [[['Symbol', 'Volume', 'Price']]]
    const { positions, gaps } = parsePivexPositions(page(), tables)
    expect(positions).toHaveLength(0)
    expect(gaps.join(' ')).toContain('no readable rows')
  })
})
