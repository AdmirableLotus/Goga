import React, { useCallback, useEffect, useState } from 'react'
import type { Curriculum, Finding, Lesson, PlatformConnection, ProgramImport, ProgramSource, ProgramSummary, ScopeDecision, SecurityAuditEntry } from '../../shared/security'
import type { ToolboxCatalog } from '../../shared/toolboxTypes'
import { PageHeader, Card, Field, EmptyState, Alert, Chip } from '../components/ui'
import { ToolboxSection } from '../components/Toolbox'
import { GrimoireSection } from '../components/Grimoire'
import type { DestinationId } from '../nav'

/**
 * Security page: bug bounty.
 *
 * Order of work in the UI mirrors the rule: import a program → check a target against its
 * scope → approve ONE request → (the agent, or you, makes exactly that request) → draft a
 * report locally. The approve button issues a single-use grant; it does not itself send
 * anything, and the tool that sends is still behind the approval gate.
 */

export default function SecurityPage({ onNavigate }: { onNavigate?: (dest: DestinationId, section?: string) => void } = {}) {
  const [programs, setPrograms] = useState<ProgramImport[]>([])
  const [active, setActive] = useState<ProgramImport | null>(null)
  const [creds, setCreds] = useState<Record<'hackerone' | 'bugcrowd', { configured: boolean; encryptionAvailable: boolean }> | null>(null)
  const [conns, setConns] = useState<Record<'hackerone' | 'bugcrowd', PlatformConnection> | null>(null)
  const [listing, setListing] = useState<ProgramSummary[]>([])
  const [listInfo, setListInfo] = useState<{ pages: number; participating: number } | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [importResults, setImportResults] = useState<{ handle: string; ok: boolean; error: string | null; name: string | null }[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const [source, setSource] = useState<ProgramSource>('hackerone')
  const [handle, setHandle] = useState('')
  const [h1User, setH1User] = useState(''), [h1Token, setH1Token] = useState('')
  const [bcToken, setBcToken] = useState('')

  const [target, setTarget] = useState('')
  const [decision, setDecision] = useState<ScopeDecision | null>(null)
  const [grantId, setGrantId] = useState<string | null>(null)

  const [findings, setFindings] = useState<Finding[]>([])
  const [audit, setAudit] = useState<SecurityAuditEntry[]>([])
  const [curriculum, setCurriculum] = useState<Curriculum | null>(null)
  const [lesson, setLesson] = useState<Lesson | null>(null)
  const [toolbox, setToolbox] = useState<ToolboxCatalog | null>(null)

  const load = useCallback(async () => {
    try {
      const s = await window.goga.invoke('security:programs')
      setPrograms(s.programs); setActive(s.active); setCreds(s.credentials); setConns(s.connections)
      if (s.connections.hackerone?.programs?.length) setListing(s.connections.hackerone.programs)
      setFindings(await window.goga.invoke('security:findings'))
      setAudit(await window.goga.invoke('security:audit', 40))
      return s
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return null }
  }, [])

  useEffect(() => {
    void (async () => {
      const s = await load()
      window.goga.invoke('security:curriculum').then(setCurriculum).catch(() => {})
      window.goga.invoke('security:toolbox').then(setToolbox).catch(() => {})
      // Honest state: a stored token is not a working one, and yesterday's "connected" is
      // not today's. If a token is stored, ask HackerOne once with the narrowest read there
      // is, so the row shows what the API says now rather than what the file on disk suggests.
      if (s?.credentials.hackerone.configured) {
        try {
          const c = await window.goga.invoke('security:checkConnection', 'hackerone')
          setConns(prev => prev ? { ...prev, hackerone: c } : prev)
        } catch { /* the row keeps saying it is unconfirmed */ }
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  async function work(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  /** Re-read the connection verdicts after a save or a check. */
  async function refreshState() {
    const s = await window.goga.invoke('security:programs')
    setConns(s.connections); setCreds(s.credentials); setPrograms(s.programs); setActive(s.active)
    return s
  }

  const STATE_LABEL: Record<PlatformConnection['state'], string> = {
    connected: 'connected',
    rejected: 'rejected',
    expired: 'expired',
    'not-connected': 'not connected',
    unchecked: 'not checked yet',
    error: 'not confirmed',
  }
  const stateTone = (s: PlatformConnection['state']) =>
    s === 'connected' ? 'ok' as const : s === 'not-connected' ? undefined : s === 'unchecked' ? 'warn' as const : 'bad' as const

  /** One platform's honest state: what a real call said, and where to fix it. */
  function ConnectionRow({ id }: { id: 'hackerone' | 'bugcrowd' }) {
    const c = conns?.[id]
    if (!c) return null
    const needsNewToken = c.state === 'rejected' || c.state === 'expired'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Chip tone={stateTone(c.state)}>{STATE_LABEL[c.state]}</Chip>
          {c.account && <span className="g-caption g-faint">as {c.account}</span>}
          {c.checkedAt && <span className="g-caption g-faint">checked {c.checkedAt.slice(0, 16).replace('T', ' ')} UTC</span>}
        </div>
        <span className="g-caption">{c.detail}</span>
        <span className="g-caption">
          {needsNewToken ? `Create a new token at ` : c.state === 'connected' ? 'Manage the token at ' : 'Get the token at '}
          <a href={c.where} target="_blank" rel="noreferrer">{c.where.replace(/^https?:\/\//, '')}</a>
        </span>
      </div>
    )
  }

  return (
    <div className="g-page">
      <div className="g-page-inner">

        <PageHeader
          title="Security"
          accent="bug bounty workspace"
          purpose="Import a program's scope, stay inside it, and write up a finding. The program's own scope and policy are what give you permission to test — not this page."
          help={<>
            <p>Any active request needs three things: a program imported, a target that its scope covers, and your approval of that exact request. Approving issues a single-use permission for one URL and method, valid for five minutes; it sends nothing by itself.</p>
            <p>Reports stay on this PC as drafts. Goga never submits them.</p>
          </>}
          actions={active && <Chip tone="accent">Active: {active.name}</Chip>}
        />

        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="ok">{notice}</Alert>}

        {/* ── Toolbox ──────────────────────────────────────────────────────── */}
        <ToolboxSection catalog={toolbox} unreadable={toolbox?.unreadable ?? []} />

        {/* ── Credentials ─────────────────────────────────────────────────── */}
        <Card title="Platform tokens" sub="Your own API tokens, encrypted with this Windows account">
          <div className="g-grid g-grid--2">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span className="g-section-title">HackerOne</span>
                <Chip tone={creds?.hackerone.configured ? 'ok' : undefined}>{creds?.hackerone.configured ? 'token stored' : 'no token'}</Chip>
              </div>
              <div className="g-row">
                <Field label="Username"><input className="g-input g-input--sm" placeholder="your handle" value={h1User} onChange={e => setH1User(e.target.value)} /></Field>
                <Field label="API token"><input className="g-input g-input--md" type="password" placeholder="token" value={h1Token} onChange={e => setH1Token(e.target.value)} /></Field>
                <button className="g-btn" disabled={busy || !h1User || !h1Token} onClick={() => void work(async () => {
                  setCreds(await window.goga.invoke('security:credentials', 'hackerone', h1User, h1Token))
                  setH1User(''); setH1Token(''); setNotice('HackerOne token stored (encrypted). It has not been checked yet — press Check connection.')
                  await refreshState()
                })}>Save</button>
                <button className="g-btn" disabled={busy || !creds?.hackerone.configured} onClick={() => void work(async () => {
                  const c = await window.goga.invoke('security:checkConnection', 'hackerone')
                  setConns(prev => prev ? { ...prev, hackerone: c } : prev)
                  setNotice(c.state === 'connected' ? c.detail : `HackerOne: ${c.detail}`)
                  await refreshState()
                })}>Check connection</button>
              </div>
              <span className="g-hint">From your HackerOne settings → API token.</span>
              <div style={{ marginTop: 8 }}><ConnectionRow id="hackerone" /></div>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span className="g-section-title">Bugcrowd</span>
                <Chip tone={creds?.bugcrowd.configured ? 'ok' : undefined}>{creds?.bugcrowd.configured ? 'token stored' : 'no token'}</Chip>
              </div>
              <div className="g-row">
                <Field label="API token"><input className="g-input g-input--md" type="password" placeholder="token" value={bcToken} onChange={e => setBcToken(e.target.value)} /></Field>
                <button className="g-btn" disabled={busy || !bcToken} onClick={() => void work(async () => {
                  setCreds(await window.goga.invoke('security:credentials', 'bugcrowd', '', bcToken))
                  setBcToken(''); setNotice('Bugcrowd token stored (encrypted).')
                })}>Save</button>
              </div>
              <span className="g-hint">From tracker.bugcrowd.com → API credentials.</span>
              <div style={{ marginTop: 8 }}><ConnectionRow id="bugcrowd" /></div>
            </div>
          </div>
          {creds && !creds.hackerone.encryptionAvailable && (
            <Alert kind="error">Secure storage is unavailable on this PC, so tokens cannot be saved.</Alert>
          )}
        </Card>

        {/* ── Import ──────────────────────────────────────────────────────── */}
        <Card title="Import a program" sub="Reads the public scope and keeps it locally">
          <div className="g-row">
            <Field label="Platform">
              <select className="g-input g-input--md" value={source} onChange={e => setSource(e.target.value as ProgramSource)}>
                <option value="hackerone">HackerOne (by handle)</option>
                <option value="bugcrowd">Bugcrowd (by program code)</option>
              </select>
            </Field>
            <Field label={source === 'hackerone' ? 'Program handle' : 'Program code'}>
              <input className="g-input g-input--lg" value={handle} onChange={e => setHandle(e.target.value)} placeholder={source === 'hackerone' ? 'e.g. security' : 'e.g. example-program'} />
            </Field>
            <button className="g-btn g-btn--primary" disabled={busy || !handle} onClick={() => void work(async () => {
              const imported = await window.goga.invoke('security:import', source, handle)
              const eligible = imported.assets.filter(a => a.eligibleForSubmission).length
              const deny = imported.assets.length - eligible
              setNotice(`Imported ${imported.name}: ${eligible} in-scope asset(s), ${deny} deny rule(s) from assets the program marks not eligible, ${imported.exclusions.length} exclusion(s).`)
              setHandle('')
              await load()
            })}>{busy ? 'Importing…' : 'Import scope'}</button>
            {source === 'hackerone' && (
              <button className="g-btn" disabled={busy || !creds?.hackerone.configured} onClick={() => void work(async () => {
                const r = await window.goga.invoke('security:listPrograms', 'hackerone')
                setListing(r.programs); setListInfo({ pages: r.pages, participating: r.participating })
                setConns(prev => prev ? { ...prev, hackerone: r.connection } : prev)
                setNotice(`HackerOne lists ${r.programs.length} program(s) this account can see, over ${r.pages} page(s). ${r.participating} of them have a report from you.`)
              })}>List my programs</button>
            )}
          </div>

          {listing.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <span className="g-section-title">Programs this account can see ({listing.length})</span>
                {listInfo && <Chip>{listInfo.participating} with a report from you</Chip>}
                <button className="g-btn g-btn--sm" disabled={busy || !picked.length} onClick={() => void work(async () => {
                  const r = await window.goga.invoke('security:importMany', 'hackerone', picked)
                  setImportResults(r.results.map(x => ({ handle: x.handle, ok: x.ok, error: x.error, name: x.program?.name ?? null })))
                  setPrograms(r.programs); setActive(r.active)
                  const ok = r.results.filter(x => x.ok).length
                  setNotice(`Imported ${ok} of ${r.results.length} program(s).`)
                  setPicked([])
                  await load()
                })}>Import selected ({picked.length})</button>
                <button className="g-btn g-btn--ghost g-btn--sm" disabled={busy} onClick={() => setPicked(listing.filter(p => p.participating).map(p => p.handle))}>Select the ones I have reported to</button>
                <button className="g-btn g-btn--ghost g-btn--sm" disabled={busy} onClick={() => setPicked([])}>Clear</button>
              </div>
              <div className="g-inset" style={{ maxHeight: 260, overflowY: 'auto', fontSize: 'var(--fs-caption)' }}>
                {listing.map(p => (
                  <label key={p.handle} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', cursor: 'pointer' }}>
                    <input type="checkbox" checked={picked.includes(p.handle)} onChange={e => setPicked(prev => e.target.checked ? [...prev, p.handle] : prev.filter(h => h !== p.handle))} />
                    <span className="g-mono" style={{ minWidth: 150 }}>{p.handle}</span>
                    <span style={{ flex: 1 }}>{p.name}</span>
                    {p.participating && <Chip tone="accent">{p.reportsForUser} report(s)</Chip>}
                    {p.offersBounties && <Chip>pays</Chip>}
                    {p.submissionState !== 'open' && <Chip tone="warn">{p.submissionState}</Chip>}
                  </label>
                ))}
              </div>
              {importResults.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="g-section-title">Last import</div>
                  <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 16 }}>
                    {importResults.map(r => <li key={r.handle}>{r.ok ? `✓ ${r.name} (${r.handle})` : `✗ ${r.handle} — ${r.error}`}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {programs.length === 0 ? (
            <EmptyState
              icon="🛡️"
              title="No program imported yet"
              body="Import a program above to load its scope. Until then Goga has nothing to check a target against, and every request stays refused."
            />
          ) : (
            <div>
              {programs.map(p => (
                <div key={p.id} className="g-details" style={{ paddingTop: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-body)', cursor: 'pointer' }}>
                    <input type="radio" checked={active?.id === p.id} onChange={() => void work(async () => {
                      const r = await window.goga.invoke('security:setActive', p.id); setActive(r.active); setPrograms(r.programs)
                    })} />
                    <strong>{p.name}</strong>
                    <span className="g-caption">{p.source}: {p.handle}</span>
                    <Chip>{p.assets.filter(a => a.eligibleForSubmission).length} eligible</Chip>
                    {p.assets.some(a => !a.eligibleForSubmission) && <Chip tone="warn">{p.assets.filter(a => !a.eligibleForSubmission).length} deny rules</Chip>}
                    {p.exclusions.length > 0 && <Chip tone="warn">{p.exclusions.length} exclusions</Chip>}
                  </label>
                  <p className="g-caption" style={{ margin: '4px 0 0 24px' }}>
                    {p.notes} Imported {p.importedAt.slice(0, 10)}. <a href={p.url} target="_blank" rel="noreferrer">program page</a>
                  </p>
                  <details className="g-details" style={{ marginLeft: 24 }}>
                    <summary>Scope ({p.assets.length} entries)</summary>
                    <ul className="g-mono" style={{ fontSize: 11.5, maxHeight: 220, overflowY: 'auto', paddingLeft: 16, marginTop: 4 }}>
                      {p.assets.map(a => <li key={a.identifier}>{a.identifier} [{a.assetType}]{a.eligibleForSubmission ? '' : ' — NOT submission-eligible: deny rule'}{a.maxSeverity ? ` · max ${a.maxSeverity}` : ''}{a.instruction ? ` · ${a.instruction}` : ''}</li>)}
                    </ul>
                    {p.exclusions.length > 0 && <><div className="g-section-title" style={{ marginTop: 8 }}>Exclusions</div><ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 16 }}>{p.exclusions.map(e => <li key={e.category}>{e.category} {e.details}</li>)}</ul></>}
                    {p.skipped.length > 0 && <><div className="g-section-title" style={{ marginTop: 8 }}>Not eligible for submission — kept as deny rules</div><ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 16 }}>{p.skipped.map(s => <li key={s}>{s}</li>)}</ul></>}
                  </details>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* ── Scope check + one approval ──────────────────────────────────── */}
        <Card title="Check a target, then approve one request" sub="The check touches no network">
          <div className="g-row">
            <Field label="Target URL" hint="Exactly the URL you intend to request, including the query string.">
              <input className="g-input g-input--xl" value={target} onChange={e => { setTarget(e.target.value); setDecision(null); setGrantId(null) }} placeholder="https://shop.example.com/search?q=goga7f3a91" />
            </Field>
            <button className="g-btn" disabled={busy || !target} onClick={() => void work(async () => {
              const r = await window.goga.invoke('security:checkTarget', target)
              setDecision(r.decision); setGrantId(null)
            })}>Check scope</button>
            <button className="g-btn g-btn--risk" disabled={busy || !target || !decision?.inScope} onClick={() => void work(async () => {
              const r = await window.goga.invoke('security:approveRequest', target, 'GET')
              setDecision(r.decision); setGrantId(r.grantId)
              setNotice(`Approved one GET to ${target}. Give Goga this approval id when he makes the request: ${r.grantId}`)
              setAudit(await window.goga.invoke('security:audit', 40))
            })}>Approve this one GET</button>
          </div>
          {decision && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Chip tone={decision.inScope ? 'ok' : 'bad'}>{decision.inScope ? 'In scope' : 'Out of scope'}</Chip>
              <span className="g-caption">
                {decision.undetermined ? 'Not covered by any rule — deny. ' : ''}{decision.reason}
              </span>
            </div>
          )}
          {grantId && <p className="g-mono g-caption">grant: {grantId}</p>}
        </Card>

        {/* ── Hands-off run you watch ──────────────────────────────────────── */}
        <Card
          title="Run the active program, hands-off"
          sub="Goga declares only the in-scope hosts, then recons, installs what it needs, and tests — you watch it live on the Jobs board"
        >
          {!active
            ? <EmptyState title="No active program" body="Activate a program above first — the run tests only that program's in-scope assets." />
            : <>
              <p className="g-caption">
                Starts an autonomous run on <strong>{active.name}</strong>. In-scope requests fire without asking you —
                out-of-scope or local/private/metadata targets are refused automatically, and declaring any <em>new</em> host still stops to ask.
                Watch every step on the Jobs board and cancel it there at any time.
              </p>
              <button className="g-btn g-btn--risk" disabled={busy} onClick={() => void work(async () => {
                const r = await window.goga.invoke('security:startBounty')
                setNotice(`Started a hands-off run on ${r.program.name} — ${r.declared.length} in-scope host(s) declared. Watch it on the Jobs board.`)
                setAudit(await window.goga.invoke('security:audit', 40))
                onNavigate?.('work', 'jobs')
              })}>Start autonomous run</button>
            </>}
        </Card>

        {/* ── Grimoire: specialist review, validator, gate, memory ─────────── */}
        <GrimoireSection programs={programs} active={active} onChanged={async () => { await load() }} />

        {/* ── Findings ───────────────────────────────────────────────────── */}
        <Card title={`Draft reports (${findings.length})`} sub="Reports stay on this PC as drafts. Goga never submits them.">
          {findings.length === 0 && (
            <EmptyState
              icon="📝"
              title="No drafts yet"
              body="Ask Goga to save one, or write it below. A draft is just text on this machine until you copy it into the program's own submission form."
            />
          )}
          {findings.map(f => (
            <details key={f.id} className="g-details">
              <summary><Chip tone={f.severity === 'critical' || f.severity === 'high' ? 'bad' : 'warn'}>{f.severity}</Chip> {f.title} — <span className="g-mono">{f.asset}</span></summary>
              <div style={{ fontSize: 'var(--fs-body)', whiteSpace: 'pre-wrap', marginTop: 8 }}>
                <strong>Summary</strong>{'\n'}{f.summary}{'\n\n'}<strong>Steps</strong>{'\n'}{f.steps}{'\n\n'}
                <strong>Impact</strong>{'\n'}{f.impact}{'\n\n'}<strong>Remediation</strong>{'\n'}{f.remediation}{'\n\n'}
                <strong>Evidence</strong>{'\n'}{f.evidence}
              </div>
              <button className="g-btn g-btn--sm" style={{ marginTop: 8 }} onClick={() => void work(async () => {
                await window.goga.invoke('security:deleteFinding', f.id)
                setFindings(await window.goga.invoke('security:findings'))
              })}>Delete draft</button>
            </details>
          ))}
          <DraftForm disabled={busy || !active} onSaved={async () => { setFindings(await window.goga.invoke('security:findings')); await load() }} onError={m => setError(m)} />
        </Card>

        {/* ── Study area ─────────────────────────────────────────────────── */}
        <Card title="Study: learning bug bounty from the sources" sub={curriculum?.note}>
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <ul style={{ minWidth: 260, flex: '0 0 300px', fontSize: 'var(--fs-body)', paddingLeft: 0, listStyle: 'none' }}>
              {curriculum?.lessons.map(l => (
                <li key={l.id} style={{ marginBottom: 2 }}>
                  <button
                    className={lesson?.id === l.id ? 'g-btn g-btn--sm' : 'g-btn g-btn--ghost g-btn--sm'}
                    style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', whiteSpace: 'normal' }}
                    onClick={() => setLesson(l)}
                  >
                    <span style={{ flex: 1 }}>{l.title}</span>
                    <span className="g-faint" style={{ fontSize: 10 }}>{l.minutes}m</span>
                  </button>
                </li>
              ))}
            </ul>
            <div style={{ flex: 1, minWidth: 300, fontSize: 'var(--fs-body)' }}>
              {!lesson && <EmptyState icon="📖" title="Pick a lesson" body="Each section lists the page it came from, so you can check the source yourself." />}
              {lesson && (
                <>
                  <h3 className="g-card-title" style={{ marginBottom: 8 }}>{lesson.title}</h3>
                  {lesson.sections.map(s => (
                    <div key={s.heading} style={{ marginBottom: 14 }}>
                      <div className="g-section-title" style={{ marginBottom: 4 }}>{s.heading}</div>
                      <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0', color: 'var(--text-muted)' }}>{s.body}</p>
                      <ul style={{ paddingLeft: 16, color: 'var(--text-faint)', fontSize: 'var(--fs-caption)' }}>
                        {s.sources.map(src => <li key={src.url}><a href={src.url} target="_blank" rel="noreferrer">{src.title}</a></li>)}
                      </ul>
                    </div>
                  ))}
                  <p style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>Before you move on: {lesson.check}</p>
                  <p className="g-caption g-faint">Goga cannot grant you testing rights. Scope and program rules govern everything.</p>
                </>
              )}
            </div>
          </div>
        </Card>

        {/* ── Audit ──────────────────────────────────────────────────────── */}
        <Card title="Audit trail">
          {audit.length === 0
            ? <EmptyState icon="🧾" title="Nothing logged yet" body="Imports, scope checks, approvals and refusals are written here as they happen." />
            : <div className="g-inset g-mono" style={{ maxHeight: 200, overflowY: 'auto', fontSize: 11.5 }}>
              {audit.map(e => (
                <div key={e.id}>{e.time.slice(0, 19).replace('T', ' ')} [{e.kind}] {e.detail}</div>
              ))}
            </div>}
        </Card>

      </div>
    </div>
  )
}

function DraftForm({ disabled, onSaved, onError }: { disabled: boolean; onSaved: () => Promise<void>; onError: (m: string) => void }) {
  const [f, setF] = useState({ title: '', asset: '', severity: 'medium' as Finding['severity'], summary: '', steps: '', impact: '', remediation: '', evidence: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
  return (
    <details className="g-details" style={{ marginTop: 12 }}>
      <summary style={{ fontSize: 'var(--fs-body)' }}>Write a new draft</summary>
      <div className="g-grid" style={{ marginTop: 10 }}>
        <Field label="Title"><input className="g-input g-input--xl" value={f.title} onChange={set('title')} /></Field>
        <div className="g-grid g-grid--2">
          <Field label="Asset"><input className="g-input" value={f.asset} onChange={set('asset')} /></Field>
          <Field label="Severity">
            <select className="g-input g-input--sm" value={f.severity} onChange={set('severity')}>
              {['info', 'low', 'medium', 'high', 'critical'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Summary"><textarea className="g-input" style={{ minHeight: 70 }} value={f.summary} onChange={set('summary')} /></Field>
        <Field label="Steps to reproduce"><textarea className="g-input" style={{ minHeight: 70 }} value={f.steps} onChange={set('steps')} /></Field>
        <Field label="Impact"><textarea className="g-input" style={{ minHeight: 70 }} value={f.impact} onChange={set('impact')} /></Field>
        <Field label="Remediation"><textarea className="g-input" style={{ minHeight: 70 }} value={f.remediation} onChange={set('remediation')} /></Field>
        <Field label="Evidence"><textarea className="g-input" style={{ minHeight: 70 }} value={f.evidence} onChange={set('evidence')} /></Field>
        <div>
          <button className="g-btn g-btn--primary" disabled={disabled || !f.title || !f.asset} onClick={async () => {
            try {
              await window.goga.invoke('security:addFinding', f)
              setF({ title: '', asset: '', severity: 'medium', summary: '', steps: '', impact: '', remediation: '', evidence: '' })
              await onSaved()
            } catch (e) { onError(e instanceof Error ? e.message : String(e)) }
          }}>Save draft locally</button>
          {disabled && <span className="g-hint" style={{ display: 'inline', marginLeft: 10 }}>Import a program first.</span>}
        </div>
      </div>
    </details>
  )
}
