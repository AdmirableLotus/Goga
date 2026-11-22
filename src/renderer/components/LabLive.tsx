import React, { useEffect, useRef, useState } from 'react'
import { Card, Chip } from './ui'
import type { LabLiveState, LiveEntry, LiveFrame, LiveKind } from '../../shared/lab'

/**
 * The live view of a Lab run: the log as it streams, and the browser's actual view.
 *
 * Two rules run through this file, and they are the whole point:
 *
 *   1. Nothing is invented. A line exists because main published it; a picture exists because a
 *      real capture came back. When no run is active the view says idle and shows nothing else —
 *      no progress bar, no spinner, no placeholder frame.
 *   2. The picture is what the browser Goga drives is showing, taken from the browser layer.
 *      It is not the user's own Brave window, and the note says so on screen rather than
 *      leaving it to be guessed.
 *
 * The stream arrives on one typed channel, `lab:live`. The page never polls for entries; it
 * asks once for the current state when it opens, then listens.
 */

/** One signal per line, and a colour that matches what kind of thing it is. */
const KIND_STYLE: Record<LiveKind, { label: string; colour: string }> = {
  source: { label: 'read', colour: 'var(--text-muted)' },
  specialist: { label: 'specialist', colour: 'var(--accent)' },
  validator: { label: 'validator', colour: 'var(--accent)' },
  target: { label: 'target', colour: 'var(--warn)' },
  send: { label: 'sent', colour: 'var(--warn)' },
  response: { label: 'came back', colour: 'var(--success)' },
  browser: { label: 'browser', colour: 'var(--text-muted)' },
  verdict: { label: 'verdict', colour: 'var(--success)' },
  stop: { label: 'stopped', colour: 'var(--danger)' },
}

function clock(iso: string): string {
  // HH:MM:SS from the entry's own timestamp. No relative wording, so nothing can read as live
  // when it is not.
  const s = String(iso ?? '')
  return s.length >= 19 ? s.slice(11, 19) : s
}

function ago(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  return `${mins} min ago`
}

