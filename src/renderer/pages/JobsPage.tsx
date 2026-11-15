import React, { useCallback, useEffect, useState } from 'react'
import type { Job, JobState, JobsView } from '../../shared/jobs'
import { PageHeader, Card, Field, EmptyState, Alert, Chip } from '../components/ui'

/**
 * The job board — one page that shows everything in flight.
 *
 * Every job the user has started is here with its state, the line it is currently on, and
 * what it produced. A job that is waiting on an answer is pinned to the top, because that is
 * the only thing on the page that needs the user.
 */

const STATE_TONE: Record<JobState, 'ok' | 'warn' | 'bad' | 'accent' | undefined> = {
  queued: undefined,
  running: 'accent',
  waiting: 'warn',
  done: 'ok',
  failed: 'bad',
  canceled: undefined,
  interrupted: 'warn',
}

const STATE_WORD: Record<JobState, string> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting on you',
  done: 'done',
  failed: 'failed',
  canceled: 'canceled',
  interrupted: 'interrupted',
}

function ago(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

function when(ts: number | undefined): string {
  return ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—'
}

export default function JobsPage() {
  const [view, setView] = useState<JobsView | null>(null)
  const [goal, setGoal] = useState('')
  const [title, setTitle] = useState('')
  const [answerDraft, setAnswerDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const v = await window.goga.invoke('jobs:state') as JobsView
      setView(v)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => {
    void load()
    const off = window.goga.on('jobs:update', (v: JobsView) => setView(v))
    return () => { off() }
  }, [load])

  async function work(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false); void load() }
  }

  const jobs = view?.jobs ?? []
  const waiting = jobs.filter(j => j.state === 'waiting')
  const active = jobs.filter(j => j.state === 'running' || j.state === 'queued')
  const interrupted = jobs.filter(j => j.state === 'interrupted')
  const finished = jobs.filter(j => j.state === 'done' || j.state === 'failed' || j.state === 'canceled')

  return (
    <div className="g-page">
      <div className="g-page-inner">
        <PageHeader
          title="Jobs"
          accent="work in flight"
          purpose="Each job is a separate worker with its own goal, its own steps and its own report. It keeps running when the window is closed, and it stops to ask you rather than guessing."
          help={<>
            <p>A job ends with a report split in two: what you get, and what happened. Anything it did not do is listed under “Not done” — a job that only partly worked says so.</p>
            <p>Every tool a job uses goes through the same approval rules as chat. A tool that needs your approval becomes a question on this page; nothing is run because a job asked for it.</p>
            <p>{view ? `${view.running} of ${view.cap} allowed jobs are running.` : ''} A job waiting on you does not hold a slot, so the queue keeps moving while you think.</p>
          </>}
          actions={view ? <Chip tone={waiting.length ? 'warn' : active.length ? 'accent' : undefined}>
            {waiting.length ? `${waiting.length} need you` : `${view.running} running · ${view.queued} queued`}
          </Chip> : undefined}
        />

        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="ok">{notice}</Alert>}

        {/* Start a job */}
        <Card title="Start a job" sub="For work that will take many steps or a long time">
          <Field label="What should it achieve?" hint="The worker sees only this — say what done looks like.">
            <textarea className="g-input" rows={3} value={goal} onChange={e => setGoal(e.target.value)}
              placeholder='e.g. "Build a landing page for the ring project, then write three testers a short invitation I can approve."' />
          </Field>
          <div className="g-row">
            <Field label="Name on the board (optional)">
              <input className="g-input g-input--md" value={title} onChange={e => setTitle(e.target.value)} placeholder="Ring landing page" />
            </Field>
            <button className="g-btn g-btn--primary" disabled={busy || goal.trim().length < 4} onClick={() => void work(async () => {
              const r = await window.goga.invoke('jobs:create', { goal: goal.trim(), title: title.trim() || undefined }) as { job: Job; view: JobsView }
              setGoal(''); setTitle(''); setView(r.view)
              setNotice(`Job ${r.job.id} created — it is ${STATE_WORD[r.job.state]}.`)
            })}>Start job</button>
          </div>
          {view && view.queued > 0 && view.running >= view.cap && (
            <Alert kind="info">{view.queued} job{view.queued === 1 ? ' is' : 's are'} queued: the {view.cap}-job limit is full, so {view.queued === 1 ? 'it starts' : 'they start'} when a running job finishes.</Alert>
          )}
        </Card>

        {/* Waiting on the user — first, because this is the only part that needs them */}
        {waiting.map(job => (
          <Card key={job.id} tone="accent" title={`Waiting on you — ${job.title}`} sub={`Asked ${ago(Date.now() - (job.question?.askedAt ?? job.createdAt))}`}>
            <p style={{ fontSize: 'var(--fs-body)' }}>{job.question?.text}</p>
            {job.question?.detail && <pre className="g-inset g-mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 220, overflowY: 'auto' }}>{job.question.detail}</pre>}
            {job.question?.options?.length ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {job.question.options.map(o => (
                  <button key={o} className="g-btn" disabled={busy} onClick={() => void work(async () => {
                    setView(await window.goga.invoke('jobs:answer', job.id, o) as JobsView)
                    setNotice('Answer sent to the job.')
                  })}>{o}</button>
                ))}
              </div>
            ) : null}
            <div className="g-row">
              <Field label="Your answer" hint={job.question?.kind === 'credential' ? 'A key or password is better entered in the app that needs it — say here where you put it, not the secret itself.' : 'Your words go back to the worker exactly as written.'}>
                <input className="g-input g-input--xl" value={answerDraft[job.id] ?? ''} onChange={e => setAnswerDraft(d => ({ ...d, [job.id]: e.target.value }))}
                  placeholder={job.question?.kind === 'approval' ? 'yes / no' : 'your answer'} />
              </Field>
              <button className="g-btn g-btn--primary" disabled={busy || !(answerDraft[job.id] ?? '').trim()} onClick={() => void work(async () => {
                setView(await window.goga.invoke('jobs:answer', job.id, (answerDraft[job.id] ?? '').trim()) as JobsView)
                setAnswerDraft(d => ({ ...d, [job.id]: '' }))
                setNotice('Answer sent to the job.')
              })}>Send answer</button>
              <button className="g-btn" disabled={busy} onClick={() => void work(async () => {
                setView(await window.goga.invoke('jobs:cancel', job.id) as JobsView)
              })}>Cancel job</button>
            </div>
          </Card>
        ))}

        {/* Everything else */}
        <Card title={`All jobs (${jobs.length})`} sub="Newest first">
          {jobs.length === 0
            ? <EmptyState icon="🗂" title="No jobs yet" body="A big request belongs in a job: start one above, or tell Goga in chat and he will hand it to a worker." />
            : (
              <div>
                {[...active, ...interrupted, ...finished].map(job => (
                  <div key={job.id} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <Chip tone={STATE_TONE[job.state]}>{STATE_WORD[job.state]}</Chip>
                      {/* A job that finished but left something undone says so on the row, not
                          only inside its report. */}
                      {job.state === 'done' && (job.report?.notDone.length ?? 0) > 0 && (
                        <Chip tone="warn">partly done</Chip>
                      )}
                      <strong style={{ fontSize: 'var(--fs-body)' }}>{job.title}</strong>
                      <span className="g-caption g-faint">{job.steps.length} step{job.steps.length === 1 ? '' : 's'} · started {ago(Date.now() - (job.startedAt ?? job.createdAt))}</span>
                      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                        <button className="g-btn g-btn--ghost g-btn--sm" onClick={() => setOpen(open === job.id ? null : job.id)}>
                          {open === job.id ? 'Hide' : 'Details'}
                        </button>
                        {job.state === 'interrupted' && (
                          <button className="g-btn g-btn--sm" disabled={busy} onClick={() => void work(async () => {
                            setView(await window.goga.invoke('jobs:resume', job.id) as JobsView)
                            setNotice('Job resumed.')
                          })}>Resume</button>
                        )}
                        {(job.state === 'running' || job.state === 'queued' || job.state === 'waiting') && (
                          <button className="g-btn g-btn--sm g-btn--risk" disabled={busy} onClick={() => void work(async () => {
                            setView(await window.goga.invoke('jobs:cancel', job.id) as JobsView)
                          })}>Cancel</button>
                        )}
                      </span>
                    </div>
                    <div className="g-caption" style={{ marginTop: 3 }}>{job.progress}</div>

                    {job.state === 'waiting' && job.question && (
                      <div className="g-caption" style={{ color: 'var(--warn)', marginTop: 4 }}>Waiting on you: {job.question.text}</div>
                    )}
                    {job.state === 'interrupted' && (
                      <div className="g-caption" style={{ color: 'var(--warn)', marginTop: 4 }}>
                        Interrupted {when(job.interruptedAt)}{job.resumedCount ? ` · resumed ${job.resumedCount}× before` : ''}. Its steps are kept; resume it or cancel it.
                      </div>
                    )}
                    {job.error && job.state === 'failed' && <div className="g-caption" style={{ color: '#f08a8a', marginTop: 4 }}>{job.error}</div>}

                    {job.report && (
                      <details className="g-details" open={open === job.id}>
                        <summary>Report — what you get, what happened, what was not done</summary>
                        <div style={{ marginTop: 6 }}>
                          {job.report.result.length > 0 && (
                            <>
                              <div className="g-section-title" style={{ marginBottom: 4 }}>What you get</div>
                              <ul style={{ fontSize: 'var(--fs-body)', paddingLeft: 18 }}>
                                {job.report.result.map((r, i) => <li key={i} style={{ whiteSpace: 'pre-wrap' }}>{r}</li>)}
                              </ul>
                            </>
                          )}
                          {job.report.notDone.length > 0 ? (
                            <Alert kind="error">
                              <div>
                                <strong>Not done</strong>
                                <ul style={{ paddingLeft: 18, marginTop: 4 }}>
                                  {job.report.notDone.map((r, i) => <li key={i}>{r}</li>)}
                                </ul>
                              </div>
                            </Alert>
                          ) : (
                            <div className="g-caption" style={{ color: 'var(--success)' }}>Every step this job attempted worked.</div>
                          )}
                          {job.report.operations.length > 0 && (
                            <details className="g-details">
                              <summary>What happened, step by step ({job.report.operations.length})</summary>
                              <pre className="g-inset g-mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 260, overflowY: 'auto', marginTop: 6 }}>{job.report.operations.join('\n')}</pre>
                            </details>
                          )}
                          {job.report.files.length > 0 && (
                            <div className="g-caption g-mono" style={{ marginTop: 6 }}>{job.report.files.join('\n')}</div>
                          )}
                        </div>
                      </details>
                    )}

                    {open === job.id && job.steps.length > 0 && (
                      <details className="g-details" open>
                        <summary>Steps ({job.steps.length})</summary>
                        <div className="g-inset g-mono" style={{ fontSize: 11.5, maxHeight: 260, overflowY: 'auto', marginTop: 6 }}>
                          {job.steps.map(s => (
                            <div key={s.index} style={{ color: s.ok ? undefined : '#f08a8a' }}>
                              {s.index + 1}. [{s.ok ? 'ok' : 'failed'}] {s.tool} — {s.detail}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    <div className="g-caption g-faint g-mono" style={{ marginTop: 4 }}>{job.id} · {when(job.createdAt)}</div>
                  </div>
                ))}
              </div>
            )}
        </Card>

        {/* The limit */}
        <Card title="How many jobs run at once" sub="One runaway job should not starve the machine or the local model">
          <div className="g-row">
            <Field label="At most this many running" hint="Waiting-on-you jobs do not count. Each job also has its own step and time limit.">
              <select className="g-input g-input--sm" value={view?.cap ?? 2} disabled={busy}
                onChange={e => void work(async () => { setView(await window.goga.invoke('jobs:setCap', Number(e.target.value)) as JobsView) })}>
                {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <div className="g-caption">
              {view ? `${view.running} running · ${view.queued} queued · ${view.waiting} waiting on you` : '—'}
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
