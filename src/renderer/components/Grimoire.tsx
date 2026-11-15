import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  GateAnswer, GateQuestion, GateResult, Hypothesis, JsEndpoint, KnowledgeBase, MemoryEntry, MemorySummary,
  ReviewRun, Specialist, SpecialistId,
} from '../../shared/grimoire'
import type { ProgramImport, ProgramEntryBar } from '../../shared/security'
import type { BountyFeed } from '../../shared/bountyFinder'
import { Card, Field, EmptyState, Alert, Chip } from './ui'

/**
 * The Grimoire section of the Security page.
 *
 * What this section says about itself, on the page, in these words:
 *   - a specialist reviewer's output is a HYPOTHESIS, not a finding;
 *   - the reviewer never contacts a target;
 *   - WordPress's rules require the human to verify and to disclose AI involvement, quoted.
 *
 * The only network reads here are Cantina's public bounty page and GitHub's public search.
 * Neither touches a program's own assets, and the page says so where it matters.
 */

const WP_QUOTE_A = 'You must review and take responsibility for what AI generates'
const WP_QUOTE_B = 'Submitting an unverified report from an automated scan or AI agent is not acceptable.'

export function GrimoireSection({ programs, active, onChanged }: {
  programs: ProgramImport[]
  active: ProgramImport | null
  onChanged: () => Promise<void> | void
}) {
  const [specialists, setSpecialists] = useState<Specialist[]>([])
  const [kb, setKb] = useState<KnowledgeBase | null>(null)
  const [questions, setQuestions] = useState<GateQuestion[]>([])
  const [memory, setMemory] = useState<{ entries: MemoryEntry[]; summary: MemorySummary } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // local target mode
  const [root, setRoot] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [indexNotes, setIndexNotes] = useState<string[]>([])
  const [fileFilter, setFileFilter] = useState('')
  const [picked, setPicked] = useState('')
  const [marker, setMarker] = useState('')
  const [run, setRun] = useState<ReviewRun | null>(null)

  // cantina / finder
  const [cantinaUrl, setCantinaUrl] = useState('')
  const [feed, setFeed] = useState<BountyFeed | null>(null)
  const [feedQuery, setFeedQuery] = useState('')

  const load = useCallback(async () => {
    try {
      // A channel that answers nothing must not take the page down with it: the section is
      // one card among several, and a null reply is "not loaded", not a crash.
      const [s, k, q, m] = await Promise.all([
        window.goga.invoke('grimoire:specialists'),
        window.goga.invoke('grimoire:knowledge'),
        window.goga.invoke('grimoire:gate'),
        window.goga.invoke('grimoire:memory'),
      ])
      setSpecialists(Array.isArray(s) ? s : [])
      setKb(k ?? null)
      setQuestions(Array.isArray(q) ? q : [])
      setMemory(m && Array.isArray(m.entries) ? m : null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function work(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const filtered = useMemo(() => {
    const q = fileFilter.trim().toLowerCase()
    if (!q) return files.slice(0, 400)
    return files.filter(f => f.toLowerCase().includes(q)).slice(0, 400)
  }, [files, fileFilter])

  const confirmed = run?.hypotheses.filter(h => h.state === 'hypothesis') ?? []
  const dropped = run?.hypotheses.filter(h => h.state === 'dropped') ?? []

  return (
    <>
      {/* ── What this is, and what it is not ──────────────────────────────── */}
      <Card
        title="Grimoire: specialist review"
        sub={`${specialists.length || 18} specialists, an independent validator, and a memory of what was already tried`}
        tone="accent"
      >
        <Alert kind="info">
          <div>
            <strong>A specialist reviewer's output is a HYPOTHESIS, not a finding.</strong>{' '}
            The reviewer never contacts a target. The only thing in Goga that reaches a live host
            is the single GET you approve lower on this page.
          </div>
        </Alert>
        <div className="g-inset" style={{ borderLeft: '2px solid var(--accent-line)' }}>
          <div className="g-section-title" style={{ marginBottom: 6 }}>WordPress's rules, quoted</div>
          <p style={{ fontSize: 'var(--fs-body)', color: 'var(--text-muted)' }}>
            “{WP_QUOTE_A} … {WP_QUOTE_B}” An unverified automated report will be closed as spam.
            You are responsible for verifying anything before you submit it, and for disclosing
            what AI tooling you used and to what extent it authored the report.
          </p>
          <a href="https://hackerone.com/wordpress" target="_blank" rel="noreferrer" style={{ fontSize: 'var(--fs-caption)' }}>
            hackerone.com/wordpress
          </a>
        </div>
        <p className="g-caption g-faint">
          Specialists reason; they do not fire. There is no scanner, no fuzzer, no payload list and no
          credential attack behind this section — which is also why it is safe to leave running.
        </p>
      </Card>

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      {/* ── Local target mode ─────────────────────────────────────────────── */}
      <Card
        title="Local target: read your own copy"
        sub="Point Goga at a source tree on this machine. Nothing leaves the machine and no host is contacted."
      >
        <div className="g-row">
          <Field label="Folder holding the copy" hint="For WordPress: extract https://wordpress.org/download/source/ and point at the extracted folder.">
            <input className="g-input g-input--lg" value={root} onChange={e => setRoot(e.target.value)} placeholder="C:\Users\you\Downloads\wordpress" />
          </Field>
          <button className="g-btn" disabled={busy || !root} onClick={() => void work(async () => {
            const t = await window.goga.invoke('grimoire:indexTarget', root)
            setFiles(t.files); setIndexNotes(t.findings); setPicked(t.files[0] ?? '')
            setNotice(`${t.files.length} readable file(s) indexed under ${t.label}. Nothing outside that folder will be read.`)
          })}>Index this folder</button>
        </div>
        {indexNotes.length > 0 && (
          <ul className="g-caption" style={{ paddingLeft: 16 }}>
            {indexNotes.map(n => <li key={n}>{n}</li>)}
          </ul>
        )}

        {files.length > 0 && (
          <>
            <div className="g-row" style={{ marginTop: 8 }}>
              <Field label="Filter files">
                <input className="g-input g-input--md" value={fileFilter} onChange={e => setFileFilter(e.target.value)} placeholder="class-wp-http.php" />
              </Field>
              <Field label="Marker (optional)" hint="A unique string you are already looking at, so the sample keeps its neighbourhood.">
                <input className="g-input g-input--md" value={marker} onChange={e => setMarker(e.target.value)} placeholder="goga7f3a91" />
              </Field>
              <button className="g-btn g-btn--primary" disabled={busy || !picked} onClick={() => void work(async () => {
                const r = await window.goga.invoke('grimoire:reviewFile', { root, path: `${root.replace(/[\\/]+$/, '')}/${picked}`.replace(/\//g, '\\'), marker: marker || undefined })
                setRun(r)
                setNotice(`Reviewed ${r.read}. ${r.sample.sampled ? 'The file was sampled — the note says what was kept.' : 'The whole file was read.'}`)
                await load()
              })}>{busy ? 'Reviewing…' : 'Review this file'}</button>
            </div>
            <div className="g-inset" style={{ maxHeight: 220, overflowY: 'auto', fontSize: 'var(--fs-caption)' }}>
              {filtered.map(f => (
                <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '1px 0', cursor: 'pointer' }}>
                  <input type="radio" checked={picked === f} onChange={() => setPicked(f)} />
                  <span className="g-mono" style={{ fontSize: 11.5 }}>{f}</span>
                </label>
              ))}
              {filtered.length === 0 && <span className="g-faint">No file matches that filter.</span>}
            </div>
          </>
        )}

        {!files.length && (
          <EmptyState icon="📂" title="Point at a folder first" body="Indexing lists readable text files and reads the WordPress version, if it finds one. It reads nothing outside the folder you name." />
        )}

        {run && <ReviewOutput run={run} questions={questions} onGate={async (h, answers) => {
          const r = await window.goga.invoke('grimoire:gateDecide', { hypothesis: h, answers })
          await load()
          return r
        }} />}
      </Card>

      {/* ── The validator ─────────────────────────────────────────────────── */}
      {run && (
        <Card title="The independent validator" sub="A candidate is not a finding until this says what would confirm it">
          <p className="g-caption">
            {confirmed.length} candidate(s) had a confirming observable present in the material.
            {' '}{dropped.length} could not be confirmed from what we have and were dropped — that refusal is the feature,
            not a failure. Nothing below is a finding.
          </p>
          {confirmed.length === 0 && dropped.length === 0 && (
            <EmptyState icon="✅" title="Nothing to validate" body="No specialist raised anything about this file." />
          )}
          {confirmed.map(h => (
            <details key={h.id} className="g-details" open>
              <summary>
                <Chip tone="warn">observable</Chip> {h.title}
                {h.seenBefore && <Chip tone="accent">seen before{h.firstSeen ? ` · ${h.firstSeen.slice(0, 10)}` : ''}</Chip>}
              </summary>
              <div style={{ fontSize: 'var(--fs-body)', marginTop: 8 }}>
                <p><strong>The specialist's argument.</strong> {h.argument}</p>
                <p><strong>If true.</strong> {h.ifTrue}</p>
                <div className="g-inset" style={{ marginTop: 8 }}>
                  <div className="g-section-title">The observable the validator found</div>
                  <p className="g-mono" style={{ fontSize: 11.5, marginTop: 4 }}>{h.validation.observable}</p>
                  <p className="g-caption g-faint">at {h.validation.observableAt}</p>
                </div>
                <div style={{ marginTop: 8 }}>
                  <div className="g-section-title">What would confirm it, on your own copy</div>
                  <ul style={{ paddingLeft: 16, color: 'var(--text-muted)', fontSize: 'var(--fs-caption)' }}>
                    {h.validation.wouldConfirm.map(w => <li key={w}>{w}</li>)}
                  </ul>
                </div>
                <p className="g-caption g-faint">The validator's check: {h.validation.check}</p>
                <p className="g-caption g-faint">
                  An observable being present means it is worth reproducing by hand. It does not mean the bug is
                  exploitable, and it is not a finding.
                </p>
              </div>
            </details>
          ))}
          {dropped.map(h => (
            <details key={h.id} className="g-details">
              <summary><Chip tone="bad">dropped</Chip> {h.title}</summary>
              <p style={{ fontSize: 'var(--fs-caption)', marginTop: 6, color: 'var(--text-muted)' }}>
                <strong>Why it was dropped.</strong> {h.validation.why}
              </p>
              <p className="g-caption g-faint">The validator's check: {h.validation.check}</p>
            </details>
          ))}
        </Card>
      )}

      {/* ── Knowledge base ────────────────────────────────────────────────── */}
      <Card title="Knowledge base, from disclosed reports" sub={kb ? `${kb.entries.length} classes, each citing the report it came from` : 'loading'}>
        {kb && (
          <>
            <p className="g-caption" style={{ whiteSpace: 'pre-wrap' }}>{kb.note}</p>
            <div className="g-section-title" style={{ marginTop: 8 }}>Sources</div>
            <ul className="g-caption" style={{ paddingLeft: 16 }}>
              {kb.sources.map(s => (
                <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> — {s.what}</li>
              ))}
            </ul>
            {kb.entries.map(e => (
              <details key={e.id} className="g-details">
                <summary>
                  <Chip tone="accent">{e.specialist}</Chip> {e.bugClass}
                  <span className="g-faint" style={{ fontSize: 10, marginLeft: 6 }}>
                    {e.citations.length ? `${e.citations.length} report(s)` : 'no disclosed report found'}
                  </span>
                </summary>
                <div style={{ fontSize: 'var(--fs-caption)', marginTop: 6 }}>
                  <p>{e.what}</p>
                  <p><strong>Fix.</strong> {e.fix}</p>
                  {e.citations.length > 0 && (
                    <ul style={{ paddingLeft: 16, marginTop: 6 }}>
                      {e.citations.map(c => (
                        <li key={c.reportId} style={{ marginBottom: 4 }}>
                          <a href={c.url} target="_blank" rel="noreferrer">report {c.reportId}</a> — {c.title}
                          <div className="g-faint" style={{ fontSize: 11 }}>
                            {[c.severity ? `severity ${c.severity}` : null, c.cwe, c.disclosed ? `disclosed ${c.disclosed}` : null].filter(Boolean).join(' · ')}
                            {c.bodyUnread ? ' · body not read — metadata only' : ''}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {e.limit && <p className="g-faint" style={{ fontStyle: 'italic' }}>{e.limit}</p>}
                </div>
              </details>
            ))}
          </>
        )}
      </Card>

      {/* ── The seven-question gate ───────────────────────────────────────── */}
      <Card title="The seven-question gate" sub="What a finding must survive before a report is drafted">
        <p className="g-caption">
          A “no” on any of the first four questions kills the finding. A killed finding stays in memory as
          dead, so it is never raised again. This is the step that keeps an unverified item off a program's
          triage queue.
        </p>
        <ol style={{ paddingLeft: 18, fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>
          {questions.map((q, i) => (
            <li key={q.id} style={{ marginBottom: 6 }}>
              <strong style={{ color: 'var(--text)' }}>{q.question}</strong>
              {i < 4 && <Chip tone="bad">fatal</Chip>}
              <div>Passes when: {q.passing}</div>
              <div className="g-faint">{q.why}</div>
            </li>
          ))}
        </ol>
      </Card>

      {/* ── Cantina ──────────────────────────────────────────────────────── */}
      <Card title="Cantina: import a bounty's scope" sub="Read from the public bounty page. Nothing is joined, paid or submitted.">
        <div className="g-row">
          <Field label="Cantina bounty URL" hint="e.g. https://bounties.cantina.xyz/cantina/bug-bounty">
            <input className="g-input g-input--lg" value={cantinaUrl} onChange={e => setCantinaUrl(e.target.value)} placeholder="https://bounties.cantina.xyz/cantina/bug-bounty" />
          </Field>
          <button className="g-btn g-btn--primary" disabled={busy || !cantinaUrl} onClick={() => void work(async () => {
            const r = await window.goga.invoke('grimoire:importCantina', cantinaUrl)
            setNotice(`Imported ${r.program.name}: ${r.program.assets.length} asset(s). ${r.bar.entry.why}`)
            setCantinaUrl('')
            await onChanged()
          })}>{busy ? 'Reading…' : 'Import Cantina scope'}</button>
        </div>
        <p className="g-caption g-faint">
          Cantina's own testing rules say: “Please be extremely cautious when performing any automated scans or tests
          that involve multiple requests. Excessive traffic may be flagged as malicious activity.” That is why the
          specialists here never fire.
        </p>
        {programs.some(p => p.source === 'cantina') && (
          <div style={{ marginTop: 10 }}>
            <div className="g-section-title">Imported Cantina programs, with the entry bar beside the reward</div>
            {programs.filter(p => p.source === 'cantina').map(p => <EntryBarCard key={p.id} program={p} active={active?.id === p.id} />)}
          </div>
        )}
      </Card>

      {/* ── Bounty finder ────────────────────────────────────────────────── */}
      <Card title="Bounty finder" sub="Read-only feed of open, bounty-labelled work, with a difficulty estimate">
        <div className="g-row">
          <Field label="Search" hint="Default: label:bounty state:open is:issue">
            <input className="g-input g-input--lg" value={feedQuery} onChange={e => setFeedQuery(e.target.value)} placeholder="label:bounty state:open is:issue" />
          </Field>
          <button className="g-btn" disabled={busy} onClick={() => void work(async () => {
            setFeed(await window.goga.invoke('grimoire:bountyFeed', feedQuery || undefined))
          })}>{busy ? 'Reading…' : 'Refresh feed'}</button>
        </div>
        {feed?.error && <Alert kind="error">{feed.error}</Alert>}
        {feed && !feed.error && (
          <>
            <p className="g-caption">{feed.note}</p>
            {feed.items.length === 0 && <EmptyState icon="🔎" title="Nothing matched" body="Try a different query, or clear it to use the default." />}
            {feed.items.map(i => (
              <div key={i.id} className="g-details">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {i.hiddenGem && <Chip tone="ok">hidden gem</Chip>}
                  <Chip tone={i.difficulty === 'starter' ? 'ok' : i.difficulty === 'hard' ? 'bad' : 'warn'}>{i.difficulty}</Chip>
                  <a href={i.url} target="_blank" rel="noreferrer" style={{ fontSize: 'var(--fs-body)' }}>{i.title}</a>
                </div>
                <div className="g-caption g-faint" style={{ marginLeft: 2 }}>
                  {i.repo} · {i.comments} comment(s) · {i.ageDays} day(s) old — {i.difficultyWhy}
                </div>
                <div className="g-caption" style={{ marginLeft: 2 }}>{i.hint}</div>
              </div>
            ))}
          </>
        )}
        {!feed && (
          <EmptyState
            icon="🧭"
            title="Press refresh to read the feed"
            body="It reads GitHub's public search once, when you ask. There is no background job: a feed that quietly calls out every six hours is not something this app should do unasked."
          />
        )}
      </Card>

      {/* ── Memory ───────────────────────────────────────────────────────── */}
      <Card
        title="Memory: what was tried"
        sub={memory ? `${memory.summary.total} candidate(s) — ${memory.summary.dropped} dropped, ${memory.summary.dead} dead, ${memory.summary.confirmed} confirmed` : 'loading'}
      >
        {!memory || memory.entries.length === 0
          ? <EmptyState icon="🧠" title="Nothing tried yet" body="A review records each candidate and what happened to it, so the same candidate is not re-argued next time." />
          : (
            <div className="g-inset" style={{ maxHeight: 260, overflowY: 'auto', fontSize: 'var(--fs-caption)' }}>
              {[...memory.entries].reverse().slice(0, 60).map(e => (
                <div key={e.key} style={{ padding: '3px 0' }}>
                  <Chip tone={e.outcome === 'user-confirmed' ? 'ok' : e.outcome === 'dropped' || e.outcome === 'dead' ? 'bad' : 'warn'}>{e.outcome}</Chip>
                  <span style={{ marginLeft: 6 }}>{e.title}</span>
                  <div className="g-faint" style={{ marginLeft: 2 }}>{e.reason}</div>
                </div>
              ))}
            </div>
          )}
      </Card>
    </>
  )
}

/* ─────────────────────────── the review output ─────────────────────────── */

function ReviewOutput({ run, questions, onGate }: {
  run: ReviewRun
  questions: GateQuestion[]
  onGate: (h: Hypothesis, answers: GateAnswer[]) => Promise<GateResult>
}) {
  const speaking = run.reviews.filter(r => !r.quiet)
  const quiet = run.reviews.filter(r => r.quiet)
  return (
    <div style={{ marginTop: 12 }}>
      <div className="g-inset">
        <div className="g-section-title">What was read</div>
        <p className="g-caption" style={{ marginTop: 4 }}>
          <span className="g-mono">{run.read}</span> — {run.bytes.toLocaleString()} bytes. {run.sample.note}
        </p>
        {run.sample.sampled && (
          <ul className="g-caption g-faint" style={{ paddingLeft: 16 }}>
            {run.sample.kept.map(k => <li key={k}>{k}</li>)}
          </ul>
        )}
        <p className="g-caption">{run.guarantee}</p>
      </div>

      <div className="g-section-title" style={{ marginTop: 12 }}>
        Specialist reasoning ({speaking.length} with something to say, {quiet.length} quiet)
      </div>
      {speaking.map(r => (
        <details key={r.specialist} className="g-details" open>
          <summary><Chip tone="accent">{r.name}</Chip> {r.hits.length} line(s) worth reading</summary>
          <p style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-caption)', color: 'var(--text-muted)', marginTop: 6 }}>{r.reasoning}</p>
          <div className="g-caption g-faint">Budget: {r.budget}</div>
        </details>
      ))}
      {quiet.length > 0 && (
        <details className="g-details">
          <summary>{quiet.length} specialist(s) had nothing to argue about</summary>
          <ul style={{ paddingLeft: 16, fontSize: 'var(--fs-caption)', color: 'var(--text-faint)' }}>
            {quiet.map(r => <li key={r.specialist}>{r.name}</li>)}
          </ul>
        </details>
      )}

      {run.hypotheses.filter(h => h.state === 'hypothesis').length > 0 && (
        <>
          <div className="g-section-title" style={{ marginTop: 12 }}>Run the seven-question gate</div>
          {run.hypotheses.filter(h => h.state === 'hypothesis').map(h => (
            <GatePanel key={h.id} hypothesis={h} questions={questions} onGate={onGate} />
          ))}
        </>
      )}
    </div>
  )
}

function GatePanel({ hypothesis, questions, onGate }: {
  hypothesis: Hypothesis
  questions: GateQuestion[]
  onGate: (h: Hypothesis, answers: GateAnswer[]) => Promise<GateResult>
}) {
  const [answers, setAnswers] = useState<Record<string, GateAnswer['answer']>>({})
  const [result, setResult] = useState<GateResult | null>(null)
  const complete = questions.every(q => answers[q.id])

  return (
    <details className="g-details">
      <summary>{hypothesis.title}</summary>
      <div style={{ marginTop: 8 }}>
        <p className="g-caption">Answer honestly. A “no” on the first four kills it, and it stays dead.</p>
        {questions.map(q => (
          <div key={q.id} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 'var(--fs-caption)' }}>{q.question}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
              {(['yes', 'no', 'unsure'] as const).map(a => (
                <button
                  key={a}
                  className={answers[q.id] === a ? 'g-btn g-btn--sm' : 'g-btn g-btn--ghost g-btn--sm'}
                  onClick={() => setAnswers(prev => ({ ...prev, [q.id]: a }))}
                >{a}</button>
              ))}
            </div>
          </div>
        ))}
        <button className="g-btn g-btn--primary g-btn--sm" disabled={!complete} onClick={async () => {
          const r = await onGate(hypothesis, questions.map(q => ({ questionId: q.id, answer: answers[q.id] ?? null, note: '' })))
          setResult(r)
        }}>Decide</button>
        {result && (
          <Alert kind={result.outcome === 'pass' ? 'ok' : result.outcome === 'fail' ? 'error' : 'info'}>
            {result.outcome === 'pass'
              ? 'Passed all seven. It is still hypothesis-level until you reproduce it yourself and write the report.'
              : result.outcome === 'fail'
                ? `Killed at: ${result.killedBy}. It is recorded as dead so it is not raised again.`
                : 'Some questions are unanswered, so nothing was decided.'}
          </Alert>
        )}
      </div>
    </details>
  )
}

/* ─────────────────────────── the entry bar card ─────────────────────────── */

function EntryBarCard({ program, active }: { program: ProgramImport; active: boolean }) {
  const bar: ProgramEntryBar | undefined = program.entryBar
  if (!bar) {
    return (
      <div className="g-inset" style={{ marginTop: 6, fontSize: 'var(--fs-caption)' }}>
        <strong>{program.name}</strong> — imported before entry bars were recorded. {program.assets.length} asset(s).
      </div>
    )
  }
  const tone = bar.entry.level === 'open' ? 'ok' as const : bar.entry.level === 'moderate' ? 'warn' as const : 'bad' as const
  return (
    <div className="g-inset" style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{program.name}</strong>
        {active && <Chip tone="accent">active</Chip>}
        <Chip tone={tone}>{bar.entry.level}</Chip>
        <span className="g-caption">{program.assets.length} asset(s)</span>
        <a href={program.url} target="_blank" rel="noreferrer" style={{ fontSize: 'var(--fs-caption)' }}>program page</a>
      </div>
      <table className="g-table" style={{ marginTop: 8 }}>
        <tbody>
          <tr><th style={{ width: 170 }}>Top reward</th><td className="g-mono">{bar.topReward ?? 'not stated'}</td></tr>
          <tr><th>Identity verification</th><td>{bar.kycRequired === false ? <Chip tone="ok">not required</Chip> : bar.kycRequired === true ? <Chip tone="bad">required to join</Chip> : <Chip>not stated</Chip>}</td></tr>
          <tr><th>Deposit to join</th><td>{bar.depositUsd ? <Chip tone="warn">${bar.depositUsd}</Chip> : 'none stated'}</td></tr>
          <tr><th>Findings already submitted</th><td className="g-mono">{bar.findingsSubmitted !== null ? bar.findingsSubmitted.toLocaleString() : 'not stated'}</td></tr>
          <tr><th>Scope kind</th><td>{bar.scopeKind}</td></tr>
          {bar.rewards.length > 0 && (
            <tr><th>By severity</th><td className="g-mono">{bar.rewards.map(r => `${r.severity} ${r.amount}`).join(' · ')}</td></tr>
          )}
        </tbody>
      </table>
      <p className="g-caption" style={{ marginTop: 6 }}><strong>Assessment, not the program's own words.</strong> {bar.entry.why}</p>
      {bar.kycQuote && <p className="g-caption g-faint">The page's own sentence: “{bar.kycQuote}”</p>}
      {bar.automatedTestingRule && (
        <p className="g-caption" style={{ marginTop: 4 }}>
          <strong>Its rule on automated testing:</strong> “{bar.automatedTestingRule}” That is why the specialists
          never fire and why the only request path is one approved GET.
        </p>
      )}
    </div>
  )
}

export type { JsEndpoint, SpecialistId }
