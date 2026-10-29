import type { Bar } from './indicators'

/**
 * Real market data. US stocks, ETFs and crypto come from Alpaca (stocks need the user's free
 * Alpaca keys; crypto needs none). Forex comes from the European Central Bank's daily
 * reference rates through Frankfurter, which has no intraday prices.
 */

export type Market = 'stock' | 'crypto' | 'forex'
export interface Instrument { symbol: string; market: Market }
export interface Quote { symbol: string; market: Market; price: number; bid?: number; ask?: number; dayChangePct?: number; time: string; source: string }
export interface NewsItem { time: string; headline: string; summary: string; source: string; url: string }
export interface AlpacaKeys { keyId: string; secret: string }

export const TIMEFRAMES = ['1Min', '5Min', '15Min', '1Hour', '4Hour', '1Day', '1Week'] as const
export type Timeframe = typeof TIMEFRAMES[number]

const DATA = 'https://data.alpaca.markets'
const FX = 'https://api.frankfurter.dev/v1'
const BARS_WANTED = 300

const CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'DOGE', 'LTC', 'AVAX', 'LINK', 'UNI', 'AAVE', 'DOT', 'XRP', 'BCH', 'SHIB', 'USDC', 'USDT', 'ADA', 'MATIC', 'XTZ', 'GRT', 'MKR', 'SUSHI', 'YFI', 'BAT', 'CRV', 'PEPE', 'TRUMP', 'ARB', 'ONDO', 'POL', 'RENDER', 'HYPE', 'SKY', 'WIF', 'FIL'])
const FIAT = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'ZAR', 'MXN', 'BRL', 'CNY', 'HKD', 'SGD', 'KRW', 'INR', 'IDR', 'ILS', 'THB', 'PHP', 'MYR', 'ISK', 'RON', 'BGN'])

/** "btc" → BTC/USD crypto, "eurusd" → EUR/USD forex, "aapl" → AAPL stock. */
export function instrument(raw: string): Instrument {
  const s = String(raw ?? '').trim().toUpperCase().replace(/[-_ ]/g, '/').replace(/\/+/g, '/')
  if (!s) throw new Error('no symbol given')
  let [base, quote]: (string | undefined)[] = s.split('/')
  if (!quote) {
    // "BTCUSD": a known coin followed by what it is priced in
    const suffix = ['USDT', 'USDC', 'USD', 'BTC'].find(q => s.endsWith(q) && CRYPTO.has(s.slice(0, -q.length)))
    if (suffix) { base = s.slice(0, -suffix.length); quote = suffix }
  }
  base = base ?? s
  if (CRYPTO.has(base) && (!quote || /^(USD|USDT|USDC|BTC)$/.test(quote))) return { symbol: `${base}/${quote ?? 'USD'}`, market: 'crypto' }
  if (/^[A-Z]{6}$/.test(s) && FIAT.has(s.slice(0, 3)) && FIAT.has(s.slice(3))) return { symbol: `${s.slice(0, 3)}/${s.slice(3)}`, market: 'forex' }
  if (quote && FIAT.has(base) && FIAT.has(quote)) return { symbol: `${base}/${quote}`, market: 'forex' }
  if (/^[A-Z][A-Z.]{0,9}$/.test(s)) return { symbol: s, market: 'stock' }
  throw new Error(`"${raw}" is not a symbol Goga knows (stocks like AAPL, crypto like BTC/USD, forex like EUR/USD)`)
}

// How far back to ask so that about BARS_WANTED bars come back (stock markets close; crypto does not).
const DAYS_BACK: Record<Timeframe, { stock: number; crypto: number }> = {
  '1Min': { stock: 3, crypto: 0.25 }, '5Min': { stock: 8, crypto: 1.1 }, '15Min': { stock: 22, crypto: 3.2 },
  '1Hour': { stock: 90, crypto: 13 }, '4Hour': { stock: 330, crypto: 51 }, '1Day': { stock: 450, crypto: 301 }, '1Week': { stock: 2200, crypto: 2200 },
}

export function timeframe(raw: unknown): Timeframe {
  const s = String(raw ?? '1Day').toLowerCase().replace(/\s+/g, '')
  const map: Record<string, Timeframe> = { '1m': '1Min', '1min': '1Min', '5m': '5Min', '5min': '5Min', '15m': '15Min', '15min': '15Min', '1h': '1Hour', '1hour': '1Hour', 'hour': '1Hour', 'hourly': '1Hour', '4h': '4Hour', '4hour': '4Hour', '1d': '1Day', '1day': '1Day', 'day': '1Day', 'daily': '1Day', '1w': '1Week', '1week': '1Week', 'week': '1Week', 'weekly': '1Week' }
  return map[s] ?? '1Day'
}

