import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { atr, backtest, chartSummary, ema, maxDrawdown, rsi, sma, type Bar } from '../trading/indicators'
import { MarketData, instrument, timeframe } from '../trading/marketData'
import { ALPACA_PAPER, PaperTrading, rewardToRisk, riskProblems } from '../trading/paperTrading'
import { looksLikeAgentTask, plannerOffers } from '../agentRouting'

const bars = (closes: number[]): Bar[] => closes.map((c, i) => ({ t: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), o: c, h: c + 1, l: c - 1, c, v: 100 }))

describe('market math', () => {
  it('computes averages, RSI and ATR the standard way', () => {
    expect(sma([1, 2, 3, 4], 2).slice(1)).toEqual([1.5, 2.5, 3.5])
    expect(ema([1, 2, 3, 4], 2)[1]).toBe(1.5)
    expect(ema([1, 2, 3, 4], 2)[3]).toBeCloseTo(3.5, 5)
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i)
    expect(rsi(rising)[29]).toBe(100)
    expect(rsi(rising.map(x => 300 - x))[29]).toBe(0)
    expect(atr(bars(Array.from({ length: 20 }, () => 50)))[19]).toBeCloseTo(2, 5)
    expect(maxDrawdown([100, 120, 90, 130])).toBeCloseTo(0.25, 5)
  })

  it('reads a chart in plain words with a stop suggestion', () => {
    const up = bars(Array.from({ length: 250 }, (_, i) => 100 + i * 0.5 + Math.sin(i) * 2))
    const text = chartSummary('SPY', up, '1Day')
    expect(text).toMatch(/uptrend/)
    expect(text).toMatch(/RSI\(14\)/)
    expect(text).toMatch(/stop 2×ATR away/)
    expect(chartSummary('X', bars([1, 2, 3]), '1Day')).toMatch(/not enough history/)
  })

  it('backtests honestly, fees included, against buy-and-hold', () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + 20 * Math.sin(i / 15) + i * 0.1)
    const hold = backtest(bars(closes), 'buy-and-hold', { feePct: 0 })
    expect(hold.totalReturn).toBeCloseTo(closes[299] / closes[0] - 1, 5)
    const cross = backtest(bars(closes), 'sma-cross', { feePct: 0.1 })
    expect(cross.trades).toBeGreaterThan(2)
    expect(cross.exposure).toBeLessThan(1)
    expect(cross.maxDrawdown).toBeGreaterThanOrEqual(0)
  })
})

describe('symbols and data', () => {
  it('tells stocks, crypto and forex apart', () => {
    expect(instrument('aapl')).toEqual({ symbol: 'AAPL', market: 'stock' })
    expect(instrument('btc')).toEqual({ symbol: 'BTC/USD', market: 'crypto' })
    expect(instrument('BTCUSD')).toEqual({ symbol: 'BTC/USD', market: 'crypto' })
    expect(instrument('eth-usd')).toEqual({ symbol: 'ETH/USD', market: 'crypto' })
    expect(instrument('eurusd')).toEqual({ symbol: 'EUR/USD', market: 'forex' })
    expect(instrument('USD/JPY')).toEqual({ symbol: 'USD/JPY', market: 'forex' })
    expect(instrument('BRK.B')).toEqual({ symbol: 'BRK.B', market: 'stock' })
    expect(() => instrument('not a symbol!')).toThrow()
    expect(timeframe('hourly')).toBe('1Hour')
    expect(timeframe(undefined)).toBe('1Day')
  })

  it('asks for Alpaca keys for stocks, and sends them only to Alpaca', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const http = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers })
      if (url.includes('frankfurter')) return new Response(JSON.stringify({ date: '2026-10-28', rates: { USD: 1.11 } }))
      return new Response(JSON.stringify({ snapshots: { 'BTC/USD': { latestTrade: { p: 80000, t: 'now' }, prevDailyBar: { c: 78000 } } } }))
    }) as unknown as typeof fetch
    await expect(new MarketData(() => null, http).quote('AAPL')).rejects.toThrow(/Alpaca keys/)
    const withKeys = new MarketData(() => ({ keyId: 'PKTEST', secret: 's' }), http)
    expect((await withKeys.quote('BTC')).price).toBe(80000)
    expect((await withKeys.quote('EUR/USD')).price).toBe(1.11)
    expect(seen.find(s => s.url.includes('frankfurter'))!.headers['APCA-API-KEY-ID']).toBeUndefined()
  })
})