export function LabLiveView() {
  const [state, setState] = useState<LabLiveState | null>(null)
  const [frame, setFrame] = useState<LiveFrame | null>(null)
  const [paneNote, setPaneNote] = useState('')
  const logRef = useRef<HTMLDivElement | null>(null)

  // One read on open, then the stream. The read is not a poll: it is what the page shows
  // before the first push arrives.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const s = await window.goga.invoke('lab:liveState')
        if (!alive) return
        setState(s)
        setFrame(s.frame)
      } catch { /* the stream will fill it in */ }
    })()
    // The stream is the live view's only source after the first read. A window without the
    // event bridge (a page rendered outside the app, or a test harness) is not a reason to
    // crash the whole Security page: the view simply stays on what the read returned.
    if (typeof window.goga.on !== 'function') return () => { alive = false }
    const off = window.goga.on('lab:live', event => {
      if (event.type === 'entry') { setState(event.state); setFrame(event.state.frame) }
      else if (event.type === 'frame') { setFrame(event.frame); setState(prev => prev ? { ...prev, frame: event.frame } : prev) }
      else { setState(event.state); setFrame(event.state.frame) }
    })
    return () => { alive = false; off() }
  }, [])

  // Follow the newest line. Only while a run is working, so a finished log stays where the
  // reader left it.
  useEffect(() => {
    if (!state?.active) return
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state?.entries.length, state?.active])

  const grab = async () => {
    setPaneNote('')
    try {
      const r = await window.goga.invoke('lab:capturePane')
      if (!r.ok) { setPaneNote(r.message ?? 'No picture came back.'); return }
      if (r.frame) { setFrame(r.frame); return }
      setPaneNote('The browser returned an empty picture.')
    } catch (e) {
      setPaneNote(`The picture could not be taken: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const active = !!state?.active
  const entries = state?.entries ?? []

  return (
    <Card
      title="Live run"
      sub="What Goga is doing right now, and the browser's actual view — no animation when nothing is running"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <Chip tone={active ? 'accent' : undefined}>{active ? 'working' : 'idle'}</Chip>
        <span className="g-caption" style={{ color: active ? 'var(--text)' : 'var(--text-muted)' }}>
          {state?.status ?? 'Idle — nothing is running.'}
        </span>
        {state?.startedAt && (
          <span className="g-caption g-faint">
            started {clock(state.startedAt)}
            {state.endedAt ? `, ended ${clock(state.endedAt)}` : ''}
          </span>
        )}
      </div>

      {!active && entries.length === 0 && (
        <p className="g-caption g-faint" style={{ margin: '0 0 8px' }}>
          Nothing is running. Start a run and each step will appear here as it happens, one line
          per thing Goga actually did.
        </p>
      )}

      <div
        ref={logRef}
        className="g-inset g-mono"
        style={{
          maxHeight: 260, overflowY: 'auto', fontSize: 'var(--fs-caption)', lineHeight: 1.55,
          padding: 'var(--sp-2) var(--sp-3)', marginBottom: 12,
        }}
      >
        {entries.length === 0
          ? <div className="g-faint">— no entries —</div>
          : entries.map(e => <LogLine key={e.id} entry={e} />)}
      </div>

      {/* The pane: the browser Goga drives, not the user's own window. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span className="g-section-title" style={{ margin: 0 }}>Browser view</span>
        {frame
          ? <Chip tone={frame.live ? 'ok' : undefined}>{frame.live ? 'live' : 'last capture'}</Chip>
          : <Chip>no picture</Chip>}
        <button className="g-btn g-btn--sm" onClick={() => void grab()}>Take a picture now</button>
      </div>

      {frame ? (
        <>
          <div className="g-mono g-caption" style={{ wordBreak: 'break-all', marginBottom: 4 }} title={frame.url}>
            {frame.url.length > 120 ? `${frame.url.slice(0, 120)}…` : (frame.url || '(the page did not report an address)')}
          </div>
          <img
            src={`data:image/png;base64,${frame.base64}`}
            alt="The page Goga's own browser is showing"
            style={{
              width: '100%', maxHeight: 380, objectFit: 'contain', objectPosition: 'top',
              border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--bg-deep)',
            }}
          />
          <p className="g-caption g-faint" style={{ margin: '4px 0 0' }}>
            Taken {clock(frame.capturedAt)} ({ago(frame.capturedAt)}).{frame.live ? '' : ' This is the last real capture from that run, not a live view.'}
          </p>
        </>
      ) : (
        <p className="g-caption g-faint" style={{ margin: 0 }}>
          No picture yet. A picture appears only when Goga has a browser open that it launched
          itself — Firefox or its own Brave window — and takes one from it.
        </p>
      )}

      {paneNote && <p className="g-caption" style={{ color: 'var(--warn)', margin: '6px 0 0' }}>{paneNote}</p>}

      <p className="g-caption g-faint" style={{ marginTop: 8 }}>
        This shows the browser Goga drives, in its own profile. It is not your own Brave window:
        Goga does not attach to that one, so nothing here is a picture of your everyday browsing.
      </p>
    </Card>
  )
}

function LogLine({ entry }: { entry: LiveEntry }) {
  const style = KIND_STYLE[entry.kind] ?? { label: entry.kind, colour: 'var(--text-muted)' }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '1px 0' }}>
      <span className="g-faint" style={{ flex: '0 0 auto' }}>{clock(entry.at)}</span>
      <span style={{ flex: '0 0 auto', color: style.colour, minWidth: 78 }}>{style.label}</span>
      <span style={{ flex: '1 1 auto', wordBreak: 'break-word' }}>
        {entry.label}
        {entry.detail && <span className="g-faint"> — {entry.detail}</span>}
      </span>
    </div>
  )
}
