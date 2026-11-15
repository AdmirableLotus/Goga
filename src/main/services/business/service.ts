import http from 'http'
import { AddressInfo } from 'net'
import type {
  BusinessActionResult, BusinessPageState, BusinessState, ConnectionId, Digest, PlayTrack, ReleaseDestination,
  Storefront, TesterApp, TesterCandidate, TesterRecruitment, TesterState,
} from '../../../shared/business'
import { DECLINED, connectionViews } from './connections'
import {
  clearCredential, credentialAccount, encryptionAvailable, readCredential, writeCredential,
  type BlueskyCredential, type GmailCredential, type MastodonCredential, type PrintfulCredential, type ShopifyCredential,
} from './credentials'
import { GmailClient, authUrl, exchangeCode, pkcePair, buildRawMessage } from './gmail'
import { bskyCreateSession, bskyPost, mastodonPost, mastodonVerify, normaliseInstance } from './social'
import { printfulCreateProduct, printfulVerify, shopifyCreateDraftProduct, shopifyVerify } from './storefront'
import { buildDigest } from './digest'
import { appSecret } from './secret'
import {
  consumeApproval, denyAction, getPending, listPending, prepareAction, readAudit, recordAudit, recordOutcome,
} from './audit'
import {
  addApp, addListing, addPost, addTester, addTesterApp, addTesterCopy, appendCheck, deleteListing, deletePost,
  deleteTesterCopy, listApps, listListings, listPosts, listProjects, listSearches, jobProfile,
  removeApp, removeTester, removeTesterApp, saveJobProfile, setTesterState, testerWorkspace, updateListing,
  updatePost, updateTester, updateTesterApp,
} from './store'
import { dateInputToIso, summariseApp } from './testers'
import { monitorRows, probeUrl, publishSteps, summariseUptime } from './monitor'
import { playState, takeSubmission, uploadApproved, setLastUpload } from './playService'
import { buildProject, runProject, stopProject } from './builder'
import { backgroundChat } from '../backgroundChat'
import { LogService } from '../logs'

/**
 * The business service.
 *
 * What it is: one place that reads the user's own mail and social notifications, prepares
 * mail, posts, listings and tester invites, builds and monitors the user's own projects, and
 * keeps the audit trail.
 *
 * The rule it enforces, not just documents: nothing leaves this machine without a
 * PendingAction being prepared first and then approved by its own id. `prepare*` never
 * sends. `executeApproved` is the only function that sends, and it can only be reached with
 * an id that `consumeApproval` accepted — single use, 30 minutes.
 */

const log = () => LogService.getInstance()

const DESTINATIONS: ReleaseDestination[] = [
  { id: 'play', name: 'Google Play Console', note: 'Upload the bundle yourself; Google reviews it. Goga builds, you publish.' },
  { id: 'builder', name: 'A builder dashboard (Base44, Runable, Choicely)', note: 'Those publish on their own servers. Goga cannot publish for you.' },
  { id: 'web', name: 'A web host (Netlify, Vercel, your own server)', note: 'Goga builds; you deploy from your own account.' },
]

export function businessState(): BusinessState {
  return {
    connections: connectionViews(),
    declined: DECLINED,
    encryptionAvailable: encryptionAvailable(),
    audit: readAudit(120),
    pending: listPending(),
  }
}

function testerRecruitment(): TesterRecruitment {
  const w = testerWorkspace()
  const now = new Date()
  const summaries = w.apps.map(a => summariseApp(a, now))
  return {
    apps: w.apps,
    summaries,
    copyDrafts: w.copyDrafts,
    shortApps: summaries.filter(s => !s.meetsCount).length,
  }
}

/** Everything the Business page draws. The digest is null until it is asked for. */
export function businessPageState(digest: Digest | null, digestError: string | null): BusinessPageState {
  const apps = listApps()
  return {
    ...businessState(),
    digest,
    digestError,
    listings: listListings(),
    posts: listPosts(),
    testers: testerRecruitment(),
    apps,
    uptime: apps.map(a => summariseUptime(a.id, a.checks ?? [])),
    projects: listProjects(),
    jobProfile: jobProfile(),
    searches: listSearches(),
    releaseSteps: publishSteps('play'),
    destinations: DESTINATIONS,
    play: playState(),
  }
}

// ── digest ──────────────────────────────────────────────────────────────────

/** The last digest read in this session, so the page can show it without re-reading mail. */
let lastDigest: Digest | null = null
let lastDigestError: string | null = null

