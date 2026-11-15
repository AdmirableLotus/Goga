import React, { useEffect, useState } from 'react'
import type { MemoryEntry } from '@shared/types'
import type { GogaFact } from '@shared/types'
import { PageHeader, Card, Field, EmptyState, Chip } from '../components/ui'

const CATEGORY_TONE: Record<string, 'accent' | 'ok' | 'warn' | undefined> = {
  about_user: 'accent',
  preference: 'ok',
  learned: 'warn',
  event: undefined,
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
    <div className="g-page">
      <div className="g-page-inner">

        <PageHeader
          title="Memory"
          purpose="What Goga has learned about you, and the key-value store he keeps it in."
          actions={<>
            <div className="g-seg" role="group" aria-label="Memory view">
              <button aria-pressed={tab === 'facts'} onClick={() => setTab('facts')}>Learned ({facts.length})</button>
              <button aria-pressed={tab === 'store'} onClick={() => setTab('store')}>Store ({entries.length})</button>
            </div>
            <button className="g-btn g-btn--sm" onClick={loadAll}>Refresh</button>
            {tab === 'facts' && <button className="g-btn g-btn--sm" style={{ color: 'var(--warn)' }} onClick={clearHistory}>Clear history</button>}
          </>}
        />

        {tab === 'facts' && (
          facts.length === 0 ? (
            <EmptyState
              icon="🧠"
              title="Goga hasn't learned anything yet"
              body="Start chatting — he remembers things you tell him about yourself, your preferences, and what he learns from books."
            />
          ) : (
            <Card title={`${facts.length} fact${facts.length === 1 ? '' : 's'}`}>
              {facts.map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                  <Chip tone={CATEGORY_TONE[f.category]}>{f.category.replace('_', ' ')}</Chip>
                  <span style={{ flex: 1, fontSize: 'var(--fs-body)' }}>{f.content}</span>
                  <span className="g-caption g-faint" style={{ flexShrink: 0 }}>{f.source} · {new Date(f.createdAt).toLocaleDateString()}</span>
                  <button className="g-btn g-btn--ghost g-btn--sm" onClick={() => delFact(f.id)} aria-label="Delete fact">✕</button>
                </div>
              ))}
            </Card>
          )
        )}

        {tab === 'store' && (
          <>
            <Card title="Set a value" sub="JSON is parsed; anything else is stored as a string">
              <div className="g-row">
                <Field label="Key"><input className="g-input g-input--sm" value={key} onChange={e => setKey(e.target.value)} placeholder="key" /></Field>
                <Field label="Value"><input className="g-input g-input--lg" value={value} onChange={e => setValue(e.target.value)} placeholder='{"any":"JSON"} or plain text' /></Field>
                <button className="g-btn g-btn--primary" onClick={save} disabled={!key.trim()}>Set</button>
              </div>
            </Card>

            {entries.length === 0 ? (
              <EmptyState icon="🗄️" title="Store is empty" body="Nothing has been written to the key-value store yet. Set a value above, or let Goga write one while he works." />
            ) : (
              <Card title={`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`}>
                {entries.map(e => (
                  <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                    <span className="g-mono" style={{ width: 200, flexShrink: 0, fontWeight: 600 }}>{e.key}</span>
                    <span className="g-caption" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {JSON.stringify(e.value)}
                    </span>
                    <button className="g-btn g-btn--ghost g-btn--sm" onClick={() => delEntry(e.key)} aria-label={`Delete ${e.key}`}>✕</button>
                  </div>
                ))}
              </Card>
            )}
          </>
        )}

      </div>
    </div>
  )
}
