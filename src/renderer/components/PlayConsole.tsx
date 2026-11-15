import React, { useCallback, useEffect, useState } from 'react'
import type { PlayBaseline, PlayConnectionView, PlayState, PlaySubmissionView } from '../../shared/business'
import { PageHeader, Card, Field, EmptyState, Alert, Chip } from './ui'

/**
 * The Google Play Console card.
 *
 * Two halves. The first is the connection: a downloaded service account JSON, its shape
 * checked, stored through the OS keychain, and then tested against Play so the page can say
 * what is actually wrong. The second is the baseline and the upload: all three apps Play
 * shows, the release on each track, and a form that queues one .aab for one track with the
 * notes the user writes. Nothing uploads until that exact entry is approved in the queue above.
 *
 * The private key never reaches this file. The page is given the service account's email and
 * the project only.
 */

const when = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace('T', ' ')}Z` : '—')

/** The apps the user has named. The third is whatever else Play returns. */
const NAMED_APPS: { packageName: string; name: string }[] = [
  { packageName: 'com.base6a76745e0296d6adfc52539f.app', name: 'Only3' },
  { packageName: 'com.base692cc10480cefa8d26ea7080.app', name: 'Dear Loved One' },
]

/** The next free version code for one app, from Play's own numbers. */
function nextCodeFor(baseline: PlayBaseline, packageName: string): string | null {
  const app = baseline.apps.find(a => a.packageName === packageName)
  if (!app) return null
  let highest = -1
  for (const t of app.tracks) for (const r of t.releases) for (const c of r.versionCodes) {
    const n = Number(c)
    if (Number.isFinite(n) && n > highest) highest = n
  }
  return highest < 0 ? null : String(highest + 1)
}

const CONNECTION_TONE: Record<PlayConnectionView['state'], 'ok' | 'warn' | 'bad' | undefined> = {
  connected: 'ok',
  'not-connected': undefined,
  'invalid-key': 'bad',
  'access-denied': 'warn',
}

const STATE_LABEL: Record<PlayConnectionView['state'], string> = {
  connected: 'connected',
  'not-connected': 'not connected',
  'invalid-key': 'invalid key',
  'access-denied': 'key valid, Play access denied',
}

export default function PlayConsole({ state, busy, onChanged, notify }: {
  state: PlayState
  busy: boolean
  onChanged: () => void
  notify: (message: string, kind: 'ok' | 'error') => void
}) {
  const [keyPath, setKeyPath] = useState('')
  const [pasted, setPasted] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [working, setWorking] = useState('')
  const [pkg, setPkg] = useState('')
  const [track, setTrack] = useState('internal')
  const [aabPath, setAabPath] = useState('')
  const [versionCode, setVersionCode] = useState('')
  const [notes, setNotes] = useState('')
  const [language, setLanguage] = useState('en-US')

  const c = state.connection
  const baseline: PlayBaseline = state.baseline

  // Offer the highest known package and its next free version code, without overwriting typing.
  useEffect(() => {
    if (pkg || !baseline.apps.length) return
    const only3 = baseline.apps.find(a => a.packageName === NAMED_APPS[0].packageName)
    setPkg((only3 ?? baseline.apps[0]).packageName)
  }, [baseline.apps, pkg])

  useEffect(() => {
    if (!pkg) return
    const next = nextCodeFor(baseline, pkg) ?? state.suggestedVersionCode
    if (next) setVersionCode(next)
  }, [pkg, baseline, state.suggestedVersionCode])

  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setWorking(label)
    try {
      return await fn()
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
      return null
    } finally {
      setWorking('')
    }
  }, [notify])

  async function pickKey() {
    const r = await run('pick-key', () => window.goga.invoke('business:playPickKey'))
    if (!r || r.canceled || !r.path) return
    setKeyPath(r.path)
    const stored = await run('use-key', () => window.goga.invoke('business:playUseKeyFile', r.path as string))
    if (!stored) return
    notify(stored.message, stored.ok ? 'ok' : 'error')
    onChanged()
  }

  async function usePasted() {
    const text = pasted
    setPasted('')
    const stored = await run('paste-key', () => window.goga.invoke('business:playPasteKey', text))
    if (!stored) return
    notify(stored.message, stored.ok ? 'ok' : 'error')
    onChanged()
  }

  async function checkAccess() {
    const s = await run('check', () => window.goga.invoke('business:playCheckAccess'))
    if (!s) return
    notify(s.connection.detail, s.connection.state === 'connected' ? 'ok' : 'error')
    onChanged()
  }

  async function readBaseline() {
    const b = await run('baseline', () => window.goga.invoke('business:playReadBaseline'))
    if (!b) return
    notify(b.error ? b.error.message : b.note, b.error ? 'error' : 'ok')
    onChanged()
  }

  async function pickBundle() {
    const r = await run('pick-bundle', () => window.goga.invoke('business:playPickBundle'))
    if (!r || r.canceled || !r.path) return
    setAabPath(r.path)
  }

  async function prepareUpload() {
    const r = await run('prepare-upload', () => window.goga.invoke('business:playPrepareUpload', {
      packageName: pkg.trim(), track, aabPath: aabPath.trim(),
      versionCode: versionCode.trim(), releaseNotes: notes, language,
    }))
    if (!r) return
    notify(r.message, r.ok ? 'ok' : 'error')
    if (r.ok) { setNotes(''); onChanged() }
  }

  const busyNow = busy || !!working

  return (
    <>
      <Card
        title="Google Play Console"
        sub="A service account key you create, and the uploads it is allowed to make"
        tone={c.state === 'connected' ? 'accent' : undefined}
        actions={<Chip tone={CONNECTION_TONE[c.state]}>{STATE_LABEL[c.state]}</Chip>}
      >
        {/* ── connection state ── */}
        {c.state === 'not-connected' ? (
          <EmptyState
            icon="🔑"
            title="No key yet"
            body={<div style={{ textAlign: 'left', maxWidth: '72ch', margin: '0 auto' }}>
              <p style={{ marginTop: 0 }}>
                Goga needs a Google <strong>service account key</strong> — a JSON file you create yourself. It signs the
                requests; it is not your Google password, and it cannot do anything in Play until you invite it there.
              </p>
              <ol style={{ paddingLeft: 20, margin: '8px 0' }}>
                <li>Open <span className="g-mono">console.cloud.google.com/iam-admin/serviceaccounts</span>, pick or create a project, then <strong>Create service account</strong>. Name it so it is obviously for Play.</li>
                <li>On that service account: <strong>Keys → Add key → Create new key → JSON → Create</strong>. The .json downloads. Keep it; do not email it to yourself.</li>
                <li>Enable the API: <span className="g-mono">console.cloud.google.com/apis/library/androidpublisher.googleapis.com</span> → <strong>Enable</strong>.</li>
                <li>
                  Invite the service account’s email address in Play Console:{' '}
                  <span className="g-mono">play.google.com/console/u/1/developers/7935784357221763213/users-and-permissions</span>{' '}
                  → <strong>Invite new users</strong>. Under App permissions grant: view app information (read-only),
                  edit and delete draft apps, release to production / exclude devices / use Play App Signing, release to
                  testing tracks, manage testing tracks and edit tester lists, and manage store presence.
                </li>
                <li>Come back and point Goga at the downloaded file below.</li>
              </ol>
              <p className="g-caption g-faint">
                Steps 1–5 are yours, in your accounts. Goga does none of them for you and never signs in as you.
              </p>
            </div>}
          />
        ) : (
          <div className="g-inset">
            <div className="g-row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 'var(--fs-body)' }}>
                  <strong>{c.serviceAccountEmail}</strong>
                </div>
                <div className="g-caption">project {c.projectId}{c.keyId ? ` · key ${c.keyId.slice(0, 8)}…` : ''}</div>
              </div>
              <Chip tone={CONNECTION_TONE[c.state]}>{STATE_LABEL[c.state]}</Chip>
            </div>
            <p className="g-caption" style={{ marginTop: 6 }}>{c.detail}</p>
            {c.checkedAt && <p className="g-caption g-faint">Last checked {when(c.checkedAt)}</p>}
            {c.state !== 'connected' && c.fixUrl && (
              <p className="g-caption">
                Fix it at <span className="g-mono">{c.fixUrl}</span> ({c.fixLabel}).
              </p>
            )}
          </div>
        )}

        <div className="g-row" style={{ marginTop: 10 }}>
          <button className="g-btn" disabled={busyNow} onClick={() => void pickKey()}>
            {working === 'pick-key' || working === 'use-key' ? 'Reading the file…' : 'Choose the JSON key file'}
          </button>
          <button className="g-btn g-btn--sm" disabled={busyNow || c.state === 'not-connected'} onClick={() => void checkAccess()}>
            {working === 'check' ? 'Asking Google…' : 'Check access'}
          </button>
          <button className="g-btn g-btn--ghost g-btn--sm" disabled={busyNow} onClick={() => setShowPaste(v => !v)}>
            {showPaste ? 'Hide paste box' : 'Paste the key instead'}
          </button>
          {c.state !== 'not-connected' && (
            <button
              className="g-btn g-btn--ghost g-btn--sm"
              disabled={busyNow}
              onClick={() => void run('forget', () => window.goga.invoke('business:playForget')).then(() => { notify('Key removed from this machine.', 'ok'); onChanged() })}
            >
              Remove the key
            </button>
          )}
        </div>
        {keyPath && <p className="g-caption g-mono">Read from {keyPath}</p>}

        {showPaste && (
          <div className="g-inset" style={{ marginTop: 8 }}>
            <p className="g-caption">
              Pasting the whole key file works, but the file is safer: the contents stay out of this window. It is stored
              encrypted either way, and never written anywhere in plain text.
            </p>
            <textarea
              className="g-input g-mono"
              style={{ width: '100%', minHeight: 110, fontSize: 11 }}
              placeholder='{ "type": "service_account", "project_id": … }'
              value={pasted}
              onChange={e => setPasted(e.target.value)}
            />
            <button className="g-btn g-btn--sm" disabled={busyNow || !pasted.trim()} onClick={() => void usePasted()}>
              Store this key
            </button>
          </div>
        )}

        {c.state === 'access-denied' && (
          <Alert kind="error">
            The key is a real service account, but it has no access to your developer account. Invite{' '}
            <strong>{c.serviceAccountEmail}</strong> at{' '}
            <span className="g-mono">{c.fixUrl}</span> with the release permissions listed above, then press Check access
            again. A service account gets nothing until it is invited — being created in Google Cloud is not enough.
          </Alert>
        )}
      </Card>

      {/* ── baseline ── */}
      <Card
        title="What Play shows"
        sub="Read-only: every app this key can see, and the release on each track"
        actions={
          <button className="g-btn g-btn--sm" disabled={busyNow || c.state === 'not-connected'} onClick={() => void readBaseline()}>
            {working === 'baseline' ? 'Reading Play…' : 'Read from Play'}
          </button>
        }
      >
        {!baseline.readAt && !baseline.error && (
          <EmptyState
            icon="📱"
            title="Nothing read yet"
            body="Press Read from Play. Goga opens a Play edit, lists the apps and their tracks, and deletes the edit again so nothing on your account changes."
          />
        )}
        {baseline.error && (
          <Alert kind={baseline.apps.length ? 'info' : 'error'}>
            {baseline.error.message}
            {baseline.error.fixUrl && <> Open <span className="g-mono">{baseline.error.fixUrl}</span>.</>}
            {baseline.error.detail && <div className="g-caption g-faint" style={{ marginTop: 4 }}>{baseline.error.detail}</div>}
          </Alert>
        )}
        {baseline.readAt && (
          <>
            <p className="g-caption">{baseline.note} Read {when(baseline.readAt)}.</p>
            {baseline.apps.map(app => (
              <div key={app.packageName} className="g-inset" style={{ marginBottom: 8 }}>
                <div className="g-row" style={{ justifyContent: 'space-between' }}>
                  <strong>{app.displayName}</strong>
                  <span className="g-mono g-caption">{app.packageName}</span>
                </div>
                {app.error && <p className="g-caption" style={{ color: 'var(--danger)' }}>{app.error}</p>}
                {app.tracks.length === 0 && !app.error && (
                  <p className="g-caption g-faint">No track returned a release.</p>
                )}
                {app.tracks.length > 0 && (
                  <table className="g-table" style={{ marginTop: 6 }}>
                    <thead><tr>{['Track', 'Status', 'Version codes', 'Release notes'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                    <tbody>
                      {app.tracks.map(t => {
                        const r = t.releases[0]
                        return (
                          <tr key={t.track}>
                            <td>{t.track}</td>
                            <td>{r?.status ?? '—'}</td>
                            <td className="g-mono">{r?.versionCodes.join(', ') || '—'}</td>
                            <td className="g-caption">{r?.releaseNotes[0]?.text ? r.releaseNotes[0].text.slice(0, 80) : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
                {app.tracks.length === 0 && (
                  <p className="g-caption g-faint">A track with no release is what an app looks like before its first upload.</p>
                )}
              </div>
            ))}
            {baseline.apps.length > 0 && (
              <p className="g-caption g-faint">
                {baseline.apps.length} app{baseline.apps.length === 1 ? '' : 's'} listed. Play shows only apps this service
                account has been given, so a missing app usually means a missing permission or a different package name.
              </p>
            )}
            <details className="g-details">
              <summary>The 12-tester gate, and what Goga can see of it</summary>
              <p className="g-caption">
                A new personal developer account must run a closed test with 12 testers who opt in and stay opted in for 14
                days before it can apply for production. The Play API does not report that count to Goga, so it is read in{' '}
                Play Console → your app → Testing → Closed testing. Goga does not create tester accounts, does not fill
                that list, and has no way to make the gate pass.
              </p>
              <p className="g-caption">
                Track tester counts and opt-in dates in the tester tracker below — that is Goga's own record, not Google's.
              </p>
            </details>
          </>
        )}
      </Card>

      {/* ── upload ── */}
      <Card
        title="Upload a bundle to a testing track"
        sub="Queued as an approval. Nothing uploads until you approve that exact entry."
        actions={<Chip tone={state.pending.length ? 'warn' : undefined}>{state.pending.length} queued</Chip>}
      >
        {c.state !== 'connected' && (
          <Alert kind="info">This needs a connected key with Play access. Fix the connection above first.</Alert>
        )}
        <div className="g-grid g-grid--2">
          <Field
            label="App"
            hint={baseline.apps.length
              ? 'Every app Play returned, by its own package name.'
              : 'Play has not been read yet, so type the package name.'}
          >
            {baseline.apps.length > 0 ? (
              <select className="g-input g-input--lg" value={pkg} onChange={e => setPkg(e.target.value)}>
                {baseline.apps.map(a => (
                  <option key={a.packageName} value={a.packageName}>{a.displayName} — {a.packageName}</option>
                ))}
              </select>
            ) : (
              <input className="g-input g-input--lg g-mono" value={pkg} onChange={e => setPkg(e.target.value)} placeholder="com.example.app" />
            )}
          </Field>
          <Field label="Track" hint="Internal testing is the safe first stop.">
            <select className="g-input g-input--md" value={track} onChange={e => setTrack(e.target.value)}>
              {['internal', 'alpha', 'beta'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        </div>
        <div className="g-row">
          <Field label="Bundle (.aab)">
            <input className="g-input g-input--xl g-mono" value={aabPath} onChange={e => setAabPath(e.target.value)} placeholder="C:\path\to\app-release.aab" />
          </Field>
          <button className="g-btn g-btn--sm" disabled={busyNow} onClick={() => void pickBundle()}>Choose file</button>
        </div>
        <div className="g-row">
          <Field
            label="Version code"
            hint={nextCodeFor(baseline, pkg)
              ? `Play's highest for this app is ${Number(nextCodeFor(baseline, pkg)) - 1}, so the next is ${nextCodeFor(baseline, pkg)}.`
              : 'Must be higher than every version already on that track.'}
          >
            <input className="g-input g-input--sm g-mono" value={versionCode} onChange={e => setVersionCode(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Notes language">
            <input className="g-input g-input--sm" value={language} onChange={e => setLanguage(e.target.value)} />
          </Field>
        </div>
        <Field label={`Release notes (${[...notes].length}/500)`}>
          <textarea
            className="g-input"
            style={{ width: '100%', minHeight: 80, fontFamily: 'inherit' }}
            maxLength={500}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="What changed in this build, in the words your testers will read."
          />
        </Field>
        <div className="g-row" style={{ marginTop: 8 }}>
          <button
            className="g-btn g-btn--primary"
            disabled={busyNow || c.state !== 'connected' || !pkg.trim() || !aabPath.trim() || !versionCode.trim() || !notes.trim()}
            onClick={() => void prepareUpload()}
          >
            {working === 'prepare-upload' ? 'Preparing…' : 'Queue this upload for approval'}
          </button>
        </div>
        <p className="g-caption g-faint" style={{ marginTop: 6 }}>
          This path stops at testing tracks. A production release is not something it will do. If Google reads a different
          version code out of the bundle than the one above, the upload is thrown away and nothing is committed.
        </p>

        {state.pending.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="g-section-title" style={{ marginBottom: 6 }}>Queued uploads</div>
            {state.pending.map((s: PlaySubmissionView) => (
              <div key={s.id} className="g-inset" style={{ marginBottom: 6 }}>
                <div className="g-caption">
                  {s.packageName} · {s.track} · version <span className="g-mono">{s.versionCode}</span> ·{' '}
                  {(s.aabBytes / (1024 * 1024)).toFixed(2)} MB · expires {when(s.expiresAt)}
                </div>
                <div className="g-caption g-faint g-mono" style={{ fontSize: 11 }}>{s.aabPath}</div>
                <div className="g-caption" style={{ marginTop: 4 }}>{s.releaseNotes}</div>
                <p className="g-caption g-faint" style={{ marginBottom: 0 }}>Approve it in the queue at the top of this page.</p>
              </div>
            ))}
          </div>
        )}

        {state.lastUpload && (
          <Alert kind={state.lastUpload.ok ? 'ok' : 'error'}>
            {when(state.lastUpload.at)} — {state.lastUpload.message}
            {state.lastUpload.versionCode && <> Version {state.lastUpload.versionCode}.</>}
            {state.lastUpload.committed ? ' It was committed to Play.' : ' Nothing was committed.'}
          </Alert>
        )}
      </Card>
    </>
  )
}
