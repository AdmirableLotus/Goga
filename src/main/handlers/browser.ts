import type { IpcMain } from 'electron'
import type { ElementQuery } from '../../shared/browser'
import type { VenueId } from '../../shared/venues'
import { browserLayer } from '../services/browser/layer'
import { correctRecipe, forgetRecipe, learnCurrentPage, readRecipes } from '../services/browser/recipes'
import { approvalGate } from '../services/venues/guard'
import { readHalt, readVenueEvents, setHalt } from '../services/venues/state'
import { analyse, closeTrade, latestTrades, readTrades } from '../services/venues/journal'
import { preparePivexOrder, readPivex, readPivexQuote, sendPivexOrder } from '../services/venues/pivex'
import { prepareAlpacaOrder, readAlpacaPaper, readAlpacaQuote, sendAlpacaOrder } from '../services/venues/alpaca'
import { readStudyBase } from '../services/venues/study'
import { VENUES } from '../../shared/venues'

/**
 * IPC for the browser layer and the two venues.
 *
 * Every handler runs in main. The renderer can read, prepare and approve, but it cannot
 * send an order without the shared gate having a matching approval, and it cannot reach
 * the browser except through these primitives.
 */

export function registerBrowserHandlers(ipcMain: IpcMain) {
  const layer = browserLayer()

  ipcMain.handle('browser:status', async () => layer.status())
  ipcMain.handle('browser:start', async (_e, url?: string) => layer.start(typeof url === 'string' ? url : undefined))
  ipcMain.handle('browser:attach', async () => layer.attach())
  ipcMain.handle('browser:detach', async () => layer.detach())
  ipcMain.handle('browser:tabs', async () => layer.listTabs())
  ipcMain.handle('browser:selectTab', async (_e, id: string) => layer.selectTab(String(id)))
  ipcMain.handle('browser:navigate', async (_e, url: string) => layer.navigate(String(url)))
  ipcMain.handle('browser:readPage', async () => layer.readPage())
  ipcMain.handle('browser:find', async (_e, query: ElementQuery) => layer.findElement(query))
  ipcMain.handle('browser:click', async (_e, query: ElementQuery) => layer.click(query))
  ipcMain.handle('browser:type', async (_e, query: ElementQuery, text: string) => layer.type(query, String(text)))
  ipcMain.handle('browser:readValue', async (_e, query: ElementQuery) => layer.readValue(query))
  ipcMain.handle('browser:waitForText', async (_e, text: string, exact?: boolean, timeoutMs?: number) =>
    layer.waitForText(String(text), !!exact, Number(timeoutMs) || undefined))
  ipcMain.handle('browser:waitForElement', async (_e, query: ElementQuery, timeoutMs?: number) =>
    layer.waitForElement(query, Number(timeoutMs) || undefined))
  ipcMain.handle('browser:screenshot', async () => layer.screenshot())

  // Site learning
  ipcMain.handle('browser:recipes', async () => readRecipes())
  ipcMain.handle('browser:learn', async () => learnCurrentPage())
  ipcMain.handle('browser:correctRecipe', async (_e, host: string, notes: string) => correctRecipe(String(host), String(notes ?? '')))
  ipcMain.handle('browser:forgetRecipe', async (_e, host: string) => { forgetRecipe(String(host)); return readRecipes() })
}

export function registerVenueHandlers(ipcMain: IpcMain) {
  // ── Venue descriptions and state ────────────────────────────────────────────
  ipcMain.handle('venue:info', async () => VENUES)
  ipcMain.handle('venue:halt', async (_e, venue: VenueId, halted: boolean, reason: string) =>
    setHalt(venue === 'pivex' ? 'pivex' : 'alpaca-paper', !!halted, String(reason ?? '')))
  ipcMain.handle('venue:events', async (_e, limit?: number) => readVenueEvents(Number(limit) || 200))

  // ── Pivex ───────────────────────────────────────────────────────────────────
  ipcMain.handle('venue:pivexRead', async () => readPivex())
  ipcMain.handle('venue:pivexQuote', async (_e, symbol: string) => readPivexQuote(String(symbol)))
  ipcMain.handle('venue:pivexPrepare', async (_e, input: Parameters<typeof preparePivexOrder>[0]) => preparePivexOrder(input))
  ipcMain.handle('venue:pivexSend', async (_e, ticketId: string) => sendPivexOrder(String(ticketId)))

  // ── Alpaca paper ────────────────────────────────────────────────────────────
  ipcMain.handle('venue:alpacaRead', async () => readAlpacaPaper())
  ipcMain.handle('venue:alpacaQuote', async (_e, symbol: string) => readAlpacaQuote(String(symbol)))
  ipcMain.handle('venue:alpacaPrepare', async (_e, input: Parameters<typeof prepareAlpacaOrder>[0]) => prepareAlpacaOrder(input))
  ipcMain.handle('venue:alpacaSend', async (_e, ticketId: string) => sendAlpacaOrder(String(ticketId)))

  // ── The shared gate ─────────────────────────────────────────────────────────
  ipcMain.handle('venue:approve', async (_e, ticketId: string, approved: boolean) =>
    approvalGate.decide(String(ticketId), !!approved))
  ipcMain.handle('venue:ticket', async (_e, ticketId: string) => approvalGate.peek(String(ticketId)))

  // ── The shared learning loop ────────────────────────────────────────────────
  ipcMain.handle('venue:stats', async (_e, venue: VenueId) =>
    analyse(latestTrades(readTrades()), venue === 'pivex' ? 'pivex' : 'alpaca-paper'))
  ipcMain.handle('venue:trades', async (_e, limit?: number) => latestTrades(readTrades(Number(limit) || 500)))
  ipcMain.handle('venue:closeTrade', async (_e, venue: VenueId, symbol: string, exitPrice: number, contractSize?: number) =>
    closeTrade(venue === 'pivex' ? 'pivex' : 'alpaca-paper', String(symbol), Number(exitPrice), Number(contractSize) || 1))

  // ── Study base ──────────────────────────────────────────────────────────────
  ipcMain.handle('venue:studyBase', async () => readStudyBase())
  ipcMain.handle('venue:haltState', async (_e, venue: VenueId) => readHalt(venue === 'pivex' ? 'pivex' : 'alpaca-paper'))
}
