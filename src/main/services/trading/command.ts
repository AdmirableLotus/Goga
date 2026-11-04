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
  // Common acronyms that are not tickers — especially this user's hardware/grant vocabulary,
  // so "buy a USB cable" or "analyze the ISFET" is never mistaken for a stock.
  'USB', 'LED', 'PCB', 'PCBA', 'BOM', 'BLE', 'IMU', 'PPG', 'ISFET', 'ADPD', 'DOF', 'SWD', 'RF',
  'CAD', 'STL', 'FMEA', 'API', 'CPU', 'GPU', 'RAM', 'ROM', 'SDK', 'LIPO', 'ECG', 'EEG', 'AFE',
  'ADC', 'DAC', 'MCU', 'IOT', 'OS', 'PC', 'TV', 'USA', 'UK', 'FAQ', 'PDF', 'CSV', 'DOC', 'NSF',
  'RFI', 'SBIR', 'STTR', 'NDA', 'CEO', 'CTO', 'FYI', 'ASAP', 'ETA', 'AKA', 'DIY', 'TODO', 'URL',
  'WIFI', 'GPS', 'SIM', 'PIN', 'ATM', 'ID', 'NEW', 'OLD', 'ONE', 'TWO', 'TOOL', 'TOOLS', 'TABLE',
])

const CRYPTO: Record<string, string> = {
  bitcoin: 'BTC/USD', btc: 'BTC/USD', ethereum: 'ETH/USD', eth: 'ETH/USD', solana: 'SOL/USD',
  sol: 'SOL/USD', dogecoin: 'DOGE/USD', doge: 'DOGE/USD', xrp: 'XRP/USD', ripple: 'XRP/USD',
}

/** An unambiguous symbol anywhere in the text: a forex/crypto pair, a crypto name, or a
 *  $-prefixed ticker. These are safe to match anywhere. Bare tickers are handled by adjacency. */
export function symbolIn(text: string): string | null {
  const pair = text.match(/\b([A-Za-z]{2,5})\/([A-Za-z]{3})\b/)
  if (pair) return `${pair[1].toUpperCase()}/${pair[2].toUpperCase()}`
  const crypto = text.match(/\b(bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|xrp|ripple)\b/i)
  if (crypto) return CRYPTO[crypto[1].toLowerCase()]
  const dollar = text.match(/\$([A-Za-z]{1,5})\b/)
  if (dollar) return dollar[1].toUpperCase()
  return null
}

/** A single candidate token → a symbol, or null. Used for verb-adjacent matches like "buy AAPL". */
function tokenSymbol(tok: string): string | null {
  const t = tok.trim()
  const pair = t.match(/^([A-Za-z]{2,5})\/([A-Za-z]{3})$/)
  if (pair) return `${pair[1].toUpperCase()}/${pair[2].toUpperCase()}`
  const c = t.toLowerCase().replace(/^\$/, '')
  if (CRYPTO[c]) return CRYPTO[c]
  const dollar = t.match(/^\$([A-Za-z]{1,5})$/)
  if (dollar) return dollar[1].toUpperCase()
  // A bare ticker must be ALL CAPS, 2–5 letters, and not a common acronym.
  if (/^[A-Z]{2,5}$/.test(t) && !NOT_SYMBOL.has(t)) return t
  return null
}

/** The symbol that an intent verb points at, e.g. "analyze AAPL", "buy 10 TSLA", "on EUR/USD". */
function symbolAfter(text: string, verbs: string): string | null {
  const re = new RegExp(`\\b(?:${verbs})\\b\\s+(?:to open\\s+|into\\s+|some\\s+|a\\s+|an\\s+|the\\s+|my\\s+|on\\s+|of\\s+|for\\s+|all\\s+|out\\s+|everything\\s+|whole\\s+|entire\\s+|\\d+(?:\\.\\d+)?\\s+(?:shares?\\s+|units?\\s+|coins?\\s+)?(?:of\\s+)?)*(\\$?[A-Za-z]{2,5}(?:\\/[A-Za-z]{3})?)\\b`, 'i')
  const m = text.match(re)
  return m ? tokenSymbol(m[1]) : null
}

