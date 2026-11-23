import React, { useCallback, useEffect, useState } from 'react'
import { Card, Field, EmptyState, Alert, Chip } from './ui'
import { LabLiveView } from './LabLive'
import { LabJoinView } from './LabJoin'
import type { DeclaredTarget, TargetKind } from '../../shared/lab'

/**
 * The Lab section, inside Security.
 *
 * What it shows, in the order a person works:
 *   1. the hosts they have declared, with what authorises each and a way to revoke it;
 *   2. a form to declare a new one — which refuses without a sentence saying what authorises it;
 *   3. the local WordPress XSS path: pick the file, read what the specialist and validator say,
 *      then reproduce and dispatch it against a local copy on this machine;
 *   4. payload dispatch for anything else, prepared and approved by itself;
 *   5. recent runs, and the kill switch.
 *
 * The page states its own limit once, plainly, rather than hedging every field: this proves a
 * bug on your own copy. It does not deliver a bounty.
 */

const TARGET_KINDS: { id: TargetKind; label: string }[] = [
  { id: 'local-vm', label: 'A virtual machine on this computer' },
  { id: 'own-server', label: 'A server I own' },
  { id: 'ctf', label: 'A CTF or practice range' },
  { id: 'authorized-engagement', label: 'A client engagement with written authorisation' },
  { id: 'lab-container', label: 'A container or service on this computer' },
]

const WP_ROOT_PLACEHOLDER = 'C:\\Users\\you\\OS3\\goga-specialist-review\\wp\\wordpress'

interface SinkView {
  file: string; line: number; excerpt: string; context: string
  observable: string | null; why: string
}

interface PathView {
  executed: boolean; reflected: boolean; tookAsMarkup: boolean; contextMatched: boolean
  context: string; payload: string; expectedTitle: string; status: number | null; bytes: number
  excerpt: string; steps: { step: string; detail: string }[]
  source: { file: string; line: number; excerpt: string; observable: string | null }
  finding: { title: string; detail: string; evidence: string } | null
  caveat: string
}

