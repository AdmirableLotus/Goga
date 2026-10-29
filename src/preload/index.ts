import { contextBridge, ipcRenderer } from 'electron'
import type { MainHandlers, RendererEvents, RendererChannel } from '../shared/ipc'

type Handler<T extends keyof MainHandlers> = MainHandlers[T]

const api = {
  markets: {
    state: (): ReturnType<MainHandlers['markets:state']> => ipcRenderer.invoke('markets:state'),
    importCsv: (symbol: string, csv: string): ReturnType<MainHandlers['markets:import']> => ipcRenderer.invoke('markets:import', symbol, csv),
    watchlist: (symbols: string[]): ReturnType<MainHandlers['markets:watchlist']> => ipcRenderer.invoke('markets:watchlist', symbols),
    backtest: (config: import('../shared/markets').BacktestRequest): ReturnType<MainHandlers['markets:backtest']> => ipcRenderer.invoke('markets:backtest', config),
  },
  invoke<T extends keyof MainHandlers>(
    channel: T,
    ...args: Parameters<Handler<T>>
  ): ReturnType<Handler<T>> {
    return ipcRenderer.invoke(channel, ...args) as ReturnType<Handler<T>>
  },

  on<T extends RendererChannel>(
    channel: T,
    listener: (payload: RendererEvents[T]) => void
  ) {
    const wrapped = (_: Electron.IpcRendererEvent, payload: RendererEvents[T]) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },

  // One-time listener
  once<T extends RendererChannel>(
    channel: T,
    listener: (payload: RendererEvents[T]) => void
  ) {
    const wrapped = (_: Electron.IpcRendererEvent, payload: RendererEvents[T]) => listener(payload)
    ipcRenderer.once(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('goga', api)

export type GogaAPI = typeof api
