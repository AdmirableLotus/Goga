import type { IpcMain } from 'electron'
import { MarketsService } from '../services/markets'
export function registerMarketsHandlers(ipcMain: IpcMain) {
  ipcMain.handle('markets:state', () => MarketsService.getInstance().state())
  ipcMain.handle('markets:import', (_, symbol: unknown, csv: unknown) => MarketsService.getInstance().importCsv(symbol, csv))
  ipcMain.handle('markets:watchlist', (_, symbols: unknown) => MarketsService.getInstance().watchlist(symbols))
  ipcMain.handle('markets:backtest', (_, config: unknown) => MarketsService.getInstance().run(config))
}
