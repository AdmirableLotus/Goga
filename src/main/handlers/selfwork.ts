import type { IpcMain } from 'electron'
import { SelfWorkService } from '../services/selfwork/service'

/**
 * The code-work page bridge.
 *
 * Every handler runs in main. The renderer can read, search and propose freely, and it can
 * approve or discard a proposal — but an apply only ever happens through the gate, and only
 * for a proposal the user approved. There is no handler that commits, pushes, deploys or
 * reloads, because there is no such method to call.
 */

export function registerSelfWorkHandlers(ipcMain: IpcMain) {
  const work = () => SelfWorkService.getInstance()

  ipcMain.handle('selfwork:state', async () => work().state())
  ipcMain.handle('selfwork:files', async () => work().listFiles())
  ipcMain.handle('selfwork:read', async (_e, path: string, start?: number, count?: number) =>
    work().read(String(path), Number(start) || 1, Number(count) || 160))
  ipcMain.handle('selfwork:search', async (_e, query: string, max?: number) =>
    work().search(String(query), Number(max) || 40))

  ipcMain.handle('selfwork:propose', async (_e, input: { path: string; summary: string; after: string; operation?: 'write' | 'patch' | 'delete' }) =>
    work().propose({ ...input, path: String(input.path), summary: String(input.summary ?? '') }))
  ipcMain.handle('selfwork:proposePatch', async (_e, input: { path: string; summary: string; find: string; replace: string }) =>
    work().proposePatch({
      path: String(input.path), summary: String(input.summary ?? ''),
      find: String(input.find ?? ''), replace: String(input.replace ?? ''),
    }))
  ipcMain.handle('selfwork:proposeDelete', async (_e, input: { path: string; summary: string }) =>
    work().proposeDelete({ path: String(input.path), summary: String(input.summary ?? '') }))

  ipcMain.handle('selfwork:decide', async (_e, id: string, approved: boolean) => work().decide(String(id), !!approved))
  ipcMain.handle('selfwork:apply', async (_e, id: string) => work().apply(String(id)))
  ipcMain.handle('selfwork:revert', async (_e, id: string) => work().revert(String(id)))

  ipcMain.handle('selfwork:check', async (_e, only?: ('build' | 'typecheck' | 'tests')[]) =>
    work().runChecks(undefined, Array.isArray(only) && only.length ? only : undefined))
  ipcMain.handle('selfwork:resetRepairs', async () => work().resetRepairs())
}
