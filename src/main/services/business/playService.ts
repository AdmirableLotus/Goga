import fs from 'fs'
import path from 'path'
import { businessFile, ensureDirFor } from './paths'
import { recordAudit, prepareAction as queueAction } from './audit'
import type {
  PlayAppView, PlayBaseline, PlayConnectionView, PlayState, PlaySubmissionView,
} from '../../../shared/business'
import {
  parseServiceAccountKey, signJwt, redactSecrets, type ServiceAccountKey, type ServiceAccountSummary,
} from './playKey'
import { PlayApiError, PlayClient, fetchAccessToken, type PlayApp } from './play'

/**
 * The Play Console connection.
 *
 * What it stores: the service account JSON, encrypted with Electron safeStorage in one file,
 * exactly like the Alpaca and HackerOne credentials. The private key never leaves this module:
 * `readKey` is module-private, and nothing returned to the renderer contains it. Errors pass
 * through `redactSecrets` before they are logged or shown, because a Google error body can
 * echo part of a JWT.
 *
 * What it does not do: create a Google Cloud project, create a service account, create a key,
 * or invite anyone in Play Console. Those are the user's own clicks, in their own accounts,
 * and the page says exactly where.
 */

const KEY_FILE = 'goga-business-play-key.bin'
const BASELINE_FILE = 'goga-business-play-baseline.json'

/**
 * The apps the user has named, as a fallback when Play's app list cannot be read, and as a
 * label on the page. Only the first two packages are known from the user; the third is
 * identified from Play itself rather than guessed.
 */
export const KNOWN_APPS: { packageName: string; name: string }[] = [
  { packageName: 'com.base6a76745e0296d6adfc52539f.app', name: 'Only3' },
  { packageName: 'com.base692cc10480cefa8d26ea7080.app', name: 'Dear Loved One' },
]
export const KNOWN_PACKAGE = KNOWN_APPS[0].packageName
export const PLAY_HOME = 'https://play.google.com/console/u/1/developers/7935784357221763213/home'
export const PLAY_USERS = 'https://play.google.com/console/u/1/developers/7935784357221763213/users-and-permissions'
export const PLAY_TESTERS = 'https://play.google.com/console/u/1/developers/7935784357221763213/testers'

function safeStorageOrNull(): typeof import('electron').safeStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage } = require('electron') as typeof import('electron')
    return safeStorage
  } catch {
    return null
  }
}

interface StoredKey {
  summary: ServiceAccountSummary
  /** The key JSON as text. Encrypted at rest by safeStorage, never logged. */
  json: string
  storedAt: string
}

/** Read the stored key. Module-private: the only function that returns key material. */
function readKey(): ServiceAccountKey | null {
  const file = businessFile(KEY_FILE)
  const store = safeStorageOrNull()
  if (!file || !store) return null
  try {
    const stored = JSON.parse(store.decryptString(fs.readFileSync(file))) as StoredKey
    const parsed = parseServiceAccountKey(stored.json)
    return parsed.ok ? parsed.key : null
  } catch {
    return null
  }
}

/** What the UI may know: the account, the project, the key id. Never the key. */
export function storedKeySummary(): ServiceAccountSummary | null {
  const file = businessFile(KEY_FILE)
  const store = safeStorageOrNull()
  if (!file || !store) return null
  try {
    const stored = JSON.parse(store.decryptString(fs.readFileSync(file))) as StoredKey
    return stored.summary ?? null
  } catch {
    return null
  }
}

export function encryptionAvailable(): boolean {
  try {
    return !!safeStorageOrNull()?.isEncryptionAvailable()
  } catch {
    return false
  }
}

// ── the client ──────────────────────────────────────────────────────────────

/** A fetch the tests can replace. Unset in the app, so the real one is used. */
let fetchOverride: typeof fetch | null = null
export function setPlayFetchForTests(f: typeof fetch | null): void { fetchOverride = f }

function http(): typeof fetch { return fetchOverride ?? fetch }

/**
 * Sign a JWT from the stored key, exchange it for an access token, and hand back a client
 * whose every call uses that token. One token per operation; nothing cached between them.
 */