/** Read mail and social notifications, and let the local model write the summary. */
export async function refreshDigest(): Promise<Digest> {
  try {
    const digest = await buildDigest({
      summarise: prompt => backgroundChat([
        { role: 'system', content: 'You summarise a person\'s inbox and notifications. Use only the items given. Invent nothing.' },
        { role: 'user', content: prompt },
      ]),
    })
    lastDigest = digest
    lastDigestError = null
    recordAudit('read', 'digest', `digest read: ${digest.mail.items.length} mail, ${digest.social.items.length} social${digest.notes.length ? `, ${digest.notes.length} note(s)` : ''}`)
    return digest
  } catch (err) {
    lastDigestError = err instanceof Error ? err.message : String(err)
    recordAudit('error', 'digest', `digest could not be read: ${lastDigestError}`)
    throw err
  }
}

/** The page state, with the digest that was last read (or the reason it could not be). */
export function refreshPage(): BusinessPageState {
  return businessPageState(lastDigest, lastDigestError)
}

// ── connections ─────────────────────────────────────────────────────────────

interface OAuthWindow { startedAt: number; server: http.Server; state: string; verifier: string; clientId: string; clientSecret: string }
let pendingOAuth: OAuthWindow | null = null

function closeOAuth(): void {
  if (!pendingOAuth) return
  try { pendingOAuth.server.close() } catch { /* already closed */ }
  pendingOAuth = null
}

/**
 * Gmail sign-in. Starts a loopback listener on 127.0.0.1, opens nothing itself, and returns
 * the URL for the user to open in their own browser. Google's own consent screen is where
 * the password is typed; Goga only ever receives the code.
 */
export async function gmailAuthUrl(clientId: string, clientSecret: string): Promise<{ url: string; port: number }> {
  if (!clientId.trim() || !clientSecret.trim()) throw new Error('Goga needs the OAuth client id and client secret from your own Google Cloud project')
  closeOAuth()
  const { verifier, challenge } = pkcePair()
  const state = appSecret(16)
  const server = http.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const redirectUri = `http://127.0.0.1:${port}`
  pendingOAuth = { startedAt: Date.now(), server, state, verifier, clientId, clientSecret }
  server.on('request', (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', redirectUri)
      const code = url.searchParams.get('code')
      const returned = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      const finish = (text: string) => res.end(`<!doctype html><meta charset="utf-8"><title>Goga</title><body style="font:16px system-ui;padding:40px;background:#0f0f0f;color:#eee">${text}</body>`)
      if (error) { finish('Google refused the sign-in. You can close this tab.'); closeOAuth(); return }
      if (!code || returned !== state || !pendingOAuth) { finish('That reply did not match the sign-in Goga started. Nothing was saved.'); return }
      try {
        const tokens = await exchangeCode(clientId, clientSecret, code, redirectUri, verifier)
        if (!tokens.refresh_token) throw new Error('Google returned no refresh token — remove Goga from your Google account’s third-party access and try again')
        const cred: GmailCredential = {
          kind: 'gmail', clientId, clientSecret, refreshToken: tokens.refresh_token,
          account: '', scope: tokens.scope ?? '', obtainedAt: new Date().toISOString(),
        }
        // Read the address back from Gmail so the page can say which account it is.
        try { cred.account = (await new GmailClient(cred).profile()).emailAddress } catch { /* the token still works */ }
        writeCredential('gmail', cred)
        recordAudit('note', 'gmail', `Gmail connected${cred.account ? ` as ${cred.account}` : ''}`)
        finish(`Gmail is connected${cred.account ? ` as ${cred.account}` : ''}. You can close this tab.`)
      } catch (err) {
        recordAudit('error', 'gmail', `Gmail sign-in failed: ${err instanceof Error ? err.message : String(err)}`)
        finish('The sign-in could not be completed. Nothing was saved. You can close this tab.')
      } finally { closeOAuth() }
    })()
  })
  setTimeout(() => { if (pendingOAuth && Date.now() - pendingOAuth.startedAt > 5 * 60_000) closeOAuth() }, 5 * 60_000).unref?.()
  return { url: authUrl(clientId, redirectUri, challenge, state), port }
}

export function gmailAuthPending(): boolean { return !!pendingOAuth }

