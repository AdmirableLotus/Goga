import React, { useEffect, useRef, useState } from 'react'
import type { DeveloperState } from '../../shared/developer'
import './developer.css'

const starters = [
  { label: 'Find weaknesses', task: 'Analyze Goga’s own source code. Trace the agent loop, tool execution, approvals, cancellation, and Telegram integration. Identify the three most important reliability problems with file references, concrete failure scenarios, and a proposed fix and verification for each. Do not change files yet.' },
  { label: 'Improve reliability', task: 'Inspect Goga’s source code and find one concrete, reproducible reliability bug. Explain the failure, implement a focused fix preserving existing changes, add a meaningful regression test, and run relevant checks. Report evidence and remaining limitations. Do not change unrelated features.' },
  { label: 'Strengthen task execution', task: 'Review Goga’s planning, execution, recovery, and completion detection. Find where a task can falsely claim success or repeat failed actions. Implement one focused improvement with a regression test and run the relevant checks. Preserve existing user changes.' },
]

export default function DeveloperPage() {
  const [state, setState] = useState<DeveloperState | null>(null)
  const [task, setTask] = useState(starters[0].task)
  const [mode, setMode] = useState<'plan' | 'build'>('plan')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const active = state?.status === 'running' || state?.status === 'stopping'
  const runDiff = state?.runDiff ?? null
  useEffect(() => {
    const unsub = window.goga.on('developer:state', setState)
    window.goga.invoke('developer:state').then(async current => {
      setState(current)
      if (!current.project) {
        try { setState(await window.goga.invoke('developer:self')) } catch { /* Packaged apps use the folder picker. */ }
      }
    }).catch(e => setError(String(e)))
    return () => { unsub() }
  }, [])
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [state?.events.length])
  async function action(run: () => Promise<DeveloperState>) {
    setError(''); setPending(true)
    try { setState(await run()) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setPending(false) }
  }
  return <section className="developer-page">
    <header className="developer-heading">
      <div><div className="developer-eyebrow">GOGA / SELF IMPROVEMENT</div><h1>Developer Mode</h1><p>Understand the code. Fix a weakness. Prove the improvement.</p></div>
      <span className={`developer-badge ${active ? 'active' : ''}`} role="status">{state?.status || 'loading'}</span>
    </header>
    <div className="developer-columns">
      <aside className="developer-controls">
        <div className="developer-panel">
          <h2>Source workspace</h2>
          <strong>{state?.project?.name || 'Choose Goga’s source code'}</strong>
          <p className="developer-path">{state?.project?.path || 'Start with the code behind this app.'}</p>
          <div className="developer-buttons"><button disabled={active || pending} onClick={() => action(() => window.goga.invoke('developer:self'))}>Use Goga source</button><button disabled={active || pending} onClick={() => action(() => window.goga.invoke('developer:choose'))}>Choose project</button></div>
          {state?.project && <p>{state.project.git ? `Branch: ${state.project.branch}` : 'Folder without Git history'} · {state.project.scripts.length} project scripts</p>}
        </div>
        <div className="developer-panel">
          <h2>Improvement task</h2>
          <div className="developer-starters">{starters.map((item, i) => <button key={item.label} disabled={active || pending} onClick={() => { setTask(item.task); setMode(i === 0 ? 'plan' : 'build') }}>{item.label}</button>)}</div>
          <label htmlFor="developer-task">What should Goga improve?</label>
          <textarea id="developer-task" value={task} onChange={e => setTask(e.target.value)} disabled={active || pending} maxLength={24000} rows={8} />
          <label htmlFor="developer-mode">How to work</label>
          <select id="developer-mode" value={mode} disabled={active || pending} onChange={e => setMode(e.target.value as 'plan' | 'build')}><option value="plan">Analyze and propose a plan</option><option value="build">Implement and verify</option></select>
          <p>{mode === 'plan' ? 'Read-only analysis. Review the findings before requesting a repair.' : 'Allows source edits and local checks in this workspace. Changes take effect after rebuild and restart.'}</p>
          <button className="developer-run" disabled={!state?.available || !state.project || !task.trim() || active || pending} onClick={() => action(() => window.goga.invoke('developer:start', task, mode))}>{pending ? 'Starting…' : mode === 'plan' ? 'Analyze code' : 'Start improvement'}</button>
          {active && <button className="developer-stop" disabled={state?.status === 'stopping' || pending} onClick={() => action(() => window.goga.invoke('developer:stop'))}>Stop task</button>}
          <p className="developer-engine">Engine: {state?.available ? 'Codex CLI detected · uses your existing sign-in' : 'Codex CLI required. Install it and run codex login.'}</p>
        </div>
      </aside>
      <div className="developer-results">
        {error && <div className="developer-error" role="alert">{error}</div>}
        <div className="developer-panel developer-timeline"><h2>Live work</h2>
          {!state?.events.length && <div className="developer-empty"><span>&lt;/&gt;</span><h3>A stronger Goga starts with evidence</h3><p>Select the source and analyze it. Findings, commands, file changes, and failures will appear here.</p></div>}
          {state?.events.map(event => <article className={`developer-event ${event.kind}`} key={event.id}><span>{event.kind}</span><pre>{event.text}</pre></article>)}<div ref={end} />
        </div>
        {state?.summary && <div className="developer-panel"><h2>Agent report</h2><pre className="developer-report">{state.summary}</pre></div>}
        <div className="developer-panel"><h2>Changes in this run</h2>
          <p>Diffed against a snapshot taken when the run started, so earlier edits are not counted.</p>
          {runDiff === null
            ? <pre className="developer-report">{state?.status === 'running' ? 'The diff appears when the run finishes.' : 'No run yet.'}</pre>
            : !runDiff.available
              ? <pre className="developer-report">{runDiff.reason || 'No diff available for this run.'}</pre>
              : <>
                  <pre className="developer-report">{runDiff.stat || 'This run changed no tracked files.'}</pre>
                  {runDiff.newFiles.length > 0 && <p>New files: {runDiff.newFiles.join(', ')}</p>}
                  {runDiff.deletedFiles.length > 0 && <p>Deleted files: {runDiff.deletedFiles.join(', ')}</p>}
                  {runDiff.patch && <details><summary>Full patch{runDiff.truncated ? ' (truncated)' : ''}</summary><pre className="developer-report">{runDiff.patch}</pre></details>}
                </>}
        </div>
        <div className="developer-panel"><h2>Working tree</h2><p>Everything uncommitted, including changes that existed before this run. Review before committing.</p><pre className="developer-report">{state?.project?.changedFiles || (state?.project?.git ? 'No uncommitted changes.' : 'Choose a Git project to see changed files.')}</pre></div>
      </div>
    </div>
  </section>
}
