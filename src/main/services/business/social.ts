import type { BlueskyCredential, MastodonCredential } from './credentials'
import type { DigestSocialItem } from '../../../shared/business'

/**
 * The two social platforms that actually document an API a personal account can use.
 *
 * Bluesky (AT Protocol) and Mastodon both publish their API, both let the account owner
 * create a credential themselves, and neither forbids a client from reading notifications
 * or posting on the account's behalf. That is why they are here and the others are not.
 *
 * Everything below is a plain documented call. Posting is a separate method that is only
 * reached after the user approved that exact post.
 */

const BSKY_PUBLIC = 'https://public.api.bsky.app/xrpc'
const BSKY_PDS = 'https://bsky.social/xrpc'

export class SocialError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function json<T>(url: string, init: RequestInit, http: typeof fetch): Promise<T> {
  const res = await http(url, { ...init, signal: AbortSignal.timeout(20_000) })
  const text = await res.text()
  if (res.status === 401 || res.status === 403) throw new SocialError('the platform rejected the stored credential — reconnect the account', res.status)
  if (!res.ok) {
    let detail = text.slice(0, 240)
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string; error_description?: string }
      detail = parsed.message || parsed.error_description || parsed.error || detail
    } catch { /* not JSON */ }
    throw new SocialError(`the platform said ${res.status}: ${detail}`, res.status)
  }
  return (text ? JSON.parse(text) : {}) as T
}

// ── Bluesky ─────────────────────────────────────────────────────────────────

export interface BskySession {
  accessJwt: string
  refreshJwt: string
  did: string
  handle: string
}

/** Sign in with a handle and an app password the user created in Bluesky settings. */
export async function bskyCreateSession(
  identifier: string, appPassword: string, http: typeof fetch = fetch,
): Promise<BskySession> {
  const id = String(identifier ?? '').trim().replace(/^@/, '')
  if (!id) throw new SocialError('enter your Bluesky handle', 0)
  if (!appPassword) throw new SocialError('enter the app password from Bluesky settings', 0)
  const doc = await json<BskySession>(`${BSKY_PDS}/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: id, password: appPassword }),
  }, http)
  if (!doc.accessJwt || !doc.did) throw new SocialError('Bluesky returned no session', 0)
  return doc
}

export async function bskyRefresh(cred: BlueskyCredential, http: typeof fetch = fetch): Promise<BskySession> {
  const doc = await json<BskySession>(`${BSKY_PDS}/com.atproto.server.refreshSession`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred.refreshJwt}` },
  }, http)
  return doc
}

interface BskyNotification {
  uri: string
  cid: string
  author: { did: string; handle: string; displayName?: string }
  reason: string
  reasonSubject?: string
  record: { text?: string; createdAt?: string }
  isRead: boolean
  indexedAt: string
}

/** Notifications: mentions, replies, quotes, follows, likes, reposts. */
export async function bskyNotifications(
  cred: BlueskyCredential, limit = 50, http: typeof fetch = fetch,
): Promise<DigestSocialItem[]> {
  const doc = await json<{ notifications?: BskyNotification[] }>(
    `${BSKY_PDS}/app.bsky.notification.listNotifications?limit=${Math.min(Math.max(limit, 1), 100)}`,
    { headers: { Authorization: `Bearer ${cred.accessJwt}` } }, http,
  )
  const kindOf = (reason: string): DigestSocialItem['kind'] => {
    switch (reason) {
      case 'mention': return 'mention'
      case 'reply': return 'reply'
      case 'quote': return 'quote'
      case 'follow': return 'follow'
      case 'repost': return 'repost'
      case 'like': return 'like'
      default: return 'mention'
    }
  }
  return (doc.notifications ?? []).map(n => {
    // A notification's uri is an at:// record; the web permalink is built from the handle
    // and the record key, which is the documented public form.
    const rkey = n.uri.split('/').pop() ?? ''
    const isPost = ['app.bsky.feed.post'].includes(n.uri.split('/')[3] ?? '')
    return {
      id: n.uri,
      platform: 'bluesky' as const,
      kind: kindOf(n.reason),
      author: n.author.displayName ? `${n.author.displayName} (@${n.author.handle})` : `@${n.author.handle}`,
      text: n.record?.text ?? '',
      createdAt: n.indexedAt,
      url: isPost && rkey ? `https://bsky.app/profile/${n.author.handle}/post/${rkey}` : null,
      unread: !n.isRead,
    }
  })
}

