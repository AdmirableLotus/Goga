import React, { useEffect, useState } from 'react'
import type { MemoryEntry } from '@shared/types'
import type { GogaFact } from '@shared/types'

const CATEGORY_COLOR: Record<string, string> = {
  about_user: 'var(--accent)',
  preference: 'var(--success)',
  learned: 'var(--warn)',
  event: 'var(--text-muted)'
}

export default function MemoryPage() {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [facts, setFacts] = useState<GogaFact[]>([])
  const [tab, setTab] = useState<'facts' | 'store'>('facts')
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')

  const loadAll = async () => {
    setEntries(await window.goga.invoke('memory:list'))
    setFacts(await window.goga.invoke('brain:facts'))
  }
  useEffect(() => { loadAll() }, [])

  const save = async () => {
    if (!key.trim()) return
    try { await window.goga.invoke('memory:set', key.trim(), JSON.parse(value)) }
    catch { await window.goga.invoke('memory:set', key.trim(), value) }
    setKey(''); setValue(''); loadAll()
  }

  const delEntry = async (k: string) => { await window.goga.invoke('memory:delete', k); loadAll() }
  const delFact = async (id: string) => { await window.goga.invoke('brain:deleteFact', id); loadAll() }
  const clearHistory = async () => { await window.goga.invoke('brain:clearHistory'); alert('Conversation history cleared.') }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => setTab('facts')} style={{ ...styles.tabBtn, ...(tab === 'facts' ? styles.tabActive : {}) }}>
            🧠 Goga's Memory ({facts.length})
          </button>
          <button onClick={() => setTab('store')} style={{ ...styles.tabBtn, ...(tab === 'store' ? styles.tabActive : {}) }}>
            🗄️ Key-Value Store ({entries.length})
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={loadAll} style={styles.btn}>Refresh</button>
          {tab === 'facts' && <button onClick={clearHistory} style={{ ...styles.btn, color: 'var(--warn)' }}>Clear History</button>}
        </div>
      </div>

      {tab === 'facts' && (
        <div style={styles.list}>
          {facts.length === 0 && (
            <div style={styles.empty}>
              <p style={{ color: 'var(--text-muted)' }}>Goga hasn't learned anything yet.</p>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>
                Start chatting — he'll automatically remember things you tell him about yourself, your preferences, and what he learns from books.
              </p>
            </div>
          )}
          {facts.map(f => (
            <div key={f.id} style={styles.factRow}>
              <span style={{ ...styles.badge, background: CATEGORY_COLOR[f.category] ?? 'var(--surface2)' }}>
                {f.category.replace('_', ' ')}
              </span>
              <span style={{ flex: 1, fontSize: 13 }}>{f.content}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}>
                {f.source} · {new Date(f.createdAt).toLocaleDateString()}
              </span>
              <button onClick={() => delFact(f.id)} style={styles.delBtn}>✕</button>
            </div>
          ))}
        </div>
      )}

      {tab === 'store' && (
        <>
          <div style={styles.form}>
            <input value={key} onChange={e => setKey(e.target.value)} placeholder="Key" style={{ width: 180 }} />
            <input value={value} onChange={e => setValue(e.target.value)} placeholder="Value (JSON or string)" style={{ flex: 1 }} />
            <button onClick={save} style={styles.saveBtn}>Set</button>
          </div>
          <div style={styles.list}>
            {entries.length === 0 && <p style={{ color: 'var(--text-muted)', padding: 20 }}>Store is empty.</p>}
            {entries.map(e => (
              <div key={e.id} style={styles.row}>
                <span style={{ fontWeight: 600, width: 180, flexShrink: 0 }}>{e.key}</span>
                <span style={{ flex: 1, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {JSON.stringify(e.value)}
                </span>
                <button onClick={() => delEntry(e.key)} style={styles.delBtn}>✕</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' },
  toolbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 24px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  tabBtn: { background: 'transparent', color: 'var(--text-muted)', padding: '5px 12px', borderRadius: 'var(--radius)' },
  tabActive: { background: 'var(--surface2)', color: 'var(--text)' },
  btn: { background: 'var(--surface2)', color: 'var(--text)' },
  form: { display: 'flex', gap: 8, padding: '12px 24px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  saveBtn: { background: 'var(--accent)', color: '#fff', fontWeight: 600 },
  list: { flex: 1, overflowY: 'auto' },
  empty: { padding: 32, textAlign: 'center' },
  factRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 24px', borderBottom: '1px solid var(--border)', fontSize: 13 },
  badge: { fontSize: 10, padding: '2px 7px', borderRadius: 10, color: '#fff', flexShrink: 0, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 24px', borderBottom: '1px solid var(--border)' },
  delBtn: { background: 'transparent', color: 'var(--text-muted)', padding: '3px 6px', fontSize: 12, flexShrink: 0 }
}