export async function connectBluesky(identifier: string, appPassword: string): Promise<void> {
  const session = await bskyCreateSession(identifier, appPassword)
  const cred: BlueskyCredential = {
    kind: 'bluesky', identifier: String(identifier).trim().replace(/^@/, ''),
    appPassword: String(appPassword), accessJwt: session.accessJwt, refreshJwt: session.refreshJwt,
    did: session.did, handle: session.handle, obtainedAt: new Date().toISOString(),
  }
  writeCredential('bluesky', cred as BlueskyCredential)
  recordAudit('note', 'bluesky', `Bluesky connected as ${session.handle}`)
}

export async function connectMastodon(instance: string, token: string): Promise<void> {
  const origin = normaliseInstance(instance)
  const me = await mastodonVerify(origin, token)
  const cred: MastodonCredential = { kind: 'mastodon', instance: origin, accessToken: token, account: me.account, obtainedAt: new Date().toISOString() }
  writeCredential('mastodon', cred as MastodonCredential)
  recordAudit('note', 'mastodon', `Mastodon connected as ${me.account}@${origin.replace(/^https?:\/\//, '')}`)
}

export async function connectShopify(shop: string, token: string): Promise<void> {
  const cred: ShopifyCredential = { kind: 'shopify', shop, accessToken: token, obtainedAt: new Date().toISOString() }
  const info = await shopifyVerify(cred)
  writeCredential('shopify', cred as ShopifyCredential)
  recordAudit('note', 'shopify', `Shopify connected: ${info.name} (${info.domain}), currency ${info.currency}`)
}

export async function connectPrintful(token: string, storeId: string | null): Promise<void> {
  const cred: PrintfulCredential = { kind: 'printful', accessToken: token, storeId: storeId || null, obtainedAt: new Date().toISOString() }
  const me = await printfulVerify(cred)
  writeCredential('printful', cred as PrintfulCredential)
  recordAudit('note', 'printful', `Printful connected: ${me.name}${me.stores.length ? ` (${me.stores.length} store(s))` : ''}`)
}

export function disconnect(id: ConnectionId): BusinessState {
  clearCredential(id)
  recordAudit('note', id, `${id} credential removed from this machine`)
  return businessState()
}

// ── outbound: prepare, then approve ─────────────────────────────────────────

/** Draft a mail in the local Drafts folder sense: nothing is sent, the text is queued for approval. */
export function prepareMail(input: { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string; references?: string }): BusinessActionResult {
  const cred = readCredential<GmailCredential>('gmail')
  if (!cred) return { ok: false, message: 'Gmail is not connected, so there is no account to send from.' }
  let raw: string
  try {
    raw = buildRawMessage({ ...input, from: cred.account || undefined })
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  const action = prepareAction('mail-send', `Mail to ${input.to}: ${input.subject}`, [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    '',
    input.body,
  ].join('\n'))
  mailQueue.set(action.id, { raws: raw, threadId: input.threadId, inReplyTo: input.inReplyTo, references: input.references, to: input.to })
  return { ok: true, message: `Prepared a message to ${input.to}. Nothing has been sent — approve it below.` }
}

interface QueuedMail { raws: string; threadId?: string; inReplyTo?: string; references?: string; to: string }
const mailQueue = new Map<string, QueuedMail>()

export function preparePost(platform: 'bluesky' | 'mastodon', text: string, about: string): BusinessActionResult {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, message: 'A post needs some text.' }
  const cred = readCredential(platform)
  if (!cred) return { ok: false, message: `${platform === 'bluesky' ? 'Bluesky' : 'Mastodon'} is not connected.` }
  if (platform === 'bluesky' && [...body].length > 300) return { ok: false, message: `Bluesky allows 300 characters; this is ${[...body].length}.` }
  const draft = addPost({ platform, text: body, about: about || 'general post' })
  const action = prepareAction('social-post', `${platform} post: ${body.slice(0, 60)}${body.length > 60 ? '…' : ''}`, body)
  postQueue.set(action.id, { platform, text: body, draftId: draft.id })
  return { ok: true, message: `Prepared a ${platform} post. Nothing has been posted — approve it below.` }
}

const postQueue = new Map<string, { platform: 'bluesky' | 'mastodon'; text: string; draftId: string }>()

