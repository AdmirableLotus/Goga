import { describe, expect, it } from 'vitest'
import { parseTradingCommand, symbolIn } from '../trading/command'

describe('symbol extraction', () => {
  it('reads tickers, pairs and crypto names', () => {
    expect(symbolIn('analyze AAPL')).toBe('AAPL')
    expect(symbolIn('plan a buy on EUR/USD')).toBe('EUR/USD')
    expect(symbolIn('how is bitcoin doing')).toBe('BTC/USD')
    expect(symbolIn('price of eth')).toBe('ETH/USD')
    expect(symbolIn('news on NVDA today')).toBe('NVDA')
    expect(symbolIn('show my account')).toBeNull()
    // Lowercase words and common acronyms are NOT tickers (no false trades on normal sentences).
    expect(symbolIn('analyze aapl')).toBeNull()
    expect(symbolIn('i need to buy tools for my table')).toBeNull()
    expect(symbolIn('buy a USB cable and an LED')).toBeNull()
    expect(symbolIn('analyze the ISFET and PPG sensors')).toBeNull()
  })
})

describe('trading command parsing', () => {
  it('routes analyze', () => {
    expect(parseTradingCommand('analyze AAPL')).toEqual({ tool: 'trading.analyze', params: { symbol: 'AAPL' } })
    expect(parseTradingCommand('analyse the TSLA chart')).toEqual({ tool: 'trading.analyze', params: { symbol: 'TSLA' } })
  })

  it('routes a plan with side and risk', () => {
    expect(parseTradingCommand('plan a buy on EUR/USD risk 1%')).toEqual({ tool: 'trading.plan', params: { symbol: 'EUR/USD', side: 'buy', riskPct: 1 } })
    expect(parseTradingCommand('should I short NVDA')).toEqual({ tool: 'trading.plan', params: { symbol: 'NVDA', side: 'sell' } })
    expect(parseTradingCommand('buy BTC risk 2%')).toMatchObject({ tool: 'trading.plan', params: { symbol: 'BTC/USD', side: 'buy', riskPct: 2 } })
  })

  it('routes account, journal, news and quote', () => {
    expect(parseTradingCommand('what is my practice account')).toEqual({ tool: 'trading.account', params: {} })
    expect(parseTradingCommand('show my trading journal')).toEqual({ tool: 'trading.journal', params: {} })
    expect(parseTradingCommand('news on NVDA')).toEqual({ tool: 'trading.news', params: { symbol: 'NVDA' } })
    expect(parseTradingCommand('any market news')).toEqual({ tool: 'trading.news', params: {} })
    expect(parseTradingCommand('price of AAPL')).toEqual({ tool: 'trading.quote', params: { symbol: 'AAPL' } })
  })

  it('routes practice/backtest sweeps, without catching "practice account"', () => {
    expect(parseTradingCommand('run trading practice')).toEqual({ tool: 'trading.practice', params: {} })
    expect(parseTradingCommand('practice trading')).toEqual({ tool: 'trading.practice', params: {} })
    expect(parseTradingCommand('backtest sweep')).toEqual({ tool: 'trading.practice', params: {} })
    expect(parseTradingCommand('what is my practice account')).toEqual({ tool: 'trading.account', params: {} })
  })

  it('does not hijack ordinary sentences into trades', () => {
    for (const s of [
      'do we need tools as well, i have nothing, i need to buy a table and set up a station',
      'buy a USB cable and an LED for the PCB',
      'should I order the ISFET chips',
      'help me plan what to buy for the R&D build',
    ]) expect(parseTradingCommand(s)).toBeNull()
  })

  it('ignores non-trading messages', () => {
    for (const s of ['hello', 'write me a poem', 'what is the weather', 'open notepad', 'how are you'])
      expect(parseTradingCommand(s)).toBeNull()
  })
})
