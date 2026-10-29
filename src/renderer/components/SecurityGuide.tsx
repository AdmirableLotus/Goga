import React, { useEffect, useState } from 'react'
import type { SecurityWorkspace } from '@shared/types'
import { LEARNING_PATH, POLICY_TOPICS, policyChecklist, type ResearchSource, type ToolInventoryEntry } from '@shared/securityGuide'

export default function SecurityGuide({ workspace, onUpdate, onSelectProgram }: { workspace: SecurityWorkspace | null; onUpdate: (ws: SecurityWorkspace) => void; onSelectProgram: (handle: string) => void }) {
  const [source, setSource] = useState<ResearchSource | null>(null)
  const [report, setReport] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{ title: string; url: string; retrievedAt: string }>>([])
  const [searched, setSearched] = useState(false)
  const [inventory, setInventory] = useState<ToolInventoryEntry[] | null>(null)
  const [answers, setAnswers] = useState<string[]>(POLICY_TOPICS.map(() => ''))
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setAnswers(workspace?.policyReview?.answers.length ? workspace.policyReview.answers : POLICY_TOPICS.map(() => '')); setMessage('') }, [workspace?.id, workspace?.policyReview])
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage('')
    try { await action() } catch (error) { setMessage(String(error)) } finally { setBusy(false) }
  }
  const read = (url: string) => run(async () => { setSource(null); setSource(await window.goga.invoke('security:research', url)) })
  return <div style={{ padding: 16, overflowY: 'auto', borderBottom: '1px solid var(--border)', maxHeight: 440, flexShrink: 0 }}>
    <details open={!workspace}>
      <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Guided Security workflow: learn → select → review → inventory → approved testing → evidence → local draft</summary>
      <p>Begin in practice labs. Public research does not authorize testing. Tool installation and execution adapters are not available in this milestone.</p>
      <label>Research query <input aria-label="Research query" value={query} maxLength={200} onChange={e => setQuery(e.target.value)} /></label>{' '}
      {(['programs', 'disclosures'] as const).map(kind => <button key={kind} disabled={busy || !query.trim()} onClick={() => run(async () => { setSearched(false); setResults([]); setResults(await window.goga.invoke('security:searchResearch', query, kind)); setSearched(true) })}>Find {kind}</button>)}
      {searched && results.length === 0 && <p>No public results returned. Try the directory or Hacktivity source below.</p>}
      {results.map(result => <div key={result.url}><strong>{result.title}</strong><div>{result.url} · Retrieved {result.retrievedAt}</div>{/^https:\/\/hackerone.com\/reports\/\d+$/.test(result.url) && <button disabled={busy} onClick={() => read(result.url)}>Read disclosure</button>}{/^https:\/\/hackerone.com\/[a-z0-9_-]+\/?$/i.test(result.url) && <button onClick={() => onSelectProgram(new URL(result.url).pathname.split('/')[1])}>Use handle for import</button>}<small>Verify current program policy through import before testing.</small></div>)}
      {LEARNING_PATH.map(item => <div key={item.url} style={{ marginBottom: 10 }}>
        <strong>{item.title}</strong> — {item.advice}<br />
        <a href={item.url} onClick={e => { e.preventDefault(); if (!busy) read(item.url) }} style={{ fontSize: 12 }}>{item.url}</a>{' '}
        <button disabled={busy} onClick={() => read(item.url)}>Retrieve public source</button>
      </div>)}
      <label>Public disclosure URL <input aria-label="Public disclosure URL" value={report} onChange={e => setReport(e.target.value)} placeholder="https://hackerone.com/reports/123" /></label>{' '}
      <button disabled={busy || !report.trim()} onClick={() => read(report.trim())}>Read disclosure</button>
      <p>Use the program directory and Hacktivity sources above to find programs and disclosures. JavaScript-only pages may return limited text.</p>
      {source && <article><strong>Source: <a href={source.url} onClick={e => { e.preventDefault(); if (!busy) read(source.url) }}>{source.url}</a></strong><div>Retrieved: {source.retrievedAt}</div><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto' }}>{source.content || 'No readable public text returned.'}</pre></article>}
      <p>Reference paper: not selected. Use the existing document ingestion workflow after choosing a paper; program rules govern testing even when a paper suggests broader techniques.</p>
      <h3>Tool inventory</h3>
      <button disabled={busy} onClick={() => run(async () => setInventory(await window.goga.invoke('security:inventory')))}>Check tools on PATH</button>
      <p>Passive file lookup only. Versions, identity, integrity and tools outside PATH are unverified. No executables are run.</p>
      {inventory && <table style={{ width: '100%', textAlign: 'left' }}><thead><tr><th>Tool</th><th>Presence / location</th><th>Version</th><th>Official source</th></tr></thead><tbody>{inventory.map(tool => <tr key={tool.name}><td>{tool.name}</td><td style={{ overflowWrap: 'anywhere' }}>{tool.status}<br />{tool.location}</td><td>{tool.version}</td><td>{tool.officialSource}</td></tr>)}</tbody></table>}
      <p>Installation recipes will require a reviewed pinned version, official download, verification and explicit destination before installation becomes available.</p>
    </details>
    {workspace?.hackerOne && <details open><summary style={{ cursor: 'pointer', fontWeight: 700 }}>Program policy review</summary>
      <p>Refresh before testing, then record a relevant passage or “not specified — clarify before use” for every topic. Unspecified techniques are not permission. Review expires after 24 hours.</p>
      <button disabled={busy} onClick={() => run(async () => onUpdate(await window.goga.invoke('security:refreshPolicy', workspace.id)))}>Refresh policy and scope</button>
      <p>Source: {workspace.programUrl} · API retrieval: {new Date(workspace.hackerOne.importedAt).toLocaleString()}</p>
      {workspace.policyReview && <p role="status">{workspace.policyReview.changed ? 'Policy or scope changed. Re-read all rules.' : 'No policy change detected at last refresh.'} {workspace.policyReview.reviewedAt ? `Reviewed ${new Date(workspace.policyReview.reviewedAt).toLocaleString()}` : 'Review required.'}</p>}
      <details><summary>Full imported policy and scope instructions</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto' }}>{workspace.programRules}</pre></details>
      {policyChecklist(workspace).map((item, i) => <label key={item.topic} style={{ display: 'block', marginTop: 10 }}>{item.topic}
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{item.detail || 'Consult full policy; no automatic interpretation.'}</div>
        <textarea aria-label={item.topic} value={answers[i] ?? ''} maxLength={4000} onChange={e => setAnswers(old => old.map((a, n) => n === i ? e.target.value : a))} style={{ width: '100%' }} />
      </label>)}
      <button disabled={busy || !workspace.policyReview || answers.some(a => !a.trim())} onClick={() => run(async () => { onUpdate(await window.goga.invoke('security:reviewPolicy', workspace.id, workspace.policyReview!.fingerprint, answers)); setMessage('Review saved. Individual in-scope request approval is still required.') })}>Save reviewed checklist</button>
    </details>}
    {busy && <p role="status">Loading…</p>}{message && <p role="status">{message}</p>}
  </div>
}
