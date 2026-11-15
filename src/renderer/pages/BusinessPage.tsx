import React, { useCallback, useEffect, useState } from 'react'
import type {
  ArtListingDraft, BusinessPageState, BusinessActionResult, ConnectionView, Digest, DigestMailItem,
  MonitoredApp, PendingAction, SocialPostDraft,
} from '../../shared/business'
import { PageHeader, Card, Field, EmptyState, Alert, Chip } from '../components/ui'
import TesterTracker from '../components/TesterTracker'
import PlayConsole from '../components/PlayConsole'

/**
 * Business page.
 *
 * Sections: connections, the inbox/social digest, drafts (mail, post, listing), the
 * tester-recruitment tracker, and the deploy/monitor view.
 *
 * The approvals card is the only place on this page that sends anything. Everything else
 * either reads, or prepares a PendingAction with the full content shown, and the sending
 * happens only when Approve is pressed for that exact action. There is no publish button:
 * publishing a release is the user's own click in their own account, and the page says so.
 */

const when = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace('T', ' ')}Z` : '—')
const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s)

const STATE_TONE: Record<string, 'ok' | 'warn' | 'bad' | undefined> = {
  connected: 'ok', expired: 'warn', 'needs-reauth': 'warn', 'not-connected': undefined, error: 'bad',
}

export default function BusinessPage() {
  const [state, setState] = useState<BusinessPageState | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [digest, setDigest] = useState<Digest | null>(null)
  const [digestBusy, setDigestBusy] = useState(false)

  // connection forms
  const [gmailId, setGmailId] = useState('')
  const [gmailSecret, setGmailSecret] = useState('')
  const [gmailUrl, setGmailUrl] = useState('')
  const [bskyHandle, setBskyHandle] = useState('')
  const [bskyPassword, setBskyPassword] = useState('')
  const [mastoInstance, setMastoInstance] = useState('')
  const [mastoToken, setMastoToken] = useState('')
  const [shopDomain, setShopDomain] = useState('')
  const [shopToken, setShopToken] = useState('')
  const [pfToken, setPfToken] = useState('')
  const [pfStore, setPfStore] = useState('')

  // drafts
  const [mailTo, setMailTo] = useState('')
  const [mailSubject, setMailSubject] = useState('')
  const [mailBody, setMailBody] = useState('')
  const [postPlatform, setPostPlatform] = useState<'bluesky' | 'mastodon'>('bluesky')
  const [postText, setPostText] = useState('')
  const [listingStore, setListingStore] = useState<'shopify' | 'printful'>('shopify')
  const [listingTitle, setListingTitle] = useState('')
  const [listingDescription, setListingDescription] = useState('')
  const [listingTags, setListingTags] = useState('')
  const [listingPrice, setListingPrice] = useState('25')
  const [listingShipping, setListingShipping] = useState('')

  // monitor
  const [appName, setAppName] = useState('')
  const [appUrl, setAppUrl] = useState('')
  const [appPackage, setAppPackage] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const [appWhere, setAppWhere] = useState('Google Play Console')

  const load = useCallback(async () => {
    try {
      const s = await window.goga.invoke('business:state')
      setState(s)
      if (s.digest) setDigest(s.digest)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function guard<T>(fn: () => Promise<T>, okMessage?: string): Promise<T | null> {
    setBusy(true); setError(''); setNotice('')
    try {
      const r = await fn()
      if (okMessage) setNotice(okMessage)
      return r
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally { setBusy(false) }
  }

  async function readDigest() {
    setDigestBusy(true); setError(''); setNotice('')
    try {
      const d = await window.goga.invoke('business:digest')
      setDigest(d)
      void load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setDigestBusy(false) }
  }

  async function startGmail() {
    const r = await guard(() => window.goga.invoke('business:gmailAuthUrl', gmailId.trim(), gmailSecret.trim()))
    if (!r) return
    setGmailUrl(r.url)
    setGmailSecret('')
    setNotice(`A one-time sign-in link is ready on port ${r.port}. Open it in your browser, sign in to Google, and come back here.`)
  }

  async function connect(kind: 'bluesky' | 'mastodon' | 'shopify' | 'printful') {
    const calls: Record<string, () => Promise<unknown>> = {
      bluesky: () => window.goga.invoke('business:connectBluesky', bskyHandle.trim(), bskyPassword),
      mastodon: () => window.goga.invoke('business:connectMastodon', mastoInstance.trim(), mastoToken.trim()),
      shopify: () => window.goga.invoke('business:connectShopify', shopDomain.trim(), shopToken.trim()),
      printful: () => window.goga.invoke('business:connectPrintful', pfToken.trim(), pfStore.trim() || null),
    }
    const r = await guard(calls[kind], 'Connected.')
    if (!r) return
    if (kind === 'bluesky') setBskyPassword('')
    if (kind === 'mastodon') setMastoToken('')
    if (kind === 'shopify') setShopToken('')
    if (kind === 'printful') setPfToken('')
    void load()
  }

  async function prepare(result: Promise<BusinessActionResult>) {
    const r = await guard(async () => result)
    if (!r) return
    if (r.ok) setNotice(r.message); else setError(r.message)
    void load()
  }

  async function approve(id: string) {
    const r = await guard(() => window.goga.invoke('business:approve', id))
    if (!r) return
    if (r.ok) setNotice(r.message); else setError(r.message)
    void load()
  }

  async function deny(id: string) {
    const r = await guard(() => window.goga.invoke('business:deny', id))
    if (r && r.ok) setNotice(r.message)
    void load()
  }

  const connections = state?.connections ?? []
  const byKind = (kind: ConnectionView['kind']) => connections.filter(c => c.kind === kind)

  return (
    <div className="g-page">
      <div className="g-page-inner">

        <PageHeader
          title="Business"
          accent="your accounts, drafted and approved by you"
          purpose="Goga reads your own mail and notifications, drafts what goes out, and waits. Every send, post, listing and invite is approved by you, one action at a time."
          help={<>
            <p>A prepared action carries its full text. Approving it sends that exact text, once; the approval expires after 30 minutes and cannot be reused. Denying it deletes it and sends nothing.</p>
            <p>Google Play is the one place Goga will upload something: a bundle goes to a testing track only after you approve that exact upload — file, package, track and version code shown. Production releases are not offered.</p>
          </>}
          actions={<>
            <Chip tone={state?.encryptionAvailable ? 'ok' : 'bad'}>Encryption {state?.encryptionAvailable ? 'available' : 'unavailable'}</Chip>
            <Chip tone={state?.pending.length ? 'warn' : undefined}>{state?.pending.length ?? 0} waiting for approval</Chip>
            <button className="g-btn g-btn--sm" onClick={() => void load()} disabled={busy}>Refresh</button>
          </>}
        />

        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="ok">{notice}</Alert>}
        {!state?.encryptionAvailable && state && (
          <Alert kind="error">Secure storage is unavailable on this PC, so no credential can be stored. Nothing can connect until that changes.</Alert>
        )}

        {/* ── approvals, first, because it is the part waiting on the user ── */}
        {state && (
          <Card
            title="Waiting for your approval"
            sub="Nothing here has been sent. Approving sends this exact content, once."
            tone={state.pending.length ? 'accent' : undefined}
            actions={<Chip tone={state.pending.length ? 'warn' : 'ok'}>{state.pending.length} queued</Chip>}
          >
            {state.pending.length === 0 ? (
              <EmptyState icon="✅" title="Nothing is waiting" body="When you prepare a mail, a post, a listing or a tester invite, it appears here with its full text until you approve or deny it." />
            ) : (
              state.pending.map((p: PendingAction) => (
                <div key={p.id} className="g-inset" style={{ marginBottom: 10, borderColor: 'var(--accent-line)' }}>
                  <div className="g-row" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <Chip tone="accent">{p.kind}</Chip>
                      <strong style={{ marginLeft: 8 }}>{p.title}</strong>
                    </div>
                    <span className="g-caption g-faint">expires {when(p.expiresAt)}</span>
                  </div>
                  <pre className="g-inset g-mono" style={{ whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 11.5 }}>{p.content}</pre>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="g-btn g-btn--danger g-btn--sm" onClick={() => void approve(p.id)} disabled={busy}>
                      {p.kind === 'release-publish' ? 'Approve and upload this' : 'Approve and send this'}
                    </button>
                    <button className="g-btn g-btn--sm" onClick={() => void deny(p.id)} disabled={busy}>Deny</button>
                  </div>
                </div>
              ))
            )}
          </Card>
        )}

        {/* ── digest ─────────────────────────────────────────────────────── */}
        <Card
          title="What needs attention"
          sub="Your own inbox and social notifications, read on this machine"
          actions={<button className="g-btn g-btn--primary g-btn--sm" onClick={() => void readDigest()} disabled={digestBusy}>{digestBusy ? 'Reading…' : 'Read now'}</button>}
        >
          {!digest ? (
            <EmptyState
              icon="📥"
              title="Nothing read yet"
              body="Press Read now. Goga reads Gmail and the social accounts you have connected, and lists what needs a reply with a link to each item."
            />
          ) : (
            <>
              <p style={{ fontSize: 'var(--fs-body)' }}>{digest.summary}</p>
              <p className="g-caption g-faint">Read {when(digest.generatedAt)}.</p>

              {digest.notes.length > 0 && (
                <Alert kind="info">
                  <ul style={{ margin: 0, paddingLeft: 18 }}>{digest.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                </Alert>
              )}

              <div className="g-grid g-grid--2">
                <div>
                  <div className="g-section-title" style={{ marginBottom: 6 }}>
                    Mail {digest.mail.connected ? `— ${digest.mail.unread} unread, ${digest.mail.needsReply} needing a reply` : '— not connected'}
                  </div>
                  {digest.mail.error && <p className="g-caption g-faint">{digest.mail.error}</p>}
                  {digest.mail.items.length === 0 && digest.mail.connected && <p className="g-caption g-faint">No message in the last 14 days needs attention.</p>}
                  {digest.mail.items.slice(0, 20).map((m: DigestMailItem) => (
                    <div key={m.id} style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 'var(--fs-body)' }}>
                        {m.unread && <Chip>unread</Chip>} {m.needsReply && <Chip tone="warn">reply</Chip>} {m.important && <Chip tone="accent">important</Chip>}
                        {' '}<strong>{short(m.subject, 70)}</strong>
                      </div>
                      <div className="g-caption">{m.from} · {when(m.receivedAt)}</div>
                      <div className="g-caption g-faint">{short(m.snippet, 140)}</div>
                      <div className="g-caption g-mono" style={{ fontSize: 11 }}>{m.url}</div>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="g-section-title" style={{ marginBottom: 6 }}>
                    Social {digest.social.connected ? `— ${digest.social.items.length} notification(s)` : '— not connected'}
                  </div>
                  {digest.social.byPlatform.map(p => (
                    <div key={p.platform} className="g-caption">{p.platform}: {p.count}{p.error ? ` (${p.error})` : ''}</div>
                  ))}
                  {digest.social.items.slice(0, 20).map(s => (
                    <div key={`${s.platform}-${s.id}`} style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 'var(--fs-body)' }}><Chip tone="accent">{s.kind}</Chip> {s.author}</div>
                      <div className="g-caption g-faint">{short(s.text, 140) || '(no text)'}</div>
                      {s.url && <div className="g-caption g-mono" style={{ fontSize: 11 }}>{s.url}</div>}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </Card>

        {/* ── connections ────────────────────────────────────────────────── */}
        {state && (
          <Card title="Connections" sub="Your own accounts. Goga never asks for a password.">
            <div className="g-grid g-grid--2">
              {connections.map((c: ConnectionView) => (
                <div key={c.id} className="g-inset">
                  <div className="g-row" style={{ justifyContent: 'space-between' }}>
                    <strong>{c.name}</strong>
                    <Chip tone={STATE_TONE[c.state]}>{c.state}</Chip>
                  </div>
                  <p className="g-caption" style={{ marginTop: 4 }}>{c.detail}</p>
                  <details className="g-details">
                    <summary>What it can and cannot do</summary>
                    <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, marginTop: 4 }}>
                      {c.capabilities.map(x => <li key={x}>✓ {x}</li>)}
                      {c.limits.map(x => <li key={x} className="g-faint">✕ {x}</li>)}
                    </ul>
                    <p className="g-caption g-faint">Where to get it: {c.where}</p>
                  </details>
                  {c.state === 'connected' && (
                    <button className="g-btn g-btn--sm" style={{ marginTop: 6 }} onClick={() => void guard(() => window.goga.invoke('business:disconnect', c.id), 'Removed.')}>
                      Disconnect
                    </button>
                  )}
                </div>
              ))}
            </div>

            <hr className="g-divider" />

            <div className="g-grid g-grid--2">
              {!byKind('email').some(c => c.state === 'connected') && (
                <div>
                  <div className="g-section-title" style={{ marginBottom: 6 }}>Gmail — sign in</div>
                  <p className="g-caption">
                    Create an OAuth client (Desktop app) in your own Google Cloud project, enable the Gmail API, and paste its id and secret here.
                    The password is typed on Google&apos;s own page, never into Goga.
                  </p>
                  <div className="g-row">
                    <Field label="Client id"><input className="g-input g-input--md" value={gmailId} onChange={e => setGmailId(e.target.value)} /></Field>
                    <Field label="Client secret"><input className="g-input g-input--md" type="password" value={gmailSecret} onChange={e => setGmailSecret(e.target.value)} /></Field>
                    <button className="g-btn" disabled={!gmailId.trim() || !gmailSecret.trim()} onClick={() => void startGmail()}>Get sign-in link</button>
                  </div>
                  {gmailUrl && (
                    <div className="g-inset" style={{ marginTop: 8 }}>
                      <p className="g-caption">Open this in your browser and sign in to Google:</p>
                      <p className="g-mono" style={{ wordBreak: 'break-all', fontSize: 11 }}>{gmailUrl}</p>
                      <button className="g-btn g-btn--sm" onClick={() => void load()}>I have finished signing in</button>
                    </div>
                  )}
                </div>
              )}

              {!byKind('social').some(c => c.id === 'bluesky' && c.state === 'connected') && (
                <div>
                  <div className="g-section-title" style={{ marginBottom: 6 }}>Bluesky — app password</div>
                  <p className="g-caption">bsky.app → Settings → App Passwords. Use an app password, never your main one.</p>
                  <div className="g-row">
                    <Field label="Handle"><input className="g-input g-input--md" placeholder="you.bsky.social" value={bskyHandle} onChange={e => setBskyHandle(e.target.value)} /></Field>
                    <Field label="App password"><input className="g-input g-input--md" type="password" value={bskyPassword} onChange={e => setBskyPassword(e.target.value)} /></Field>
                    <button className="g-btn" disabled={!bskyHandle.trim() || !bskyPassword} onClick={() => void connect('bluesky')}>Connect</button>
                  </div>
                </div>
              )}

              {!byKind('social').some(c => c.id === 'mastodon' && c.state === 'connected') && (
                <div>
                  <div className="g-section-title" style={{ marginBottom: 6 }}>Mastodon — access token</div>
                  <p className="g-caption">Preferences → Development → New application, with read and write:statuses scopes.</p>
                  <div className="g-row">
                    <Field label="Instance"><input className="g-input g-input--md" placeholder="mastodon.social" value={mastoInstance} onChange={e => setMastoInstance(e.target.value)} /></Field>
                    <Field label="Token"><input className="g-input g-input--md" type="password" value={mastoToken} onChange={e => setMastoToken(e.target.value)} /></Field>
                    <button className="g-btn" disabled={!mastoInstance.trim() || !mastoToken.trim()} onClick={() => void connect('mastodon')}>Connect</button>
                  </div>
                </div>
              )}

              {!byKind('storefront').some(c => c.id === 'shopify' && c.state === 'connected') && (
                <div>
                  <div className="g-section-title" style={{ marginBottom: 6 }}>Shopify — admin token</div>
                  <p className="g-caption">Develop apps → Create an app → Admin API access token with write_products. Goga creates DRAFTS only.</p>
                  <div className="g-row">
                    <Field label="Shop"><input className="g-input g-input--md" placeholder="my-shop.myshopify.com" value={shopDomain} onChange={e => setShopDomain(e.target.value)} /></Field>
                    <Field label="Token"><input className="g-input g-input--md" type="password" value={shopToken} onChange={e => setShopToken(e.target.value)} /></Field>
                    <button className="g-btn" disabled={!shopDomain.trim() || !shopToken.trim()} onClick={() => void connect('shopify')}>Connect</button>
                  </div>
                </div>
              )}

              {!byKind('storefront').some(c => c.id === 'printful' && c.state === 'connected') && (
                <div>
                  <div className="g-section-title" style={{ marginBottom: 6 }}>Printful — private token</div>
                  <p className="g-caption">Settings → Developers → API tokens. Publishing is done in Printful.</p>
                  <div className="g-row">
                    <Field label="Token"><input className="g-input g-input--md" type="password" value={pfToken} onChange={e => setPfToken(e.target.value)} /></Field>
                    <Field label="Store id"><input className="g-input g-input--sm" value={pfStore} onChange={e => setPfStore(e.target.value)} placeholder="optional" /></Field>
                    <button className="g-btn" disabled={!pfToken.trim()} onClick={() => void connect('printful')}>Connect</button>
                  </div>
                </div>
              )}
            </div>

            <details className="g-details">
              <summary>Platforms Goga deliberately does not automate ({state.declined.length})</summary>
              <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, marginTop: 4 }}>
                {state.declined.map(d => (
                  <li key={d.name}><strong>{d.name}</strong> — {d.reason} <em>{d.manualPath}</em></li>
                ))}
              </ul>
            </details>
          </Card>
        )}

        {/* ── drafts ─────────────────────────────────────────────────────── */}
        <Card title="Draft something" sub="Preparing creates an approval. It sends nothing.">
          <div className="g-grid g-grid--2">
            <div>
              <div className="g-section-title" style={{ marginBottom: 6 }}>A mail</div>
              <Field label="To"><input className="g-input g-input--lg" value={mailTo} onChange={e => setMailTo(e.target.value)} placeholder="name@example.com" /></Field>
              <Field label="Subject"><input className="g-input g-input--xl" value={mailSubject} onChange={e => setMailSubject(e.target.value)} /></Field>
              <Field label="Body"><textarea className="g-input" style={{ width: '100%', minHeight: 90, fontFamily: 'inherit' }} value={mailBody} onChange={e => setMailBody(e.target.value)} /></Field>
              <button
                className="g-btn"
                disabled={busy || !mailTo.trim() || !mailSubject.trim() || !mailBody.trim()}
                onClick={() => void prepare(window.goga.invoke('business:prepareMail', { to: mailTo.trim(), subject: mailSubject.trim(), body: mailBody }))}
              >Prepare this mail</button>
            </div>

            <div>
              <div className="g-section-title" style={{ marginBottom: 6 }}>A social post</div>
              <div className="g-seg" role="group" aria-label="Platform">
                {(['bluesky', 'mastodon'] as const).map(p => (
                  <button key={p} aria-pressed={postPlatform === p} onClick={() => setPostPlatform(p)}>{p === 'bluesky' ? 'Bluesky' : 'Mastodon'}</button>
                ))}
              </div>
              <Field label={`Text (${[...postText].length}${postPlatform === 'bluesky' ? '/300' : ''})`}>
                <textarea className="g-input" style={{ width: '100%', minHeight: 90, fontFamily: 'inherit' }} value={postText} onChange={e => setPostText(e.target.value)} />
              </Field>
              <button
                className="g-btn"
                disabled={busy || !postText.trim()}
                onClick={() => void prepare(window.goga.invoke('business:preparePost', postPlatform, postText, 'general post'))}
              >Prepare this post</button>
            </div>

            <div>
              <div className="g-section-title" style={{ marginBottom: 6 }}>A storefront listing</div>
              <div className="g-seg" role="group" aria-label="Storefront">
                {(['shopify', 'printful'] as const).map(s => (
                  <button key={s} aria-pressed={listingStore === s} onClick={() => setListingStore(s)}>{s === 'shopify' ? 'Shopify' : 'Printful'}</button>
                ))}
              </div>
              <Field label="Title"><input className="g-input g-input--xl" value={listingTitle} onChange={e => setListingTitle(e.target.value)} /></Field>
              <Field label="Description"><textarea className="g-input" style={{ width: '100%', minHeight: 70, fontFamily: 'inherit' }} value={listingDescription} onChange={e => setListingDescription(e.target.value)} /></Field>
              <div className="g-row">
                <Field label="Price"><input className="g-input g-input--sm" type="number" min="0" step="0.01" value={listingPrice} onChange={e => setListingPrice(e.target.value)} /></Field>
                <Field label="Tags (comma separated)"><input className="g-input g-input--md" value={listingTags} onChange={e => setListingTags(e.target.value)} /></Field>
                <Field label="Shipping note"><input className="g-input g-input--md" value={listingShipping} onChange={e => setListingShipping(e.target.value)} /></Field>
              </div>
              <button
                className="g-btn"
                disabled={busy || !listingTitle.trim()}
                onClick={() => void prepare(window.goga.invoke('business:prepareListing', {
                  storefront: listingStore, title: listingTitle.trim(), description: listingDescription,
                  tags: listingTags.split(',').map(t => t.trim()).filter(Boolean),
                  price: Number(listingPrice) || 0, currency: 'USD', shipping: listingShipping,
                }))}
              >Prepare this listing</button>
              <p className="g-caption g-faint">A listing is created as a DRAFT on the storefront, and you publish it there.</p>
            </div>

            <div>
              <div className="g-section-title" style={{ marginBottom: 6 }}>What is already drafted</div>
              {(state?.listings.length ?? 0) === 0 && (state?.posts.length ?? 0) === 0 && (
                <p className="g-caption g-faint">No listing or post drafts yet.</p>
              )}
              {(state?.listings ?? []).map((l: ArtListingDraft) => (
                <div key={l.id} className="g-inset" style={{ marginBottom: 6 }}>
                  <div className="g-row" style={{ justifyContent: 'space-between' }}>
                    <span><Chip>{l.storefront}</Chip> {short(l.title, 60)}</span>
                    <Chip tone={l.status === 'created' ? 'ok' : l.status === 'failed' ? 'bad' : undefined}>{l.status}</Chip>
                  </div>
                  <div className="g-caption">{l.price.toFixed(2)} {l.currency} · {l.createdAt.slice(0, 10)}{l.remoteUrl ? ` · ${l.remoteUrl}` : ''}</div>
                  {l.error && <div className="g-caption" style={{ color: 'var(--danger)' }}>{l.error}</div>}
                  {l.status === 'draft' && (
                    <button className="g-btn g-btn--ghost g-btn--sm" onClick={() => void guard(() => window.goga.invoke('business:forgetListingDraft', l.id), 'Draft removed.').then(load)}>Remove</button>
                  )}
                </div>
              ))}
              {(state?.posts ?? []).map((p: SocialPostDraft) => (
                <div key={p.id} className="g-inset" style={{ marginBottom: 6 }}>
                  <div className="g-row" style={{ justifyContent: 'space-between' }}>
                    <span><Chip>{p.platform}</Chip> {short(p.text, 60)}</span>
                    <Chip tone={p.status === 'posted' ? 'ok' : p.status === 'failed' ? 'bad' : undefined}>{p.status}</Chip>
                  </div>
                  <div className="g-caption">{p.createdAt.slice(0, 10)}{p.remoteUrl ? ` · ${p.remoteUrl}` : ''}</div>
                  {p.error && <div className="g-caption" style={{ color: 'var(--danger)' }}>{p.error}</div>}
                  {p.status === 'draft' && (
                    <button className="g-btn g-btn--ghost g-btn--sm" onClick={() => void guard(() => window.goga.invoke('business:forgetPostDraft', p.id), 'Draft removed.').then(load)}>Remove</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Card>

        {/* ── testers ────────────────────────────────────────────────────── */}
        {state && (
          <TesterTracker
            recruitment={state.testers}
            busy={busy}
            onChanged={() => void load()}
            notify={(message, kind) => { if (kind === 'error') setError(message); else setNotice(message) }}
          />
        )}

        {/* ── Google Play Console ────────────────────────────────────────── */}
        {state && (
          <PlayConsole
            state={state.play}
            busy={busy}
            onChanged={() => void load()}
            notify={(message, kind) => { if (kind === 'error') setError(message); else setNotice(message) }}
          />
        )}

        {/* ── deploy + monitor ───────────────────────────────────────────── */}
        <Card
          title="Deploy and monitor"
          sub="Goga builds and watches. Publishing is your click, in your own account."
          actions={<button className="g-btn g-btn--sm" disabled={busy} onClick={() => void guard(() => window.goga.invoke('business:checkAll'), 'Checked everything.').then(load)}>Check all now</button>}
        >
          <div className="g-row">
            <Field label="Name"><input className="g-input g-input--md" value={appName} onChange={e => setAppName(e.target.value)} /></Field>
            <Field label="URL to check"><input className="g-input g-input--lg" placeholder="https://example.com" value={appUrl} onChange={e => setAppUrl(e.target.value)} /></Field>
            <Field label="Package"><input className="g-input g-input--md" placeholder="com.example.app" value={appPackage} onChange={e => setAppPackage(e.target.value)} /></Field>
            <Field label="Live version"><input className="g-input g-input--sm" value={appVersion} onChange={e => setAppVersion(e.target.value)} /></Field>
            <Field label="Published where"><input className="g-input g-input--md" value={appWhere} onChange={e => setAppWhere(e.target.value)} /></Field>
            <button
              className="g-btn"
              disabled={busy || !appUrl.trim()}
              onClick={() => void guard(
                () => window.goga.invoke('business:addApp', {
                  name: appName.trim(), url: appUrl.trim(), packageName: appPackage.trim(),
                  liveVersion: appVersion.trim(), publishedWhere: appWhere.trim(),
                }),
                'Added to the monitor. Nothing was deployed.',
              ).then(r => { if (r) { setAppName(''); setAppUrl(''); setAppPackage(''); setAppVersion(''); void load() } })}
            >Add to monitor</button>
          </div>

          {state && state.apps.length === 0 ? (
            <EmptyState icon="📡" title="Nothing monitored yet" body="Add a site or app and Goga will check it answers, and keep the uptime record. It does not deploy." />
          ) : (
            <table className="g-table">
              <thead><tr>{['App', 'URL', 'Version', 'Checked', 'Uptime', 'Last check'].map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {(state?.apps ?? []).map((a: MonitoredApp) => {
                  const u = state?.uptime.find(x => x.appId === a.id)
                  return (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td className="g-mono" style={{ fontSize: 11.5 }}>{a.url}</td>
                      <td>{a.liveVersion || '—'}</td>
                      <td className="num">{u?.checks ?? 0}</td>
                      <td className="num">{u?.uptimePct == null ? 'not measured' : `${u.uptimePct.toFixed(1)}%`}</td>
                      <td>
                        {u?.lastCheck
                          ? <span style={{ color: u.lastCheck.ok ? 'var(--success)' : 'var(--danger)' }}>
                              {u.lastCheck.ok ? 'ok' : 'failed'} {when(u.lastCheck.at)}
                            </span>
                          : <span className="g-faint">never</span>}
                        <button className="g-btn g-btn--ghost g-btn--sm" style={{ marginLeft: 6 }} disabled={busy} onClick={() => void guard(() => window.goga.invoke('business:checkApp', a.id), 'Checked.').then(load)}>Check</button>
                        <button className="g-btn g-btn--ghost g-btn--sm" style={{ marginLeft: 4 }} onClick={() => void guard(() => window.goga.invoke('business:forgetApp', a.id), 'Removed.').then(load)}>✕</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          <details className="g-details" open>
            <summary>Publishing a release: the steps, in your account</summary>
            <ol style={{ fontSize: 'var(--fs-caption)', paddingLeft: 20, marginTop: 4 }}>
              {(state?.releaseSteps ?? []).map(s => <li key={s}>{s}</li>)}
            </ol>
            <p className="g-caption g-faint">There is no publish button here, on purpose. The only upload Goga makes is the Play bundle you approve above, and only to a testing track.</p>
          </details>

          {state && state.projects.length > 0 && (
            <details className="g-details">
              <summary>Build projects ({state.projects.length})</summary>
              <table className="g-table" style={{ marginTop: 8 }}>
                <thead><tr>{['Project', 'Folder', 'Template', 'Last build', 'Actions'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {state.projects.map(p => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td className="g-mono" style={{ fontSize: 11 }}>{p.dir}</td>
                      <td>{p.template}</td>
                      <td>
                        {p.lastBuild
                          ? <span style={{ color: p.lastBuild.ok ? 'var(--success)' : 'var(--danger)' }}>{p.lastBuild.ok ? 'passed' : 'failed'} {when(p.lastBuild.at)}</span>
                          : <span className="g-faint">never</span>}
                      </td>
                      <td>
                        <button className="g-btn g-btn--ghost g-btn--sm" disabled={busy} onClick={() => void guard(() => window.goga.invoke('business:build', p.id), 'Build finished — see the result above.').then(load)}>Build</button>
                        <button className="g-btn g-btn--ghost g-btn--sm" style={{ marginLeft: 4 }} disabled={busy} onClick={() => void guard(() => window.goga.invoke('business:run', p.id), 'Preview started.').then(load)}>Preview</button>
                        <button className="g-btn g-btn--ghost g-btn--sm" style={{ marginLeft: 4 }} disabled={busy} onClick={() => void guard(() => window.goga.invoke('business:stop', p.id), 'Stopped.').then(load)}>Stop</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {state.projects.filter(p => p.lastBuild).map(p => (
                <details key={p.id} className="g-details">
                  <summary>{p.name} — build output</summary>
                  <pre className="g-inset g-mono" style={{ whiteSpace: 'pre-wrap', marginTop: 4, fontSize: 11, maxHeight: 200, overflowY: 'auto' }}>{p.lastBuild?.output ?? ''}</pre>
                </details>
              ))}
            </details>
          )}
        </Card>

        {/* ── audit ──────────────────────────────────────────────────────── */}
        {state && (
          <Card title="Audit trail" sub="Prepared, approved, denied, sent, and every error, newest first">
            {state.audit.length === 0 ? (
              <EmptyState icon="🧾" title="Nothing logged yet" body="Every prepared action and every approval is written here with its time." />
            ) : (
              <div className="g-inset g-mono" style={{ maxHeight: 260, overflowY: 'auto', fontSize: 11.5 }}>
                {state.audit.map(e => (
                  <div key={e.id} style={{ padding: '2px 0', color: e.kind === 'error' ? 'var(--danger)' : e.kind === 'execute' ? 'var(--success)' : 'var(--text-muted)' }}>
                    {when(e.time)} [{e.kind}] {e.action}: {e.detail}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

      </div>
    </div>
  )
}
