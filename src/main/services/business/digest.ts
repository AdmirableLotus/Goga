import type { Digest, DigestMailItem, DigestSocialItem } from '../../../shared/business'
import { readCredential, type BlueskyCredential, type GmailCredential, type MastodonCredential } from './credentials'
import { GmailClient, parseMessage } from './gmail'
import { bskyNotifications, mastodonNotifications } from './social'

/**
 * The digest: what needs attention in mail and on the two social accounts Goga can read.
 *
 * Every item carries the real link back to the real thing, and the time it was read. The
 * summary is written by the local model from those items only — it is given the items and
 * told to use nothing else. When the model is unavailable the digest still returns the
 * items and a plain count, and says the summary was not written.
 *
 * Nothing here invents a message. If a read fails, the failure is reported in `notes` and
 * the section is marked as not read, rather than shown as empty.
 */

const MAIL_QUERY = 'in:inbox newer_than:14d -category:promotions -category:social'
const MAX_MAIL = 25

export interface DigestDeps {
  /** Local model, prose. Rejects when no brain is running. */
  summarise: (prompt: string) => Promise<string>
  http?: typeof fetch
}

export async function buildDigest(deps: DigestDeps): Promise<Digest> {
  const notes: string[] = []
  const http = deps.http ?? fetch

  // ── mail ──
  let mailItems: DigestMailItem[] = []
  let mailConnected = false
  let mailError: string | null = null
  const gmailCred = readCredential<GmailCredential>('gmail')
  if (!gmailCred) {
    mailError = 'Gmail is not connected, so no mail was read.'
  } else {
    mailConnected = true
    try {
      const client = new GmailClient(gmailCred, http)
      const ids = await client.listMessageIds(MAIL_QUERY, MAX_MAIL)
      const messages = await Promise.all(ids.map(id => client.getMessage(id).catch(() => null)))
      const parsed = messages.filter((m): m is NonNullable<typeof m> => m !== null).map(parseMessage)
      // A thread needs a reply when its newest message is from someone else and it is not bulk.
      const newestByThread = new Map<string, string>()
      for (const m of parsed) {
        const seen = newestByThread.get(m.threadId)
        if (!seen || Date.parse(m.date) > Date.parse(seen)) newestByThread.set(m.threadId, m.date)
      }
      mailItems = parsed.map(m => ({
        id: m.id,
        threadId: m.threadId,
        from: m.from,
        subject: m.subject,
        snippet: m.snippet,
        receivedAt: m.date,
        unread: m.unread,
        important: m.important,
        needsReply: !m.bulk && newestByThread.get(m.threadId) === m.date,
        url: m.url,
      }))
      if (parsed.length < ids.length) {
        notes.push(`${ids.length - parsed.length} message(s) could not be read and are not in this digest.`)
      }
    } catch (err) {
      mailError = err instanceof Error ? err.message : String(err)
      notes.push(`Mail could not be read: ${mailError}`)
    }
  }

  // ── social ──
  const socialItems: DigestSocialItem[] = []
  const byPlatform: Digest['social']['byPlatform'] = []
  let socialConnected = false

  const bsky = readCredential<BlueskyCredential>('bluesky')
  if (bsky) {
    socialConnected = true
    try {
      const items = await bskyNotifications(bsky, 40, http)
      socialItems.push(...items)
      byPlatform.push({ platform: 'Bluesky', count: items.length, error: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      byPlatform.push({ platform: 'Bluesky', count: 0, error: message })
      notes.push(`Bluesky notifications could not be read: ${message}`)
    }
  } else {
    byPlatform.push({ platform: 'Bluesky', count: 0, error: 'not connected' })
  }

  const masto = readCredential<MastodonCredential>('mastodon')
  if (masto) {
    socialConnected = true
    try {
      const items = await mastodonNotifications(masto, 40, http)
      socialItems.push(...items)
      byPlatform.push({ platform: 'Mastodon', count: items.length, error: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      byPlatform.push({ platform: 'Mastodon', count: 0, error: message })
      notes.push(`Mastodon notifications could not be read: ${message}`)
    }
  } else {
    byPlatform.push({ platform: 'Mastodon', count: 0, error: 'not connected' })
  }

  socialItems.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  const unread = mailItems.filter(m => m.unread).length
  const important = mailItems.filter(m => m.important).length
  const needsReply = mailItems.filter(m => m.needsReply).length

  // ── summary ──
  let summary = ''
  const nothingToSay = mailItems.length === 0 && socialItems.length === 0
  if (nothingToSay) {
    summary = mailConnected || socialConnected
      ? 'Nothing needs attention in what Goga can read right now.'
      : 'Nothing is connected yet, so there is nothing to summarise.'
  } else {
    try {
      summary = await deps.summarise(summaryPrompt(mailItems, socialItems))
      summary = summary.trim()
      if (!summary) throw new Error('the model returned nothing')
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      summary = `${unread} unread, ${important} marked important, ${needsReply} waiting on a reply; ${socialItems.length} social notification(s). No summary was written (${why}).`
      notes.push('The local model did not write a summary, so the counts above are the whole digest.')
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    mail: { connected: mailConnected, unread, important, needsReply, items: mailItems, error: mailError },
    social: { connected: socialConnected, items: socialItems, byPlatform },
    summary,
    notes,
  }
}

/**
 * The prompt is built from the items and nothing else, and says so. The model is asked for
 * a short brief, not for advice, and is told not to add anything that is not in the list.
 */
export function summaryPrompt(mail: DigestMailItem[], social: DigestSocialItem[]): string {
  const mailLines = mail.slice(0, 20).map(m =>
    `- ${m.unread ? '[unread] ' : ''}${m.important ? '[important] ' : ''}${m.needsReply ? '[needs reply] ' : ''}from ${m.from}: "${m.subject}" — ${m.snippet.slice(0, 160)}`,
  )
  const socialLines = social.slice(0, 20).map(s =>
    `- ${s.platform} ${s.kind} from ${s.author}: ${s.text.slice(0, 160) || '(no text)'}`,
  )
  return [
    'You are summarising a person\'s inbox and social notifications for them.',
    'Use ONLY the items listed below. Do not invent a message, a sender, a number or a link.',
    'If a list is empty, say so in one clause. Do not give advice or suggest replies.',
    'Write at most 5 short sentences, plain prose, no headings, no bullet points.',
    '',
    'MAIL:',
    mailLines.length ? mailLines.join('\n') : '(no mail items)',
    '',
    'SOCIAL:',
    socialLines.length ? socialLines.join('\n') : '(no social items)',
  ].join('\n')
}