/** Post to the account. Called only after the user approved this exact text. */
export async function bskyPost(
  cred: BlueskyCredential, text: string, http: typeof fetch = fetch,
): Promise<{ uri: string; cid: string; url: string }> {
  const body = String(text ?? '').trim()
  if (!body) throw new SocialError('a post needs some text', 0)
  // Bluesky's own limit is 300 graphemes; count code points as a close, safe approximation.
  if ([...body].length > 300) throw new SocialError(`Bluesky allows 300 characters; this is ${[...body].length}`, 0)
  const doc = await json<{ uri: string; cid: string }>(`${BSKY_PDS}/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred.accessJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo: cred.did,
      collection: 'app.bsky.feed.post',
      record: { $type: 'app.bsky.feed.post', text: body, createdAt: new Date().toISOString() },
    }),
  }, http)
  const rkey = doc.uri.split('/').pop() ?? ''
  return { uri: doc.uri, cid: doc.cid, url: `https://bsky.app/profile/${cred.handle}/post/${rkey}` }
}

/** The account's own recent posts, for the "what is live" view. Read-only. */
export async function bskyOwnPosts(
  cred: BlueskyCredential, limit = 10, http: typeof fetch = fetch,
): Promise<{ text: string; createdAt: string; url: string; likes: number; replies: number; reposts: number }[]> {
  const doc = await json<{ feed?: { post: { uri: string; record: { text?: string; createdAt?: string }; likeCount?: number; replyCount?: number; repostCount?: number } }[] }>(
    `${BSKY_PUBLIC}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(cred.did)}&limit=${Math.min(Math.max(limit, 1), 50)}&filter=posts_no_replies`,
    { headers: {} }, http,
  )
  return (doc.feed ?? []).map(f => ({
    text: f.post.record?.text ?? '',
    createdAt: f.post.record?.createdAt ?? '',
    url: `https://bsky.app/profile/${cred.handle}/post/${f.post.uri.split('/').pop() ?? ''}`,
    likes: f.post.likeCount ?? 0,
    replies: f.post.replyCount ?? 0,
    reposts: f.post.repostCount ?? 0,
  }))
}

// ── Mastodon ────────────────────────────────────────────────────────────────

export function normaliseInstance(input: string): string {
  const raw = String(input ?? '').trim()
  if (!raw) throw new SocialError('enter your Mastodon instance, e.g. mastodon.social', 0)
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try { url = new URL(withScheme) } catch { throw new SocialError('that is not a valid instance address', 0) }
  if (url.protocol !== 'https:') throw new SocialError('Mastodon instances are reached over https', 0)
  if (url.pathname !== '/' && url.pathname !== '') throw new SocialError('enter just the instance address, with no path', 0)
  return url.origin
}

interface MastodonNotification {
  id: string
  type: string
  created_at: string
  account: { acct: string; display_name?: string; url?: string }
  status?: { id: string; content?: string; url?: string; created_at?: string }
}

export async function mastodonVerify(
  instance: string, accessToken: string, http: typeof fetch = fetch,
): Promise<{ account: string; displayName: string }> {
  const origin = normaliseInstance(instance)
  const doc = await json<{ acct?: string; username?: string; display_name?: string }>(
    `${origin}/api/v1/accounts/verify_credentials`,
    { headers: { Authorization: `Bearer ${accessToken}` } }, http,
  )
  return { account: doc.acct || doc.username || '', displayName: doc.display_name || '' }
}

export async function mastodonNotifications(
  cred: MastodonCredential, limit = 40, http: typeof fetch = fetch,
): Promise<DigestSocialItem[]> {
  const origin = normaliseInstance(cred.instance)
  const doc = await json<MastodonNotification[]>(
    `${origin}/api/v1/notifications?limit=${Math.min(Math.max(limit, 1), 80)}&types[]=mention&types[]=status&types[]=follow&types[]=favourite&types[]=reblog`,
    { headers: { Authorization: `Bearer ${cred.accessToken}` } }, http,
  )
  const kindOf = (type: string): DigestSocialItem['kind'] => {
    switch (type) {
      case 'mention': return 'mention'
      case 'status': return 'reply'
      case 'follow': return 'follow'
      case 'favourite': return 'like'
      case 'reblog': return 'repost'
      default: return 'mention'
    }
  }
  return (Array.isArray(doc) ? doc : []).map(n => ({
    id: n.id,
    platform: 'mastodon' as const,
    kind: kindOf(n.type),
    author: n.account.display_name ? `${n.account.display_name} (@${n.account.acct})` : `@${n.account.acct}`,
    text: (n.status?.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim(),
    createdAt: n.created_at,
    url: n.status?.url ?? null,
    unread: true,
  }))
}

/** Post to the account. Called only after the user approved this exact text. */
export async function mastodonPost(
  cred: MastodonCredential, text: string, http: typeof fetch = fetch,
): Promise<{ id: string; url: string }> {
  const body = String(text ?? '').trim()
  if (!body) throw new SocialError('a post needs some text', 0)
  const origin = normaliseInstance(cred.instance)
  const doc = await json<{ id: string; url: string }>(`${origin}/api/v1/statuses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: body, visibility: 'public' }),
  }, http)
  return { id: doc.id, url: doc.url }
}

export async function mastodonOwnPosts(
  cred: MastodonCredential, limit = 10, http: typeof fetch = fetch,
): Promise<{ text: string; createdAt: string; url: string; likes: number; replies: number; reposts: number }[]> {
  const origin = normaliseInstance(cred.instance)
  const me = await json<{ id: string }>(`${origin}/api/v1/accounts/verify_credentials`, {
    headers: { Authorization: `Bearer ${cred.accessToken}` },
  }, http)
  const doc = await json<{ content?: string; created_at?: string; url?: string; favourites_count?: number; replies_count?: number; reblogs_count?: number }[]>(
    `${origin}/api/v1/accounts/${encodeURIComponent(me.id)}/statuses?limit=${Math.min(Math.max(limit, 1), 40)}&exclude_replies=true`,
    { headers: { Authorization: `Bearer ${cred.accessToken}` } }, http,
  )
  return (Array.isArray(doc) ? doc : []).map(s => ({
    text: (s.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim(),
    createdAt: s.created_at ?? '',
    url: s.url ?? '',
    likes: s.favourites_count ?? 0,
    replies: s.replies_count ?? 0,
    reposts: s.reblogs_count ?? 0,
  }))
}
