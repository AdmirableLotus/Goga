import React, { useState } from 'react'
import type { PlayTrack, TesterApp, TesterAppSummary, TesterCandidate, TesterRecruitment, TesterState } from '../../shared/business'
import { Alert, Card, Chip, EmptyState, Field } from './ui'

/**
 * Tester tracker, one app at a time.
 *
 * Google's gate is per app: 12 testers opted in continuously for 14 days, on that app's
 * closed test. So each app keeps its own list, its own dates and its own count, and the
 * counts are never added together.
 *
 * What this does: records who you asked, what they said, when they opted in and when they
 * left, and says plainly when an app is short. What it does not do: send anything, mark
 * anyone opted in on its own, or read Play Console. The invite is prepared here and sent
 * only when you approve that exact message; everything else is your own record.
 *
 * The one number it will not round in your favour is the count. A tester who drops out is
 * not deleted — the date they left is kept, because a break in the streak restarts their
 * 14 days.
 */

type Notice = (message: string, kind?: 'ok' | 'error') => void

const STATE_LABEL: Record<TesterState, string> = {
  candidate: 'candidate',
  invited: 'invited',
  accepted: 'accepted',
  installed: 'installed',
  'opted-in': 'opted in',
  dropped: 'dropped out',
}

const TRACKS: PlayTrack[] = ['internal', 'closed', 'open', 'production']

const when = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—')