export function LabSection() {
  const [targets, setTargets] = useState<DeclaredTarget[]>([])
  const [runs, setRuns] = useState<{ id: string; tool: string; targetHost: string; state: string; requests: number; startedAt: string }[]>([])
  const [payloads, setPayloads] = useState<{ id: string; targetHost: string; method: string; marker: string; status: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // declare
  const [host, setHost] = useState('')
  const [ports, setPorts] = useState('')
  const [kind, setKind] = useState<TargetKind>('local-vm')
  const [note, setNote] = useState('')

  // WordPress path
  const [wpRoot, setWpRoot] = useState(WP_ROOT_PLACEHOLDER)
  const [wpFile, setWpFile] = useState('wp-admin/edit-tag-form.php')
  const [sinks, setSinks] = useState<SinkView[] | null>(null)
  const [path, setPath] = useState<PathView | null>(null)

  // payload dispatch
  const [urlTemplate, setUrlTemplate] = useState('http://127.0.0.1:PORT/sink?v={payload}')
  const [payload, setPayload] = useState('')
  const [marker, setMarker] = useState('')
  const [proposal, setProposal] = useState<{ id: string; url: string; method: string; marker: string; targetHost: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await window.goga.invoke('lab:state')
      setTargets(s.targets); setRuns(s.runs); setPayloads(s.payloads)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function work<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(true); setError(''); setNotice('')
    try { return await fn() }
    catch (e) { setError(`${label}: ${e instanceof Error ? e.message : String(e)}`); return null }
    finally { setBusy(false) }
  }

  const declare = () => work('Declare', async () => {
    const r = await window.goga.invoke('lab:declareTarget', { host, ports, kind, note })
    if (!r.ok) { setError(r.message); return null }
    setNotice(r.message)
    setHost(''); setPorts(''); setNote('')
    await refresh()
    return r
  })

  const revoke = (id: string) => work('Revoke', async () => {
    const r = await window.goga.invoke('lab:revokeTarget', id, 'revoked from the Lab section')
    setNotice(r.message)
    await refresh()
    return r
  })

  const readSinks = () => work('Read file', async () => {
    const r = await window.goga.invoke('lab:readXssSinks', wpRoot, wpFile)
    setSinks(r.candidates)
    setNotice(r.candidates.length
      ? `${r.candidates.length} candidate(s) the validator would confirm in ${r.file}.`
      : `Nothing in ${r.file} survived the validator. That is a real answer, not a failure.`)
    return r
  })

  const runPath = (line?: number) => work('Run the XSS path', async () => {
    const r = await window.goga.invoke('lab:wpXssPath', wpRoot, wpFile, line)
    setPath(r)
    setNotice(r.executed
      ? 'Confirmed on the local reproduction: the payload executed.'
      : r.tookAsMarkup
        ? 'The payload came back as live markup, but no browser run confirmed execution.'
        : 'The payload did not take as markup. Reported as it happened.')
    return r
  })

  const prepare = () => work('Prepare payload', async () => {
    const r = await window.goga.invoke('lab:preparePayload', { urlTemplate, payload, marker, method: 'GET' })
    if (!r.ok) { setError(r.message); return null }
    setProposal(r.proposal)
    setNotice(r.message)
    return r
  })

  const approve = () => work('Approve', async () => {
    if (!proposal) return null
    const r = await window.goga.invoke('lab:decidePayload', proposal.id, true)
    setNotice(r.message)
    return r
  })

  const dispatch = () => work('Dispatch', async () => {
    if (!proposal) return null
    const r = await window.goga.invoke('lab:dispatchPayload', proposal.id)
    setNotice(`${r.reflection.verdict} — HTTP ${r.status ?? '—'}, ${r.bytes} bytes. Recorded as an observation.`)
    await refresh()
    return r
  })

  return (
    <>
      <LabLiveView />

      <Card
        title="The Lab — declared targets and the local XSS path"
        sub="Offensive tools run only against a host you declare, or the local lab on this machine"
      >
        <p className="g-caption">
          A declaration is your own statement that you own or are authorised to test a host. Goga
          records it in the audit trail and holds every tool to it; it cannot verify the statement
          itself. Cloud metadata endpoints are refused even when declared. A bug-bounty program's
          rules are separate from and stricter than this list, and a declaration is not permission
          from a program.
        </p>
      </Card>

      <Card title="Declared targets" sub="Every offensive tool refuses anything not on this list">
        {targets.length === 0
          ? <EmptyState icon="🎯" title="Nothing declared" body="Declare a host below before any Lab tool will accept it. The local lab on 127.0.0.1 needs no declaration." />
          : <div style={{ display: 'grid', gap: 8 }}>
              {targets.map(t => (
                <div key={t.id} className="g-details" style={{ paddingTop: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="g-mono">{t.host}</span>
                    <span className="g-caption g-faint">{t.ports ? `ports ${t.ports}` : 'all ports'}</span>
                    <Chip>{t.kind}</Chip>
                    {t.revokedAt && <Chip tone="warn">revoked</Chip>}
                    {!t.revokedAt && (
                      <button className="g-btn g-btn--sm" disabled={busy} onClick={() => void revoke(t.id)}>Revoke</button>
                    )}
                  </div>
                  <p className="g-caption" style={{ margin: '4px 0 0' }}>
                    “{t.note}” — declared {t.declaredAt.slice(0, 10)}
                    {t.revokedAt ? `, revoked ${t.revokedAt.slice(0, 10)} (${t.revokedReason})` : ''}
                  </p>
                </div>
              ))}
            </div>}

        <div className="g-grid g-grid--2" style={{ marginTop: 12 }}>
          <Field label="Host, IP or CIDR" hint="For example 192.168.56.10, 10.0.0.0/24, or lab.example.test.">
            <input className="g-input" value={host} onChange={e => setHost(e.target.value)} placeholder="192.168.56.10" />
          </Field>
          <Field label="Ports" hint="Optional: 80,443 or 1-1024. Empty means every port.">
            <input className="g-input" value={ports} onChange={e => setPorts(e.target.value)} placeholder="80,443" />
          </Field>
        </div>
        <div className="g-grid g-grid--2">
          <Field label="What it is">
            <select className="g-input" value={kind} onChange={e => setKind(e.target.value as TargetKind)}>
              {TARGET_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </Field>
          <Field label="What authorises it" hint="Required, and shown back to you in the audit trail.">
            <input className="g-input" value={note} onChange={e => setNote(e.target.value)} placeholder="my VirtualBox Ubuntu VM on the host-only network" />
          </Field>
        </div>
        <button className="g-btn" disabled={busy || !host || !note} onClick={() => void declare()}>Declare this target</button>
      </Card>

      <Card
        title="Local WordPress XSS path"
        sub="Read the source, let the validator state the observable, reproduce it on this machine, and see whether the value took"
      >
        <p className="g-caption">
          This never leaves the machine: the reproduction is served on 127.0.0.1 only, and every
          request is re-checked to loopback before it is sent. There is no PHP here, so WordPress
          itself is not running — what this proves is that the line's behaviour is exploitable,
          not that a live install is.
        </p>
        <div className="g-grid g-grid--2">
          <Field label="Folder of your local copy">
            <input className="g-input g-input--xl" value={wpRoot} onChange={e => { setWpRoot(e.target.value); setSinks(null); setPath(null) }} />
          </Field>
          <Field label="File to read, relative to it">
            <input className="g-input g-input--xl" value={wpFile} onChange={e => { setWpFile(e.target.value); setSinks(null); setPath(null) }} />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="g-btn" disabled={busy || !wpRoot || !wpFile} onClick={() => void readSinks()}>Read this file</button>
          <button className="g-btn g-btn--risk" disabled={busy || !wpRoot || !wpFile} onClick={() => void runPath()}>Run the path against a local copy</button>
        </div>

        {sinks && (
          <div style={{ marginTop: 12 }}>
            <div className="g-section-title">Candidates the validator would confirm ({sinks.length})</div>
            {sinks.length === 0
              ? <p className="g-caption g-faint">None. A source read with nothing confirmed is an answer, not a failure.</p>
              : <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 16 }}>
                  {sinks.map(s => (
                    <li key={`${s.line}-${s.context}`} style={{ marginBottom: 6 }}>
                      <span className="g-mono">line {s.line}</span> — {s.context}
                      <div className="g-faint">{s.excerpt}</div>
                      {s.observable && <div>observable: {s.observable}</div>}
                    </li>
                  ))}
                </ul>}
          </div>
        )}

        {path && (
          <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Chip tone={path.executed ? 'ok' : path.tookAsMarkup ? 'warn' : undefined}>
                {path.executed ? 'executed' : path.tookAsMarkup ? 'markup, not executed' : 'reflected only'}
              </Chip>
              <Chip tone={path.contextMatched ? 'ok' : 'warn'}>{path.context}</Chip>
              <span className="g-caption g-faint">{path.source.file}:{path.source.line}</span>
            </div>
            <ol style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, margin: 0 }}>
              {path.steps.map((s, i) => <li key={i} style={{ marginBottom: 4 }}><strong>{s.step}:</strong> {s.detail}</li>)}
            </ol>
            <p className="g-caption">{path.caveat}</p>
            {path.finding && (
              <div className="g-inset" style={{ fontSize: 'var(--fs-caption)' }}>
                <div className="g-section-title">Evidence recorded</div>
                <div>{path.finding.title}</div>
                <pre className="g-mono" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{path.finding.evidence}</pre>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="Payload dispatch" sub="Send one candidate payload and observe the response. It needs its own approval, and a result is an observation, not a finding.">
        <div className="g-grid g-grid--2">
          <Field label="URL template" hint="Put {payload} where the value goes. Only 127.0.0.1 or a declared target is accepted.">
            <input className="g-input g-input--xl" value={urlTemplate} onChange={e => setUrlTemplate(e.target.value)} />
          </Field>
          <Field label="Marker" hint="A unique string inside the payload, four characters or more.">
            <input className="g-input" value={marker} onChange={e => setMarker(e.target.value)} placeholder="goga7f3a91" />
          </Field>
        </div>
        <Field label="Payload">
          <input className="g-input g-input--xl" value={payload} onChange={e => setPayload(e.target.value)} placeholder={'"><img src=x onerror="document.title=\'goga7f3a91\'">'} />
        </Field>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="g-btn" disabled={busy || !urlTemplate || !payload || !marker} onClick={() => void prepare()}>Prepare</button>
          <button className="g-btn g-btn--risk" disabled={busy || !proposal} onClick={() => void approve()}>Approve this exact request</button>
          <button className="g-btn g-btn--risk" disabled={busy || !proposal} onClick={() => void dispatch()}>Send it once</button>
        </div>
        {proposal && (
          <div className="g-inset" style={{ marginTop: 8, fontSize: 'var(--fs-caption)' }}>
            <div className="g-section-title">Prepared</div>
            <div className="g-mono">{proposal.method} {proposal.url}</div>
          </div>
        )}
        {payloads.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="g-section-title">Held dispatches</div>
            <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 16 }}>
              {payloads.map(p => <li key={p.id}>{p.status} — {p.method} {p.targetHost} · marker {p.marker}</li>)}
            </ul>
          </div>
        )}
      </Card>

      <LabJoinView />

      <Card title="Recent runs" sub="What the Lab has actually done, newest first">
        {runs.length === 0
          ? <p className="g-caption g-faint">No runs yet.</p>
          : <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 16 }}>
              {runs.slice(0, 10).map(r => (
                <li key={r.id}><Chip>{r.state}</Chip> <span className="g-mono">{r.tool}</span> → {r.targetHost} · {r.requests} request(s) · {r.startedAt.slice(0, 19).replace('T', ' ')}</li>
              ))}
            </ul>}
        <button className="g-btn" disabled={busy} onClick={() => void work('Stop', async () => {
          const r = await window.goga.invoke('lab:stop')
          setNotice(r.message)
          await refresh()
          return r
        })}>Stop every Lab process</button>
      </Card>

      {notice && <Alert kind="info">{notice}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
    </>
  )
}
