import type { IpcMain } from 'electron'
import { alpacaKeys, paperTrading, saveAlpacaKeys } from '../services/trading/desk'

export interface TradingStatus { hasKeys: boolean; paperValue: number | null; error: string | null }

async function status(): Promise<TradingStatus> {
  if (!alpacaKeys()) return { hasKeys: false, paperValue: null, error: null }
  try {
    const alpaca = (await paperTrading().accounts()).find(a => a.name.startsWith('Alpaca'))
    return { hasKeys: true, paperValue: alpaca?.equity ?? null, error: null }
  } catch (err) {
    return { hasKeys: true, paperValue: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerTradingHandlers(ipcMain: IpcMain) {
  ipcMain.handle('trading:status', async () => status())
  ipcMain.handle('trading:saveKeys', async (_e, keyId: string, secret: string) => {
    const id = String(keyId ?? '').trim(), key = String(secret ?? '').trim()
    if (!/^[A-Z0-9]{16,40}$/.test(id) || key.length < 20) return { hasKeys: false, paperValue: null, error: 'Those do not look like Alpaca keys' }
    // Paper keys start with PK; live keys (AK) are refused so real money is never in reach.
    if (!id.startsWith('PK')) return { hasKeys: false, paperValue: null, error: 'Use the PAPER trading keys (the key ID starts with PK)' }
    saveAlpacaKeys({ keyId: id, secret: key })
    const s = await status()
    if (s.error) saveAlpacaKeys(null)
    return s
  })
  ipcMain.handle('trading:forgetKeys', async () => { saveAlpacaKeys(null); return status() })
}
