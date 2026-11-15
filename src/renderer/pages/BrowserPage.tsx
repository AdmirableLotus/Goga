import React, { useCallback, useEffect, useState } from 'react'
import type { BrowserStatus, BrowserTab, PageRead, SiteRecipe } from '../../shared/browser'
import { PageHeader, Card, Field, EmptyState, Alert, Chip } from '../components/ui'

/**
 * The Browser page: the general layer, in the user's hands.
 *
 * It shows what Goga can see and do in Firefox, and it is deliberately blunt about the
 * one thing that is not automatic: Goga launches its own Firefox with its own profile, so
 * a site the user is signed in to in their everyday browser is not signed in there. That
 * is a step only the user can take, and the page says so instead of failing quietly.
 */

export default function BrowserPage() {
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [page, setPage] = useState<PageRead | null>(null)
  const [recipes, setRecipes] = useState<SiteRecipe[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [url, setUrl] = useState('https://app.pivex.com/trading-platform')
  const [findText, setFindText] = useState('')
  const [found, setFound] = useState('')
  const [correction, setCorrection] = useState('')

  const refresh = useCallback(async () => {
    try {
      const s = await window.goga.invoke('browser:status')
      setStatus(s)
      if (s.state === 'attached') {
        setTabs(await window.goga.invoke('browser:tabs'))
      } else {
        setTabs([])
      }
      setRecipes(await window.goga.invoke('browser:recipes'))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(true); setError(''); setNotice('')
    try { return await fn() }
    catch (e) { setError(`${label}: ${e instanceof Error ? e.message : String(e)}`); return null }
    finally { setBusy(false); void refresh() }
  }

  const start = () => run('Start Firefox', async () => {
    const s = await window.goga.invoke('browser:start', url || undefined)
    setNotice(s.message)
    return s
  })

  const attach = () => run('Attach', async () => {
    const s = await window.goga.invoke('browser:attach')
    setNotice(s.message)
    return s
  })

  const readPage = () => run('Read page', async () => {
    const p = await window.goga.invoke('browser:readPage')
    setPage(p)
    setNotice(`Read "${p.title}" — ${p.elements.length} interactive element${p.elements.length === 1 ? '' : 's'}${p.textClipped ? ', and the text was longer than one pass' : ''}.`)
    return p
  })

  const learn = () => run('Learn this page', async () => {
    const r = await window.goga.invoke('browser:learn')
    setNotice(`Learned ${r.host}: ${r.fields.length} field(s), ${r.actions.length} action(s). Saved as revision ${r.revisions}.`)
    return r
  })

  const find = () => run('Find', async () => {
    const f = await window.goga.invoke('browser:find', { by: 'text', text: findText })
    setFound(f.found
      ? `Found one: ${f.match?.role} "${f.match?.name}"${f.match?.value ? ` (value "${f.match.value}")` : ''}`
      : f.count > 1
        ? `${f.count} elements match, so Goga will not guess: ${f.candidates.join(' · ')}`
        : 'Nothing on the page matches that text.')
    return f
  })

  const navigate = () => run('Go to', async () => {
    const r = await window.goga.invoke('browser:navigate', url)
    setNotice(`Now on ${r.title || r.url}.`)
    return r
  })

  const currentRecipe = page ? recipes.find(r => r.host === (() => { try { return new URL(page.url).host } catch { return '' } })()) : null

  return (
    <div className="g-page">
      <div className="g-page-inner">

        <PageHeader
          title="Browser"
          accent="Firefox, under Goga's control"
          purpose="Goga launches its own Firefox, attaches to it, and can read a page, find an element, click it, type into it and take a screenshot. Any site, not just the ones built in."
          help={<>
            <p><strong>How it starts.</strong> Goga runs Firefox with <span className="g-mono">--remote-debugging-port</span> and its own profile folder, so it never opens, reads or changes the Firefox you browse in. Firefox 160 answers on that port with WebDriver BiDi, not the older Chrome protocol, and Goga speaks BiDi.</p>
            <p><strong>Signing in.</strong> Goga's Firefox is a separate profile, so a site you are signed in to in your everyday browser is not signed in there. Sign in once in Goga's Firefox window and it stays signed in.</p>
            <p><strong>What it will not do.</strong> It does not read cookies, saved passwords or the profile's secret store. It attaches to the port and works the pages, and that is all.</p>
          </>}
          actions={<>
            <button className="g-btn g-btn--sm" onClick={() => void refresh()} disabled={busy}>Refresh</button>
            <button className="g-btn g-btn--primary g-btn--sm" onClick={() => void start()} disabled={busy}>Start Firefox</button>
            <button className="g-btn g-btn--sm" onClick={() => void attach()} disabled={busy || status?.state === 'attached'}>Attach</button>
          </>}
        />

        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="ok">{notice}</Alert>}

        <Card title="Connection" sub="What is true right now">
          {!status ? <EmptyState icon="🌐" title="Checking…" body="Asking whether Firefox is listening." /> : (
            <>
              <div className="g-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Chip tone={status.state === 'attached' ? 'ok' : status.state === 'blocked' ? 'bad' : 'warn'}>
                  {status.state === 'attached' ? 'Attached' : status.state === 'running' ? 'Firefox is up, not attached' : status.state === 'blocked' ? 'Port taken by something else' : 'Not running'}
                </Chip>
                <Chip>Port {status.port}</Chip>
                {status.browserVersion && <Chip>Firefox {status.browserVersion}</Chip>}
                <Chip tone={status.executable ? 'ok' : 'bad'}>{status.executable ? 'Firefox found' : 'Firefox not found'}</Chip>
                <Chip>{status.tabCount} tab{status.tabCount === 1 ? '' : 's'}</Chip>
              </div>
              <p className="g-caption" style={{ marginTop: 10 }}>{status.message}</p>
              {status.profileDir && (
                <p className="g-caption g-faint">Goga's own Firefox profile: <span className="g-mono">{status.profileDir}</span></p>
              )}
            </>
          )}
        </Card>

        {status?.state === 'attached' && (
          <Card title="Tabs" sub="Pick the one Goga should work in">
            {tabs.length === 0 ? <EmptyState icon="🗂" title="No tabs" body="Firefox has no tabs open." /> : (
              <table className="g-table">
                <thead><tr>{['', 'Title', 'Address'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {tabs.map(t => (
                    <tr key={t.id}>
                      <td>{t.current ? <Chip tone="accent">current</Chip> : (
                        <button className="g-btn g-btn--sm" disabled={busy} onClick={() => void run('Select tab', () => window.goga.invoke('browser:selectTab', t.id))}>Use</button>
                      )}</td>
                      <td>{t.title || '(no title yet)'}</td>
                      <td className="g-mono" style={{ fontSize: 11.5 }}>{t.url}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        <Card title="Work a page" sub="Read it, find something on it, or go somewhere">
          <div className="g-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Address"><input className="g-input g-input--xl" value={url} onChange={e => setUrl(e.target.value)} /></Field>
            <button className="g-btn g-btn--sm" disabled={busy || status?.state !== 'attached'} onClick={() => void navigate()}>Go to</button>
            <button className="g-btn g-btn--sm" disabled={busy || status?.state !== 'attached'} onClick={() => void readPage()}>Read page</button>
            <button className="g-btn g-btn--sm" disabled={busy || status?.state !== 'attached'} onClick={() => void learn()}>Learn this page</button>
          </div>

          <hr className="g-divider" />

          <div className="g-row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Field label="Find an element by its text"><input className="g-input g-input--md" value={findText} onChange={e => setFindText(e.target.value)} placeholder="e.g. BUY" /></Field>
            <button className="g-btn g-btn--sm" disabled={busy || !findText || status?.state !== 'attached'} onClick={() => void find()}>Find</button>
          </div>
          {found && <p className="g-caption" style={{ marginTop: 8 }}>{found}</p>}

          {page && (
            <>
              <hr className="g-divider" />
              <div className="g-section-title" style={{ marginBottom: 6 }}>{page.title || '(untitled)'}</div>
              <p className="g-caption g-faint" style={{ marginBottom: 8 }}>{page.url}</p>
              <details className="g-details" open>
                <summary>{page.elements.length} interactive element{page.elements.length === 1 ? '' : 's'}</summary>
                <table className="g-table" style={{ marginTop: 6 }}>
                  <thead><tr>{['Role', 'Name', 'Value', 'State'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    {page.elements.slice(0, 40).map((el, i) => (
                      <tr key={`${el.role}-${el.name}-${i}`}>
                        <td className="g-mono" style={{ fontSize: 11.5 }}>{el.role}</td>
                        <td>{el.name || <span className="g-faint">(no label)</span>}</td>
                        <td className="g-mono" style={{ fontSize: 11.5 }}>{el.value ?? ''}</td>
                        <td>{el.disabled ? <Chip tone="warn">disabled</Chip> : <Chip tone="ok">usable</Chip>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
              <details className="g-details">
                <summary>Visible text{page.textClipped ? ' (clipped)' : ''}</summary>
                <pre className="g-inset g-mono" style={{ maxHeight: 260, overflow: 'auto', fontSize: 11.5, whiteSpace: 'pre-wrap', marginTop: 6 }}>{page.text}</pre>
              </details>
            </>
          )}
        </Card>

        <Card title="What Goga has learned about sites" sub="One description per site, in a file you can read and correct">
          {recipes.length === 0 ? (
            <EmptyState
              icon="📝"
              title="Nothing learned yet"
              body="Open a site in Goga's Firefox, press Read page, then Learn this page. Goga writes down the fields, the buttons and what a finished action looks like, so next time it does not start from zero."
            />
          ) : (
            <>
              {recipes.map(r => (
                <div key={r.host} className="g-inset" style={{ marginBottom: 10 }}>
                  <div className="g-row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div className="g-section-title">{r.host}</div>
                    <span className="g-caption g-faint">revision {r.revisions} · {new Date(r.updatedAt).toLocaleString()}</span>
                  </div>
                  <p className="g-caption" style={{ marginTop: 4 }}>{r.purpose}</p>
                  <details className="g-details">
                    <summary>{r.fields.length} field(s), {r.actions.length} action(s)</summary>
                    <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, marginTop: 6 }}>
                      {r.fields.map(f => <li key={`f-${f.name}`}>field <span className="g-mono">{f.name}</span> ({f.role}){f.sample ? ` — saw "${f.sample}"` : ''}</li>)}
                      {r.actions.map(a => <li key={`a-${a.name}`}>{a.name || '(unlabelled)'} — {a.expectation}</li>)}
                    </ul>
                    {r.notes.length > 0 && (
                      <>
                        <div className="g-label" style={{ marginTop: 8 }}>What the learner was unsure about</div>
                        <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18 }}>{r.notes.map(n => <li key={n}>{n}</li>)}</ul>
                      </>
                    )}
                    <div className="g-label" style={{ marginTop: 8 }}>What a finished action looks like</div>
                    <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18 }}>{r.completion.map(c => <li key={c}>{c}</li>)}</ul>
                  </details>
                  {r.userNotes && (
                    <p className="g-caption" style={{ marginTop: 6 }}><strong>Your correction:</strong> {r.userNotes}</p>
                  )}
                  <div className="g-row" style={{ gap: 8, marginTop: 8, alignItems: 'flex-end' }}>
                    <Field label="Correct or add to this description">
                      <input
                        className="g-input g-input--xl"
                        value={currentRecipe?.host === r.host ? correction : ''}
                        placeholder={r.userNotes || 'e.g. the Confirm button is the green one in the middle'}
                        onChange={e => setCorrection(e.target.value)}
                      />
                    </Field>
                    <button className="g-btn g-btn--sm" disabled={busy || !correction} onClick={() => void run('Save correction', async () => {
                      const saved = await window.goga.invoke('browser:correctRecipe', r.host, correction)
                      setCorrection('')
                      setNotice(`Saved your correction for ${saved.host}. Goga keeps it when it re-learns the site.`)
                      return saved
                    })}>Save correction</button>
                    <button className="g-btn g-btn--risk g-btn--sm" disabled={busy} onClick={() => void run('Forget', () => window.goga.invoke('browser:forgetRecipe', r.host))}>Forget</button>
                  </div>
                </div>
              ))}
              <p className="g-caption g-faint">
                These live in <span className="g-mono">site-recipes.json</span> in Goga's data folder. You can open that file and edit it directly; Goga reads it fresh each time.
              </p>
            </>
          )}
        </Card>

      </div>
    </div>
  )
}