type Fetch = typeof fetch

export class MarketData {
  constructor(private keys: () => AlpacaKeys | null, private http: Fetch = fetch) {}

  async quote(raw: string): Promise<Quote> {
    const inst = instrument(raw)
    if (inst.market === 'forex') {
      const [base, quote] = inst.symbol.split('/')
      const r = await this.json(`${FX}/latest?base=${base}&symbols=${quote}`)
      return { ...inst, price: r.rates[quote], time: r.date, source: 'European Central Bank daily reference rate (not live)' }
    }
    const snap = inst.market === 'crypto'
      ? (await this.json(`${DATA}/v1beta3/crypto/us/snapshots?symbols=${encodeURIComponent(inst.symbol)}`)).snapshots?.[inst.symbol]
      : await this.json(`${DATA}/v2/stocks/${inst.symbol}/snapshot?feed=iex`, true)
    if (!snap?.latestTrade) throw new Error(`no price found for ${inst.symbol}`)
    const prev = snap.prevDailyBar?.c
    const price = snap.latestTrade.p
    return {
      ...inst, price,
      bid: snap.latestQuote?.bp || undefined, ask: snap.latestQuote?.ap || undefined,
      dayChangePct: prev ? (price / prev - 1) * 100 : undefined,
      time: snap.latestTrade.t,
      source: inst.market === 'crypto' ? 'Alpaca crypto (live)' : 'Alpaca, IEX exchange feed (live)',
    }
  }

  async bars(raw: string, tf: Timeframe): Promise<{ inst: Instrument; tf: Timeframe; bars: Bar[] }> {
    const inst = instrument(raw)
    if (inst.market === 'forex') return { inst, tf: '1Day', bars: await this.fxBars(inst.symbol) }
    const start = new Date(Date.now() - DAYS_BACK[tf][inst.market === 'crypto' ? 'crypto' : 'stock'] * 86_400_000).toISOString()
    const bars: Bar[] = []
    let page: string | undefined
    for (let i = 0; i < 5; i++) {
      const token = page ? `&page_token=${encodeURIComponent(page)}` : ''
      const r = inst.market === 'crypto'
        ? await this.json(`${DATA}/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(inst.symbol)}&timeframe=${tf}&start=${start}&limit=10000${token}`)
        : await this.json(`${DATA}/v2/stocks/${inst.symbol}/bars?timeframe=${tf}&start=${start}&limit=10000&adjustment=split&feed=iex${token}`, true)
      const got = (inst.market === 'crypto' ? r.bars?.[inst.symbol] : r.bars) ?? []
      bars.push(...got.map((b: Bar) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })))
      page = r.next_page_token
      if (!page) break
    }
    return { inst, tf, bars: bars.slice(-BARS_WANTED) }
  }

  async news(raw: string | undefined, limit = 8): Promise<NewsItem[]> {
    const symbols = raw ? `symbols=${encodeURIComponent(instrument(raw).symbol.replace('/', ''))}&` : ''
    const r = await this.json(`${DATA}/v1beta1/news?${symbols}limit=${Math.min(limit, 20)}`, true)
    return (r.news ?? []).map((n: { created_at: string; headline: string; summary?: string; source?: string; url?: string }) => ({
      time: n.created_at, headline: n.headline, summary: (n.summary ?? '').slice(0, 300), source: n.source ?? '', url: n.url ?? '',
    }))
  }

  private async fxBars(symbol: string): Promise<Bar[]> {
    const [base, quote] = symbol.split('/')
    const start = new Date(Date.now() - 450 * 86_400_000).toISOString().slice(0, 10)
    const r = await this.json(`${FX}/${start}..?base=${base}&symbols=${quote}`)
    return Object.entries(r.rates as Record<string, Record<string, number>>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, rates]) => { const c = rates[quote]; return { t: `${day}T00:00:00Z`, o: c, h: c, l: c, c, v: 0 } })
      .slice(-BARS_WANTED)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async json(url: string, needsKeys = false): Promise<any> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const keys = this.keys()
    if (needsKeys && !keys) throw new Error('US stock data and news need Alpaca keys — add them in Settings → Trading (free at alpaca.markets)')
    if (keys && url.startsWith(DATA)) { headers['APCA-API-KEY-ID'] = keys.keyId; headers['APCA-API-SECRET-KEY'] = keys.secret }
    const res = await this.http(url, { headers, signal: AbortSignal.timeout(20_000) })
    if (res.status === 401 || res.status === 403) throw new Error('Alpaca refused the keys — check them in Settings → Trading')
    if (!res.ok) throw new Error(`market data error ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return res.json()
  }
}
