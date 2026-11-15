import crypto from 'crypto'
import type { GmailCredential } from './credentials'

/**
 * Gmail, through Google's own documented API.
 *
 * The user creates an OAuth client in their own Google Cloud project (Desktop app type),
 * pastes the client id and secret into Goga, and signs in through Google's own consent
 * screen in their browser. Goga never sees the password. The refresh token is stored with
 * safeStorage.
 *
 * Scopes are the narrowest that do the job:
 *   gmail.readonly   — read and search mail
 *   gmail.labels     — apply and remove labels
 *   gmail.compose    — create drafts
 *   gmail.send       — send, used only for a message the user approved
 *
 * Nothing here sends on its own. `sendMessage` is called from one place, after the
 * approval queue has released that exact message.
 */

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
]

const AUTH_HOST = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_HOST = 'https://oauth2.googleapis.com/token'
const API_HOST = 'https://gmail.googleapis.com/gmail/v1'

export class GmailError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function authUrl(clientId: string, redirectUri: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    // Without this Google returns a refresh token only the first time ever.
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${AUTH_HOST}?${params.toString()}`
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

async function tokenRequest(body: Record<string, string>, http: typeof fetch): Promise<TokenResponse> {
  const res = await http(TOKEN_HOST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let json: TokenResponse = {}
  try { json = JSON.parse(text) as TokenResponse } catch { /* handled below */ }
  if (!res.ok || json.error) {
    const why = json.error_description || json.error || `HTTP ${res.status}`
    throw new GmailError(`Google refused the sign-in: ${why}`, res.status)
  }
  return json
}

export async function exchangeCode(
  clientId: string, clientSecret: string, code: string, redirectUri: string, verifier: string,
  http: typeof fetch = fetch,
): Promise<TokenResponse> {
  return tokenRequest({
    client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri,
    grant_type: 'authorization_code', code_verifier: verifier,
  }, http)
}

export async function refreshAccessToken(cred: GmailCredential, http: typeof fetch = fetch): Promise<string> {
  const json = await tokenRequest({
    client_id: cred.clientId, client_secret: cred.clientSecret,
    refresh_token: cred.refreshToken, grant_type: 'refresh_token',
  }, http)
  if (!json.access_token) throw new GmailError('Google returned no access token', 0)
  return json.access_token
}

// ── API ─────────────────────────────────────────────────────────────────────

interface GmailHeader { name: string; value: string }
interface GmailPart {
  mimeType?: string
  headers?: GmailHeader[]
  body?: { data?: string; size?: number }
  parts?: GmailPart[]
}
export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: GmailPart
}

export interface ParsedMail {
  id: string
  threadId: string
  from: string
  to: string
  subject: string
  date: string
  snippet: string
  unread: boolean
  important: boolean
  /** True when the message carries a List-Unsubscribe header — a bulk send, not a person. */
  bulk: boolean
  bodyText: string
  url: string
}

function header(part: GmailPart | undefined, name: string): string {
  const found = part?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())
  return found?.value ?? ''
}

function decodeBase64Url(data: string): string {
  try { return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') } catch { return '' }
}

/** Walk the MIME tree for the first text/plain part, falling back to text/html stripped. */
function bodyOf(part: GmailPart | undefined, depth = 0): string {
  if (!part || depth > 8) return ''
  if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data)
  for (const child of part.parts ?? []) {
    const text = bodyOf(child, depth + 1)
    if (text) return text
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return decodeBase64Url(part.body.data)
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s{2,}/g, ' ').trim()
  }
  return ''
}

export function parseMessage(m: GmailMessage): ParsedMail {
  const labels = m.labelIds ?? []
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m.payload, 'From'),
    to: header(m.payload, 'To'),
    subject: header(m.payload, 'Subject') || '(no subject)',
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m.payload, 'Date'),
    snippet: (m.snippet ?? '').trim(),
    unread: labels.includes('UNREAD'),
    important: labels.includes('IMPORTANT'),
    bulk: !!header(m.payload, 'List-Unsubscribe'),
    bodyText: bodyOf(m.payload).slice(0, 20_000),
    url: `https://mail.google.com/mail/u/0/#all/${m.id}`,
  }
}

export class GmailClient {
  private accessToken: string | null = null
  private expiresAt = 0

  constructor(private cred: GmailCredential, private http: typeof fetch = fetch) {}

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken
    const fresh = await refreshAccessToken(this.cred, this.http)
    this.accessToken = fresh
    this.expiresAt = Date.now() + 50 * 60_000
    return fresh
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.token()
    const res = await this.http(`${API_HOST}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(25_000),
    })
    const text = await res.text()
    if (res.status === 401) throw new GmailError('Gmail rejected the stored token — reconnect the account', 401)
    if (res.status === 403) throw new GmailError('Gmail refused this request: the account has not granted that scope', 403)
    if (!res.ok) {
      let detail = text.slice(0, 240)
      try { detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail } catch { /* not JSON */ }
      throw new GmailError(`Gmail said ${res.status}: ${detail}`, res.status)
    }
    return (text ? JSON.parse(text) : {}) as T
  }

  /** The address this token belongs to. Used to show which account is connected. */
  async profile(): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number }> {
    return this.call('/users/me/profile')
  }

  async listMessageIds(query: string, max = 25): Promise<string[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(max, 1), 100)) })
    const doc = await this.call<{ messages?: { id: string }[] }>(`/users/me/messages?${params.toString()}`)
    return (doc.messages ?? []).map(m => m.id)
  }

  async getMessage(id: string): Promise<GmailMessage> {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new GmailError('that is not a Gmail message id', 0)
    return this.call(`/users/me/messages/${id}?format=full`)
  }

  async getThread(id: string): Promise<{ id: string; messages?: GmailMessage[] }> {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new GmailError('that is not a Gmail thread id', 0)
    return this.call(`/users/me/threads/${id}?format=full`)
  }

  async labels(): Promise<{ id: string; name: string; type: string }[]> {
    const doc = await this.call<{ labels?: { id: string; name: string; type: string }[] }>('/users/me/labels')
    return doc.labels ?? []
  }

  async modifyLabels(messageId: string, add: string[], remove: string[]): Promise<void> {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(messageId)) throw new GmailError('that is not a Gmail message id', 0)
    await this.call(`/users/me/messages/${messageId}/modify`, {
      method: 'POST',
      body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
    })
  }

  /** Create a draft. This is the default way Goga writes mail: it lands in Drafts. */
  async createDraft(raw: string, threadId?: string): Promise<{ id: string; message: { id: string; threadId: string } }> {
    return this.call('/users/me/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }),
    })
  }

  /** Send. Called only after the user approved this exact message. */
  async sendMessage(raw: string, threadId?: string): Promise<{ id: string; threadId: string; labelIds?: string[] }> {
    return this.call('/users/me/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
    })
  }
}

/** RFC 2822 message, base64url encoded the way Gmail's API wants it. */
export function buildRawMessage(input: {
  to: string
  subject: string
  body: string
  from?: string
  inReplyTo?: string
  references?: string
}): string {
  const to = String(input.to ?? '').trim()
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(to)) throw new Error('that does not look like an email address')
  const subject = String(input.subject ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (!subject) throw new Error('a message needs a subject')
  const lines = [
    ...(input.from ? [`From: ${input.from}`] : []),
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.references || input.inReplyTo}`] : []),
    '',
    String(input.body ?? ''),
  ]
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
}