export function prepareListing(input: {
  storefront: Storefront; title: string; description: string; tags: string[]; price: number; currency: string; shipping: string
}): BusinessActionResult {
  const title = String(input.title ?? '').trim()
  if (!title) return { ok: false, message: 'A listing needs a title.' }
  const price = Number(input.price)
  if (!(price > 0)) return { ok: false, message: 'A listing needs a price above zero.' }
  const cred = readCredential(input.storefront)
  if (!cred) return { ok: false, message: `${input.storefront === 'shopify' ? 'Shopify' : 'Printful'} is not connected.` }
  const draft = addListing({
    storefront: input.storefront, title, description: String(input.description ?? ''),
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [], price,
    currency: input.currency || 'USD', shipping: String(input.shipping ?? ''),
  })
  const action = prepareAction('listing-create', `${input.storefront} draft product: ${title}`, [
    `Title: ${title}`, `Price: ${price.toFixed(2)} ${draft.currency}`, `Tags: ${draft.tags.join(', ') || '(none)'}`,
    '', draft.description,
  ].join('\n'))
  listingQueue.set(action.id, { storefront: input.storefront, draftId: draft.id })
  return { ok: true, message: `Prepared "${title}". Nothing was created on ${input.storefront} — approve it below.` }
}

const listingQueue = new Map<string, { storefront: Storefront; draftId: string }>()