async function clientFromStoredKey(): Promise<{ client: PlayClient; summary: ServiceAccountSummary }> {
  const key = readKey()
  const summary = storedKeySummary()
  if (!key || !summary) throw new Error('No Play service account key is stored.')
  const { accessToken } = await fetchAccessToken(signJwt(key), http())
  return { client: new PlayClient({ getToken: async () => accessToken, fetchImpl: http() }), summary }
}

export function forgetPlayKey(): PlayState {
  const file = businessFile(KEY_FILE)
  if (file) { try { fs.unlinkSync(file) } catch { /* nothing stored */ } }
  lastConnection = null
  recordAudit('note', 'release-publish', 'the Play service account key was removed from this machine')
  return playState()
}

// ── connection state ────────────────────────────────────────────────────────

let lastConnection: PlayConnectionView | null = null

function notConnected(detail: string): PlayConnectionView {
  return {
    state: 'not-connected',
    serviceAccountEmail: null, projectId: null, keyId: null,
    detail, fixUrl: PLAY_USERS, fixLabel: 'Open Users and permissions',
    checkedAt: null, encryptionAvailable: encryptionAvailable(),
  }
}

/**
 * Check the file's shape and store it. Storing is a local write and nothing more: whether Play
 * accepts the key is a separate question, answered by `checkAccess`.
 */
export function storePlayKey(text: string): { ok: boolean; message: string; state: PlayState } {
  const parsed = parseServiceAccountKey(text)
  if (!parsed.ok) {
    recordAudit('error', 'release-publish', `the Play key was refused: ${redactSecrets(parsed.reason)}`)
    lastConnection = { ...notConnected(parsed.reason), state: 'invalid-key', fixUrl: null, fixLabel: null }
    return { ok: false, message: `${parsed.reason} ${parsed.fix}`, state: playState() }
  }
  const store = safeStorageOrNull()
  if (!store || !store.isEncryptionAvailable()) {
    return { ok: false, message: 'Secure storage is unavailable on this PC, so the key was not saved. Nothing was written.', state: playState() }
  }
  const file = businessFile(KEY_FILE)
  if (!file) return { ok: false, message: 'Goga has no data folder to store the key in, so nothing was saved.', state: playState() }
  const stored: StoredKey = { summary: parsed.summary, json: JSON.stringify(parsed.key), storedAt: new Date().toISOString() }
  ensureDirFor(file)
  fs.writeFileSync(file, store.encryptString(JSON.stringify(stored)), { mode: 0o600 })
  recordAudit('note', 'release-publish', `Play service account key stored for ${parsed.summary.clientEmail} (project ${parsed.summary.projectId})`)
  lastConnection = {
    state: 'connected',
    serviceAccountEmail: parsed.summary.clientEmail,
    projectId: parsed.summary.projectId,
    keyId: parsed.summary.keyId,
    detail: 'The key is stored and its shape is valid. Whether Play lets it do anything has not been checked yet — press Check access.',
    fixUrl: PLAY_USERS, fixLabel: 'Open Users and permissions',
    checkedAt: null,
    encryptionAvailable: true,
  }
  return { ok: true, message: `Stored the key for ${parsed.summary.clientEmail}. Now check what Play allows it to do.`, state: playState() }
}

/**
 * Ask Google what this key can actually do.
 *
 * The order matters, because the failures differ: a bad key gives 401 at the token step; a
 * good key that was never invited gives 403 on the first API call; a project that never
 * enabled the API says "service disabled". Each is named separately, and the invited-but-
 * not-permitted case is the one that actually happens.
 */
