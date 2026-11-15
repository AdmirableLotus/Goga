import type { IpcMain } from 'electron'
import { dialog } from 'electron'
import fs from 'fs'
import type { ConnectionId, PlayTrack, Storefront, TesterApp, TesterState } from '../../shared/business'
import {
  addCandidate, addMonitoredApp, addTrackedApp, buildNow, businessState, checkAllApps, checkAppNow, connectionAccounts,
  connectBluesky, connectMastodon, connectPrintful, connectShopify, deny, disconnect, editTrackedApp, executeApproved,
  forgetApp, forgetCandidate, forgetCopyDraft, forgetTrackedApp, gmailAuthPending, gmailAuthUrl, prepareListing, prepareMail,
  preparePost, prepareTesterInvite, refreshDigest, refreshPage, removeListingDraft, removePostDraft,
  runNow, saveCopyDraft, saveProfile, setCandidateOptInDate, setCandidateState, stopNow,
  playCheckAccess, playReadBaseline, playState, storePlayKey, forgetPlayKey,
} from '../services/business/service'
import { prepareSubmission } from '../services/business/playService'
import { listSearches } from '../services/business/store'

/**
 * Business page bridge.
 *
 * Every `prepare*` handler only ever queues a PendingAction with its full content.
 * `business:approve` is the ONLY handler that sends anything, and it sends exactly one
 * action, for which it must be given that action's id. A release upload follows the same
 * rule: `business:playPrepareUpload` queues it, and `business:approve` on that id is the
 * only path that uploads and commits.
 *
 * The service account key is read from disk here, in the main process, and never travels to
 * the renderer: the renderer only ever learns the file's path and what the key is for.
 */