export function prepareTesterInvite(appId: string, candidateId: string, subject: string, body: string): BusinessActionResult {
  const app = testerWorkspace().apps.find(a => a.id === appId)
  if (!app) return { ok: false, message: 'No such app in the tracker.' }
  const candidate = app.candidates.find(c => c.id === candidateId)
  if (!candidate) return { ok: false, message: 'No such candidate.' }
  if (!readCredential('gmail')) return { ok: false, message: 'Gmail is not connected, so there is no account to invite from.' }
  let raw: string
  try {
    raw = buildRawMessage({ to: candidate.email, subject, body })
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  const action = prepareAction('tester-invite', `Tester invite for ${app.name || app.packageName} to ${candidate.name || candidate.email}`, [`To: ${candidate.email}`, `Subject: ${subject}`, '', body].join('\n'))
  inviteQueue.set(action.id, { raws: raw, appId, candidateId, email: candidate.email })
  return { ok: true, message: `Prepared an invite to ${candidate.email}. Nothing has been sent — approve it below.` }
}

const inviteQueue = new Map<string, { raws: string; appId: string; candidateId: string; email: string }>()

export function deny(id: string): BusinessActionResult {
  const r = denyAction(id)
  return { ok: r.ok, message: r.ok ? 'Denied. Nothing was sent.' : r.reason }
}

/**
 * The only function that sends anything. It takes the approval for exactly one action, and
 * dispatches on the kind that approval was granted for. A mixed-up id cannot send the wrong
 * kind: `consumeApproval` refuses when the kind does not match.
 */
export async function executeApproved(id: string): Promise<BusinessActionResult> {
  const pending = getPending(id)
  if (!pending) return { ok: false, message: 'That approval is unknown or has expired — prepare the action again.' }

  if (pending.kind === 'mail-send') {
    const queued = mailQueue.get(id)
    if (!queued) return { ok: false, message: 'The prepared message is no longer held. Prepare it again.' }
    const done = consumeApproval(id, 'mail-send')
    if (!done.ok) return { ok: false, message: done.reason }
    mailQueue.delete(id)
    const cred = readCredential<GmailCredential>('gmail')
    if (!cred) { recordOutcome('mail-send', pending.title, false, 'no Gmail credential'); return { ok: false, message: 'Gmail is not connected.' } }
    try {
      const sent = await new GmailClient(cred).sendMessage(queued.raws, queued.threadId)
      recordOutcome('mail-send', pending.title, true, `sent to ${queued.to} (Gmail id ${sent.id})`)
      return { ok: true, message: `Sent to ${queued.to}. Gmail id ${sent.id}.` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      recordOutcome('mail-send', pending.title, false, message)
      return { ok: false, message: `Not sent: ${message}` }
    }
  }

  if (pending.kind === 'social-post') {
    const queued = postQueue.get(id)
    if (!queued) return { ok: false, message: 'The prepared post is no longer held. Prepare it again.' }
    const done = consumeApproval(id, 'social-post')
    if (!done.ok) return { ok: false, message: done.reason }
    postQueue.delete(id)
    try {
      if (queued.platform === 'bluesky') {
        const cred = readCredential<BlueskyCredential>('bluesky')
        if (!cred) throw new Error('Bluesky is not connected')
        const r = await bskyPost(cred, queued.text)
        updatePost(queued.draftId, { status: 'posted', remoteUrl: r.url })
        recordOutcome('social-post', pending.title, true, `posted: ${r.url}`)
        return { ok: true, message: `Posted to Bluesky: ${r.url}` }
      }
      const cred = readCredential<MastodonCredential>('mastodon')
      if (!cred) throw new Error('Mastodon is not connected')
      const r = await mastodonPost(cred, queued.text)
      updatePost(queued.draftId, { status: 'posted', remoteUrl: r.url })
      recordOutcome('social-post', pending.title, true, `posted: ${r.url}`)
      return { ok: true, message: `Posted to Mastodon: ${r.url}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      updatePost(queued.draftId, { status: 'failed', error: message })
      recordOutcome('social-post', pending.title, false, message)
      return { ok: false, message: `Not posted: ${message}` }
    }
  }

  if (pending.kind === 'listing-create') {
    const queued = listingQueue.get(id)
    const draft = queued ? listListings().find(l => l.id === queued.draftId) : null
    if (!queued || !draft) return { ok: false, message: 'The prepared listing is no longer held. Prepare it again.' }
    const done = consumeApproval(id, 'listing-create')
    if (!done.ok) return { ok: false, message: done.reason }
    listingQueue.delete(id)
    try {
      if (queued.storefront === 'shopify') {
        const cred = readCredential<ShopifyCredential>('shopify')
        if (!cred) throw new Error('Shopify is not connected')
        const r = await shopifyCreateDraftProduct(cred, draft)
        updateListing(draft.id, { status: 'created', remoteId: r.id, remoteUrl: r.adminUrl })
        recordOutcome('listing-create', pending.title, true, `Shopify draft product ${r.id}`)
        return { ok: true, message: `Created as a DRAFT in Shopify (${r.status}). Publish it there when you are ready: ${r.adminUrl}` }
      }
      const cred = readCredential<PrintfulCredential>('printful')
      if (!cred) throw new Error('Printful is not connected')
      const r = await printfulCreateProduct(cred, draft)
      updateListing(draft.id, { status: 'created', remoteId: String(r.id), remoteUrl: r.url })
      recordOutcome('listing-create', pending.title, true, `Printful sync product ${r.id}`)
      return { ok: true, message: `Created a Printful sync product (${r.id}). It is published from Printful: ${r.url}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      updateListing(draft.id, { status: 'failed', error: message })
      recordOutcome('listing-create', pending.title, false, message)
      return { ok: false, message: `Not created: ${message}` }
    }
  }

  if (pending.kind === 'tester-invite') {
    const queued = inviteQueue.get(id)
    if (!queued) return { ok: false, message: 'The prepared invite is no longer held. Prepare it again.' }
    const done = consumeApproval(id, 'tester-invite')
    if (!done.ok) return { ok: false, message: done.reason }
    inviteQueue.delete(id)
    const cred = readCredential<GmailCredential>('gmail')
    if (!cred) { recordOutcome('tester-invite', pending.title, false, 'no Gmail credential'); return { ok: false, message: 'Gmail is not connected.' } }
    try {
      const sent = await new GmailClient(cred).sendMessage(queued.raws)
      updateTester(queued.appId, queued.candidateId, { state: 'invited', invitedAt: new Date().toISOString() })
      recordOutcome('tester-invite', pending.title, true, `invite sent to ${queued.email} (Gmail id ${sent.id})`)
      return { ok: true, message: `Invite sent to ${queued.email}. Marked as invited.` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      recordOutcome('tester-invite', pending.title, false, message)
      return { ok: false, message: `Not sent: ${message}` }
    }
  }

  if (pending.kind === 'release-publish') {
    const submission = takeSubmission(id)
    if (!submission) return { ok: false, message: 'That prepared upload is no longer held. Prepare it again.' }
    const done = consumeApproval(id, 'release-publish')
    if (!done.ok) return { ok: false, message: done.reason }
    const outcome = await uploadApproved(submission)
    setLastUpload(outcome)
    recordOutcome('release-publish', pending.title, outcome.ok, outcome.message)
    return { ok: outcome.ok, message: outcome.message }
  }

  const done = consumeApproval(id, pending.kind)
  return { ok: false, message: done.ok ? `${pending.kind} has no outbound path from this page.` : done.reason }
}

// ── local records ───────────────────────────────────────────────────────────

export function addCandidate(input: { appId: string; name: string; email: string; source: string; notes: string }) {
  const c = addTester(input)
  recordAudit('note', 'tester-invite', `candidate added for app ${input.appId}: ${c.email}`)
  return c
}

export function setCandidateState(appId: string, id: string, state: TesterState, optedInAt?: string | null) {
  const iso = optedInAt ? dateInputToIso(optedInAt) : null
  const c = setTesterState(appId, id, state, undefined, iso)
  recordAudit('note', 'tester-invite', `${c.email} marked ${state}${c.optedInAt ? ` (opted in ${c.optedInAt.slice(0, 10)})` : ''}`)
  return c
}

/** Set or correct the day a tester opted in, without changing their state. */
export function setCandidateOptInDate(appId: string, id: string, date: string) {
  const iso = dateInputToIso(date)
  if (!iso) throw new Error('that is not a date')
  const app = testerWorkspace().apps.find(a => a.id === appId)
  const existing = app?.candidates.find(c => c.id === id)
  if (!existing) throw new Error('no such candidate')
  const patch: Partial<TesterCandidate> = { optedInAt: iso }
  if (existing.state !== 'opted-in') patch.state = 'opted-in'
  const c = updateTester(appId, id, patch)
  recordAudit('note', 'tester-invite', `${c.email} opted-in date set to ${iso.slice(0, 10)}`)
  return c
}

export function forgetCandidate(appId: string, id: string): void { removeTester(appId, id) }

export function addTrackedApp(input: { name: string; packageName: string; track?: PlayTrack; required?: number; optInDays?: number; notes?: string }) {
  const app = addTesterApp(input)
  recordAudit('note', 'tester-invite', `app added to the tester tracker: ${app.name || app.packageName} (${app.packageName}, ${app.track})`)
  return app
}

export function editTrackedApp(appId: string, patch: Partial<Pick<TesterApp, 'name' | 'track' | 'required' | 'optInDays' | 'notes'>>) {
  const app = updateTesterApp(appId, patch)
  recordAudit('note', 'tester-invite', `app updated: ${app.name || app.packageName} (${app.track}, needs ${app.required} for ${app.optInDays} days)`)
  return app
}

export function forgetTrackedApp(appId: string): void {
  const app = testerWorkspace().apps.find(a => a.id === appId)
  removeTesterApp(appId)
  recordAudit('note', 'tester-invite', `app removed from the tester tracker: ${app?.name || appId}`)
}

export function saveCopyDraft(channel: string, text: string) { return addTesterCopy(channel, text) }
export function forgetCopyDraft(id: string): void { deleteTesterCopy(id) }
export function removeListingDraft(id: string): void { deleteListing(id) }
export function removePostDraft(id: string): void { deletePost(id) }
export function saveProfile(patch: Parameters<typeof saveJobProfile>[0]) { return saveJobProfile(patch) }

// ── monitor + build ─────────────────────────────────────────────────────────

export function addMonitoredApp(input: { name: string; url: string; packageName: string; liveVersion: string; publishedWhere: string }) {
  const app = addApp(input)
  recordAudit('note', 'release-publish', `monitoring ${app.url}`)
  return app
}

export function forgetApp(id: string): void { removeApp(id) }

/** Run one health check now, and record it. The only network call the monitor makes. */
export async function checkAppNow(id: string) {
  const app = listApps().find(a => a.id === id)
  if (!app) throw new Error('no such app')
  const check = await probeUrl(app.url)
  const updated = appendCheck(id, check)
  recordAudit('read', 'release-publish', `health check ${app.url}: ${check.ok ? 'ok' : 'failed'}${check.status ? ` (${check.status})` : ''} in ${check.ms}ms`)
  return { app: updated, check }
}

export async function checkAllApps() {
  const results = []
  for (const app of listApps()) {
    try {
      const check = await probeUrl(app.url)
      results.push({ id: app.id, check, app: appendCheck(app.id, check) })
    } catch (err) {
      log().warn(`Monitor: ${app.url} could not be checked — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { results, rows: monitorRows(listApps()) }
}

export async function buildNow(id: string) { return buildProject(id) }
export async function runNow(id: string) { return runProject(id) }
export function stopNow(id: string) { return stopProject(id) }

export { monitorRows, summariseUptime, publishSteps }

/**
 * Play, re-exported through the business service so the handlers have one import site.
 * `checkAccess` and `readBaseline` are the only calls that touch the network.
 */
export {
  checkAccess as playCheckAccess,
  readBaseline as playReadBaseline,
  storePlayKey,
  forgetPlayKey,
  playState,
} from './playService'

/** Which account each connection is signed in as. Never a secret. */
export function connectionAccounts(): Record<string, string | null> {
  return {
    gmail: credentialAccount('gmail'), bluesky: credentialAccount('bluesky'), mastodon: credentialAccount('mastodon'),
    shopify: credentialAccount('shopify'), printful: credentialAccount('printful'),
  }
}