export async function checkAccess(): Promise<PlayState> {
  let client: PlayClient
  let summary: ServiceAccountSummary
  try {
    const built = await clientFromStoredKey()
    client = built.client
    summary = built.summary
  } catch (err) {
    const google = err instanceof PlayApiError ? err.google : null
    if (!storedKeySummary()) {
      lastConnection = notConnected('No key is stored. Add the service account JSON first.')
      return playState()
    }
    const summaryNow = storedKeySummary()!
    lastConnection = {
      state: google ? 'invalid-key' : 'not-connected',
      serviceAccountEmail: summaryNow.clientEmail, projectId: summaryNow.projectId, keyId: summaryNow.keyId,
      detail: google?.message ?? `Google would not accept the key: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
      fixUrl: google?.fixUrl ?? NULL_FIX.url, fixLabel: google?.fixLabel ?? NULL_FIX.label,
      checkedAt: new Date().toISOString(), encryptionAvailable: true,
    }
    recordAudit('error', 'release-publish', `Play token refused: ${redactSecrets(google?.detail ?? String(err))}`)
    return playState()
  }

  try {
    const apps = await client.listApps()
    lastConnection = connectedView(summary, apps.length
      ? `Play answered: this account can see ${apps.length} app${apps.length === 1 ? '' : 's'}.`
      : 'Play answered, but listed no apps this service account can see yet.')
    recordAudit('read', 'release-publish', `Play access confirmed for ${summary.clientEmail}: ${apps.length} app(s) visible`)
    return playState()
  } catch (err) {
    const google = err instanceof PlayApiError ? err.google : null
    // The app list comes from the Reporting API. A project that enabled only the publisher
    // API is still usable, so try one publisher call per known app before calling this a failure.
    let publisherWorked = false
    let lastPublisherError: PlayApiError | null = null
    for (const known of KNOWN_APPS) {
      try {
        const editId = await client.insertEdit(known.packageName)
        await client.deleteEdit(known.packageName, editId).catch(() => undefined)
        publisherWorked = true
        break
      } catch (pubErr) {
        if (pubErr instanceof PlayApiError) lastPublisherError = pubErr
      }
    }
    if (publisherWorked) {
      lastConnection = connectedView(summary, google
        ? `The publisher API works. Goga could not read the full app list: ${google.message}`
        : 'Play answered through the publisher API.')
      recordAudit('read', 'release-publish', `Play publisher access confirmed for ${summary.clientEmail}`)
      return playState()
    }
    {
      const pubGoogle = lastPublisherError?.google ?? null
      const chosen = pubGoogle ?? google
      lastConnection = {
        state: chosen?.kind === 'access-denied' || chosen?.kind === 'api-disabled' ? 'access-denied' : 'invalid-key',
        serviceAccountEmail: summary.clientEmail, projectId: summary.projectId, keyId: summary.keyId,
        detail: chosen?.message ?? 'Play did not answer.',
        fixUrl: chosen?.fixUrl ?? PLAY_USERS, fixLabel: chosen?.fixLabel ?? 'Open Users and permissions',
        checkedAt: new Date().toISOString(), encryptionAvailable: true,
      }
      recordAudit('error', 'release-publish', `Play access failed for ${summary.clientEmail}: ${redactSecrets(chosen?.detail ?? 'no detail')}`)
      return playState()
    }
  }
}

const NULL_FIX = { url: null as string | null, label: null as string | null }

function connectedView(summary: ServiceAccountSummary, detail: string): PlayConnectionView {
  return {
    state: 'connected',
    serviceAccountEmail: summary.clientEmail,
    projectId: summary.projectId,
    keyId: summary.keyId,
    detail,
    fixUrl: PLAY_USERS, fixLabel: 'Open Users and permissions',
    checkedAt: new Date().toISOString(),
    encryptionAvailable: true,
  }
}

// ── baseline ────────────────────────────────────────────────────────────────

function readBaselineFile(): PlayBaseline {
  const file = businessFile(BASELINE_FILE)
  if (!file) return { readAt: null, apps: [], error: null, note: 'No data folder, so nothing could be remembered.' }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PlayBaseline
  } catch {
    return { readAt: null, apps: [], error: null, note: 'Nothing read from Play yet.' }
  }
}

function writeBaseline(b: PlayBaseline): void {
  const file = businessFile(BASELINE_FILE)
  if (!file) return
  ensureDirFor(file)
  fs.writeFileSync(file, JSON.stringify(b, null, 2), { mode: 0o600 })
}

/**
 * Read every app and every track. Read-only: an edit is opened only because the API requires
 * one, and it is deleted afterwards, so Play is left exactly as it was found.
 */
export async function readBaseline(): Promise<PlayBaseline> {
  if (!readKey()) {
    const baseline: PlayBaseline = {
      readAt: null, apps: [],
      error: { message: 'No service account key is stored, so Goga cannot read Play. Add the key first.', fixUrl: PLAY_USERS, fixLabel: 'Open Users and permissions', detail: '' },
      note: 'Nothing was read.',
    }
    writeBaseline(baseline)
    return baseline
  }

  let client: PlayClient
  try {
    client = (await clientFromStoredKey()).client
  } catch (err) {
    const google = err instanceof PlayApiError ? err.google : null
    const baseline: PlayBaseline = {
      readAt: new Date().toISOString(), apps: [],
      error: { message: google?.message ?? 'Google would not accept the key.', fixUrl: google?.fixUrl ?? null, fixLabel: google?.fixLabel ?? null, detail: redactSecrets(google?.detail ?? '') },
      note: 'Nothing was read.',
    }
    writeBaseline(baseline)
    return baseline
  }

  let apps: PlayApp[]
  let listError: PlayBaseline['error'] = null
  try {
    apps = await client.listApps()
  } catch (err) {
    const google = err instanceof PlayApiError ? err.google : null
    listError = {
      message: google?.kind === 'api-disabled'
        ? 'The full app list needs the Play Developer Reporting API, which is not enabled on this Google Cloud project. Goga tried the two apps you named instead.'
        : google?.message ?? 'Play could not list the apps this key can see.',
      fixUrl: google?.fixUrl ?? null, fixLabel: google?.fixLabel ?? null,
      detail: redactSecrets(google?.detail ?? (err instanceof Error ? err.message : String(err))),
    }
    // The publisher API is a different service. If it works, the two named apps can still be
    // read, which is most of what the page is for.
    apps = KNOWN_APPS.map(a => ({ packageName: a.packageName, displayName: a.name }))
  }

  const views: PlayAppView[] = []
  for (const app of apps) {
    const view: PlayAppView = { packageName: app.packageName, displayName: app.displayName, tracks: [], error: null }
    try {
      const editId = await client.insertEdit(app.packageName)
      try {
        view.tracks = await client.listTracks(app.packageName, editId)
      } finally {
        await client.deleteEdit(app.packageName, editId).catch(() => undefined)
      }
    } catch (err) {
      const google = err instanceof PlayApiError ? err.google : null
      view.error = google?.message ?? (err instanceof Error ? err.message : String(err))
    }
    views.push(view)
  }
  const notes = apps.length
    ? `Read ${views.length} app${views.length === 1 ? '' : 's'} and their tracks.`
    : 'The service account is valid, but Play listed no apps for it. That is what it looks like before it has been invited to the developer account.'

  // Say which of the apps the user has named Play did not return, rather than leaving it to
  // be noticed. A named app that is missing is a permission or package-name question, and the
  // page should say so plainly.
  const seen = new Set(views.map(v => v.packageName))
  const missing = KNOWN_APPS.filter(a => !seen.has(a.packageName))
  const missingNote = missing.length
    ? ` Play did not return ${missing.map(a => `${a.name} (${a.packageName})`).join(', ')}. Either the service account was not given that app, or that package name is not the one the app was built with.`
    : ''

  const baseline: PlayBaseline = { readAt: new Date().toISOString(), apps: views, error: listError, note: notes + missingNote }
  writeBaseline(baseline)
  recordAudit('read', 'release-publish', `Play baseline read: ${views.length} app(s), ${views.reduce((n, a) => n + a.tracks.length, 0)} track(s)`)
  return baseline
}

/** The next free version code, read from Play's own numbers. */
export function highestVersionCode(baseline: PlayBaseline): string | null {
  let highest = -1
  for (const app of baseline.apps) {
    for (const track of app.tracks) {
      for (const release of track.releases) {
        for (const code of release.versionCodes) {
          const n = Number(code)
          if (Number.isFinite(n) && n > highest) highest = n
        }
      }
    }
  }
  return highest < 0 ? null : String(highest + 1)
}

// ── submissions: prepare, then approve ──────────────────────────────────────

export const TRACKS = ['internal', 'alpha', 'beta', 'production'] as const

const submissions = new Map<string, PlaySubmissionView>()

export interface PrepareSubmissionInput {
  packageName: string
  track: string
  aabPath: string
  versionCode: string
  releaseNotes: string
  language?: string
}

/**
 * Check the bundle and queue the upload for approval. Nothing is uploaded here: the file is
 * checked for existence and for being a zip, its size is recorded, and an approval entry is
 * created showing the file, the package, the track, the version code and the notes.
 */
export function prepareSubmission(input: PrepareSubmissionInput): { ok: boolean; message: string; submission: PlaySubmissionView | null; state: PlayState } {
  const fail = (message: string) => ({ ok: false, message, submission: null, state: playState() })
  const packageName = String(input.packageName ?? '').trim()
  const track = String(input.track ?? '').trim()
  const aabPath = String(input.aabPath ?? '').trim()
  const versionCode = String(input.versionCode ?? '').trim()
  const releaseNotes = String(input.releaseNotes ?? '').trim()
  const language = String(input.language ?? '').trim() || 'en-US'

  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(packageName)) return fail('That is not a package name. It looks like com.company.app.')
  if (!(TRACKS as readonly string[]).includes(track)) return fail(`Choose a track: ${TRACKS.join(', ')}.`)
  if (track === 'production') return fail('This path uploads to testing tracks only. Goga does not do a production release.')
  if (!/^\d+$/.test(versionCode)) return fail('A version code is a whole number, higher than the one already on that track.')
  if (!releaseNotes) return fail('Write the release notes. Play shows them to your testers.')
  if (!aabPath) return fail('Choose the .aab file to upload.')
  if (!aabPath.toLowerCase().endsWith('.aab')) return fail('Play takes an Android App Bundle (.aab) for a release like this, not an .apk.')

  let stat: fs.Stats
  try { stat = fs.statSync(aabPath) } catch { return fail('That file is not there any more.') }
  if (!stat.isFile()) return fail('That path is not a file.')
  let head: Buffer
  try {
    const fd = fs.openSync(aabPath, 'r')
    head = Buffer.alloc(4)
    fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
  } catch {
    return fail('The file could not be read, so it was not queued.')
  }
  if (head[0] !== 0x50 || head[1] !== 0x4b) return fail('That file does not start like a bundle — an .aab is a zip file.')
  if (!readKey()) return fail('No service account key is stored. Add and check the key first.')

  const content = [
    `Package: ${packageName}`,
    `Track: ${track}${track === 'internal' ? ' (internal testing)' : ''}`,
    `File: ${aabPath}`,
    `Size: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`,
    `Version code: ${versionCode}`,
    `Release notes language: ${language}`,
    '',
    'Release notes:',
    releaseNotes,
    '',
    'Approving opens a Play edit, uploads this bundle, puts it on that track with these notes, and commits the edit.',
    'If Google reports a different version code from the one above, the edit is thrown away and nothing is committed.',
    'Nothing is uploaded until you approve this exact entry.',
  ].join('\n')

  const action = queueAction('release-publish', `Upload ${path.basename(aabPath)} to ${packageName} — ${track}, version ${versionCode}`, content)
  const submission: PlaySubmissionView = {
    id: action.id, packageName, track, aabPath, aabBytes: stat.size,
    versionCode, releaseNotes, language, preparedAt: action.createdAt, expiresAt: action.expiresAt,
  }
  submissions.set(action.id, submission)
  return { ok: true, message: `Prepared the upload to ${track}. Nothing is uploaded until you approve it in the queue.`, submission, state: playState() }
}

export function takeSubmission(id: string): PlaySubmissionView | null {
  const found = submissions.get(id) ?? null
  submissions.delete(id)
  return found
}

export function pendingSubmissions(): PlaySubmissionView[] {
  return [...submissions.values()]
}

// ── the approved upload ─────────────────────────────────────────────────────

export interface UploadOutcome {
  ok: boolean
  message: string
  versionCode: string | null
  track: string | null
  committed: boolean
}

/**
 * Upload and commit, once, for an approval the caller has already consumed.
 *
 * The version code is checked against the one approved. Google reads the code out of the
 * bundle itself, so a stale build is caught here — before the commit — and the edit is
 * deleted instead.
 */
export async function uploadApproved(submission: PlaySubmissionView): Promise<UploadOutcome> {
  const fail = (message: string, versionCode: string | null = null, committed = false): UploadOutcome =>
    ({ ok: false, message, versionCode, track: submission.track, committed })

  let client: PlayClient
  try {
    client = (await clientFromStoredKey()).client
  } catch (err) {
    const google = err instanceof PlayApiError ? err.google : null
    const message = google?.message ?? 'Google would not accept the key, so nothing was uploaded.'
    recordAudit('error', 'release-publish', `upload to ${submission.packageName}: no token — ${redactSecrets(message)}`)
    return fail(message)
  }

  let editId: string | null = null
  try {
    editId = await client.insertEdit(submission.packageName)
    const bytes = fs.readFileSync(submission.aabPath)
    if (bytes.length !== submission.aabBytes) {
      await client.deleteEdit(submission.packageName, editId).catch(() => undefined)
      recordAudit('error', 'release-publish', `upload to ${submission.packageName}: the file changed after approval; edit discarded`)
      return fail('The bundle changed on disk after you approved it, so it was not uploaded.')
    }
    const uploaded = await client.uploadBundle(submission.packageName, editId, bytes)
    if (uploaded.versionCode !== submission.versionCode) {
      await client.deleteEdit(submission.packageName, editId).catch(() => undefined)
      const message = `The bundle's version code is ${uploaded.versionCode}, but you approved ${submission.versionCode}. Nothing was committed — prepare it again with the right number.`
      recordAudit('error', 'release-publish', `upload to ${submission.packageName}: version code ${uploaded.versionCode} does not match the approved ${submission.versionCode}; edit discarded`)
      return fail(message, uploaded.versionCode)
    }
    await client.setTrackRelease(submission.packageName, editId, {
      track: submission.track,
      versionCode: uploaded.versionCode,
      releaseNotes: submission.releaseNotes,
      language: submission.language,
    })
    await client.commitEdit(submission.packageName, editId)
    recordAudit('execute', 'release-publish', `uploaded ${path.basename(submission.aabPath)} to ${submission.packageName} on ${submission.track}, version ${uploaded.versionCode}, and committed`)
    return {
      ok: true,
      message: `Uploaded to ${submission.track} as version ${uploaded.versionCode} and committed. Play now reviews it; it is not live to anyone until that finishes.`,
      versionCode: uploaded.versionCode, track: submission.track, committed: true,
    }
  } catch (err) {
    if (editId) await client.deleteEdit(submission.packageName, editId).catch(() => undefined)
    const google = err instanceof PlayApiError ? err.google : null
    const message = google?.message ?? (err instanceof Error ? err.message : String(err))
    recordAudit('error', 'release-publish', `upload to ${submission.packageName} failed: ${redactSecrets(message)}`)
    return fail(message)
  }
}

// ── page state ──────────────────────────────────────────────────────────────

let lastUpload: PlayState['lastUpload'] = null
export function setLastUpload(outcome: UploadOutcome): void {
  lastUpload = { at: new Date().toISOString(), ...outcome }
}

export function playState(): PlayState {
  const summary = storedKeySummary()
  const connection: PlayConnectionView = lastConnection ?? (summary
    ? {
        state: 'connected',
        serviceAccountEmail: summary.clientEmail, projectId: summary.projectId, keyId: summary.keyId,
        detail: 'A key is stored. Press Check access to ask Play what it can do.',
        fixUrl: PLAY_USERS, fixLabel: 'Open Users and permissions',
        checkedAt: null, encryptionAvailable: encryptionAvailable(),
      }
    : notConnected('Not connected. Goga has no Play service account key.'))
  const baseline = readBaselineFile()
  return {
    connection,
    baseline,
    pending: pendingSubmissions(),
    suggestedVersionCode: highestVersionCode(baseline),
    lastUpload,
  }
}
