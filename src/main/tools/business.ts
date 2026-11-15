import { ToolRegistry } from './registry'
import type { ToolResult } from '../../shared/types'
import {
  businessPageState, connectionAccounts, refreshDigest, saveProfile,
  prepareMail, preparePost, prepareListing, checkAllApps,
} from '../services/business/service'
import { connectionViews, DECLINED } from '../services/business/connections'
import { readAudit } from '../services/business/audit'
import { listListings, listPosts, testerWorkspace } from '../services/business/store'
import { describeApp, summariseApp } from '../services/business/testers'
import { monitorRows } from '../services/business/monitor'
import { SOURCES, MANUAL_MARKETPLACES } from '../services/business/jobs'

/**
 * Business tools.
 *
 * Everything here READS, or drafts into the user's own local store. There is no tool that
 * sends mail, posts, creates a storefront product, invites a tester or publishes a release:
 * those are prepared as a pending action and executed only from the Business page, where the
 * user presses Approve on that exact action. A model cannot approve on the user's behalf.
 */

const reg = ToolRegistry.getInstance()
const failure = (err: unknown): ToolResult => ({ success: false, error: err instanceof Error ? err.message : String(err) })

reg.register({
  name: 'business.status',
  description:
    'What the business layer can currently do: each connection (Gmail, Bluesky, Mastodon, Shopify, Printful) with its state and the account it is signed in as — never a secret — plus the platforms Goga deliberately does not automate and why. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => {
  const views = connectionViews()
  const accounts = connectionAccounts()
  return {
    success: true,
    data: [
      ...views.map(v => `${v.name} (${v.kind}, ${v.authKind}): ${v.state}${accounts[v.id] ? ` as ${accounts[v.id]}` : ''} — ${v.detail}`),
      '',
      'Can do:',
      ...views.flatMap(v => v.capabilities.map(c => `  ${v.name}: ${c}`)),
      'Cannot do:',
      ...views.flatMap(v => v.limits.map(l => `  ${v.name}: ${l}`)),
      '',
      'Deliberately not automated:',
      ...DECLINED.map(d => `  ${d.name}: ${d.reason} Instead — ${d.manualPath}`),
    ].join('\n'),
  }
})

