// Trader mode: turn a plain trading request into an exact tool call, deterministically,
// so trading always works without depending on the local model emitting perfect JSON.
// Returns the tool and params to run, or null when it is not a clear trading command.

export interface TradingCommand { tool: string; params: Record<string, unknown> }

// Words that look like tickers but are not. Kept short and trading-specific.
const NOT_SYMBOL = new Set([
  'THE', 'A', 'AN', 'CHART', 'CHARTS', 'STOCK', 'STOCKS', 'PRICE', 'QUOTE', 'ON', 'OF', 'FOR', 'MY',
  'BUY', 'SELL', 'LONG', 'SHORT', 'RISK', 'PLEASE', 'NOW', 'TODAY', 'PLAN', 'ANALYZE', 'ANALYSE',
  'NEWS', 'ACCOUNT', 'PORTFOLIO', 'POSITIONS', 'BALANCE', 'AND', 'WITH', 'AT', 'TO', 'GET', 'SHOW',
  'ME', 'IS', 'DOING', 'WHAT', 'HOW', 'IN', 'IT', 'DO', 'CAN', 'YOU', 'LOOK', 'READ', 'TELL', 'ABOUT',
  'TRADE', 'TRADING', 'OR', 'VS', 'UP', 'DOWN', 'OUT', 'SET', 'UPON', 'PAIR', 'CRYPTO', 'FOREX',
  'I', 'ANY', 'ALL', 'SOME', 'THIS', 'THAT', 'LAST', 'NEXT', 'GOOD', 'BEST', 'MORE', 'MOST', 'WANT',
  'NEED', 'HELP', 'GIVE', 'MAKE', 'WHEN', 'WHY', 'WHO', 'ARE', 'WAS', 'HAS', 'HAD', 'WILL', 'FROM',
  'INTO', 'OVER', 'JUST', 'ALSO', 'VERY', 'MUCH', 'LETS', 'LET', 'SO', 'IF', 'BE', 'AS', 'BY', 'WE',
  'HE', 'SHE', 'THEY', 'OUR', 'YOUR', 'HIS', 'HER', 'NOT', 'NO', 'YES', 'OK', 'HI', 'HEY', 'SEE',
  'WERE', 'BEEN', 'THAN', 'THEM', 'LIKE', 'GOING', 'GONNA', 'WANNA', 'SHOULD', 'COULD', 'WOULD',
])

const CRYPTO: Record<string, string> = {
  bitcoin: 'BTC/USD', btc: 'BTC/USD', ethereum: 'ETH/USD', eth: 'ETH/USD', solana: 'SOL/USD',
  sol: 'SOL/USD', dogecoin: 'DOGE/USD', doge: 'DOGE/USD', xrp: 'XRP/USD', ripple: 'XRP/USD',
}

/** The symbol in a request: a pair like EUR/USD, an uppercase ticker, a crypto name, else null. */
export function symbolIn(text: string): string | null {
  const pair = text.match(/\b([A-Za-z]{2,5})\/([A-Za-z]{3})\b/)
  if (pair) return `${pair[1].toUpperCase()}/${pair[2].toUpperCase()}`
  const crypto = text.match(/\b(bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|xrp|ripple)\b/i)
  if (crypto) return CRYPTO[crypto[1].toLowerCase()]
  const words = text.match(/\b[A-Za-z]{1,5}\b/g) ?? []
  // Prefer a token that was written in capitals (AAPL, SPY, TSLA).
  for (const w of words) { const u = w.toUpperCase(); if (!NOT_SYMBOL.has(u) && w === u) return u }
  // Otherwise the first non-stopword 2–5 letter word (handles lowercase "analyze aapl").
  for (const w of words) { const u = w.toUpperCase(); if (!NOT_SYMBOL.has(u) && w.length >= 2) return u }
  return null
}

const TIMEFRAME: Record<string, string> = { hour: '1Hour', hourly: '1Hour', day: '1Day', daily: '1Day', week: '1Week', weekly: '1Week', minute: '1Min' }
function timeframeIn(text: string): string | undefined {
  const m = text.match(/\b(hourly|hour|daily|day|weekly|week|minute)\b/i)
  return m ? TIMEFRAME[m[1].toLowerCase()] : undefined
}
function riskIn(text: string): number | undefined {
  const m = text.match(/risk(?:ing)?\s*(\d+(?:\.\d+)?)\s*%?/i) ?? text.match(/(\d+(?:\.\d+)?)\s*%\s*risk/i)
  return m ? Number(m[1]) : undefined
}

export function parseTradingCommand(raw: string): TradingCommand | null {
  const text = raw.trim()
  if (!text || text.length > 200) return null
  const lower = text.toLowerCase()

  // Account / journal need no symbol.
  if (/\b(account|portfolio|positions|holdings|balance)\b/.test(lower) && /\b(my|practice|paper|account|portfolio|positions|holdings|balance|show|what)\b/.test(lower))
    return { tool: 'trading.account', params: {} }
  if (/\b(journal|trade history|my trades|past trades)\b/.test(lower))
    return { tool: 'trading.journal', params: {} }

  // News (symbol optional).
  if (/\bnews\b/.test(lower)) return { tool: 'trading.news', params: symbolIn(text) ? { symbol: symbolIn(text) } : {} }

  // Plan a trade — a buy/sell/long/short intent. Always a plan, never a direct order.
  const side = lower.match(/\b(buy|long)\b/) ? 'buy' : lower.match(/\b(sell|short)\b/) ? 'sell' : null
  if (side && (/\b(plan|set\s*up|setup|should i|thinking of|consider)\b/.test(lower) || /\b(buy|sell|long|short)\b/.test(lower))) {
    const symbol = symbolIn(text)
    if (symbol) return { tool: 'trading.plan', params: { symbol, side, ...(riskIn(text) !== undefined ? { riskPct: riskIn(text) } : {}), ...(timeframeIn(text) ? { timeframe: timeframeIn(text) } : {}) } }
  }

  // Analyze a chart — needs an explicit chart/analysis word to avoid catching plain questions.
  if (/\b(analy[sz]e|chart|technicals?|technical analysis|candles?)\b/.test(lower)) {
    const symbol = symbolIn(text)
    if (symbol) return { tool: 'trading.analyze', params: { symbol, ...(timeframeIn(text) ? { timeframe: timeframeIn(text) } : {}) } }
  }

  // Price / quote.
  if (/\b(price|quote|worth|cost|trading at)\b/.test(lower)) {
    const symbol = symbolIn(text)
    if (symbol) return { tool: 'trading.quote', params: { symbol } }
  }

  return null
}
