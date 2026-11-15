import type { IpcMain } from 'electron'
import type { BrokerMode } from '../../shared/broker'
import { broker } from '../services/broker/service'
import { saveLiveKeys, liveKeys, paperKeys } from '../services/broker/credentials'
import { saveAlpacaKeys } from '../services/trading/desk'

/**
 * Broker IPC. Every handler runs in the main process; the renderer only ever asks.
 * The renderer cannot switch live trading on, clear the kill switch, or send an order
 * without going through the checks in BrokerService.
 */

export function registerBrokerHandlers(ipcMain: IpcMain) {
  ipcMain.handle('broker:snapshot', async (_e, mode: BrokerMode) => broker().snapshot(mode === 'live' ? 'live' : 'paper'))
  ipcMain.handle('broker:prepare', async (_e, input: Parameters<ReturnType<typeof broker>['prepareOrder']>[0]) => broker().prepareOrder(input))
  ipcMain.handle('broker:approve', async (_e, intentId: string, approved: boolean) => broker().approveIntent(String(intentId), !!approved))
  ipcMain.handle('broker:send', async (_e, intentId: string) => broker().sendOrder(String(intentId)))
  ipcMain.handle('broker:kill', async (_e, mode: BrokerMode, reason: string) => broker().killSwitch(mode === 'live' ? 'live' : 'paper', String(reason ?? '')))
  ipcMain.handle('broker:clearKill', async () => broker().clearKillSwitch())
  ipcMain.handle('broker:setLive', async (_e, enabled: boolean, phrase: string) => broker().setLiveEnabled(!!enabled, String(phrase ?? '')))
  ipcMain.handle('broker:audit', async (_e, limit: number) => broker().audit(Number(limit) || 100))
  ipcMain.handle('broker:limits', async () => broker().snapshot('paper').then(s => s.limits))

  ipcMain.handle('broker:savePaperKeys', async (_e, keyId: string, secret: string) => {
    const id = String(keyId ?? '').trim(), key = String(secret ?? '').trim()
    if (!/^PK[A-Z0-9]{10,40}$/.test(id)) return { ok: false, error: 'A paper key id starts with PK. Goga will not store anything else there.' }
    if (key.length < 20) return { ok: false, error: 'That secret looks too short to be an Alpaca secret key.' }
    saveAlpacaKeys({ keyId: id, secret: key })
    return { ok: true, error: null }
  })
  ipcMain.handle('broker:saveLiveKeys', async (_e, keyId: string, secret: string) => {
    const id = String(keyId ?? '').trim(), key = String(secret ?? '').trim()
    if (!/^AK[A-Z0-9]{10,40}$/.test(id)) return { ok: false, error: 'A live key id starts with AK.' }
    if (key.length < 20) return { ok: false, error: 'That secret looks too short to be an Alpaca secret key.' }
    try { saveLiveKeys({ keyId: id, secret: key }) } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
    return { ok: true, error: null }
  })
  ipcMain.handle('broker:forgetLiveKeys', async () => { saveLiveKeys(null); return { ok: true } })
  ipcMain.handle('broker:keyState', async () => ({ paper: !!paperKeys(), live: !!liveKeys() }))
}
