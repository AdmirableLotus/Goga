import type { IpcMain } from 'electron'
import type { StrategyId, StrategyParams, StrategySettings } from '../../shared/strategy'
import { strategyService, writeStrategySettings } from '../services/strategy/service'

/**
 * Strategy IPC. All of it runs in the main process; the renderer only asks.
 *
 * There is deliberately no channel here that sends a live order. The paper loop prepares
 * paper orders only, and the two approval channels act on the one paper intent the loop
 * is holding.
 */

export function registerStrategyHandlers(ipcMain: IpcMain) {
  ipcMain.handle('strategy:state', async () => strategyService().state())
  ipcMain.handle('strategy:backtest', async (_e, input: { strategyId: StrategyId; symbol: string; params?: StrategyParams; days?: number }) =>
    strategyService().backtest(input))
  ipcMain.handle('strategy:review', async (_e, strategyId: string, symbol: string) =>
    strategyService().review(String(strategyId), String(symbol).toUpperCase()))
  ipcMain.handle('strategy:saveSettings', async (_e, patch: Partial<StrategySettings>) => {
    writeStrategySettings(patch)
    return strategyService().state()
  })
  ipcMain.handle('strategy:setPaperRun', async (_e, enabled: boolean) => strategyService().setPaperRun(!!enabled))
  ipcMain.handle('strategy:setAutoApprove', async (_e, enabled: boolean) => strategyService().setAutoApprovePaper(!!enabled))
  ipcMain.handle('strategy:runOnce', async () => strategyService().tick())
  ipcMain.handle('strategy:approvePending', async () => strategyService().approvePending())
  ipcMain.handle('strategy:discardPending', async () => strategyService().discardPending())
  ipcMain.handle('strategy:journal', async (_e, limit?: number) => strategyService().journal(Number(limit) || 200))
}
