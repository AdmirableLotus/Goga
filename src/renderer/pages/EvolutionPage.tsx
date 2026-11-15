import React, { useCallback, useEffect, useState } from 'react'
import type { EvolutionRun, EvolutionState, LearningNote, SkillRecord } from '../../shared/evolution'
import { PageHeader, Card, Field, EmptyState, Alert, Chip } from '../components/ui'

/**
 * Self-improve page.
 *
 * What the loop does is visible here at every stage: the weaknesses it named in the
 * read-only review, the exact change, the diff, whether the build and tests passed, and —
 * the only button that writes to the real source — "Install this change". Above it sits
 * the persistent learning layer, and below it the skills that survived restarts.
 */

const STAGE_LABEL: Record<string, string> = {
  review: 'reading its own source (read-only)',
  propose: 'writing up a change',
  apply: 'applying to a private copy',
  verify: 'typecheck and tests on the copy',
  awaiting: 'WAITING FOR YOUR APPROVAL',
  install: 'installing, rebuilding, retesting',
  done: 'installed (not reloaded)',
  'rolled-back': 'broken change rolled back',
  refused: 'refused or discarded',
  failed: 'failed',
}

export default function EvolutionPage() {
  const [state, setState] = useState<EvolutionState | null>(null)
  const [learning, setLearning] = useState<LearningNote[]>([])
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [status, setStatus] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const s = await window.goga.invoke('evolution:state') as EvolutionState & { learning?: LearningNote[]; skills?: SkillRecord[] }
      setState(s)
      if (s.learning) setLearning(s.learning)
      if (s.skills) setSkills(s.skills)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => {
    void load()
    const offUpdate = window.goga.on('evolution:update', (s: EvolutionState) => setState(s))
    const offStatus = window.goga.on('evolution:status', (text: string) => setStatus(text))
    return () => { offUpdate(); offStatus() }
  }, [load])

  async function work(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false); void load() }
  }

  const run: EvolutionRun | null = state?.current ?? null
  const awaiting = run?.stage === 'awaiting'

  return (
    <div className="g-page">
      <div className="g-page-inner">

        <PageHeader
          title="Self-improve"
          purpose="A supervised loop, not unrestricted self-modification. Goga reads his own source read-only, writes up what is wrong, changes a private copy, and proves it with the typechecker and the full test suite."
          help={<>
            <p>Nothing in the running code changes until you press install — and if the install breaks the build or the tests, it rolls back to a snapshot and says so.</p>
            <p>It never commits, pushes, deploys or reloads itself. A run needs the local coding model (Settings → coder model) and takes several minutes, because the private copy runs the whole test suite.</p>
          </>}
          actions={state?.running ? <Chip tone="accent">Running</Chip> : undefined}
        />

        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="ok">{notice}</Alert>}
        {status && <Alert kind="info">{status}</Alert>}

        {/* Run */}
        <Card title="Start a run" sub="Describe one specific weakness">
          <div className="g-row">
            <Field label="Weakness" hint="Be specific — a vague goal produces a vague change.">
              <input className="g-input g-input--xl" value={goal} onChange={e => setGoal(e.target.value)} placeholder='e.g. "browser.open retries the same failing page"' />
            </Field>
            <button className="g-btn g-btn--primary" disabled={busy || !!state?.running || goal.trim().length < 12} onClick={() => void work(async () => {
              await window.goga.invoke('evolution:start', goal)
              setGoal('')
              setNotice('Run finished. Read the review and the diff below before installing anything.')
            })}>{state?.running ? 'Running…' : 'Start'}</button>
          </div>
        </Card>

        {/* Current run */}
        {run && (
          <Card
            title={`This run — ${STAGE_LABEL[run.stage] ?? run.stage}`}
            tone={awaiting ? 'accent' : undefined}
            actions={<>
              <Chip tone={run.buildPassed === null ? undefined : run.buildPassed ? 'ok' : 'bad'}>Typecheck {run.buildPassed === null ? 'not reached' : run.buildPassed ? 'passed' : 'failed'}</Chip>
              <Chip tone={run.testsPassed === null ? undefined : run.testsPassed ? 'ok' : 'bad'}>Tests {run.testsPassed === null ? 'not reached' : run.testsPassed ? 'passed' : 'failed'}</Chip>
            </>}
          >
            <p style={{ fontSize: 'var(--fs-body)' }}><strong>Goal:</strong> {run.goal}</p>
            {run.weaknesses.length > 0 && (
              <details className="g-details" open>
                <summary>Weaknesses named in the read-only review ({run.weaknesses.length})</summary>
                <ul style={{ fontSize: 'var(--fs-body)', paddingLeft: 18, marginTop: 4 }}>
                  {run.weaknesses.map((w, i) => <li key={i}><strong>{w.title}</strong>{w.files.length ? <span className="g-mono g-faint"> — {w.files.join(', ')}</span> : ''}<div className="g-caption" style={{ whiteSpace: 'pre-wrap' }}>{w.problem}</div></li>)}
                </ul>
              </details>
            )}
            {run.summary && <p style={{ fontSize: 'var(--fs-body)' }}><strong>Change:</strong> {run.summary}<br /><span className="g-caption g-faint">Files: {run.files.join(', ') || '—'}</span></p>}
            {run.guardHits.length > 0 && (
              <Alert kind="error">Guardrail hits: {run.guardHits.map(g => `${g.path} (${g.why})`).join('; ')} — these files are refused.</Alert>
            )}
            {run.diff && <details className="g-details"><summary>Diff ({run.diff.split('\n').length} lines)</summary><pre className="g-inset g-mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 340, overflowY: 'auto', marginTop: 6, fontSize: 11.5 }}>{run.diff}</pre></details>}
            {run.error && <Alert kind="error">{run.error}</Alert>}
            {run.installNote && <p className="g-caption">{run.installNote}</p>}
            {awaiting && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="g-btn g-btn--primary" disabled={busy} onClick={() => void work(async () => {
                  const done = await window.goga.invoke('evolution:install')
                  setNotice(`Installed: ${done.installNote ?? done.summary}. Restart Goga yourself to run it.`)
                })}>Install this change into my running code</button>
                <button className="g-btn" disabled={busy} onClick={() => void work(async () => {
                  await window.goga.invoke('evolution:discard')
                  setNotice('Discarded. The running code was never touched.')
                })}>Discard</button>
              </div>
            )}
            {run.events.length > 0 && (
              <details className="g-details"><summary>Event log</summary>
                <div className="g-inset g-mono" style={{ maxHeight: 200, overflowY: 'auto', marginTop: 6, fontSize: 11.5 }}>
                  {run.events.map(e => <div key={e.id}>{e.time.slice(11, 19)} [{e.stage}] {e.text}</div>)}
                </div>
              </details>
            )}
          </Card>
        )}

        {/* History */}
        <Card title="History">
          {!state?.history?.length
            ? <EmptyState icon="🕘" title="No runs yet" body="Start a run above. Each one is kept here with its goal, stage, summary and diff." />
            : state.history.map(h => (
              <details key={h.id} className="g-details">
                <summary>{h.startedAt.slice(0, 16).replace('T', ' ')} <Chip>{h.stage}</Chip> {h.goal}</summary>
                <p style={{ fontSize: 'var(--fs-body)', marginTop: 4 }}>{h.summary || h.error || 'no summary'}</p>
                {h.files.length > 0 && <p className="g-caption g-faint g-mono">{h.files.join(', ')}</p>}
                {h.installNote && <p className="g-caption">{h.installNote}</p>}
                {h.diff && <details className="g-details"><summary>Diff</summary><pre className="g-inset g-mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 340, overflowY: 'auto', marginTop: 6, fontSize: 11.5 }}>{h.diff}</pre></details>}
              </details>
            ))}
        </Card>

        {/* Learning */}
        <Card title={`What carries across restarts (${learning.length})`} sub="Injected into the prompt on every task, so a lesson learned once is not lost when the app closes">
          {learning.length === 0
            ? <EmptyState icon="🧠" title="Nothing stored yet" body="Tell Goga to remember something, or let a run record what worked." />
            : <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {[...learning].reverse().map(n => (
                <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                  <Chip>{n.kind}</Chip>
                  <span style={{ flex: 1, fontSize: 'var(--fs-body)' }}>{n.text}</span>
                  <button className="g-btn g-btn--ghost g-btn--sm" onClick={() => void work(async () => {
                    await window.goga.invoke('evolution:forget', n.id)
                    setLearning(await window.goga.invoke('evolution:notes'))
                  })}>forget</button>
                </div>
              ))}
            </div>}
        </Card>

        {/* Skills */}
        <Card title={`Skills (${skills.length})`} sub="A procedure that worked, saved by name so it can be reused">
          {skills.length === 0
            ? <EmptyState icon="📘" title="No skills saved" body="When a procedure works, Goga can save it by name. He reads one with evolution.skills when it is relevant." />
            : skills.map(s => (
              <details key={s.id} className="g-details">
                <summary>{s.name} <span className="g-faint">({s.steps.length} steps, used {s.used}×)</span></summary>
                {s.whenToUse && <p className="g-caption" style={{ marginTop: 4 }}>{s.whenToUse}</p>}
                <ol style={{ fontSize: 'var(--fs-body)', paddingLeft: 18 }}>{s.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
                {s.tools.length > 0 && <p className="g-caption g-faint g-mono">Tools: {s.tools.join(', ')}</p>}
                <button className="g-btn g-btn--sm" onClick={() => void work(async () => {
                  await window.goga.invoke('evolution:deleteSkill', s.id)
                  setSkills(await window.goga.invoke('evolution:skills'))
                })}>Delete</button>
              </details>
            ))}
        </Card>

      </div>
    </div>
  )
}
