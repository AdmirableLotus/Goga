import React, { useCallback, useEffect, useState } from 'react'
import type {
  DomainResult, EmailResult, OsintAuditEntry, OsintKind, OsintPageState, ProfileResult, UsernameResult,
} from '../../shared/osint'
import { PageHeader, Card, Field, EmptyState, Alert, Chip } from '../components/ui'

/**
 * OSINT page.
 *
 * Four searches, each showing what was found, the source it came from, when it was read,
 * and — in its own list, never folded into the results — what could not be checked. A
 * "not found" line is worded as a statement about that site, not about the person.
 *
 * The page never invents a value: every row it draws came back from a source, and every
 * gap it shows was reported by the code that ran the search.
 */

const KINDS: { id: OsintKind; label: string; hint: string; placeholder: string; needsPurpose: boolean }[] = [
  { id: 'username', label: 'Reverse username', hint: 'Checks one handle across a curated list of public sites and returns only the profiles that answered.', placeholder: 'e.g. torvalds', needsPurpose: false },
  { id: 'email', label: 'Reverse email', hint: 'Gravatar profile and its linked accounts, the domain\'s mail routing and registration, breach status if a key is stored, and public mentions.', placeholder: 'e.g. someone@example.com', needsPurpose: true },
  { id: 'domain', label: 'Domain recon', hint: 'RDAP registration, DNS records, certificate-transparency subdomains and network metadata. Public records only — no scanning.', placeholder: 'e.g. example.com', needsPurpose: false },
  { id: 'profile', label: 'Profile aggregation', hint: 'From one confirmed identity, the profiles the person published themselves, each with its source.', placeholder: 'a handle, an email address, or a profile URL', needsPurpose: true },
]

/**
 * A run that was declined comes back as `{ refused: "why" }` rather than a result object.
 * It has to be caught here: the result views read arrays off the payload, and a refusal
 * has none, so drawing it as a result throws and takes the whole window down.
 */
function refusalOf(data: unknown): string | null {
  if (data && typeof data === 'object' && typeof (data as { refused?: unknown }).refused === 'string') {
    return (data as { refused: string }).refused
  }
  return null
}

function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  return `${iso.slice(0, 19).replace('T', ' ')}Z`
}

function SourceLine({ source }: { source: { source: string; url: string; readAt: string; cached: boolean } | null }) {
  if (!source) return <span className="g-caption g-faint">no source recorded</span>
  return (
    <span className="g-caption g-faint">
      {source.source} — <span className="g-mono">{source.url}</span> — read {when(source.readAt)}{source.cached ? ' (from cache)' : ''}
    </span>
  )
}

function Notes({ notes }: { notes: { kind: string; detail: string }[] }) {
  if (!notes.length) return null
  return (
    <div style={{ marginTop: 12 }}>
      <div className="g-section-title" style={{ marginBottom: 4 }}>What this does not tell you</div>
      <ul style={{ fontSize: 'var(--fs-body)', margin: 0, paddingLeft: 18 }}>
        {notes.map((n, i) => <li key={i}><span className="g-faint">[{n.kind}]</span> {n.detail}</li>)}
      </ul>
    </div>
  )
}

function Redactions({ list }: { list: { kind: string; count: number }[] }) {
  if (!list.length) return null
  return <p className="g-caption g-faint" style={{ marginTop: 8 }}>Removed before display: {list.map(r => `${r.count}× ${r.kind}`).join(', ')}</p>
}

