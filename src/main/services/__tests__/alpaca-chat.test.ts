import { describe, expect, it } from 'vitest'
import { isTradingScheduleRequest, parseTradingCommand, proposalSymbol, tradingScheduleReply } from '../trading/command'
import { describeOrder, orderWarnings } from '../trading/paperTrading'
import { isConfirmation } from '../agentRouting'

describe('the leftover AAPL stops from a real account', () => {
  const held = [{ symbol: 'AAPL', qty: 51, price: 344.88 }]
  const stop = (id: string, qty: string, price: string) => ({ id, side: 'sell', qty, symbol: 'AAPL', type: 'stop', stop_price: price, status: 'new' })
  const orders = [stop('7d2f460f-1', '10', '140'), stop('a4f0eb0b-2', '10', '140'), stop('256c9b1a-3', '20', '145'), stop('d5518cae-4', '10', '150')]

  it('reads plainly, without "stop stop"', () => {
    expect(describeOrder(orders[0])).toBe('7d2f460f-1: sell 10 AAPL, stop at 140 (new)')
  })

  it('points out stacked and far-away stops', () => {
    const w = orderWarnings(held, orders)
    expect(w[0]).toMatch(/4 separate stop orders on AAPL cover 50 of 51 shares/)
    expect(w.some(x => /150\) is 57% below the price/.test(x))).toBe(true)
  })

  it('says nothing about one sensible stop', () => {
    expect(orderWarnings(held, [stop('x', '51', '320')])).toEqual([])
  })

  it('flags stops on something no longer held', () => {
    expect(orderWarnings([], [orders[0]])[0]).toMatch(/no AAPL is held/)
  })

  it('cancels by the start of an order id', () => {
    expect(parseTradingCommand('cancel order 7d2f460f')).toEqual({ tool: 'trading.cancel', params: { orderId: '7d2f460f' } })
  })
})

describe('closing a position', () => {
  it('closes the whole position on an explicit exit phrase', () => {
    expect(parseTradingCommand('sell all my AAPL')).toEqual({ tool: 'trading.close', params: { symbol: 'AAPL' } })
    expect(parseTradingCommand('close out BTC')).toEqual({ tool: 'trading.close', params: { symbol: 'BTC/USD' } })
    expect(parseTradingCommand('exit my EUR/USD position')).toEqual({ tool: 'trading.close', params: { symbol: 'EUR/USD' } })
    expect(parseTradingCommand('dump TSLA')).toEqual({ tool: 'trading.close', params: { symbol: 'TSLA' } })
    expect(parseTradingCommand('get out of NVDA')).toEqual({ tool: 'trading.close', params: { symbol: 'NVDA' } })
  })

  it('leaves a plain sell as a plan, and needs a real symbol', () => {
    expect(parseTradingCommand('sell AAPL')).toEqual({ tool: 'trading.plan', params: { symbol: 'AAPL', side: 'sell' } })
    expect(parseTradingCommand('close the chart')).toBeNull()
    expect(parseTradingCommand('close the app')).toBeNull()
  })
})

describe('is the market open', () => {
  it('answers trading hours from the clock, not the account', () => {
    expect(parseTradingCommand('is the market open')).toEqual({ tool: 'trading.clock', params: {} })
    expect(parseTradingCommand('is the stock market open today')).toEqual({ tool: 'trading.clock', params: {} })
    expect(parseTradingCommand('what are the market hours')).toEqual({ tool: 'trading.clock', params: {} })
  })

  it('does not fire for market news or a vague "how is the market"', () => {
    expect(parseTradingCommand('any market news')).toEqual({ tool: 'trading.news', params: {} })
    expect(parseTradingCommand('how is the market doing')).toBeNull()
  })
})

describe('agreeing to a trade proposal', () => {
  it('finds the symbol Goga proposed, not an indicator name', () => {
    const offer = 'I’ll check the 50-day and 200-day moving averages, RSI, and support/resistance levels for AAPL. Based on the analysis, I’ll place a new buy order for AAPL with a stop loss. Would you like me to proceed?'
    expect(proposalSymbol(offer)).toBe('AAPL')
    expect(proposalSymbol('Want me to analyze bitcoin on the daily chart?')).toBe('BTC/USD')
  })
})

// From a real chat: "how is alpaca" got a promise instead of the account, "review it on your
// own every hour" got a made-up schedule, and "you do that" sent three bare words to the planner.

describe('asking about Alpaca', () => {
  it('shows the account for plain questions', () => {
    expect(parseTradingCommand('how is alpaca')).toEqual({ tool: 'trading.account', params: {} })
    expect(parseTradingCommand('check alpaca')).toEqual({ tool: 'trading.account', params: {} })
  })

  it('leaves key setup and schedules alone', () => {
    expect(parseTradingCommand('where do I put my alpaca keys')).toBeNull()
    expect(parseTradingCommand('watch alpaca every hour')).toBeNull()
  })
})

describe('"review it on your own every hour"', () => {
  const chat = ['how is alpaca', 'I\'ll check the status of your Alpaca paper trading account. Would you like me to proceed?']

  it('is about the account when Alpaca was just mentioned', () => {
    expect(isTradingScheduleRequest('review it on your own every hour', chat)).toBe(true)
    expect(isTradingScheduleRequest('keep an eye on my portfolio')).toBe(true)
  })

  it('is not about trading without that context', () => {
    expect(isTradingScheduleRequest('review it on your own every hour', ['draft the NSF budget'])).toBe(false)
    expect(isTradingScheduleRequest('how is alpaca', chat)).toBe(false)
  })

  it('describes what really runs, including what is switched off', () => {
    expect(tradingScheduleReply(true, true)).toMatch(/Every 5 minutes.*\n.*Every 15 minutes/)
    expect(tradingScheduleReply(false, false)).toMatch(/watcher is off[\s\S]*trading is off/)
  })
})

describe('"you do that"', () => {
  it('agrees to what Goga offered', () => {
    for (const reply of ['you do that', 'you can do it', 'do it for me', 'check it yourself', 'go on'])
      expect(isConfirmation(reply), reply).toBe(true)
    expect(isConfirmation('you do that thing with the files later')).toBe(false)
  })
})
