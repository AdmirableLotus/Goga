import React, { useState, useEffect } from 'react'
import type { SecurityWorkspace, SecurityFinding, EvidenceEntry } from '@shared/types'

const SEV_COLOR: Record<string, string> = {
  info: 'var(--text-muted)', low: 'var(--success)',
  medium: 'var(--warn)', high: 'var(--danger)', critical: '#ff4444'
}
const STATUS_COLOR: Record<string, string> = {
  draft: 'var(--text-muted)', submitted: 'var(--accent)',
  triaged: 'var(--warn)', resolved: 'var(--success)'
}

type Section = 'scope' | 'findings' | 'evidence' | 'audit'

const EMPTY_WS = {
  program: '', programUrl: '',
  authorizedAssets: [] as string[], excludedAssets: [] as string[],
  allowedTechniques: [] as string[], prohibitedTechniques: [] as string[],
  rateLimit: '', programRules: '', testNotes: ''
}

export default function SecurityPage() {
  const [workspaces, setWorkspaces] = useState<SecurityWorkspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selected, setSelected] = useState<SecurityWorkspace | null>(null)
  const [section, setSection] = useState<Section>('scope')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ ...EMPTY_WS })
  const [scopeTest, setScopeTest] = useState('')
  const [scopeResult, setScopeResult] = useState<{ inScope: boolean; reason: string } | null>(null)
  const [newFinding, setNewFinding] = useState<Partial<SecurityFinding> | null>(null)
  const [newNote, setNewNote] = useState('')
  const [saved, setSaved] = useState(false)

  const load = async () => {
    const [all, active] = await Promise.all([
      window.goga.invoke('security:list'),
      window.goga.invoke('security:getActive')
    ])
    setWorkspaces(all)
    setActiveId(active?.id ?? null)
    if (selected) {
      const fresh = all.find(w => w.id === selected.id)
      if (fresh) setSelected(fresh)
    }
  }

  useEffect(() => { load() }, [])

  const activate = async (id: string | null) => {
    await window.goga.invoke('security:setActive', id)
    setActiveId(id)
  }

  const selectWs = (ws: SecurityWorkspace) => {
    setSelected(ws)
    setCreating(false)
    setSection('scope')
    setScopeResult(null)
  }

  const createWs = async () => {
    const ws = await window.goga.invoke('security:create', draft)
    setDraft({ ...EMPTY_WS })
    setCreating(false)
    await load()
    setSelected(ws)
  }

  const deleteWs = async (id: string) => {
    if (!confirm('Delete this workspace and all its findings?')) return
    await window.goga.invoke('security:delete', id)
    if (selected?.id === id) setSelected(null)
    await load()
  }

  const saveNotes = async () => {
    if (!selected) return
    await window.goga.invoke('security:update', selected.id, { testNotes: selected.testNotes, programRules: selected.programRules })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    await load()
  }

  const testScope = async () => {
    if (!selected || !scopeTest.trim()) return
    const r = await window.goga.invoke('security:checkScope', selected.id, scopeTest.trim())
    setScopeResult(r)
  }

  const addFinding = async () => {
    if (!selected || !newFinding?.title) return
    await window.goga.invoke('security:addFinding', selected.id, {
      title: newFinding.title ?? '',
      severity: newFinding.severity ?? 'medium',
      target: newFinding.target ?? '',
      description: newFinding.description ?? '',
      steps: newFinding.steps ?? '',
      evidenceIds: [],
      status: 'draft'
    })
    setNewFinding(null)
    await load()
  }

  const addNote = async () => {
    if (!selected || !newNote.trim()) return
    await window.goga.invoke('security:addEvidence', selected.id, {
      type: 'note', label: newNote.slice(0, 60), content: newNote
    })
    setNewNote('')
    await load()
  }

  const updateAssets = async (field: 'authorizedAssets' | 'excludedAssets', raw: string) => {
    if (!selected) return
    const arr = raw.split('\n').map(s => s.trim()).filter(Boolean)
    const updated = await window.goga.invoke('security:update', selected.id, { [field]: arr })
    setSelected(updated)
  }

  return (
    <div style={styles.container}>
      {/* Sidebar */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>🔐 Security</span>
          <button onClick={() => { setCreating(true); setSelected(null) }} style={styles.smallBtn}>+ New</button>
        </div>

        {workspaces.length === 0 && !creating && (
          <p style={{ color: 'var(--text-muted)', fontSize: 12, padding: '12px 16px' }}>
            No workspaces yet. Create one to start a HackerOne or authorized security engagement.
          </p>
        )}

        {workspaces.map(ws => (
          <div
            key={ws.id}
            onClick={() => selectWs(ws)}
            style={{ ...styles.wsItem, ...(selected?.id === ws.id ? styles.wsItemActive : {}) }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ws.program}
              </span>
              {activeId === ws.id && <span style={{ color: 'var(--success)', fontSize: 10, marginLeft: 4 }}>● ACTIVE</span>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {ws.findings.length} finding{ws.findings.length !== 1 ? 's' : ''} · {ws.authorizedAssets.length} asset{ws.authorizedAssets.length !== 1 ? 's' : ''}
            </div>
          </div>
        ))}
      </div>

      {/* Main content */}
      <div style={styles.main}>
        {/* Create form */}
        {creating && (
          <div style={styles.createForm}>
            <div style={styles.toolbar}>
              <span style={{ fontWeight: 600 }}>New Security Workspace</span>
              <button onClick={() => setCreating(false)} style={styles.smallBtn}>Cancel</button>
            </div>
            <div style={styles.formBody}>
              <Field label="Program name"><input value={draft.program} onChange={e => setDraft(d => ({ ...d, program: e.target.value }))} placeholder="Acme Corp Bug Bounty" style={{ width: 300 }} /></Field>
              <Field label="Program URL"><input value={draft.programUrl} onChange={e => setDraft(d => ({ ...d, programUrl: e.target.value }))} placeholder="https://hackerone.com/acme" style={{ width: 300 }} /></Field>
              <Field label="Authorized assets (one per line)">
                <textarea
                  value={draft.authorizedAssets.join('\n')}
                  onChange={e => setDraft(d => ({ ...d, authorizedAssets: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }))}
                  placeholder={'*.acme.com\napi.acme.com\n10.0.0.0/8'}
                  style={styles.textarea}
                />
              </Field>
              <Field label="Excluded assets (one per line)">
                <textarea
                  value={draft.excludedAssets.join('\n')}
                  onChange={e => setDraft(d => ({ ...d, excludedAssets: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }))}
                  placeholder={'admin.acme.com\nlegacy.acme.com'}
                  style={styles.textarea}
                />
              </Field>
              <Field label="Allowed techniques">
                <input value={draft.allowedTechniques.join(', ')} onChange={e => setDraft(d => ({ ...d, allowedTechniques: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} placeholder="recon, web-app-testing, api-testing" style={{ width: 400 }} />
              </Field>
              <Field label="Prohibited techniques">
                <input value={draft.prohibitedTechniques.join(', ')} onChange={e => setDraft(d => ({ ...d, prohibitedTechniques: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} placeholder="dos, social-engineering" style={{ width: 400 }} />
              </Field>
              <Field label="Rate limit"><input value={draft.rateLimit} onChange={e => setDraft(d => ({ ...d, rateLimit: e.target.value }))} placeholder="max 10 req/sec" style={{ width: 200 }} /></Field>
              <div style={{ marginTop: 16 }}>
                <button onClick={createWs} disabled={!draft.program} style={styles.primaryBtn}>Create Workspace</button>
              </div>
            </div>
          </div>
        )}

        {/* Workspace detail */}
        {selected && !creating && (
          <>
            <div style={styles.toolbar}>
              <div>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{selected.program}</span>
                {selected.programUrl && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 10 }}>{selected.programUrl}</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {activeId === selected.id
                  ? <button onClick={() => activate(null)} style={{ ...styles.smallBtn, color: 'var(--success)' }}>● Deactivate</button>
                  : <button onClick={() => activate(selected.id)} style={{ ...styles.smallBtn, color: 'var(--accent)' }}>Activate</button>
                }
                <button onClick={() => deleteWs(selected.id)} style={{ ...styles.smallBtn, color: 'var(--danger)' }}>Delete</button>
              </div>
            </div>

            {activeId === selected.id && (
              <div style={styles.activeBanner}>
                ⚡ This workspace is ACTIVE — Goga will enforce scope for all autonomous actions
              </div>
            )}

            {/* Section tabs */}
            <div style={styles.sectionTabs}>
              {(['scope', 'findings', 'evidence', 'audit'] as Section[]).map(s => (
                <button key={s} onClick={() => setSection(s)}
                  style={{ ...styles.sectionTab, ...(section === s ? styles.sectionTabActive : {}) }}>
                  {s === 'scope' ? '🎯 Scope' : s === 'findings' ? `🐛 Findings (${selected.findings.length})` : s === 'evidence' ? `📎 Evidence (${selected.evidence.length})` : `📋 Audit (${selected.auditLog.length})`}
                </button>
              ))}
            </div>

            <div style={styles.sectionBody}>
              {/* SCOPE */}
              {section === 'scope' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', gap: 16 }}>
                    <div style={{ flex: 1 }}>
                      <div style={styles.label}>Authorized Assets</div>
                      <textarea
                        defaultValue={selected.authorizedAssets.join('\n')}
                        onBlur={e => updateAssets('authorizedAssets', e.target.value)}
                        style={{ ...styles.textarea, height: 120 }}
                        placeholder="*.acme.com&#10;api.acme.com&#10;10.0.0.0/8"
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={styles.label}>Excluded Assets</div>
                      <textarea
                        defaultValue={selected.excludedAssets.join('\n')}
                        onBlur={e => updateAssets('excludedAssets', e.target.value)}
                        style={{ ...styles.textarea, height: 120 }}
                        placeholder="admin.acme.com&#10;legacy.acme.com"
                      />
                    </div>
                  </div>

                  <div>
                    <div style={styles.label}>Test Scope</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input value={scopeTest} onChange={e => setScopeTest(e.target.value)} onKeyDown={e => e.key === 'Enter' && testScope()} placeholder="Enter a target to check (domain, IP, URL)…" style={{ flex: 1 }} />
                      <button onClick={testScope} style={styles.primaryBtn}>Check</button>
                    </div>
                    {scopeResult && (
                      <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 'var(--radius)', background: scopeResult.inScope ? 'rgba(82,201,122,0.1)' : 'rgba(224,82,82,0.1)', border: `1px solid ${scopeResult.inScope ? 'var(--success)' : 'var(--danger)'}`, fontSize: 13 }}>
                        <span style={{ color: scopeResult.inScope ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>
                          {scopeResult.inScope ? '✓ IN SCOPE' : '✗ OUT OF SCOPE'}
                        </span>
                        <span style={{ color: 'var(--text-muted)', marginLeft: 10 }}>{scopeResult.reason}</span>
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 16 }}>
                    <div style={{ flex: 1 }}>
                      <div style={styles.label}>Allowed Techniques</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {selected.allowedTechniques.map(t => <Tag key={t} text={t} color="var(--success)" />)}
                        {selected.allowedTechniques.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>None specified</span>}
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={styles.label}>Prohibited Techniques</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {selected.prohibitedTechniques.map(t => <Tag key={t} text={t} color="var(--danger)" />)}
                        {selected.prohibitedTechniques.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>None specified</span>}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div style={styles.label}>Program Rules</div>
                    <textarea
                      value={selected.programRules}
                      onChange={e => setSelected(s => s ? { ...s, programRules: e.target.value } : s)}
                      style={{ ...styles.textarea, height: 80 }}
                      placeholder="Paste program rules here…"
                    />
                  </div>
                  <div>
                    <div style={styles.label}>Test Notes</div>
                    <textarea
                      value={selected.testNotes}
                      onChange={e => setSelected(s => s ? { ...s, testNotes: e.target.value } : s)}
                      style={{ ...styles.textarea, height: 80 }}
                      placeholder="Your notes, recon findings, ideas…"
                    />
                  </div>
                  <button onClick={saveNotes} style={styles.primaryBtn}>{saved ? '✓ Saved' : 'Save Notes'}</button>
                </div>
              )}

              {/* FINDINGS */}
              {section === 'findings' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <button onClick={() => setNewFinding({ severity: 'medium', status: 'draft' })} style={styles.primaryBtn}>+ New Finding</button>

                  {newFinding && (
                    <div style={styles.card}>
                      <div style={styles.label}>New Finding</div>
                      <Field label="Title"><input value={newFinding.title ?? ''} onChange={e => setNewFinding(f => ({ ...f, title: e.target.value }))} style={{ width: 400 }} /></Field>
                      <Field label="Target"><input value={newFinding.target ?? ''} onChange={e => setNewFinding(f => ({ ...f, target: e.target.value }))} style={{ width: 300 }} placeholder="affected.domain.com" /></Field>
                      <Field label="Severity">
                        <select value={newFinding.severity ?? 'medium'} onChange={e => setNewFinding(f => ({ ...f, severity: e.target.value as SecurityFinding['severity'] }))} style={styles.select}>
                          {['info', 'low', 'medium', 'high', 'critical'].map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </Field>
                      <Field label="Description">
                        <textarea value={newFinding.description ?? ''} onChange={e => setNewFinding(f => ({ ...f, description: e.target.value }))} style={{ ...styles.textarea, width: 500 }} />
                      </Field>
                      <Field label="Steps to reproduce">
                        <textarea value={newFinding.steps ?? ''} onChange={e => setNewFinding(f => ({ ...f, steps: e.target.value }))} style={{ ...styles.textarea, width: 500 }} />
                      </Field>
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button onClick={addFinding} disabled={!newFinding.title} style={styles.primaryBtn}>Save Finding</button>
                        <button onClick={() => setNewFinding(null)} style={styles.smallBtn}>Cancel</button>
                      </div>
                    </div>
                  )}

                  {selected.findings.length === 0 && !newFinding && (
                    <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No findings yet. Add one manually or let Goga discover issues during testing.</p>
                  )}

                  {[...selected.findings].reverse().map(f => (
                    <div key={f.id} style={styles.card}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <span style={{ fontWeight: 600 }}>{f.title}</span>
                          <span style={{ marginLeft: 10, fontSize: 11, color: SEV_COLOR[f.severity], textTransform: 'uppercase', fontWeight: 700 }}>{f.severity}</span>
                          <span style={{ marginLeft: 10, fontSize: 11, color: STATUS_COLOR[f.status] }}>{f.status}</span>
                        </div>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{f.target}</span>
                      </div>
                      {f.description && <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>{f.description.slice(0, 300)}{f.description.length > 300 ? '…' : ''}</p>}
                    </div>
                  ))}
                </div>
              )}

              {/* EVIDENCE */}
              {section === 'evidence' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input value={newNote} onChange={e => setNewNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && addNote()} placeholder="Add a note or paste text evidence…" style={{ flex: 1 }} />
                    <button onClick={addNote} disabled={!newNote.trim()} style={styles.primaryBtn}>Add Note</button>
                  </div>

                  {selected.evidence.length === 0 && (
                    <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No evidence yet. Goga automatically saves screenshots and request/response data during testing.</p>
                  )}

                  {[...selected.evidence].reverse().map(e => (
                    <div key={e.id} style={styles.card}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{e.label}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{e.type} · {new Date(e.createdAt).toLocaleString()}</span>
                      </div>
                      {e.type === 'screenshot'
                        ? <img src={`data:image/png;base64,${e.content}`} alt={e.label} style={{ maxWidth: '100%', borderRadius: 4, border: '1px solid var(--border)' }} />
                        : <pre style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{e.content.slice(0, 600)}{e.content.length > 600 ? '…' : ''}</pre>
                      }
                    </div>
                  ))}
                </div>
              )}

              {/* AUDIT LOG */}
              {section === 'audit' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {selected.auditLog.length === 0 && (
                    <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No audit entries yet. Every tool call Goga makes while this workspace is active will be logged here.</p>
                  )}
                  {[...selected.auditLog].reverse().slice(0, 500).map(entry => (
                    <div key={entry.id} style={{ ...styles.auditRow, borderLeft: `3px solid ${entry.inScope ? 'var(--success)' : 'var(--danger)'}` }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11, width: 80, flexShrink: 0 }}>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                      <span style={{ color: 'var(--accent)', width: 160, flexShrink: 0, fontSize: 12 }}>{entry.tool}</span>
                      <span style={{ color: 'var(--text-muted)', width: 180, flexShrink: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.target || '—'}</span>
                      <span style={{ flex: 1, fontSize: 12, color: entry.result === 'success' ? 'var(--success)' : 'var(--danger)' }}>{entry.result}</span>
                      {!entry.inScope && <span style={{ color: 'var(--danger)', fontSize: 11, fontWeight: 700 }}>OUT OF SCOPE</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {!selected && !creating && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', flexDirection: 'column', gap: 12 }}>
            <span style={{ fontSize: 32 }}>🔐</span>
            <span>Select a workspace or create a new one</span>
            <span style={{ fontSize: 12, maxWidth: 400, textAlign: 'center' }}>
              Security workspaces let you define authorized scope for HackerOne or other bug bounty programs. Goga will enforce scope boundaries during autonomous testing.
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ width: 180, color: 'var(--text-muted)', flexShrink: 0, paddingTop: 6, fontSize: 13 }}>{label}</span>
      {children}
    </div>
  )
}

function Tag({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ background: 'var(--surface)', border: `1px solid ${color}`, color, borderRadius: 4, padding: '2px 8px', fontSize: 11 }}>
      {text}
    </span>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container:      { display: 'flex', flex: 1, overflow: 'hidden' },
  sidebar:        { width: 220, background: 'var(--surface)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflowY: 'auto' },
  sidebarHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)' },
  wsItem:         { padding: '10px 16px', cursor: 'pointer', borderBottom: '1px solid var(--border)' },
  wsItemActive:   { background: 'var(--surface2)' },
  main:           { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  toolbar:        { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  activeBanner:   { background: 'rgba(82,201,122,0.08)', borderBottom: '1px solid var(--success)', padding: '6px 20px', fontSize: 12, color: 'var(--success)' },
  sectionTabs:    { display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', flexShrink: 0 },
  sectionTab:     { background: 'transparent', color: 'var(--text-muted)', padding: '8px 16px', borderRadius: 0, fontSize: 13 },
  sectionTabActive: { background: 'var(--surface2)', color: 'var(--text)', borderBottom: '2px solid var(--accent)' },
  sectionBody:    { flex: 1, overflowY: 'auto', padding: 20 },
  createForm:     { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  formBody:       { flex: 1, overflowY: 'auto', padding: 20 },
  card:           { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 14 },
  auditRow:       { display: 'flex', gap: 12, padding: '6px 12px', borderBottom: '1px solid var(--border)', alignItems: 'center' },
  label:          { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--accent)', fontWeight: 700, marginBottom: 6 },
  textarea:       { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)', fontFamily: 'monospace', fontSize: 12, padding: '8px 10px', width: '100%', height: 80, resize: 'vertical' },
  select:         { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)', padding: '6px 10px' },
  smallBtn:       { background: 'var(--surface2)', color: 'var(--text)', padding: '4px 10px', fontSize: 12 },
  primaryBtn:     { background: 'var(--accent)', color: '#fff', fontWeight: 600 }
}