reg.register({
  name: 'business.digest',
  description:
    'Read the user\'s own Gmail inbox and Bluesky/Mastodon notifications and summarise what needs attention. Every item carries the real link back to it. Items that could not be read are reported, never shown as empty. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'web',
}, async () => {
  try {
    const d = await refreshDigest()
    return {
      success: true,
      data: [
        d.summary,
        '',
        d.mail.connected
          ? `Mail: ${d.mail.unread} unread, ${d.mail.important} important, ${d.mail.needsReply} waiting on a reply.`
          : `Mail: not read (${d.mail.error ?? 'not connected'}).`,
        ...d.mail.items.slice(0, 12).map(m => `  ${m.unread ? '•' : ' '} ${m.from} — "${m.subject}" (${m.receivedAt.slice(0, 10)}) ${m.url}`),
        '',
        d.social.connected ? `Social: ${d.social.items.length} notification(s).` : 'Social: not read (nothing connected).',
        ...d.social.byPlatform.map(p => `  ${p.platform}: ${p.count}${p.error ? ` (${p.error})` : ''}`),
        ...d.social.items.slice(0, 10).map(s => `  ${s.platform} ${s.kind} from ${s.author}: ${s.text.slice(0, 120)}${s.url ? ` ${s.url}` : ''}`),
        ...(d.notes.length ? ['', 'What this does not tell you:', ...d.notes.map(n => `  • ${n}`)] : []),
      ].join('\n'),
    }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'business.drafts',
  description: 'The local drafts waiting for the user: storefront listings and social posts, with their status (draft, created, posted, failed). Read-only — nothing here was sent.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => {
  const listings = listListings()
  const posts = listPosts()
  if (!listings.length && !posts.length) {
    return { success: true, data: 'No listing or post drafts yet. Drafts are prepared in the Business page, then approved there.' }
  }
  return {
    success: true,
    data: [
      ...listings.map(l => `listing [${l.status}] ${l.storefront}: "${l.title}" ${l.price.toFixed(2)} ${l.currency}${l.remoteUrl ? ` — ${l.remoteUrl}` : ''}${l.error ? ` (error: ${l.error})` : ''}`),
      ...posts.map(p => `post [${p.status}] ${p.platform}: "${p.text.slice(0, 80)}"${p.remoteUrl ? ` — ${p.remoteUrl}` : ''}${p.error ? ` (error: ${p.error})` : ''}`),
    ].join('\n'),
  }
})

reg.register({
  name: 'business.testers',
  description:
    'The tester-recruitment tracker, per app: each app with its package name, Play track, how many testers Google requires, how many are opted in right now, how many days until the 14-day streak completes, and every candidate with their state (candidate, invited, accepted, installed, opted-in, dropped) and the dates recorded. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => {
  const w = testerWorkspace()
  if (!w.apps.length) return { success: true, data: 'No apps are being tracked yet. Add one in the Business page with its package name.' }
  const now = new Date()
  const blocks = w.apps.map(a => describeApp(summariseApp(a, now), a))
  return {
    success: true,
    data: [
      ...blocks,
      '',
      'Google counts only testers who are opted in, per app, continuously for 14 days. These figures are the dates recorded here, not a reading of Play Console.',
      ...(w.copyDrafts.length ? ['', 'Recruitment copy:', ...w.copyDrafts.map(d => `  [${d.channel}] ${d.text.slice(0, 160)}`)] : []),
    ].join('\n'),
  }
})

reg.register({
  name: 'business.monitor',
  description: 'The apps and sites being monitored: each one\'s URL, the live version the user says, the last health check and its uptime. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => {
  const rows = monitorRows(businessPageState(null, null).apps)
  if (!rows.length) return { success: true, data: 'Nothing is being monitored yet. Add an app or site in the Business page.' }
  return {
    success: true,
    data: rows.map(r => [
      `${r.app.name} — ${r.app.url}${r.down ? '  DOWN on the last checks' : ''}`,
      `  version ${r.app.liveVersion || '(not stated)'}, published via ${r.app.publishedWhere || '(not stated)'}`,
      `  ${r.uptime.checks} check(s), ${r.uptime.up} ok, uptime ${r.uptime.uptimePct === null ? 'not measured' : `${r.uptime.uptimePct.toFixed(1)}%`}, average ${r.uptime.avgMs ?? '—'}ms`,
      r.uptime.lastCheck ? `  last: ${r.uptime.lastCheck.at.slice(0, 19).replace('T', ' ')} ${r.uptime.lastCheck.ok ? 'ok' : `failed (${r.uptime.lastCheck.error ?? r.uptime.lastCheck.status})`}` : '  never checked',
    ].join('\n')).join('\n\n'),
  }
})

reg.register({
  name: 'business.audit',
  description: 'The business audit trail: every prepared action, approval, denial, send, error and read, with the time. Use it to answer "what was sent, and who approved it". Read-only.',
  parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many recent entries (default 40).' } } },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async p => {
  const entries = readAudit(Number(p.limit) || 40)
  if (!entries.length) return { success: true, data: 'The business audit log is empty.' }
  return { success: true, data: entries.map(e => `${e.time.slice(0, 19).replace('T', ' ')} [${e.kind}] ${e.action}: ${e.detail}`).join('\n') }
})

reg.register({
  name: 'business.jobSources',
  description: 'The freelance sources Goga can read directly, and the marketplaces it will not scrape — with the search URL it prepares for the user to run themselves. Read-only.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'memory',
}, async () => ({
  success: true,
  data: [
    'Read directly:',
    ...SOURCES.map(s => `  ${s.name} (${s.url}) — ${s.about}`),
    '',
    'Prepared for you, never scraped:',
    ...MANUAL_MARKETPLACES.map(m => `  ${m.name}: ${m.note}`),
  ].join('\n'),
}))

reg.register({
  name: 'business.saveProfile',
  description:
    'Save the user\'s freelance profile (headline, skills, portfolio links, rate floor, currency, availability, timezone, kinds of work, summary) so job matches and proposals can be scored against it. Writes only to Goga\'s own local store.',
  parameters: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'One line: what they do.' },
      skills: { type: 'array', description: 'Skill names.' },
      portfolio: { type: 'array', description: 'Portfolio URLs.' },
      rateFloor: { type: 'number', description: 'Lowest acceptable rate, per hour unless the summary says otherwise.' },
      currency: { type: 'string', description: 'e.g. USD.' },
      availability: { type: 'string', description: 'e.g. "20 hours a week, remote".' },
      timezone: { type: 'string', description: 'e.g. Europe/Berlin.' },
      kinds: { type: 'array', description: 'Kinds of work wanted, e.g. ["frontend","automation"].' },
      summary: { type: 'string', description: 'A short paragraph about their experience.' },
    },
  },
  riskLevel: 'low', reversible: true, category: 'filesystem',
}, async p => {
  try {
    const patch: Record<string, unknown> = {}
    for (const key of ['headline', 'currency', 'availability', 'timezone', 'summary'] as const) {
      if (typeof p[key] === 'string') patch[key] = p[key]
    }
    for (const key of ['skills', 'portfolio', 'kinds'] as const) {
      if (Array.isArray(p[key])) patch[key] = (p[key] as unknown[]).map(String)
    }
    if (p.rateFloor !== undefined) patch.rateFloor = Number(p.rateFloor)
    if (!Object.keys(patch).length) return { success: false, error: 'nothing to save — give at least one field' }
    const saved = saveProfile(patch)
    return { success: true, data: `Saved. Headline: ${saved.headline || '(none)'}. Skills: ${saved.skills.join(', ') || '(none)'}. Rate floor: ${saved.rateFloor || 'not set'} ${saved.currency}.` }
  } catch (err) { return failure(err) }
})