export function registerBusinessHandlers(ipcMain: IpcMain) {
  ipcMain.handle('business:state', async () => refreshPage())
  ipcMain.handle('business:digest', async () => refreshDigest())

  // Connections
  ipcMain.handle('business:gmailAuthUrl', async (_e, clientId: string, clientSecret: string) => gmailAuthUrl(clientId, clientSecret))
  ipcMain.handle('business:gmailPending', async () => gmailAuthPending())
  ipcMain.handle('business:connectBluesky', async (_e, identifier: string, appPassword: string) => {
    await connectBluesky(identifier, appPassword)
    return businessState()
  })
  ipcMain.handle('business:connectMastodon', async (_e, instance: string, token: string) => {
    await connectMastodon(instance, token)
    return businessState()
  })
  ipcMain.handle('business:connectShopify', async (_e, shop: string, token: string) => {
    await connectShopify(shop, token)
    return businessState()
  })
  ipcMain.handle('business:connectPrintful', async (_e, token: string, storeId: string | null) => {
    await connectPrintful(token, storeId)
    return businessState()
  })
  ipcMain.handle('business:disconnect', async (_e, id: ConnectionId) => disconnect(id))
  ipcMain.handle('business:accounts', async () => connectionAccounts())

  // Preparations — these send nothing
  ipcMain.handle('business:prepareMail', async (_e, input: { to: string; subject: string; body: string; threadId?: string }) => prepareMail(input))
  ipcMain.handle('business:preparePost', async (_e, platform: 'bluesky' | 'mastodon', text: string, about: string) => preparePost(platform, text, about))
  ipcMain.handle('business:prepareListing', async (_e, input: {
    storefront: Storefront; title: string; description: string; tags: string[]; price: number; currency: string; shipping: string
  }) => prepareListing(input))
  ipcMain.handle('business:prepareTesterInvite', async (_e, appId: string, candidateId: string, subject: string, body: string) => prepareTesterInvite(String(appId), String(candidateId), subject, body))

  // The one approval path
  ipcMain.handle('business:approve', async (_e, pendingId: string) => executeApproved(String(pendingId)))
  ipcMain.handle('business:deny', async (_e, pendingId: string) => deny(String(pendingId)))

  // Local records
  ipcMain.handle('business:addCandidate', async (_e, input: { appId: string; name: string; email: string; source: string; notes: string }) => addCandidate(input))
  ipcMain.handle('business:setCandidateState', async (_e, appId: string, id: string, state: TesterState, optedInAt?: string | null) => setCandidateState(String(appId), String(id), state, optedInAt ?? null))
  ipcMain.handle('business:setCandidateOptInDate', async (_e, appId: string, id: string, date: string) => setCandidateOptInDate(String(appId), String(id), String(date)))
  ipcMain.handle('business:forgetCandidate', async (_e, appId: string, id: string) => forgetCandidate(String(appId), String(id)))
  ipcMain.handle('business:addTrackedApp', async (_e, input: { name: string; packageName: string; track?: PlayTrack; required?: number; optInDays?: number; notes?: string }) => addTrackedApp(input))
  ipcMain.handle('business:editTrackedApp', async (_e, appId: string, patch: Partial<Pick<TesterApp, 'name' | 'track' | 'required' | 'optInDays' | 'notes'>>) => editTrackedApp(String(appId), patch))
  ipcMain.handle('business:forgetTrackedApp', async (_e, appId: string) => forgetTrackedApp(String(appId)))
  ipcMain.handle('business:saveCopyDraft', async (_e, channel: string, text: string) => saveCopyDraft(channel, text))
  ipcMain.handle('business:forgetCopyDraft', async (_e, id: string) => forgetCopyDraft(id))
  ipcMain.handle('business:forgetListingDraft', async (_e, id: string) => removeListingDraft(id))
  ipcMain.handle('business:forgetPostDraft', async (_e, id: string) => removePostDraft(id))
  ipcMain.handle('business:saveProfile', async (_e, patch: Record<string, unknown>) => saveProfile(patch))

  // Monitoring and building
  ipcMain.handle('business:addApp', async (_e, input: { name: string; url: string; packageName: string; liveVersion: string; publishedWhere: string }) => addMonitoredApp(input))
  ipcMain.handle('business:forgetApp', async (_e, id: string) => forgetApp(id))
  ipcMain.handle('business:checkApp', async (_e, id: string) => checkAppNow(id))
  ipcMain.handle('business:checkAll', async () => checkAllApps())
  ipcMain.handle('business:build', async (_e, id: string) => buildNow(id))
  ipcMain.handle('business:run', async (_e, id: string) => runNow(id))
  ipcMain.handle('business:stop', async (_e, id: string) => stopNow(id))
  ipcMain.handle('business:searches', async () => listSearches())

  // ── Google Play Console ───────────────────────────────────────────────────
  // The key is picked by path and read here; its contents never cross to the renderer.
  ipcMain.handle('business:playState', async () => playState())

  ipcMain.handle('business:playPickKey', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose the Google service account key (JSON)',
      properties: ['openFile'],
      filters: [{ name: 'JSON key', extensions: ['json'] }],
    })
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true, path: null }
    return { canceled: false, path: picked.filePaths[0] }
  })

  ipcMain.handle('business:playUseKeyFile', async (_e, filePath: string) => {
    let text: string
    try {
      const stat = fs.statSync(String(filePath))
      if (stat.size > 64 * 1024) throw new Error('that file is far too large to be a key')
      text = fs.readFileSync(String(filePath), 'utf8')
    } catch {
      return { ok: false, message: 'That file could not be read. Pick the .json key you downloaded from Google Cloud.', state: playState() }
    }
    const result = storePlayKey(text)
    // Do not leave the key text in memory longer than needed.
    text = ''
    return result
  })

  ipcMain.handle('business:playPasteKey', async (_e, text: string) => storePlayKey(String(text ?? '')))
  ipcMain.handle('business:playCheckAccess', async () => playCheckAccess())
  ipcMain.handle('business:playReadBaseline', async () => playReadBaseline())
  ipcMain.handle('business:playForget', async () => forgetPlayKey())

  ipcMain.handle('business:playPickBundle', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose the Android App Bundle',
      properties: ['openFile'],
      filters: [{ name: 'Android App Bundle', extensions: ['aab'] }],
    })
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true, path: null }
    return { canceled: false, path: picked.filePaths[0] }
  })

  ipcMain.handle('business:playPrepareUpload', async (_e, input: {
    packageName: string; track: string; aabPath: string; versionCode: string; releaseNotes: string; language?: string
  }) => prepareSubmission(input))
}