const INDICATOR_WORDS = new Set(['RSI', 'SMA', 'EMA', 'ATR', 'MACD', 'VWAP', 'ETF', 'ETFS', 'USD', 'PNL', 'ROI', 'IPO', 'EPS', 'GTC'])

/** The symbol in Goga's own trade proposal ("…analysis for AAPL and place a buy order?"). */
export function proposalSymbol(text: string): string | null {
  const near = symbolAfter(text, 'buy|sell|analy[sz]e|analysis (?:of|for|on)|for|on')
  if (near && !INDICATOR_WORDS.has(near)) return near
  const clear = symbolIn(text)
  if (clear) return clear
  const bare = (text.match(/\b[A-Z]{2,5}\b/g) ?? []).find(t => !NOT_SYMBOL.has(t) && !INDICATOR_WORDS.has(t))
  return bare ?? null
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

const RECURRENCE = /\b(every (hour|day|morning|evening|night|\d+ ?(min|mins|minutes|hours?))|hourly|daily|on your own|by yourself|keep an eye|keep watching|monitor|watch (it|the account|my account|my trades))\b/
function hasRecurrence(lower: string): boolean { return RECURRENCE.test(lower) }
const TRADING_TOPIC = /\b(alpaca|paper (trading|account)|trading account|my account|portfolio|positions|my trades|balance)\b/i

/**
 * "Review it on your own every hour" about the trading account. Goga already does this in
 * the background; say what really runs, instead of promising a schedule that doesn't exist.
 * `context` is the earlier messages, so "it" can refer to Alpaca mentioned a moment ago.
 */
export function isTradingScheduleRequest(message: string, context: string[] = []): boolean {
  const lower = message.toLowerCase()
  if (message.length > 200 || !hasRecurrence(lower)) return false
  return TRADING_TOPIC.test(message) || (/\b(it|that|this|them)\b/.test(lower) && context.some(c => TRADING_TOPIC.test(c)))
}

export function tradingScheduleReply(watching: boolean, autoTrading: boolean): string {
  const lines = [
    watching
      ? '- Every 5 minutes I check the paper account and tell you right away about fills, stops or targets hit, and big moves.'
      : '- My account watcher is off. Turn on "Watch my paper trades" in the tray menu and I\'ll check every 5 minutes.',
    autoTrading
      ? '- Every 15 minutes I review my own practice trades: look for fresh signals, manage open trades, and learn from closed ones.'
      : '- My own practice trading is off ("Let Goga trade on paper to learn" in the tray menu).',
    '- After 5 pm I post a daily summary of what I did.',
  ]
  return `I already review it on my own, more often than hourly:\n${lines.join('\n')}\n\nHere's how it looks right now:`
}

export function parseTradingCommand(raw: string): TradingCommand | null {
  const text = raw.trim()
  if (!text || text.length > 200) return null
  const lower = text.toLowerCase()

  // "cancel order 7d2f460f" — an order id (or its first 8+ characters) from the account view.
  const cancel = text.match(/\bcancel (?:the )?order\s+([0-9a-f]{8}(?:-[0-9a-f-]{1,28})?)\b/i)
  if (cancel) return { tool: 'trading.cancel', params: { orderId: cancel[1].toLowerCase() } }

  // "is the market open?" — about trading hours, not an account/position/order question.
  if (/\b(stock market|markets?|exchange|nyse|nasdaq)\b/.test(lower) && /\b(open|closed|close|hours?)\b/.test(lower)
    && !/\b(account|position|holdings?|order|buy|sell|news|price|quote)\b/.test(lower))
    return { tool: 'trading.clock', params: {} }

  // Account / journal / connection status need no symbol.
  if ((/\b(account|portfolio|positions|holdings|balance|buying power)\b/.test(lower) && /\b(my|practice|paper|account|portfolio|positions|holdings|balance|show|what)\b/.test(lower))
    || /\b(my (trading|paper) (progress|status|results)|(are we|am i) connected to alpaca|alpaca (status|connected))\b/.test(lower)
    // "how is alpaca", "check alpaca" — but never key setup, which belongs in Settings.
    || (/\balpaca\b/.test(lower) && !/\b(keys?|secret|api|password|sign ?up|log ?in)\b/.test(lower) && !hasRecurrence(lower)))
    return { tool: 'trading.account', params: {} }
  if (/\b(journal|trade history|my trades|past trades)\b/.test(lower))
    return { tool: 'trading.journal', params: {} }

  // Practice / backtest sweep — explicit phrases only, so it doesn't catch "practice account".
  if (!/\baccount\b/.test(lower) && /\b(trading practice|practice trading|run (a )?practice|backtest (sweep|everything|all|my watchlist)|what (strategy|strategies) works?|which strateg\w+)\b/.test(lower))
    return { tool: 'trading.practice', params: {} }

  // News — for a named symbol (adjacent or unambiguous), or an explicit "market/stock/crypto news".
  if (/\bnews\b/.test(lower)) {
    const symbol = symbolAfter(text, 'news|on|about|for') ?? symbolIn(text)
    if (symbol) return { tool: 'trading.news', params: { symbol } }
    if (/\b(market|stock|stocks|crypto|financial|trading)\s+news\b/.test(lower)) return { tool: 'trading.news', params: {} }
  }

  // Close a whole position: "sell all my AAPL", "close out BTC", "exit my EUR/USD", "dump TSLA".
  // Checked before the buy/sell plan below so "sell all my AAPL" closes rather than opens a sell.
  if (/\b(close|exit|liquidate|dump|flatten|get out of|sell (?:all|everything|it all|my (?:whole|entire)))\b/.test(lower)) {
    const symbol = symbolAfter(text, 'close|exit|liquidate|dump|flatten|get out of|out of|sell|out|of') ?? symbolIn(text)
    if (symbol) return { tool: 'trading.close', params: { symbol } }
  }

  // Plan a trade. Symbol must sit right after the buy/sell verb ("buy AAPL"), or be an
  // unambiguous pair/crypto/$ticker — so "what to buy for the QFN PCB" never trades.
  if (/\b(buy|sell|long|short|plan a (buy|sell|trade)|go (long|short))\b/.test(lower)) {
    const side = /\b(buy|long)\b/.test(lower) ? 'buy' : 'sell'
    const symbol = symbolAfter(text, 'buy|sell|long|short|on') ?? symbolIn(text)
    if (symbol) return { tool: 'trading.plan', params: { symbol, side, ...(riskIn(text) !== undefined ? { riskPct: riskIn(text) } : {}), ...(timeframeIn(text) ? { timeframe: timeframeIn(text) } : {}) } }
  }

  // Analyze a chart — the symbol must follow the analyze/chart word, or be a clear pair/crypto.
  if (/\b(analy[sz]e|chart|technicals?|technical analysis|candles?)\b/.test(lower)) {
    const symbol = symbolAfter(text, 'analy[sz]e|chart|chart of|on|of|for') ?? symbolIn(text)
    if (symbol) return { tool: 'trading.analyze', params: { symbol, ...(timeframeIn(text) ? { timeframe: timeframeIn(text) } : {}) } }
  }

  // Price / quote — likewise verb-adjacent or an unambiguous symbol.
  if (/\b(price|quote|worth|cost|trading at)\b/.test(lower)) {
    const symbol = symbolAfter(text, 'price|quote|worth|cost|of|for|on') ?? symbolIn(text)
    if (symbol) return { tool: 'trading.quote', params: { symbol } }
  }

  return null
}