function UsernameView({ d }: { d: UsernameResult }) {
  return (
    <div>
      <p style={{ fontSize: 'var(--fs-body)' }}>
        <strong>{d.query}</strong> — {d.mode === 'program' ? `under program ${d.programName}` : 'unattributed public research'}
        {d.purpose ? <> · purpose recorded: {d.purpose}</> : null}
      </p>
      {d.found.length > 0 && (
        <>
          <div className="g-section-title" style={{ margin: '12px 0 4px' }}>Profiles that answered ({d.found.length})</div>
          <table className="g-table">
            <tbody>
              {d.found.map(f => (
                <tr key={f.site}>
                  <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{f.site}</td>
                  <td className="g-mono" style={{ fontSize: 11.5 }}>{f.url}</td>
                  <td className="g-caption g-faint" style={{ whiteSpace: 'nowrap' }}>read {when(f.readAt)} · HTTP {f.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {d.absent.length > 0 && (
        <details className="g-details">
          <summary>Sites that answered "no such user" ({d.absent.length}) — a statement about those sites only</summary>
          <ul style={{ fontSize: 'var(--fs-body)', paddingLeft: 18, marginTop: 4 }}>{d.absent.map(a => <li key={a.site}>{a.site} — read {when(a.readAt)}</li>)}</ul>
        </details>
      )}
      {d.blocked.length > 0 && (
        <details className="g-details" open>
          <summary>Could not be checked — the site refused an automated read ({d.blocked.length})</summary>
          <ul style={{ fontSize: 'var(--fs-body)', paddingLeft: 18, marginTop: 4 }}>{d.blocked.map(b => <li key={b.site}>{b.site}: {b.detail}</li>)}</ul>
        </details>
      )}
      {d.notChecked.length > 0 && (
        <details className="g-details">
          <summary>Not checked ({d.notChecked.length})</summary>
          <ul style={{ fontSize: 'var(--fs-body)', paddingLeft: 18, marginTop: 4 }}>{d.notChecked.map(n => <li key={n.site}>{n.site}: {n.detail}</li>)}</ul>
        </details>
      )}
      <Notes notes={d.notes} />
      <Redactions list={d.redactions} />
    </div>
  )
}

function EmailView({ d }: { d: EmailResult }) {
  return (
    <div>
      <p style={{ fontSize: 'var(--fs-body)' }}><strong>{d.query}</strong> — {d.mode === 'program' ? `under program ${d.programName}` : 'unattributed public research'} · purpose recorded: {d.purpose}</p>

      <div className="g-section-title" style={{ margin: '12px 0 4px' }}>Gravatar — {d.gravatar.outcome}</div>
      {d.gravatar.displayName && <p style={{ fontSize: 'var(--fs-body)', margin: '2px 0' }}>Name: {d.gravatar.displayName}</p>}
      {d.gravatar.aboutMe && <p style={{ fontSize: 'var(--fs-body)', margin: '2px 0' }}>About: {d.gravatar.aboutMe}</p>}
      {d.gravatar.linkedAccounts.length > 0 && (
        <ul style={{ fontSize: 'var(--fs-body)', paddingLeft: 18 }}>
          {d.gravatar.linkedAccounts.map(a => (
            <li key={a.url}>{a.label} — <span className="g-mono">{a.url}</span>{a.verified ? ' (verified by Gravatar)' : ' (unverified)'}</li>
          ))}
        </ul>
      )}
      {d.gravatar.detail && <p className="g-caption g-faint" style={{ margin: '2px 0' }}>{d.gravatar.detail}</p>}
      <p style={{ margin: '2px 0' }}><SourceLine source={d.gravatar.source} /></p>

      <div className="g-section-title" style={{ margin: '14px 0 4px' }}>Domain {d.domainContext.domain}</div>
      <p style={{ fontSize: 'var(--fs-body)', margin: '2px 0' }}>
        Mail routing: {d.domainContext.hasMailRoute === null ? 'unknown' : d.domainContext.hasMailRoute ? 'MX records present' : 'no MX records published'}
        {d.domainContext.mx.length ? ` — ${d.domainContext.mx.join(', ')}` : ''}
      </p>
      {d.domainContext.rdapSummary.map((s, i) => <p key={i} style={{ fontSize: 'var(--fs-body)', margin: '2px 0' }}>{s}</p>)}
      {d.domainContext.sources.map(s => <p key={s.url} style={{ margin: '2px 0' }}><SourceLine source={s} /></p>)}

      <div className="g-section-title" style={{ margin: '14px 0 4px' }}>Breach status — {d.breach.checked ? d.breach.outcome : 'not checked'}</div>
      <p style={{ fontSize: 'var(--fs-body)', margin: '2px 0' }}>{d.breach.detail}</p>
      {d.breach.breaches.length > 0 && (
        <ul style={{ fontSize: 'var(--fs-body)', paddingLeft: 18 }}>
          {d.breach.breaches.map(b => <li key={`${b.name}-${b.date}`}>{b.name} ({b.domain}, {b.date}): {b.dataClasses.join(', ')}</li>)}
        </ul>
      )}

      <div className="g-section-title" style={{ margin: '14px 0 4px' }}>Public mentions ({d.mentions.length})</div>
      {d.mentions.length === 0 && <p className="g-caption g-faint" style={{ margin: '2px 0' }}>No page in the search index contained this exact address.</p>}
      <ul style={{ fontSize: 'var(--fs-body)', paddingLeft: 18 }}>
        {d.mentions.map(m => <li key={m.url}>{m.title} — <span className="g-mono">{m.url}</span> <span className="g-faint">(read {when(m.readAt)})</span></li>)}
      </ul>

      <Notes notes={d.notes} />
      <Redactions list={d.redactions} />
    </div>
  )
}

function DomainView({ d }: { d: DomainResult }) {
  return (
    <div>
      <p style={{ fontSize: 'var(--fs-body)' }}><strong>{d.domain}</strong> — {d.mode === 'program' ? `under program ${d.programName}` : 'unattributed public research'}{d.purpose ? ` · purpose recorded: ${d.purpose}` : ''}</p>

      <div className="g-section-title" style={{ margin: '12px 0 4px' }}>Registration — {d.registration.outcome}</div>
      {d.registration.summary.map((s, i) => <p key={i} style={{ fontSize: 'var(--fs-body)', margin: '2px 0' }}>{s}</p>)}
      {d.registration.detail && <p className="g-caption g-faint" style={{ margin: '2px 0' }}>{d.registration.detail}</p>}
      <p style={{ margin: '2px 0' }}><SourceLine source={d.registration.source} /></p>

      <div className="g-section-title" style={{ margin: '14px 0 4px' }}>DNS</div>
      <table className="g-table">
        <tbody>
          {d.dns.map(r => (
            <tr key={r.type}>
              <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{r.type}</td>
              <td className="g-mono" style={{ fontSize: 11.5 }}>{r.values.length ? r.values.join(', ') : (r.note ?? 'none')}</td>
              <td className="g-caption g-faint">{r.source ? `read ${when(r.source.readAt)}` : 'not read'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="g-section-title" style={{ margin: '14px 0 4px' }}>Certificate-transparency names — {d.subdomains.total} found</div>
      <p className="g-caption g-faint" style={{ margin: '2px 0' }}>{d.subdomains.note}</p>
      {d.subdomains.detail && <p className="g-caption g-faint" style={{ margin: '2px 0' }}>{d.subdomains.detail}</p>}
      {d.subdomains.names.length > 0 && (
        <details className="g-details" open>
          <summary>{d.subdomains.names.length} name(s) shown</summary>
          <div className="g-inset g-mono" style={{ maxHeight: 220, overflowY: 'auto', marginTop: 4, fontSize: 11.5 }}>{d.subdomains.names.join('\n')}</div>
        </details>
      )}
      <p style={{ margin: '2px 0' }}><SourceLine source={d.subdomains.source} /></p>

      {d.hosts.length > 0 && (
        <>
          <div className="g-section-title" style={{ margin: '14px 0 4px' }}>Host metadata</div>
          <table className="g-table">
            <tbody>
              {d.hosts.map(h => (
                <tr key={h.host}>
                  <td className="g-mono" style={{ fontSize: 11.5 }}>{h.host}</td>
                  <td className="g-mono" style={{ fontSize: 11.5 }}>{h.addresses.join(', ') || '—'}</td>
                  <td>{h.network ?? '—'}</td>
                  <td>{h.asn ?? ''}{h.detail ? <span className="g-faint"> ({h.detail})</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <Notes notes={d.notes} />
      <Redactions list={d.redactions} />
    </div>
  )
}

function ProfileView({ d }: { d: ProfileResult }) {
  return (
    <div>
      <p style={{ fontSize: 'var(--fs-body)' }}><strong>{d.subject}</strong> — {d.mode === 'program' ? `under program ${d.programName}` : 'unattributed public research'} · purpose recorded: {d.purpose}</p>
      <div className="g-section-title" style={{ margin: '12px 0 4px' }}>Profiles the person published themselves ({d.selfPublished.length})</div>
      <ul style={{ fontSize: 'var(--fs-body)', paddingLeft: 18 }}>
        {d.selfPublished.map(p => (
          <li key={`${p.site}-${p.url}`}>{p.site} — <span className="g-mono">{p.url}</span><br /><SourceLine source={p.source} /></li>
        ))}
      </ul>
      <div className="g-section-title" style={{ margin: '14px 0 4px' }}>Facts, each with its source ({d.facts.length})</div>
      <table className="g-table">
        <tbody>
          {d.facts.map((f, i) => (
            <tr key={i}>
              <td style={{ whiteSpace: 'nowrap', verticalAlign: 'top', fontWeight: 600 }}>{f.label}</td>
              <td>{f.value}</td>
              <td className="g-caption g-faint">{f.source ? `${f.source.source}, read ${when(f.source.readAt)}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Notes notes={d.notes} />
      <Redactions list={d.redactions} />
    </div>
  )
}

export default function OsintPage() {
  const [state, setState] = useState<OsintPageState | null>(null)
  const [kind, setKind] = useState<OsintKind>('username')
  const [query, setQuery] = useState('')
  const [purpose, setPurpose] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ kind: OsintKind; data: unknown; text: string; audit: OsintAuditEntry } | null>(null)
  const [history, setHistory] = useState<OsintAuditEntry[]>([])
  const [breachKey, setBreachKey] = useState('')

  const load = useCallback(async () => {
    try {
      const s = await window.goga.invoke('osint:state')
      setState(s)
      setHistory(await window.goga.invoke('osint:history', 30))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => { void load() }, [load])

  const active = KINDS.find(k => k.id === kind) ?? KINDS[0]

  async function run() {
    setBusy(true); setError(''); setResult(null)
    try {
      const params: Record<string, unknown> = { purpose }
      if (kind === 'username') params.username = query
      else if (kind === 'email') params.email = query
      else if (kind === 'domain') params.domain = query
      else params.subject = query
      const out = await window.goga.invoke('osint:run', kind, params)
      setResult({ kind, data: out.data, text: out.text, audit: out.audit })
      setHistory(await window.goga.invoke('osint:history', 30))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="g-page">
      <div className="g-page-inner">

        <PageHeader
          title="OSINT"
          accent="public-source research"
          purpose="Four searches over public sources: a username, an email address, a domain, or one confirmed identity. Every result carries its source and read time; every gap is listed rather than filled in."
          help={<>
            <p>Goga does not sign in anywhere, does not solve challenges, and does not report &quot;not found&quot; as &quot;does not exist&quot;. Each run is written to an audit log with its query, sources, time and stated purpose.</p>
            <p>Requests are throttled to one per second per host, two at a time overall, and cached with the time they were read. Pages are only read where robots.txt allows it.</p>
          </>}
          actions={state?.activeProgram
            ? <Chip tone="accent">Program: {state.activeProgram.name}</Chip>
            : <Chip>Unattributed research</Chip>}
        />

        {error && <Alert kind="error">{error}</Alert>}

        <Card>
          <p className="g-caption" style={{ marginBottom: 12 }}>
            {state?.activeProgram
              ? <>Active program: <strong>{state.activeProgram.name}</strong> ({state.activeProgram.source}: {state.activeProgram.handle}). Domain recon refuses any domain that program&apos;s scope does not cover.</>
              : <>No bug-bounty program is active, so results are labelled <strong>unattributed public research</strong>. Import a program in the Security page to tie domain recon to an authorized scope.</>}
          </p>

          <div className="g-seg" role="group" aria-label="Search type" style={{ marginBottom: 12 }}>
            {KINDS.map(k => (
              <button key={k.id} aria-pressed={kind === k.id} onClick={() => { setKind(k.id); setResult(null) }}>{k.label}</button>
            ))}
          </div>

          <p className="g-caption" style={{ marginBottom: 12 }}>{active.hint}</p>

          <div className="g-row">
            <Field label={`${active.label} target`} className="g-field" >
              <input className="g-input g-input--lg" value={query} onChange={e => setQuery(e.target.value)} placeholder={active.placeholder} />
            </Field>
            <Field label={<>Stated purpose {active.needsPurpose ? '(required)' : "(required for a person's name)"}</>}>
              <input className="g-input g-input--lg" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder='e.g. "authorised assessment for the Example program"' />
            </Field>
            <button className="g-btn g-btn--primary" disabled={busy || !query.trim()} onClick={() => void run()}>{busy ? 'Working…' : 'Run'}</button>
          </div>
        </Card>

        {result && (
          <Card title={`${KINDS.find(k => k.id === result.kind)?.label} result`}>
            {refusalOf(result.data)
              ? <Alert kind="error">{refusalOf(result.data)}</Alert>
              : <>
                  {result.kind === 'username' && <UsernameView d={result.data as UsernameResult} />}
                  {result.kind === 'email' && <EmailView d={result.data as EmailResult} />}
                  {result.kind === 'domain' && <DomainView d={result.data as DomainResult} />}
                  {result.kind === 'profile' && <ProfileView d={result.data as ProfileResult} />}
                </>}
            <details className="g-details" style={{ marginTop: 12 }}>
              <summary>Audit entry for this run</summary>
              <pre className="g-inset g-mono" style={{ whiteSpace: 'pre-wrap', marginTop: 6, fontSize: 11.5 }}>
{`time: ${when(result.audit.time)}
tool: ${result.audit.tool}
query: ${result.audit.query}
purpose: ${result.audit.purpose || '(none recorded)'}
mode: ${result.audit.mode}${result.audit.programName ? ` (${result.audit.programName})` : ''}
sources contacted: ${result.audit.sources.join(', ') || 'none'}
skipped: ${result.audit.skipped.map(s => `${s.host} — ${s.reason}`).join('; ') || 'none'}
summary: ${result.audit.summary}`}
              </pre>
            </details>
          </Card>
        )}

        <Card title="Breach-check API key" sub="Only checked when you supply a key for a service that allows API access">
          <p className="g-caption">
            Have I Been Pwned is the one this build speaks to. The key is encrypted with your Windows account and
            never leaves this machine except as the request header to that service.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Chip tone={state?.breachKey.configured ? 'ok' : undefined}>{state?.breachKey.configured ? 'Key stored' : 'No key stored'}</Chip>
            <span className="g-caption g-faint">
              {state?.breachKey.configured ? 'Breach status is checked on email searches.' : 'Breach status is reported as "not checked".'}
            </span>
          </div>
          {state && !state.breachKey.encryptionAvailable && (
            <Alert kind="error">Secure storage is unavailable on this PC, so a key cannot be saved.</Alert>
          )}
          <div className="g-row">
            <Field label="API key"><input className="g-input g-input--lg" type="password" value={breachKey} onChange={e => setBreachKey(e.target.value)} placeholder="breach-check API key" /></Field>
            <button className="g-btn" disabled={!breachKey.trim()} onClick={() => void (async () => {
              try {
                await window.goga.invoke('osint:saveBreachKey', breachKey)
                setBreachKey('')
                await load()
              } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
            })()}>Save</button>
            <button className="g-btn" disabled={!state?.breachKey.configured} onClick={() => void (async () => {
              try { await window.goga.invoke('osint:clearBreachKey'); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
            })()}>Forget</button>
          </div>
        </Card>

        <Card title="What is checked, and what is not">
          <div className="g-grid g-grid--2">
            <div>
              <div className="g-section-title" style={{ marginBottom: 6 }}>Checked for a username</div>
              <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, color: 'var(--text-muted)' }}>
                {(state?.sites ?? []).map(s => <li key={s.site}><strong style={{ color: 'var(--text)' }}>{s.site}</strong> — {s.about}</li>)}
              </ul>
            </div>
            <div>
              <div className="g-section-title" style={{ marginBottom: 6 }}>Deliberately not checked</div>
              <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, color: 'var(--text-muted)' }}>
                {(state?.excluded ?? []).map(s => <li key={s.site}><strong style={{ color: 'var(--text)' }}>{s.site}</strong> — {s.reason}</li>)}
              </ul>
            </div>
          </div>
        </Card>

        <Card title="Audit trail">
          {history.length === 0
            ? <EmptyState icon="🧾" title="No OSINT run yet" body="Every run is written here with its query, sources, time and stated purpose. Run a search above to start the record." />
            : history.slice().reverse().map(h => (
              <details key={h.id} className="g-details">
                <summary>{when(h.time)} · {h.tool} · &quot;{h.query}&quot; · {h.summary}</summary>
                <p className="g-caption" style={{ margin: '4px 0' }}>Purpose: {h.purpose || '(none recorded)'}</p>
                <p className="g-caption" style={{ margin: '4px 0' }}>Mode: {h.mode}{h.programName ? ` (${h.programName})` : ''}</p>
                <p className="g-caption" style={{ margin: '4px 0' }}>Sources: {h.sources.join(', ') || 'none contacted'}</p>
                {h.skipped.length > 0 && <p className="g-caption" style={{ margin: '4px 0' }}>Skipped: {h.skipped.map(s => `${s.host} (${s.reason})`).join('; ')}</p>}
              </details>
            ))}
        </Card>

      </div>
    </div>
  )
}
