import React, { useCallback, useEffect, useState } from 'react'
import { Card, Field, Alert, Chip, EmptyState } from './ui'
import type { JoinAttemptView, JoinDraft, JoinPolicyView, JoinSendResult, RunBudget } from '../../shared/lab'

/**
 * Joining a source finding to a live attempt.
 *
 * This panel carries one idea the rest of the Lab does not: the two halves of a real finding,
 * in one place, with the line between them drawn on screen.
 *
 *   - Left of the line: the source read. A specialist says a line is a sink, the independent
 *     validator says what would confirm it. That is a hypothesis about a file.
 *   - Right of the line: one live request, in Goga's own signed-in Brave window, with the user's
 *     single-use approval for that exact URL, payload and marker.
 *
 * The words on screen are the ones that matter here, so they are not softened: a marker coming
 * back in the page is a REFLECTION and is never shown as execution; only the page title turning
 * into a value the injected script alone could set is execution; and a confirmed finding on a
 * program's site is not a bounty — the program decides, and the submission is the user's.
 *
 * There is no button here that submits anything, because there is no submission code in Goga.
 * The draft that this panel can assemble stays in the local store.
 */

const SOURCE_HINT = 'The file the XSS specialist read, and the line it argued about.'

export function LabJoinView() {
  const [policy, setPolicy] = useState<JoinPolicyView | null>(null)
  const [joins, setJoins] = useState<JoinAttemptView[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // promotion inputs
  const [root, setRoot] = useState('')
  const [file, setFile] = useState('')
  const [line, setLine] = useState('')
  const [targetUrl, setTargetUrl] = useState('')
  const [maxRequests, setMaxRequests] = useState('')
  const [maxPerMinute, setMaxPerMinute] = useState('')

  const [attempt, setAttempt] = useState<JoinAttemptView | null>(null)
  const [result, setResult] = useState<JoinSendResult | null>(null)
  const [draft, setDraft] = useState<JoinDraft | null>(null)
  const [verified, setVerified] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [p, list] = await Promise.all([window.goga.invoke('lab:joinPolicy'), window.goga.invoke('lab:joins')])
      // A page rendered without the handlers behind it (a test harness, or a build where main
      // is older) must not take the whole Security page down with it. An absent policy is
      // simply no policy to show; an absent list is no attempts held.
      const policy_ = p ?? null
      setPolicy(policy_)
      setJoins(Array.isArray(list) ? list : [])
      if (!maxRequests && policy_) setMaxRequests(String(policy_.defaults.maxRequests))
      if (!maxPerMinute && policy_) setMaxPerMinute(String(policy_.defaults.maxPerMinute))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    // Intentionally not re-running for the limit fields: they are only defaulted once here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function work<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(true); setError(''); setNotice('')
    try { return await fn() }
    catch (e) { setError(`${label}: ${e instanceof Error ? e.message : String(e)}`); return null }
    finally { setBusy(false) }
  }

  const prepare = () => work('Prepare', async () => {
    const limits: Partial<RunBudget> = {}
    if (maxRequests) limits.maxRequests = Number(maxRequests)
    if (maxPerMinute) limits.maxPerMinute = Number(maxPerMinute)
    const r = await window.goga.invoke('lab:joinPrepare', {
      root, file,
      line: line ? Number(line) : undefined,
      targetUrl,
      limits,
    })
    if (!r.ok) { setError(r.message); setAttempt(null); return null }
    setAttempt(r.attempt); setResult(null); setDraft(null)
    setNotice(r.message)
    await refresh()
    return r
  })

  const approve = () => work('Approve', async () => {
    if (!attempt) return null
    const r = await window.goga.invoke('lab:joinDecide', attempt.id, true)
    if (!r.ok) { setError(r.message); return null }
    setNotice(r.message)
    if (r.attempt) setAttempt(r.attempt)
    await refresh()
    return r
  })

  const send = () => work('Send once', async () => {
    if (!attempt) return null
    const r = await window.goga.invoke('lab:joinSend', attempt.id)
    setResult(r)
    setNotice(r.executed
      ? 'The payload ran: the page title became a value only the injected script could set.'
      : r.reflected
        ? 'The marker came back in the page, but the payload did not run. That is a reflection, not an execution.'
        : r.caveat)
    await refresh()
    return r
  })

  const stop = () => work('Stop', async () => {
    if (!attempt) return null
    const r = await window.goga.invoke('lab:joinStop', attempt.id)
    setNotice(r.message)
    return r
  })

  const assembleDraft = () => work('Draft', async () => {
    if (!attempt) return null
    const r = await window.goga.invoke('lab:joinDraft', attempt.id, { verifiedByUser: verified })
    if (!r.ok) { setError(r.message); return null }
    setDraft(r.draft); setNotice(r.message)
    return r
  })

  const ceiling = policy?.ceiling

  return (
    <>
      <Card
        title="Join a source finding to a live attempt"
        sub="Promote one validated source finding to one approved request, in Goga's own signed-in Brave window"
        tone="accent"
      >
        <p className="g-caption">
          The left half is a hypothesis about a file: a specialist says a line is a sink and the
          independent validator says what would confirm it. The right half is one request on a host
          a program's published scope — or your own declaration — allows. A marker coming back in the
          page is a <strong>reflection</strong>. Only the page title becoming a value the injected
          script alone could set is <strong>execution</strong>, and only execution can become a
          finding.
        </p>

        {policy?.automatedTestingRule && (
          <Alert kind="info">
            The program's own rule about automation, quoted: “{policy.automatedTestingRule}”
            {' '}That is why this run has a cap you set when you start it, and why the cap cannot be
            raised above {ceiling?.maxRequests ?? 20} requests at {ceiling?.maxPerMinute ?? 6} a
            minute.
          </Alert>
        )}

        {!policy?.automatedTestingRule && (
          <p className="g-caption g-faint">
            No program is imported, so nothing authorises a request to a public host right now.
            Import a program on this page, or declare a host you own, before preparing a live
            attempt. The local reproduction on 127.0.0.1 needs neither.
          </p>
        )}

        <p className="g-caption">
          Cantina's policy says nothing about AI assistance either way. Silence is not permission —
          if you are unsure, ask the program before you submit. The program's own testing rule is
          also the one that applies here: “{policy?.ownAccountsRule ?? 'Use only your own accounts or test accounts for testing.'}”
          {' '}That is why this runs in your own signed-in session.
        </p>

        <div className="g-grid g-grid--2">
          <Field label="Folder of the source tree" hint={SOURCE_HINT}>
            <input className="g-input g-input--xl" value={root} onChange={e => setRoot(e.target.value)} placeholder="C:\Users\you\OS3\goga-specialist-review\wp\wordpress" />
          </Field>
          <Field label="File to read, relative to it">
            <input className="g-input g-input--xl" value={file} onChange={e => setFile(e.target.value)} placeholder="wp-admin/edit-tag-form.php" />
          </Field>
        </div>
        <div className="g-grid g-grid--2">
          <Field label="Line (optional)" hint="Empty uses the strongest candidate the validator kept.">
            <input className="g-input" value={line} onChange={e => setLine(e.target.value)} placeholder="207" />
          </Field>
          <Field label="Live URL the payload goes to" hint="In scope in an imported program, or a host you declared. Put {payload} where the value goes.">
            <input className="g-input g-input--xl" value={targetUrl} onChange={e => setTargetUrl(e.target.value)} placeholder="https://cantina.xyz/search?q={payload}" />
          </Field>
        </div>

        <div className="g-grid g-grid--2">
          <Field label="Requests for this run" hint={`Default ${policy?.defaults.maxRequests ?? 5}. The ceiling is ${ceiling?.maxRequests ?? 20}, fixed in code.`}>
            <input className="g-input" value={maxRequests} onChange={e => setMaxRequests(e.target.value)} placeholder="5" />
          </Field>
          <Field label="Requests per minute" hint={`Default ${policy?.defaults.maxPerMinute ?? 2}. The ceiling is ${ceiling?.maxPerMinute ?? 6}, fixed in code.`}>
            <input className="g-input" value={maxPerMinute} onChange={e => setMaxPerMinute(e.target.value)} placeholder="2" />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="g-btn" disabled={busy || !root || !file || !targetUrl} onClick={() => void prepare()}>
            Promote this finding to a live attempt
          </button>
          {attempt && (
            <button className="g-btn g-btn--risk" disabled={busy} onClick={() => void approve()}>Approve this exact request</button>
          )}
          {attempt && attempt.approved && (
            <button className="g-btn g-btn--risk" disabled={busy || attempt.sent} onClick={() => void send()}>
              {attempt.sent ? 'Already sent once' : 'Send it once, in Goga\'s Brave'}
            </button>
          )}
          <button className="g-btn" disabled={busy} onClick={() => void stop()}>Stop this run</button>
        </div>

        <p className="g-caption g-faint" style={{ marginTop: 8 }}>
          One approval covers one request: this exact URL, method, payload and marker. Change any of
          them and the approval no longer applies. Approvals expire and do not survive a restart.
          The kill switch aborts the request in flight.
        </p>
      </Card>

      {attempt && (
        <Card title="The held attempt" sub="Exactly what would be sent, and to which host">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <Chip tone={attempt.approved ? 'ok' : undefined}>{attempt.approved ? 'approved' : 'not approved'}</Chip>
            <Chip tone={attempt.sent ? 'warn' : undefined}>{attempt.sent ? 'sent once' : 'not sent'}</Chip>
            <Chip>{attempt.authority.via === 'program' ? 'allowed by the program scope' : attempt.authority.via === 'declaration' ? 'allowed by your declaration' : attempt.authority.via ?? 'unknown authority'}</Chip>
          </div>
          <div className="g-inset" style={{ fontSize: 'var(--fs-caption)', display: 'grid', gap: 6 }}>
            <div><strong>Host:</strong> <span className="g-mono">{attempt.host}</span></div>
            <div><strong>Request:</strong> <span className="g-mono">{attempt.method} {attempt.url}</span></div>
            <div><strong>Payload:</strong> <span className="g-mono">{attempt.payload}</span></div>
            <div><strong>Marker:</strong> <span className="g-mono">{attempt.marker}</span></div>
            <div><strong>Only running script can set:</strong> <span className="g-mono">document.title = {attempt.expectedTitle}</span></div>
            <div><strong>Allowed because:</strong> {attempt.authority.reason}{attempt.authority.rule ? ` (rule: ${attempt.authority.rule})` : ''}</div>
            <div><strong>Limits:</strong> {attempt.limits.maxRequests} request(s), at most {attempt.limits.maxPerMinute} a minute</div>
          </div>

          <div className="g-section-title" style={{ marginTop: 12 }}>From source — the line this came from</div>
          <div className="g-inset" style={{ fontSize: 'var(--fs-caption)' }}>
            <div className="g-mono">{attempt.source.evidenceLine}</div>
            <div style={{ marginTop: 4 }}><strong>Sink context:</strong> {attempt.source.context}</div>
            {attempt.source.observable && <div><strong>The validator's observable:</strong> {attempt.source.observable}</div>}
            {attempt.source.wouldConfirm.length > 0 && (
              <div><strong>Would confirm it:</strong> {attempt.source.wouldConfirm.join(' ')}</div>
            )}
          </div>
        </Card>
      )}

      {result && (
        <Card
          title="What came back"
          sub="An observation, with what the page actually did — and the line between a reflection and execution"
          tone={result.executed ? 'accent' : undefined}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <Chip tone={result.executed ? 'ok' : result.reflected ? 'warn' : 'bad'}>
              {result.executed ? 'executed' : result.reflected ? 'reflected, NOT executed' : 'no marker'}
            </Chip>
            <Chip>{result.confidence}</Chip>
            <span className="g-caption g-faint">HTTP {result.status ?? '—'} · {result.elapsedMs} ms</span>
          </div>
          <div className="g-inset" style={{ fontSize: 'var(--fs-caption)', display: 'grid', gap: 4 }}>
            <div><strong>Page title came back:</strong> <span className="g-mono">{result.title || '(empty)'}</span></div>
            <div><strong>Expected only if script ran:</strong> <span className="g-mono">{result.expectedTitle}</span></div>
            <div><strong>The marker appeared:</strong> {result.observationContext}</div>
          </div>
          <p className="g-caption" style={{ marginTop: 8 }}>{result.caveat}</p>
          <p className="g-caption g-faint">
            Reflection is never reported as execution. A draft can be assembled only when the title
            became {result.expectedTitle} — a value only the injected script could set.
          </p>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
            <label className="g-caption" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />
              I reproduced this by hand and take responsibility for the report
            </label>
            <button className="g-btn" disabled={busy || !result.executed} onClick={() => void assembleDraft()}>
              Assemble a draft
            </button>
          </div>
          {!result.executed && (
            <p className="g-caption g-faint" style={{ marginTop: 4 }}>
              No draft is offered from a reflection — there is nothing confirmed to report.
            </p>
          )}
        </Card>
      )}

      {draft && (
        <Card title="Draft report — stays in Goga's local store" sub="There is no submission path in Goga. You send it.">
          <div className="g-inset" style={{ fontSize: 'var(--fs-caption)', display: 'grid', gap: 10 }}>
            <div><strong>Program:</strong> {draft.program}</div>
            <div><strong>Asset:</strong> <span className="g-mono">{draft.asset}</span></div>
            <div><strong>In-scope rule:</strong> {draft.inScopeRule}</div>
            <div><strong>Class:</strong> {draft.vulnerabilityClass}</div>
            <div><strong>Severity:</strong> {draft.severity} — {draft.severityBasis}</div>
            <div><strong>Source evidence:</strong><pre className="g-mono" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{draft.sourceEvidence}</pre></div>
            <div><strong>Live evidence:</strong><pre className="g-mono" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{draft.liveEvidence}</pre></div>
            <div><strong>Reproduction steps:</strong><pre className="g-mono" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{draft.steps}</pre></div>
            <div><strong>Remediation:</strong><pre className="g-mono" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{draft.remediation}</pre></div>
            <div><strong>AI assistance:</strong><pre className="g-mono" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{draft.aiDisclosure}</pre></div>
            <div className="g-caption g-faint">{draft.caveat}</div>
          </div>
        </Card>
      )}

      <Card title="Attempts being held" sub="Prepared but not yet sent, newest first">
        {joins.length === 0
          ? <EmptyState icon="🔗" title="Nothing held" body="Prepare an attempt above. A source finding with no live attempt stays a hypothesis about a file." />
          : <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 16 }}>
              {joins.map(j => (
                <li key={j.id} style={{ marginBottom: 4 }}>
                  <Chip>{j.status}</Chip> <span className="g-mono">{j.host}</span> · {j.source.file}:{j.source.line}
                  {j.approved && !j.sent && <button className="g-btn g-btn--sm" style={{ marginLeft: 8 }} disabled={busy} onClick={() => { setAttempt(j); setResult(j.result); setDraft(null) }}>Show</button>}
                </li>
              ))}
            </ul>}
        <p className="g-caption g-faint" style={{ marginTop: 8 }}>
          A hypothesis that only a local reproduction confirmed stays <em>reproduction-only</em>. It is
          not evidence about a live host, and it is not shown as execution here unless a live attempt
          actually ran.
        </p>
      </Card>

      {notice && <Alert kind="ok">{notice}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
    </>
  )
}
