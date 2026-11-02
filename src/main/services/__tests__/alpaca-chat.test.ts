import { describe, expect, it } from 'vitest'
import { isTradingScheduleRequest, parseTradingCommand, tradingScheduleReply } from '../trading/command'
import { isConfirmation } from '../agentRouting'

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