describe('practice trading', () => {
  const limits = { maxPositionPct: 10, requireStop: true, dailyLossPct: 3 }
  const base = { equity: 100_000, dayPnlPct: 0, orderValue: 5000, opening: true, price: 100, side: 'buy' as const, stopPrice: 95, reason: 'pullback to the 50-day average in an uptrend' }

  it('lets a sensible trade through and explains every broken rule', () => {
    expect(riskProblems(base, limits)).toEqual([])
    const bad = riskProblems({ ...base, orderValue: 20_000, stopPrice: undefined, dayPnlPct: -4, reason: '' }, limits).join('\n')
    expect(bad).toMatch(/why/)
    expect(bad).toMatch(/10% limit/)
    expect(bad).toMatch(/daily loss limit/)
    expect(bad).toMatch(/stop price/)
    expect(riskProblems({ ...base, stopPrice: 105 }, limits).join()).toMatch(/below the price/)
    expect(riskProblems({ ...base, side: 'sell' }, limits).join()).toMatch(/only buying to open/)
    // Closing what is held needs only a reason
    expect(riskProblems({ ...base, opening: false, side: 'sell', stopPrice: undefined }, limits)).toEqual([])
    expect(rewardToRisk(100, 95, 115)).toBe(3)
  })

  it('can only reach Alpaca\'s paper account', () => {
    expect(ALPACA_PAPER).toBe('https://paper-api.alpaca.markets/v2')
  })

  it('keeps a forex practice ledger with stops, and a journal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-fx-'))
    let rate = 1.1
    const data = { quote: async (s: string) => ({ symbol: s, market: 'forex', price: rate, time: 'today', source: 'test' }) } as unknown as MarketData
    const desk = new PaperTrading({ keys: () => null, data, limits: () => limits, journalFile: path.join(dir, 'j.json'), fxFile: path.join(dir, 'fx.json') })
    await expect(desk.order({ symbol: 'EUR/USD', side: 'buy', notional: 5000, reason: 'too short' })).rejects.toThrow(/why|stop/)
    const filled = await desk.order({ symbol: 'EUR/USD', side: 'buy', notional: 5500, stopPrice: 1.08, reason: 'euro holding above its 200-day average' })
    expect(filled).toMatch(/filled/)
    let [fx] = await desk.accounts()
    expect(fx.positions[0]).toMatchObject({ symbol: 'EUR/USD', stop: 1.08 })
    expect(fx.equity).toBeCloseTo(100_000, 0)
    rate = 1.07
    ;[fx] = await desk.accounts()
    expect(fx.positions).toEqual([])
    expect(fx.equity).toBeCloseTo(100_000 - 5000 * 0.02, 0)
    expect(desk.journal().map(e => e.reason)).toEqual(['euro holding above its 200-day average', 'stop reached'])
  })

  it('closes a whole forex position when asked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-fxc-'))
    const data = { quote: async (s: string) => ({ symbol: s, market: 'forex', price: 1.1, time: 'today', source: 'test' }) } as unknown as MarketData
    const desk = new PaperTrading({ keys: () => null, data, limits: () => limits, journalFile: path.join(dir, 'j.json'), fxFile: path.join(dir, 'fx.json') })
    await desk.order({ symbol: 'EUR/USD', side: 'buy', notional: 5500, stopPrice: 1.08, reason: 'euro holding above its 200-day average' })
    const msg = await desk.closePosition('EUR/USD', 'taking the practice position off the table')
    expect(msg).toMatch(/sell/i)
    expect((await desk.accounts())[0].positions).toEqual([])
    expect(desk.journal().some(e => e.reason === 'taking the practice position off the table')).toBe(true)
    await expect(desk.closePosition('GBP/USD', 'nothing is held here anyway')).rejects.toThrow(/no GBP\/USD/)
  })
})

describe('routing trading work', () => {
  it('sends live-data and practice-account requests to the agent', () => {
    expect(looksLikeAgentTask("what's the bitcoin price right now")).toBe(true)
    expect(looksLikeAgentTask('analyze the chart for NVDA stock')).toBe(true)
    expect(looksLikeAgentTask('backtest an sma cross on SPY')).toBe(true)
    expect(looksLikeAgentTask('buy 2 shares of AAPL in my practice account')).toBe(true)
    expect(looksLikeAgentTask('what is RSI and how do traders use it?')).toBe(false)
  })

  it('offers the trading tools only for trading tasks', () => {
    const t = plannerOffers('analyze BTC/USD and suggest a trade')
    expect(t('trading.analyze')).toBe(true)
    expect(t('web.search')).toBe(true)
    expect(t('computer.click')).toBe(false)
    expect(plannerOffers('open notepad')('trading.order')).toBe(false)
  })
})