export default function TesterTracker({
  recruitment, busy, onChanged, notify,
}: {
  recruitment: TesterRecruitment
  busy: boolean
  onChanged: () => void
  notify: Notice
}) {
  const { apps, summaries, copyDrafts } = recruitment
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inviteSubject, setInviteSubject] = useState('')
  const [inviteBody, setInviteBody] = useState('')
  const [inviteTargetId, setInviteTargetId] = useState<string | null>(null)
  const [draftChannel, setDraftChannel] = useState('')
  const [draftText, setDraftText] = useState('')

  const [newAppName, setNewAppName] = useState('')
  const [newAppPackage, setNewAppPackage] = useState('')
  const [newAppTrack, setNewAppTrack] = useState<PlayTrack>('closed')

  const [tName, setTName] = useState('')
  const [tEmail, setTEmail] = useState('')
  const [tSource, setTSource] = useState('')

  const selected = apps.find(a => a.id === selectedId) ?? apps[0] ?? null
  const summary = selected ? summaries.find(s => s.appId === selected.id) ?? null : null

  async function call<T>(fn: () => Promise<T>, ok: string): Promise<T | null> {
    try {
      const r = await fn()
      notify(ok, 'ok')
      onChanged()
      return r
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
      return null
    }
  }

  async function addApp() {
    await call(
      () => window.goga.invoke('business:addTrackedApp', {
        name: newAppName.trim(), packageName: newAppPackage.trim(), track: newAppTrack,
      }),
      'App added to the tracker. Nothing was sent to Google.',
    )
    setNewAppName(''); setNewAppPackage('')
  }

  async function addCandidate(app: TesterApp) {
    const r = await call(
      () => window.goga.invoke('business:addCandidate', {
        appId: app.id, name: tName.trim(), email: tEmail.trim(), source: tSource.trim(), notes: '',
      }),
      'Added to this app’s list. Nothing was sent.',
    )
    if (r) { setTName(''); setTEmail(''); setTSource('') }
  }

  function inviteText(app: TesterApp, c: TesterCandidate): { subject: string; body: string } {
    const name = c.name || 'there'
    const subject = `Would you test ${app.name || 'my app'} on Android for two weeks?`
    const body = [
      `Hi ${name},`,
      '',
      `I have an Android app, ${app.name || 'an app I built'}, in closed testing on Google Play. Before Google lets it go public, it needs at least 12 people to install it from a test link and stay opted in for 14 days straight.`,
      '',
      'What it would involve:',
      '  1. Open the link I send you on an Android phone, signed in to the Google account you gave me.',
      '  2. Press “Become a tester”, then install the app.',
      '  3. Keep it installed and stay opted in for at least 14 days. Opening it a few times and telling me what is confusing or broken is the useful part.',
      '',
      'You can leave the test at any time — just tell me and I will replace you rather than wonder why the count moved.',
      '',
      'No obligation. Say no and I will not ask again.',
      '',
      'Thanks',
    ].join('\n')
    return { subject, body }
  }

  function appCard(app: TesterApp, s: TesterAppSummary) {
    const active = selected?.id === app.id
    return (
      <div key={app.id} className="g-inset" style={{ marginBottom: 12, borderColor: active ? 'var(--accent-line)' : undefined }}>
        <div className="g-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <strong>{app.name || app.packageName}</strong>
            <div className="g-caption">
              <span className="g-mono">{app.packageName}</span> · {app.track} track · {app.required} needed for {app.optInDays} days
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Chip tone={s.meetsCount ? (s.daysRemaining !== null && s.daysRemaining > 0 ? 'warn' : 'ok') : s.optedIn === 0 ? 'bad' : 'warn'}>
              {s.optedIn} of {s.required} opted in
            </Chip>
            <button className="g-btn g-btn--ghost g-btn--sm" onClick={() => setSelectedId(app.id)} disabled={active}>
              {active ? 'Open' : 'Manage'}
            </button>
            <button
              className="g-btn g-btn--ghost g-btn--sm"
              disabled={busy}
              onClick={() => void call(() => window.goga.invoke('business:forgetTrackedApp', app.id), 'App and its tester list removed from the tracker.')}
            >✕</button>
          </div>
        </div>

        {s.warning && <Alert kind="error">{s.warning}</Alert>}
        {s.meetsCount && s.eligibleAt && (
          <Alert kind="info">
            {s.daysRemaining !== null && s.daysRemaining > 0
              ? `The ${s.optInDays}-day streak completes ${s.eligibleAt.slice(0, 10)} on the dates recorded here. Keep all ${s.required} opted in until then.`
              : `${s.required} have been opted in for at least ${s.optInDays} days on the dates recorded here. You can apply for production access in Play Console.`}
          </Alert>
        )}

        {!active && (
          <div className="g-caption">
            {s.outstanding} invited/accepted/installed and not yet opted in · {s.dropped} dropped out
          </div>
        )}

        {active && (
          <>
            <div className="g-caption" style={{ marginTop: 6 }}>
              {s.outstanding} invited, accepted or installed and not yet opted in · {s.dropped} dropped out.
              Nothing here is sent to Google; it is your record of what each person told you.
            </div>

            {app.candidates.length === 0 ? (
              <EmptyState
                icon="🧑‍🤝‍🧑"
                title="No testers on this app yet"
                body="Add the people you would ask. The list keeps the invite, the day they opted in and the day they left in one place."
              />
            ) : (
              <table className="g-table" style={{ marginTop: 8 }}>
                <thead>
                  <tr>{['Name', 'Email', 'Source', 'State', 'Invited', 'Opted in', 'Left', ''].map(h => <th key={h}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {app.candidates.map(c => (
                    <tr key={c.id}>
                      <td>{c.name || '—'}</td>
                      <td className="g-mono" style={{ fontSize: 11.5 }}>{c.email}</td>
                      <td className="g-caption">{c.source || '—'}</td>
                      <td>
                        <select
                          className="g-input g-input--sm"
                          value={c.state}
                          disabled={busy}
                          onChange={e => void call(
                            () => window.goga.invoke('business:setCandidateState', app.id, c.id, e.target.value as TesterState, null),
                            `${c.email} marked ${STATE_LABEL[e.target.value as TesterState]}.`,
                          )}
                        >
                          {(Object.keys(STATE_LABEL) as TesterState[]).map(k => <option key={k} value={k}>{STATE_LABEL[k]}</option>)}
                        </select>
                      </td>
                      <td>{when(c.invitedAt)}</td>
                      <td>
                        <input
                          type="date"
                          className="g-input g-input--sm"
                          value={c.optedInAt ? c.optedInAt.slice(0, 10) : ''}
                          disabled={busy}
                          onChange={e => {
                            const v = e.target.value
                            if (!v) return
                            void call(
                              () => window.goga.invoke('business:setCandidateOptInDate', app.id, c.id, v),
                              `${c.email} opted in on ${v}.`,
                            )
                          }}
                        />
                      </td>
                      <td>{when(c.droppedAt)}</td>
                      <td>
                        <button
                          className="g-btn g-btn--sm"
                          disabled={busy}
                          onClick={() => {
                            const t = inviteText(app, c)
                            setInviteSubject(t.subject)
                            setInviteBody(t.body)
                            setInviteTargetId(c.id)
                            notify(`Invite text for ${c.email} is below the table. Read it, then prepare it — nothing is sent until you approve it.`, 'ok')
                          }}
                        >Draft invite</button>
                        <button
                          className="g-btn g-btn--ghost g-btn--sm"
                          style={{ marginLeft: 4 }}
                          disabled={busy}
                          onClick={() => void call(() => window.goga.invoke('business:forgetCandidate', app.id, c.id), 'Removed from this app’s list.')}
                        >✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="g-row" style={{ marginTop: 10 }}>
              <Field label="Name"><input className="g-input g-input--md" value={tName} onChange={e => setTName(e.target.value)} /></Field>
              <Field label="Email"><input className="g-input g-input--md" value={tEmail} onChange={e => setTEmail(e.target.value)} placeholder="name@example.com" /></Field>
              <Field label="Where from"><input className="g-input g-input--md" value={tSource} onChange={e => setTSource(e.target.value)} placeholder="a friend, a testing subreddit…" /></Field>
              <button className="g-btn" disabled={busy || !tEmail.trim()} onClick={() => void addCandidate(app)}>Add tester</button>
            </div>

            <details className="g-details">
              <summary>Settings for this app</summary>
              <div className="g-row" style={{ marginTop: 6 }}>
                <Field label="Track">
                  <select
                    className="g-input g-input--sm"
                    value={app.track}
                    onChange={e => void call(
                      () => window.goga.invoke('business:editTrackedApp', app.id, { track: e.target.value as PlayTrack }),
                      'Track updated in your record.',
                    )}
                  >
                    {TRACKS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
                <Field label="Testers Google needs">
                  <input
                    className="g-input g-input--xs"
                    type="number"
                    min={1}
                    value={app.required}
                    onChange={e => void call(
                      () => window.goga.invoke('business:editTrackedApp', app.id, { required: Number(e.target.value) }),
                      'Requirement updated in your record.',
                    )}
                  />
                </Field>
                <Field label="Days opted in">
                  <input
                    className="g-input g-input--xs"
                    type="number"
                    min={1}
                    value={app.optInDays}
                    onChange={e => void call(
                      () => window.goga.invoke('business:editTrackedApp', app.id, { optInDays: Number(e.target.value) }),
                      'Days updated in your record.',
                    )}
                  />
                </Field>
              </div>
              <p className="g-caption g-faint">
                These are recorded, not fetched. If Google changes the rule, change them here and every
                count on this page follows.
              </p>
            </details>

            <details className="g-details">
              <summary>Invite text for this app</summary>
              <div className="g-caption" style={{ marginTop: 4 }}>
                Filled in from the row you pressed Draft invite on. Preparing it queues an approval; it is
                sent only when you approve that exact message, and only if Gmail is connected.
              </div>
              <Field label="Subject">
                <input className="g-input g-input--xl" value={inviteSubject} onChange={e => setInviteSubject(e.target.value)} />
              </Field>
              <Field label="Body">
                <textarea className="g-input g-input--xl" rows={12} value={inviteBody} onChange={e => setInviteBody(e.target.value)} />
              </Field>
              <p className="g-caption g-faint">
                One person at a time, on purpose: no batch sends, no mailing lists.
              </p>
            </details>
          </>
        )}
      </div>
    )
  }

  return (
    <Card
      title="Tester recruitment"
      sub="Google counts only testers who are opted in, per app, on that app’s closed test"
      actions={<Chip tone={recruitment.shortApps ? 'warn' : 'ok'}>
        {recruitment.shortApps ? `${recruitment.shortApps} of ${summaries.length} short` : 'all apps at the requirement'}
      </Chip>}
    >
      <p className="g-caption">
        Google’s rule for a personal developer account created after 13 November 2023: a closed test with at
        least 12 testers opted in <em>continuously</em> for the preceding 14 days, then apply for production
        access. The count is per app, so each app below is tracked on its own.
      </p>

      {apps.length === 0 ? (
        <EmptyState icon="📱" title="No apps tracked yet" body="Add an app with its package name. Nothing is read from Play Console; this is your own record." />
      ) : (
        <>
          {apps.map(a => {
            const s = summaries.find(x => x.appId === a.id)
            return s ? appCard(a, s) : null
          })}

          {selected && (
            <div className="g-row" style={{ marginTop: 6 }}>
              <button
                className="g-btn g-btn--sm"
                disabled={busy || !inviteSubject.trim() || !inviteBody.trim()}
                onClick={() => {
                  const c = selected.candidates.find(x => x.id === inviteTargetId)
                    ?? selected.candidates.find(x => x.state !== 'opted-in' && x.state !== 'dropped')
                  if (!c) { notify('Add a tester to this app first, or pick one who has not opted in yet.', 'error'); return }
                  void call(
                    () => window.goga.invoke('business:prepareTesterInvite', selected.id, c.id, inviteSubject.trim(), inviteBody.trim()),
                    `Prepared an invite to ${c.email}. It is waiting in the approvals card above; nothing has been sent.`,
                  )
                }}
              >Prepare invite</button>
              <span className="g-caption g-faint">
                One person at a time, to the row you drafted. Approve it in the card at the top of this page.
              </span>
            </div>
          )}
        </>
      )}

      <details className="g-details">
        <summary>Add another app</summary>
        <div className="g-row" style={{ marginTop: 6 }}>
          <Field label="Name"><input className="g-input g-input--md" value={newAppName} onChange={e => setNewAppName(e.target.value)} placeholder="Only3" /></Field>
          <Field label="Package name"><input className="g-input g-input--lg" value={newAppPackage} onChange={e => setNewAppPackage(e.target.value)} placeholder="com.example.app" /></Field>
          <Field label="Track">
            <select className="g-input g-input--sm" value={newAppTrack} onChange={e => setNewAppTrack(e.target.value as PlayTrack)}>
              {TRACKS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <button className="g-btn" disabled={busy || !newAppPackage.trim()} onClick={() => void addApp()}>Add app</button>
        </div>
        <p className="g-caption g-faint">
          The package name is the one Play Console shows under the app’s name. Guessing it would only make the
          record wrong, so it is asked for.
        </p>
      </details>

      <details className="g-details">
        <summary>Recruitment copy ({copyDrafts.length})</summary>
        <div className="g-row" style={{ marginTop: 6 }}>
          <Field label="Where for"><input className="g-input g-input--md" value={draftChannel} onChange={e => setDraftChannel(e.target.value)} placeholder="r/AndroidClosedTesting" /></Field>
        </div>
        <textarea
          className="g-input g-input--xl"
          rows={6}
          value={draftText}
          onChange={e => setDraftText(e.target.value)}
          placeholder="Paste the version you posted, so you can find it again."
        />
        <div className="g-row" style={{ marginTop: 6 }}>
          <button
            className="g-btn g-btn--sm"
            disabled={busy || !draftText.trim()}
            onClick={() => void call(
              () => window.goga.invoke('business:saveCopyDraft', draftChannel.trim() || 'general', draftText.trim()),
              'Kept with your notes. Nothing was posted.',
            ).then(r => { if (r) setDraftText('') })}
          >Keep this copy</button>
        </div>
        {copyDrafts.length > 0 && (
          <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, marginTop: 8 }}>
            {copyDrafts.map(d => (
              <li key={d.id} style={{ marginBottom: 6 }}>
                <span className="g-faint">[{d.channel}] {d.createdAt.slice(0, 10)}</span>
                <div className="g-mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{d.text.slice(0, 300)}{d.text.length > 300 ? '…' : ''}</div>
                <button
                  className="g-btn g-btn--ghost g-btn--sm"
                  disabled={busy}
                  onClick={() => void call(() => window.goga.invoke('business:forgetCopyDraft', d.id), 'Removed.')}
                >✕</button>
              </li>
            ))}
          </ul>
        )}
      </details>
    </Card>
  )
}
