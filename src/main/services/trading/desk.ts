import fs from 'fs'
import path from 'path'
import { app, safeStorage } from 'electron'
import { SettingsService } from '../settings'
import { MarketData, type AlpacaKeys } from './marketData'
import { PaperTrading } from './paperTrading'

/** Goga's trading desk: market data and the practice accounts, sharing the user's Alpaca keys. */

const keysFile = () => path.join(app.getPath('userData'), 'alpaca-keys.bin')
let cached: AlpacaKeys | null | undefined

export function alpacaKeys(): AlpacaKeys | null {
  if (cached !== undefined) return cached
  try { cached = JSON.parse(safeStorage.decryptString(fs.readFileSync(keysFile()))) } catch { cached = null }
  return cached ?? null
}

/** The keys are only ever stored encrypted with the Windows account's key. */
export function saveAlpacaKeys(keys: AlpacaKeys | null): void {
  if (!keys) { try { fs.unlinkSync(keysFile()) } catch { /* none saved */ } cached = null; return }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('secure storage is not available on this PC')
  fs.writeFileSync(keysFile(), safeStorage.encryptString(JSON.stringify(keys)), { mode: 0o600 })
  cached = keys
}

let data: MarketData | null = null
let paper: PaperTrading | null = null

export function marketData(): MarketData {
  return data ??= new MarketData(alpacaKeys)
}

/** The user's practice-trade risk limits from settings. */
export function tradingLimits() {
  const s = SettingsService.getInstance().get()
  return { maxPositionPct: s.tradingMaxPositionPct ?? 10, requireStop: s.tradingRequireStop ?? true, dailyLossPct: s.tradingDailyLossPct ?? 3 }
}

export function paperTrading(): PaperTrading {
  return paper ??= new PaperTrading({
    keys: alpacaKeys,
    data: marketData(),
    limits: () => {
      const s = SettingsService.getInstance().get()
      return { maxPositionPct: s.tradingMaxPositionPct ?? 10, requireStop: s.tradingRequireStop ?? true, dailyLossPct: s.tradingDailyLossPct ?? 3 }
    },
    journalFile: path.join(app.getPath('userData'), 'trading-journal.json'),
    fxFile: path.join(app.getPath('userData'), 'forex-practice.json'),
  })
}
