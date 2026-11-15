import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { Bar } from '../../../shared/strategy'
import { broker } from '../broker/service'
import { paperKeys } from '../broker/credentials'

/**
 * Where backtest bars come from.
 *
 * 1. Alpaca, through the existing `broker.bars` path, when a paper key is stored.
 * 2. A saved copy of the last successful read, when Alpaca cannot be reached.
 * 3. A synthetic series, clearly labelled as such, so the engine can still be exercised
 *    and tested. A synthetic result is never presented as a market result.
 */

export interface BarSet {
  bars: Bar[]
  source: 'alpaca' | 'cache' | 'synthetic'
  note: string
}

const cacheDir = () => path.join(app.getPath('userData'), 'strategy-bars')
const cacheFile = (symbol: string) => path.join(cacheDir(), `${symbol.replace(/[^A-Z.]/g, '')}.json`)

function readCache(symbol: string): Bar[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(symbol), 'utf8')) as { bars?: Bar[] }
    return Array.isArray(raw.bars) && raw.bars.length ? raw.bars : null
  } catch { return null }
}

function writeCache(symbol: string, bars: Bar[]): void {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true })
    fs.writeFileSync(cacheFile(symbol), JSON.stringify({ symbol, savedAt: new Date().toISOString(), bars }), { mode: 0o600 })
  } catch { /* a cache miss is not an error */ }
}

/** Deterministic pseudo-random walk. Same symbol and length always give the same bars. */
export function syntheticBars(symbol: string, count = 400, startPrice = 100): Bar[] {
  let seed = 0
  for (const ch of symbol) seed = (seed * 31 + ch.charCodeAt(0)) % 2_147_483_647
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  const bars: Bar[] = []
  let price = startPrice
  const day = new Date(Date.UTC(2024, 0, 2))
  for (let i = 0; i < count; i++) {
    // A slow cycle plus noise, so trends and ranges both appear.
    const drift = Math.sin(i / 40) * 0.0012 + 0.0002
    const shock = (rand() - 0.5) * 0.022
    const open = price
    const close = Math.max(1, open * (1 + drift + shock))
    const high = Math.max(open, close) * (1 + rand() * 0.008)
    const low = Math.min(open, close) * (1 - rand() * 0.008)
    bars.push({
      t: new Date(day.getTime() + i * 86_400_000).toISOString(),
      o: Number(open.toFixed(4)), h: Number(high.toFixed(4)),
      l: Number(low.toFixed(4)), c: Number(close.toFixed(4)),
      v: Math.round(1_000_000 + rand() * 4_000_000),
    })
    price = close
  }
  return bars
}

/**
 * Bars for a backtest. Never invents a live result: if Alpaca is not reachable the
 * source says so and the UI shows it.
 */
export async function loadBars(symbol: string, days = 400): Promise<BarSet> {
  const sym = String(symbol ?? '').trim().toUpperCase()
  if (!/^[A-Z][A-Z.]{0,9}$/.test(sym)) throw new Error(`"${symbol}" does not look like a stock symbol`)

  if (paperKeys()) {
    try {
      const bars = await broker().bars(sym, 'paper', days)
      if (bars.length) {
        writeCache(sym, bars)
        return { bars, source: 'alpaca', note: `${bars.length} daily bars from Alpaca for ${sym}.` }
      }
    } catch (err) {
      const cached = readCache(sym)
      if (cached) {
        return { bars: cached, source: 'cache', note: `Alpaca could not be read (${err instanceof Error ? err.message : String(err)}), so this uses the last saved copy of ${sym} from ${cached[0]?.t?.slice(0, 10) ?? 'an earlier read'}.` }
      }
      return { bars: syntheticBars(sym, days), source: 'synthetic', note: `Alpaca could not be read (${err instanceof Error ? err.message : String(err)}) and no saved copy exists, so this is a SYNTHETIC series for ${sym}. It is not market data.` }
    }
  }

  const cached = readCache(sym)
  if (cached) return { bars: cached, source: 'cache', note: `No Alpaca paper key is stored, so this uses the last saved copy of ${sym}.` }
  return {
    bars: syntheticBars(sym, days),
    source: 'synthetic',
    note: `No Alpaca paper key is stored, so this is a SYNTHETIC series for ${sym} — a deterministic random walk, not market data. Add a paper key in Trading to backtest real history.`,
  }
}
