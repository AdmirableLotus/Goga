import React, { useCallback, useEffect, useState } from 'react'
import type {
  LoopStats, TradeRecord, VenueId, VenueInfo, VenueTicket,
} from '../../shared/venues'
import { PageHeader, Card, Field, EmptyState, Alert, Chip } from '../components/ui'

/**
 * Practice: the two venues Goga can trade on, and what each one actually is.
 *
 * The distinction this page exists to make:
 *   - Pivex is a simulation with a challenge fee. Its balance is not money.
 *   - Alpaca paper is a real broker's simulated account, with real market prices.
 *
 * Neither is real money. The page says that at the top and next to every number, because
 * a green profit figure in a terminal looks exactly like income and is not.
 */

function money(n: number, currency = 'USD'): string {
  return `${n < 0 ? '-' : ''}${currency === 'USD' ? '$' : ''}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function plain(n: number | null, digits = 2): string {
  return n === null ? '—' : n.toFixed(digits)
}

export default function VenuesPage() {
  const [info, setInfo] = useState<Record<VenueId, VenueInfo> | null>(null)
  const [venue, setVenue] = useState<VenueId>('alpaca-paper')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Reads
  const [pivex, setPivex] = useState<{ account: import('../../shared/venues').VenueAccount | null; needsSignIn: boolean; gaps: string[] } | null>(null)
  const [alpaca, setAlpaca] = useState<{ account: import('../../shared/venues').VenueAccount | null; error: string | null; keyStored: boolean } | null>(null)

  // Order builder
  const [symbol, setSymbol] = useState('EURUSD')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [lots, setLots] = useState('0.01')
  const [qty, setQty] = useState('1')
  const [stopPrice, setStopPrice] = useState('')
  const [reason, setReason] = useState('')
  const [ticket, setTicket] = useState<VenueTicket | null>(null)

  // Learning loop
  const [stats, setStats] = useState<LoopStats | null>(null)
  const [trades, setTrades] = useState<TradeRecord[]>([])
  const [halted, setHalted] = useState(false)
  const [study, setStudy] = useState<{ found: boolean; source: string; markdown: string; error: string | null; modifiedAt: string | null } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [i, p, a] = await Promise.all([
        window.goga.invoke('venue:info'),
        window.goga.invoke('venue:pivexRead'),
        window.goga.invoke('venue:alpacaRead'),
      ])
      setInfo(i); setPivex(p); setAlpaca(a)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  const refreshStats = useCallback(async (v: VenueId) => {
    try {
      const [s, t, h] = await Promise.all([
        window.goga.invoke('venue:stats', v),
        window.goga.invoke('venue:trades', 100),
        window.goga.invoke('venue:haltState', v),
      ])
      setStats(s); setTrades(t.filter(x => x.venue === v)); setHalted(h.halted)
    } catch { /* the page still works without the numbers */ }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { void refreshStats(venue) }, [venue, refreshStats])
  useEffect(() => { void window.goga.invoke('venue:studyBase').then(setStudy).catch(() => {}) }, [])

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(true); setError(''); setNotice('')
    try { return await fn() }
    catch (e) { setError(`${label}: ${e instanceof Error ? e.message : String(e)}`); return null }
    finally { setBusy(false) }
  }

  const current = info?.[venue] ?? null
  const account = venue === 'pivex' ? pivex?.account ?? null : alpaca?.account ?? null

  async function prepare() {
    const built = await run('Prepare', async () => {
      if (venue === 'pivex') {
        return window.goga.invoke('venue:pivexPrepare', {
          symbol, side, lots: Number(lots), stopPrice: stopPrice ? Number(stopPrice) : null, reason,
        })
      }
      return window.goga.invoke('venue:alpacaPrepare', {
        symbol, side, qty: Number(qty), stopPrice: stopPrice ? Number(stopPrice) : null, reason,
      })
    })
    if (built) { setTicket(built); setNotice('Prepared. Nothing has been sent — approve that exact order below.') }
  }

  async function approveAndSend() {
    if (!ticket) return
    const sent = await run('Send', async () => {
      await window.goga.invoke('venue:approve', ticket.id, true)
      return venue === 'pivex'
        ? window.goga.invoke('venue:pivexSend', ticket.id)
        : window.goga.invoke('venue:alpacaSend', ticket.id)
    })
    if (sent) {
      setNotice(sent.message)
      if (!sent.ok) setError(sent.message)
      setTicket(null)
    }
    void refreshStats(venue)
  }

  async function deny() {
    if (!ticket) return
    await run('Discard', () => window.goga.invoke('venue:approve', ticket.id, false))
    setTicket(null)
    setNotice('Discarded. Nothing was sent.')
  }

  return (
    <div className="g-page">
      <div className="g-page-inner">

        <PageHeader
          title="Practice"
          accent="two simulated venues"
          purpose="Goga can practise on Pivex and on an Alpaca paper account. Both are simulations. Neither can make or lose you real money, and neither balance can be withdrawn."
          help={<>
            <p><strong>Pivex</strong> is a prop-firm evaluation. You paid a challenge fee; you trade a fake balance against a 10% target with 4% daily and 6% overall loss limits. Its own terms say no real trading occurs and it is not regulated by the CFTC, NFA, SEC, FINRA or any financial authority. The advertised 80–90% split is not in the Terms of Use.</p>
            <p><strong>Alpaca paper</strong> is a simulated account at a real US broker. The prices are real market prices; the fills and the money are not.</p>
            <p><strong>The order gate.</strong> Preparing an order sends nothing. You see the exact symbol, side, size, price and what it risks, and it expires after two minutes. Sending needs your approval of that one order, and a ticket works once.</p>
            <p><strong>The risk guard.</strong> Before an order is even prepared it is checked against the venue's loss budget: the daily limit, the overall limit, a per-trade cap, a per-order value cap and a position-count cap. Anything that breaches one is refused with the reason.</p>
          </>}
          actions={<>
            <div className="g-seg" role="group" aria-label="Venue">
              {(['alpaca-paper', 'pivex'] as VenueId[]).map(v => (
                <button key={v} aria-pressed={venue === v} onClick={() => { setVenue(v); setTicket(null) }}>
                  {v === 'pivex' ? 'Pivex' : 'Alpaca paper'}
                </button>
              ))}
            </div>
            <button className="g-btn g-btn--sm" disabled={busy} onClick={() => { void refresh(); void refreshStats(venue) }}>Refresh</button>
          </>}
        />

        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="ok">{notice}</Alert>}

        {current && (
          <Card title={current.name} sub="What this actually is" tone="accent">
            <p style={{ marginBottom: 6 }}>{current.whatItIs}</p>
            <div className="g-inset" style={{ marginTop: 8 }}>
              <div className="g-label">Money at stake</div>
              <p style={{ fontSize: 'var(--fs-caption)' }}>{current.moneyAtStake}</p>
              <div className="g-label" style={{ marginTop: 8 }}>Who supervises it</div>
              <p style={{ fontSize: 'var(--fs-caption)' }}>{current.regulator}</p>
            </div>
            <div className="g-row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              <Chip tone={current.realMoney ? 'bad' : 'ok'}>{current.realMoney ? 'REAL MONEY' : 'Simulation — no real money'}</Chip>
              <Chip>daily limit {current.budget.dailyLossPct}%</Chip>
              <Chip>overall limit {current.budget.overallLossPct}%</Chip>
              <Chip>per-trade cap {current.budget.perTradeCapPct}%</Chip>
              <Chip>{halted ? 'HALTED' : 'trading allowed'}</Chip>
            </div>
            <div className="g-row" style={{ gap: 8, marginTop: 10 }}>
              <button className="g-btn g-btn--risk g-btn--sm" disabled={busy} onClick={() => void run('Halt', async () => {
                await window.goga.invoke('venue:halt', venue, true, 'Halted from the Practice page')
                setHalted(true); setNotice('Halted. No new order can be prepared or sent on this venue.')
              })}>Halt this venue</button>
              {halted && (
                <button className="g-btn g-btn--sm" disabled={busy} onClick={() => void run('Clear halt', async () => {
                  await window.goga.invoke('venue:halt', venue, false, '')
                  setHalted(false); setNotice('Halt cleared.')
                })}>Clear halt</button>
              )}
            </div>
          </Card>
        )}

        {/* ── Account ──────────────────────────────────────────────────────── */}
        <Card
          title={venue === 'pivex' ? 'Pivex account' : 'Paper account'}
          sub={venue === 'pivex' ? 'Read from the Pivex page in Firefox' : 'Read from Alpaca\'s paper API'}
        >
          {venue === 'pivex' && pivex?.needsSignIn && (
            <Alert kind="info">
              The Pivex tab in Goga's Firefox is showing a sign-in page. Sign in to Pivex once in
              that Firefox window — only you can do that — then press Refresh. Goga will not sign in as you.
            </Alert>
          )}
          {!account ? (
            <EmptyState
              icon="📊"
              title={venue === 'pivex' ? 'No Pivex account read' : 'No paper account read'}
              body={venue === 'pivex'
                ? (pivex?.gaps.join(' ') || 'Open Pivex in Goga\'s Firefox and press Refresh.')
                : (alpaca?.error ?? 'Reading the paper account…')}
            />
          ) : (
            <>
              <div className="g-grid g-grid--4">
                <div>
                  <span className="g-label">{venue === 'pivex' ? 'Simulated balance' : 'Equity'}</span>
                  <div className="g-value" style={{ fontSize: 18 }}>{money(account.equity, account.currency)}</div>
                </div>
                <div>
                  <span className="g-label">Cash</span>
                  <div className="g-value" style={{ fontSize: 18 }}>{account.cash === null ? '—' : money(account.cash, account.currency)}</div>
                </div>
                <div>
                  <span className="g-label">Today</span>
                  <div className="g-value" style={{ fontSize: 18, color: account.dayPnlPct >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {account.dayPnlPct >= 0 ? '+' : ''}{account.dayPnlPct.toFixed(2)}%
                  </div>
                </div>
                <div>
                  <span className="g-label">Open positions</span>
                  <div className="g-value" style={{ fontSize: 18 }}>{account.positions.length}</div>
                </div>
              </div>

              {account.notes.length > 0 && (
                <ul className="g-caption" style={{ paddingLeft: 18, marginTop: 10 }}>
                  {account.notes.map(n => <li key={n}>{n}</li>)}
                </ul>
              )}

              <hr className="g-divider" />
              {account.positions.length === 0 ? (
                <EmptyState icon="📉" title="No open positions" body="Nothing is held in this account right now." />
              ) : (
                <table className="g-table">
                  <thead><tr>{['Symbol', 'Side', 'Size', 'Entry', 'Price', 'Unrealised', '% of account'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    {account.positions.map(p => (
                      <tr key={p.symbol}>
                        <td style={{ fontWeight: 600 }}>{p.symbol}</td>
                        <td>{p.side}</td>
                        <td className="num">{p.size}</td>
                        <td className="num">{p.avgEntryPrice.toFixed(4)}</td>
                        <td className="num">{p.currentPrice.toFixed(4)}</td>
                        <td className="num" style={{ color: p.unrealizedPl >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                          {p.unrealizedPl >= 0 ? '+' : ''}{p.unrealizedPl.toFixed(2)} ({p.unrealizedPlPct.toFixed(1)}%)
                        </td>
                        <td className="num">{p.exposurePct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </Card>

        {/* ── Order builder ────────────────────────────────────────────────── */}
        <Card title="Prepare an order" sub="This sends nothing. You approve that exact order afterwards.">
          <div className="g-grid g-grid--4">
            <Field label="Symbol">
              <input className="g-input g-input--sm" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} maxLength={12} />
            </Field>
            <Field label="Side">
              <select className="g-input g-input--sm" value={side} onChange={e => setSide(e.target.value as 'buy' | 'sell')}>
                <option value="buy">Buy</option><option value="sell">Sell</option>
              </select>
            </Field>
            {venue === 'pivex'
              ? <Field label="Lots" hint="Pivex defaults to 0.01"><input className="g-input g-input--sm" type="number" min="0.01" step="0.01" value={lots} onChange={e => setLots(e.target.value)} /></Field>
              : <Field label="Shares"><input className="g-input g-input--sm" type="number" min="1" step="1" value={qty} onChange={e => setQty(e.target.value)} /></Field>}
            <Field label="Stop price" hint="Required: without it there is no risk figure">
              <input className="g-input g-input--sm" type="number" step="any" value={stopPrice} onChange={e => setStopPrice(e.target.value)} />
            </Field>
          </div>
          <Field label="Why this trade" hint="Kept with the trade forever. At least 10 characters.">
            <input className="g-input g-input--xl" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. price held the 50-day average and volume rose" />
          </Field>
          <div>
            <button className="g-btn g-btn--primary" disabled={busy || !symbol || !stopPrice || reason.trim().length < 10} onClick={() => void prepare()}>
              Prepare order
            </button>
            <span className="g-hint" style={{ display: 'inline', marginLeft: 10 }}>Sends nothing.</span>
          </div>

          {ticket && (
            <div className="g-inset" style={{ borderColor: 'var(--accent-line)', background: 'var(--surface-3)', marginTop: 12 }}>
              <div className="g-section-title" style={{ marginBottom: 8 }}>Confirm this exact order</div>
              <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{ticket.confirmation}</p>
              <p className="g-caption">{ticket.reason}</p>
              <details className="g-details">
                <summary>Checks that passed</summary>
                <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, marginTop: 4 }}>{ticket.checks.map(c => <li key={c}>{c}</li>)}</ul>
              </details>
              <p className="g-caption g-faint" style={{ marginTop: 8 }}>
                Ticket <span className="g-mono">{ticket.id.slice(0, 8)}</span> · expires {new Date(ticket.expiresAt).toLocaleTimeString()} · works once
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="g-btn g-btn--danger" disabled={busy} onClick={() => void approveAndSend()}>
                  Approve and send this order
                </button>
                <button className="g-btn" disabled={busy} onClick={() => void deny()}>Cancel</button>
              </div>
            </div>
          )}
        </Card>

        {/* ── Learning loop ────────────────────────────────────────────────── */}
        <Card title="What the numbers say" sub="From closed trades only, with the reason you gave at the time">
          {!stats ? <EmptyState icon="📈" title="Reading…" body="Working out the numbers." /> : (
            <>
              <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>{stats.headline}</p>
              <div className="g-grid g-grid--4">
                <div><span className="g-label">Closed trades</span><div className="g-value" style={{ fontSize: 18 }}>{stats.closedTrades}</div></div>
                <div><span className="g-label">Win rate</span><div className="g-value" style={{ fontSize: 18 }}>{stats.winRate === null ? 'not enough trades' : `${(stats.winRate * 100).toFixed(1)}%`}</div></div>
                <div><span className="g-label">Average win</span><div className="g-value" style={{ fontSize: 18 }}>{plain(stats.avgWin)}</div></div>
                <div><span className="g-label">Average loss</span><div className="g-value" style={{ fontSize: 18 }}>{plain(stats.avgLoss)}</div></div>
                <div><span className="g-label">Win / loss size</span><div className="g-value" style={{ fontSize: 18 }}>{plain(stats.winLossRatio)}</div></div>
                <div><span className="g-label">Expectancy per trade</span><div className="g-value" style={{ fontSize: 18 }}>{plain(stats.expectancy)}</div></div>
              </div>
              <ul className="g-caption" style={{ paddingLeft: 18, marginTop: 10 }}>
                {stats.findings.map(f => <li key={f}>{f}</li>)}
              </ul>
            </>
          )}

          <details className="g-details">
            <summary>{trades.length} trade record{trades.length === 1 ? '' : 's'}</summary>
            {trades.length === 0 ? <p className="g-caption" style={{ marginTop: 6 }}>No trades recorded on this venue yet.</p> : (
              <table className="g-table" style={{ marginTop: 6 }}>
                <thead><tr>{['When', 'Symbol', 'Side', 'Size', 'Result', 'Why'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {[...trades].reverse().slice(0, 25).map(t => (
                    <tr key={`${t.id}-${t.closedAt ?? 'open'}`}>
                      <td className="g-mono" style={{ fontSize: 11 }}>{(t.closedAt ?? t.openedAt).slice(0, 16).replace('T', ' ')}</td>
                      <td>{t.symbol}</td>
                      <td>{t.side}</td>
                      <td className="num">{t.size} {t.sizeUnit}</td>
                      <td className="num" style={{ color: (t.pnl ?? 0) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                        {t.pnl === null ? 'open' : `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}`}
                      </td>
                      <td className="g-caption">{t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
          <p className="g-caption g-faint" style={{ marginTop: 8 }}>
            A positive expectancy on a few dozen trades is not a promise. It describes what already happened, on simulated money.
          </p>
        </Card>

        {/* ── Study base ───────────────────────────────────────────────────── */}
        <Card title="Study base" sub="The plain-English notes already written for you, read from the file rather than copied">
          {!study ? <EmptyState icon="📚" title="Reading…" body="Looking for the study base file." /> : !study.found ? (
            <Alert kind="error">{study.error}</Alert>
          ) : (
            <>
              <p className="g-caption" style={{ marginBottom: 8 }}>
                Read from <span className="g-mono">{study.source}</span>
                {study.modifiedAt ? `, last changed ${new Date(study.modifiedAt).toLocaleDateString()}` : ''}.
                Edit that file and this page shows the change.
              </p>
              <details className="g-details" open>
                <summary>Open the notes</summary>
                <pre className="g-inset" style={{ maxHeight: 520, overflow: 'auto', fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.55, marginTop: 6 }}>
                  {study.markdown}
                </pre>
              </details>
            </>
          )}
        </Card>

      </div>
    </div>
  )
}