// ── Preparing an action, from chat ───────────────────────────────────────────
//
// The Business page could prepare a mail, a post, a listing and a tester invite, and chat
// could only read. Preparing sends nothing: it writes a pending action the user approves on
// the page, and that approval is bound to the exact action. So reaching it from chat is safe,
// and it is the difference between "Goga can tell you about your business" and "Goga can do
// the first half of the work".

reg.register({
  name: 'business.prepareMail',
  description: 'Prepare an email as a PENDING action: recipient, subject and body, saved locally. Nothing is sent. The user approves that exact message on the Business page, and only then does it go. Use this when asked to draft or write an email.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient address.' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'The message body, in full.' },
    },
    required: ['to', 'subject', 'body'],
  },
  riskLevel: 'medium', reversible: true, category: 'filesystem',
}, async p => {
  try {
    const result = prepareMail({ to: String(p.to ?? ''), subject: String(p.subject ?? ''), body: String(p.body ?? '') })
    return { success: result.ok, data: result.message, error: result.ok ? undefined : result.message }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'business.preparePost',
  description: 'Prepare a social post (Bluesky or Mastodon) as a PENDING action, saved locally. Nothing is posted. The user approves that exact post on the Business page. Use this when asked to draft a post.',
  parameters: {
    type: 'object',
    properties: {
      platform: { type: 'string', enum: ['bluesky', 'mastodon'], description: 'Which platform.' },
      text: { type: 'string', description: 'The post text.' },
      about: { type: 'string', description: 'What it is about, for the record.' },
    },
    required: ['platform', 'text'],
  },
  riskLevel: 'medium', reversible: true, category: 'filesystem',
}, async p => {
  try {
    const platform = String(p.platform) === 'mastodon' ? 'mastodon' : 'bluesky'
    const result = preparePost(platform, String(p.text ?? ''), String(p.about ?? ''))
    return { success: result.ok, data: result.message, error: result.ok ? undefined : result.message }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'business.prepareListing',
  description: 'Prepare a storefront listing (Shopify or Printful) as a PENDING action, saved locally. Nothing is created on the storefront. The user approves that exact listing on the Business page.',
  parameters: {
    type: 'object',
    properties: {
      storefront: { type: 'string', enum: ['shopify', 'printful'], description: 'Which storefront.' },
      title: { type: 'string', description: 'Listing title.' },
      description: { type: 'string', description: 'Listing description.' },
      tags: { type: 'array', description: 'Tags.' },
      price: { type: 'number', description: 'Price.' },
      currency: { type: 'string', description: 'Currency, e.g. USD.' },
      shipping: { type: 'string', description: 'Shipping note.' },
    },
    required: ['storefront', 'title', 'price'],
  },
  riskLevel: 'medium', reversible: true, category: 'filesystem',
}, async p => {
  try {
    const storefront = String(p.storefront) === 'printful' ? 'printful' : 'shopify'
    const result = prepareListing({
      storefront: storefront as never,
      title: String(p.title ?? ''),
      description: String(p.description ?? ''),
      tags: Array.isArray(p.tags) ? (p.tags as unknown[]).map(String) : [],
      price: Number(p.price) || 0,
      currency: String(p.currency ?? 'USD'),
      shipping: String(p.shipping ?? ''),
    })
    return { success: result.ok, data: result.message, error: result.ok ? undefined : result.message }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'business.checkApps',
  description: 'Run a fresh health check on every monitored app and site, and report each one\'s status, response time and whether it is down. This makes real HTTP requests to the user\'s own sites. Use it for "check my apps" or "is my site up".',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'medium', reversible: true, category: 'web',
}, async () => {
  try {
    const result = await checkAllApps()
    if (!result.results.length) return { success: true, data: 'Nothing is being monitored yet. Add an app or site in the Business section first.' }
    return {
      success: true,
      data: result.results.map(r => `${r.id}: ${r.check.ok ? `up (${r.check.status}, ${r.check.ms}ms)` : `DOWN — ${r.check.error ?? r.check.status}`} at ${r.check.at.slice(0, 19).replace('T', ' ')}`).join('\n'),
    }
  } catch (err) { return failure(err) }
})
