import React, { useCallback, useEffect, useState } from 'react'
import type { PersonaState } from '../../shared/persona'
import { Card, Field, EmptyState, Alert, Chip } from '../components/ui'

/**
 * The persona editor, shown inside Settings.
 *
 * Two parts, kept visibly separate because they are different things:
 *   1. the user's own words about how Goga should behave, which they can edit and save here;
 *   2. what Goga remembers about them, which is a list they can read and delete from.
 *
 * The identity text below the box is the exact text every prompt starts from, generated in
 * main, shown read-only so nobody has to guess what Goga was told.
 */

const CATEGORY_TONE: Record<string, 'accent' | 'ok' | 'warn' | undefined> = {
  about_user: 'accent', preference: 'ok', learned: 'warn', event: undefined,
}

export default function PersonaEditor() {
  const [state, setState] = useState<PersonaState | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const s = await window.goga.invoke('persona:state')
      setState(s)
      setText(s.personality)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function save() {
    setBusy(true); setError(''); setNotice('')
    try {
      const s = await window.goga.invoke('persona:save', text)
      setState(s)
      setText(s.personality)
      setNotice('Saved. Chat, voice, Telegram and tasks all start from this from now on.')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function forget(id: string) {
    try {
      await window.goga.invoke('persona:forgetFact', id)
      setNotice('Forgotten.')
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const max = state?.maxChars ?? 1500

  return (
    <>
      <Card
        title="Persona"
        sub="How Goga is to be, in your own words — and what he remembers about you"
        actions={<button className="g-btn g-btn--primary g-btn--sm" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save persona'}</button>}
      >
        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="ok">{notice}</Alert>}

        <Field
          label={<>Personality notes ({text.length}/{max})</>}
          hint="Used in chat, voice, Telegram and every task. Honesty and safety limits come first and cannot be edited away here."
        >
          <textarea
            className="g-input"
            style={{ width: '100%', minHeight: 120, fontFamily: 'inherit', resize: 'vertical' }}
            value={text}
            maxLength={max}
            onChange={e => setText(e.target.value.slice(0, max))}
            placeholder='e.g. "Be blunt with me about risk. Call me Ace. Remind me to check the live account before I close the laptop."'
          />
        </Field>

        <div className="g-row">
          <button className="g-btn g-btn--primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save persona'}</button>
          <button className="g-btn" onClick={() => setText('')} disabled={busy || !text}>Clear</button>
          <span className="g-caption g-faint">Saved to Goga&apos;s own settings on this PC. Nothing is sent anywhere.</span>
        </div>

        {state && (
          <details className="g-details">
            <summary>Show the exact identity text every prompt starts from</summary>
            <pre className="g-inset g-mono" style={{ whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 11.5 }}>{state.identity}</pre>
          </details>
        )}
      </Card>

      <Card
        title="What Goga remembers"
        sub="Facts he has kept about you and what he has learned"
        actions={<Chip tone={state?.facts.length ? 'accent' : undefined}>{state?.facts.length ?? 0} remembered</Chip>}
      >
        {!state || state.facts.length === 0 ? (
          <EmptyState
            icon="🧠"
            title="Nothing remembered yet"
            body="As you talk to Goga he keeps facts worth keeping — what you prefer, what you are working on, what he got wrong. They appear here, and you can delete any of them."
          />
        ) : (
          state.facts.map(f => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
              <Chip tone={CATEGORY_TONE[f.category]}>{f.category.replace('_', ' ')}</Chip>
              <span style={{ flex: 1, fontSize: 'var(--fs-body)' }}>{f.content}</span>
              <span className="g-caption g-faint" style={{ flexShrink: 0 }}>{f.source} · {new Date(f.createdAt).toLocaleDateString()}</span>
              <button className="g-btn g-btn--ghost g-btn--sm" onClick={() => void forget(f.id)} aria-label="Forget this fact">✕</button>
            </div>
          ))
        )}
        <p className="g-caption g-faint" style={{ marginTop: 8 }}>
          Anything deleted here is gone: Goga will not recall it in a later conversation.
        </p>
      </Card>
    </>
  )
}
