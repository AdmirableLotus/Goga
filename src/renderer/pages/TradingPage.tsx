import React, { useCallback, useEffect, useState } from 'react'
import type {
  BrokerMode, BrokerSnapshot, OrderAuditEntry, OrderIntent, OrderAuditEntry as Audit, RiskLimitsView,
} from '../../shared/broker'
import { PageHeader, Card, Field, EmptyState, Alert, Chip } from '../components/ui'

/**
 * Trading page: the Alpaca broker.
 *
 * Three panels: what the account looks like right now (read from Alpaca), the order
 * builder, which only ever PREPARES an order and then asks twice (approve, then send),
 * and the kill switch with the limits and the audit log.
 *
 * Live trading has its own switch that needs the phrase "REAL MONEY" typed in. That is
 * a deliberate extra step: nothing here places a real order by accident.
 */

function money(n: number): string {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default function TradingPage() {
  const [mode, setMode] = useState<BrokerMode>('paper')
  const [snap, setSnap] = useState<BrokerSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [audit, setAudit] = useState<OrderAuditEntry[]>([])

  // Order builder
  const [symbol, setSymbol] = useState('AAPL')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [qty, setQty] = useState('1')
  const [useNotional, setUseNotional] = useState(false)
  const [notional, setNotional] = useState('100')
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market')
  const [limitPrice, setLimitPrice] = useState('')
  const [reason, setReason] = useState('')
  const [intent, setIntent] = useState<OrderIntent | null>(null)

  // Keys
  const [paperId, setPaperId] = useState(''), [paperSecret, setPaperSecret] = useState('')
  const [liveId, setLiveId] = useState(''), [liveSecret, setLiveSecret] = useState('')
  const [phrase, setPhrase] = useState('')

  const refresh = useCallback(async (m: BrokerMode) => {
    setBusy(true); setError('')
    try { setSnap(await window.goga.invoke('broker:snapshot', m)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
    try { setAudit(await window.goga.invoke('broker:audit', 40)) } catch { /* audit is optional */ }
  }, [])

  useEffect(() => { void refresh(mode) }, [mode, refresh])

  async function prepare() {
    setBusy(true); setError(''); setNotice(''); setIntent(null)
    try {
      const built = await window.goga.invoke('broker:prepare', {
        mode, symbol, side,
        qty: useNotional ? null : Number(qty),
        notional: useNotional ? Number(notional) : null,
        orderType, limitPrice: orderType === 'limit' ? Number(limitPrice) : null,
        reason,
      })
      setIntent(built)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  async function send() {
    if (!intent) return
    setBusy(true); setError('')
    try {
      const r = await window.goga.invoke('broker:send', intent.id)
      setNotice(r.message)
      if (r.ok) setIntent(null)
      else setError(r.message)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false); void refresh(mode) }
  }

  async function kill() {
    setError(''); setNotice('')
    try {
      const r = await window.goga.invoke('broker:kill', mode, 'Kill switch pressed in the Trading page')
      setNotice(r.message)
      setIntent(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { void refresh(mode) }
  }

  const limits: RiskLimitsView | null = snap?.limits ?? null
  const acct = snap?.account ?? null
  const creds = snap?.credentials

  return (
    <div className="g-page">
      <div className="g-page-inner">

        <PageHeader
          title="Trading"
          accent="Alpaca broker"
          purpose="Paper trading by default. Real money needs a stored live key, live trading switched on with the phrase, and your approval of each order."
          help={<>
            <p>Goga never guesses a credential and never sends an order he prepared without your say-so. Preparing an order sends nothing: you get a confirmation line with symbol, side, quantity, order type, estimated price and dollar value, and it expires after two minutes.</p>
            <p>Limits: {limits ? `${limits.maxPositionPct}% max per position · ${limits.maxOpenPositions} max positions · ${money(limits.maxOrderNotional)} max per order · halt at ${limits.dailyLossPct}% daily loss` : 'read from the broker snapshot'}. Change them in Settings → Trading.</p>
          </>}
          actions={<>
            <div className="g-seg" role="group" aria-label="Account mode">
              {(['paper', 'live'] as BrokerMode[]).map(m => (
                <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
                  {m === 'paper' ? 'Paper' : 'Live'}
                </button>
              ))}
            </div>
            <button className="g-btn g-btn--sm" onClick={() => void refresh(mode)} disabled={busy}>{busy ? 'Reading…' : 'Refresh'}</button>
            <button className="g-btn g-btn--risk g-btn--sm" onClick={() => void kill()} title="Cancel all orders and stop trading">
              ⛔ Kill switch
            </button>
          </>}
        />

        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="ok">{notice}</Alert>}

        {creds?.halted && (
          <Alert kind="error">
            <span style={{ flex: 1 }}>
              <strong>Kill switch is on.</strong> {creds.haltReason ?? ''} No order can be prepared or sent until you clear it.
            </span>
            <button className="g-btn g-btn--sm" onClick={async () => {
              try { setNotice((await window.goga.invoke('broker:clearKill')).message) } catch (e) { setError(String(e)) }
              void refresh(mode)
            }}>Clear kill switch</button>
          </Alert>
        )}

        {/* ── Account ─────────────────────────────────────────────────────── */}
        <Card
          title={mode === 'live' ? 'Live account' : 'Paper account'}
          sub={mode === 'live' ? 'Real money' : 'Fake money — nothing here can lose you a cent'}
          actions={acct && (
            <Chip tone={acct.dayPnl >= 0 ? 'ok' : 'bad'}>
              {acct.dayPnl >= 0 ? '+' : ''}{money(acct.dayPnl)} ({acct.dayPnlPct.toFixed(2)}%)
            </Chip>
          )}
        >
          {!acct ? (
            <EmptyState
              icon="🔑"
              title={snap?.error ? 'No account to read' : 'Reading the account…'}
              body={snap?.error ?? 'Goga is asking Alpaca for the account and positions.'}
              action={!creds?.paper && (
                <span className="g-caption">Add a paper key below to connect an account.</span>
              )}
            />
          ) : (
            <>
              <div className="g-grid g-grid--4">
                <div>
                  <span className="g-label">Equity</span>
                  <div className="g-value" style={{ fontSize: 18 }}>{money(acct.equity)}</div>
                </div>
                <div>
                  <span className="g-label">Cash</span>
                  <div className="g-value" style={{ fontSize: 18 }}>{money(acct.cash)}</div>
                </div>
                <div>
                  <span className="g-label">Buying power</span>
                  <div className="g-value" style={{ fontSize: 18 }}>{money(acct.buyingPower)}</div>
                </div>
                <div>
                  <span className="g-label">Open positions</span>
                  <div className="g-value" style={{ fontSize: 18 }}>{snap!.positions.length}</div>
                </div>
              </div>

              {acct.tradingBlocked && <Alert kind="error">Trading is blocked: {acct.blockedReason}</Alert>}

              <hr className="g-divider" />

              {snap!.positions.length === 0 ? (
                <EmptyState
                  icon="📉"
                  title="No open positions"
                  body="Nothing is held in this account right now. Prepare an order below to open one."
                />
              ) : (
                <table className="g-table">
                  <thead>
                    <tr>{['Symbol', 'Qty', 'Avg entry', 'Price', 'Value', 'P/L', '% of account'].map(h => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {snap!.positions.map(p => (
                      <tr key={p.symbol}>
                        <td style={{ fontWeight: 600 }}>{p.symbol}</td>
                        <td className="num">{p.qty}</td>
                        <td className="num">{p.avgEntryPrice.toFixed(2)}</td>
                        <td className="num">{p.currentPrice.toFixed(2)}</td>
                        <td className="num">{money(p.marketValue)}</td>
                        <td className="num" style={{ color: p.unrealizedPl >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                          {p.unrealizedPl >= 0 ? '+' : ''}{money(p.unrealizedPl)} ({p.unrealizedPlPct.toFixed(1)}%)
                        </td>
                        <td className="num">{p.exposurePct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {snap!.openOrders.length > 0 && (
                <details className="g-details">
                  <summary>{snap!.openOrders.length} open order(s)</summary>
                  <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, marginTop: 6 }}>
                    {snap!.openOrders.map(o => <li key={o.id}><span className="g-mono">{o.id}</span>: {o.side} {o.qty ?? money(o.notional ?? 0)} {o.symbol} {o.type} — {o.status}</li>)}
                  </ul>
                </details>
              )}
            </>
          )}
        </Card>

        {/* ── Order builder ──────────────────────────────────────────────── */}
        <Card title="Place an order" sub="Preparing sends nothing — you confirm before anything leaves this machine">
          <div className="g-grid g-grid--4">
            <Field label="Symbol">
              <input className="g-input g-input--sm" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} maxLength={10} />
            </Field>
            <Field label="Side">
              <select className="g-input g-input--sm" value={side} onChange={e => setSide(e.target.value as 'buy' | 'sell')}>
                <option value="buy">Buy</option><option value="sell">Sell</option>
              </select>
            </Field>
            <Field label="Size by">
              <select className="g-input g-input--sm" value={useNotional ? 'notional' : 'qty'} onChange={e => setUseNotional(e.target.value === 'notional')}>
                <option value="qty">Share quantity</option><option value="notional">Dollar amount</option>
              </select>
            </Field>
            {useNotional
              ? <Field label="Dollar amount"><input className="g-input g-input--sm" type="number" min="1" value={notional} onChange={e => setNotional(e.target.value)} /></Field>
              : <Field label="Shares"><input className="g-input g-input--sm" type="number" min="0" step="any" value={qty} onChange={e => setQty(e.target.value)} /></Field>}
            <Field label="Order type">
              <select className="g-input g-input--sm" value={orderType} onChange={e => setOrderType(e.target.value as 'market' | 'limit')}>
                <option value="market">Market</option><option value="limit">Limit</option>
              </select>
            </Field>
            {orderType === 'limit' && (
              <Field label="Limit price"><input className="g-input g-input--sm" type="number" min="0" step="any" value={limitPrice} onChange={e => setLimitPrice(e.target.value)} /></Field>
            )}
          </div>

          <Field label="Why this trade" hint="Kept in the audit log. At least 10 characters — it is the record of your reasoning.">
            <input className="g-input g-input--xl" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. breakout above the 50-day average with volume" />
          </Field>

          <div>
            <button className="g-btn g-btn--primary" disabled={busy || !symbol || reason.trim().length < 10} onClick={() => void prepare()}>
              Prepare order
            </button>
            <span className="g-hint" style={{ display: 'inline', marginLeft: 10 }}>Sends nothing.</span>
          </div>

          {intent && (
            <div className="g-inset" style={{ borderColor: 'var(--accent-line)', background: 'var(--surface-3)' }}>
              <div className="g-section-title" style={{ marginBottom: 8 }}>Confirm this order</div>
              <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{intent.confirmation}</p>
              <p className="g-caption">{intent.reason}</p>
              <details className="g-details">
                <summary>Checks that passed</summary>
                <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, marginTop: 4 }}>{intent.checks.map(c => <li key={c}>{c}</li>)}</ul>
              </details>
              <p className="g-caption g-faint" style={{ marginTop: 8 }}>
                Intent <span className="g-mono">{intent.id}</span> · expires {new Date(intent.expiresAt).toLocaleTimeString()}
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="g-btn g-btn--danger" disabled={busy} onClick={() => void send()}>
                  {intent.mode === 'live' ? 'Approve and send REAL-MONEY order' : 'Approve and send paper order'}
                </button>
                <button className="g-btn" disabled={busy} onClick={async () => {
                  try { await window.goga.invoke('broker:approve', intent.id, false) } catch { /* recorded in main */ }
                  setIntent(null); setNotice('Order discarded. Nothing was sent.')
                }}>Cancel</button>
              </div>
            </div>
          )}
        </Card>

        {/* ── Limits + keys + live switch ────────────────────────────────── */}
        <Card title="Limits and credentials" sub="Keys are encrypted with this Windows account and never leave the machine">
          <div className="g-row" style={{ gap: 8 }}>
            <Chip tone={creds?.paper ? 'ok' : undefined}>Paper key {creds?.paper ? 'stored' : 'not stored'}</Chip>
            <Chip tone={creds?.live ? 'ok' : undefined}>Live key {creds?.live ? 'stored' : 'not stored'}</Chip>
            <Chip tone={creds?.liveEnabled ? 'warn' : undefined}>Live trading {creds?.liveEnabled ? 'ON' : 'off'}</Chip>
            <Chip tone={creds?.encryptionAvailable ? 'ok' : 'bad'}>Encryption {creds?.encryptionAvailable ? 'available' : 'unavailable'}</Chip>
          </div>

          {!creds?.paper && (
            <>
              <hr className="g-divider" />
              <div className="g-section-title" style={{ marginBottom: 8 }}>Add a paper key</div>
              <p className="g-caption" style={{ marginBottom: 10 }}>
                Free at alpaca.markets → Paper Trading → API Keys. The key id starts with <span className="g-mono">PK</span>.
              </p>
              <div className="g-row">
                <Field label="Key id"><input className="g-input g-input--md" placeholder="PK…" value={paperId} onChange={e => setPaperId(e.target.value)} /></Field>
                <Field label="Secret"><input className="g-input g-input--md" type="password" placeholder="paper secret" value={paperSecret} onChange={e => setPaperSecret(e.target.value)} /></Field>
                <button className="g-btn" disabled={!paperId || !paperSecret} onClick={async () => {
                  const r = await window.goga.invoke('broker:savePaperKeys', paperId, paperSecret)
                  if (!r.ok) setError(r.error ?? 'could not save'); else { setNotice('Paper key stored (encrypted).'); setPaperId(''); setPaperSecret('') }
                  void refresh(mode)
                }}>Save paper key</button>
              </div>
            </>
          )}

          <hr className="g-divider" />

          <div className="g-section-title" style={{ marginBottom: 8 }}>Real-money trading</div>
          <p className="g-caption" style={{ marginBottom: 10 }}>
            Off by default. Needs your own live key (id starts with <span className="g-mono">AK</span>) and the words
            <strong> REAL MONEY</strong> typed below. Even switched on, each real order still needs your approval of that exact order.
          </p>
          {creds?.liveEnabled
            ? <button className="g-btn g-btn--risk" onClick={async () => { await window.goga.invoke('broker:setLive', false, ''); void refresh(mode) }}>Switch live trading OFF</button>
            : (
              <div className="g-row">
                <Field label="Live key id"><input className="g-input g-input--md" placeholder="AK…" value={liveId} onChange={e => setLiveId(e.target.value)} /></Field>
                <Field label="Live secret"><input className="g-input g-input--md" type="password" placeholder="live secret" value={liveSecret} onChange={e => setLiveSecret(e.target.value)} /></Field>
                <button className="g-btn" disabled={!liveId || !liveSecret} onClick={async () => {
                  const r = await window.goga.invoke('broker:saveLiveKeys', liveId, liveSecret)
                  if (!r.ok) setError(r.error ?? 'could not save'); else { setNotice('Live key stored (encrypted).'); setLiveId(''); setLiveSecret('') }
                  void refresh(mode)
                }}>Save live key</button>
                <Field label="Confirmation phrase"><input className="g-input g-input--sm" placeholder="REAL MONEY" value={phrase} onChange={e => setPhrase(e.target.value)} /></Field>
                <button className="g-btn g-btn--risk" disabled={phrase.trim().toUpperCase() !== 'REAL MONEY'} onClick={async () => {
                  try { const r = await window.goga.invoke('broker:setLive', true, phrase); setNotice(r.message); setPhrase('') }
                  catch (e) { setError(e instanceof Error ? e.message : String(e)) }
                  void refresh(mode)
                }}>Switch live trading ON</button>
              </div>
            )}
        </Card>

        {/* ── Audit ──────────────────────────────────────────────────────── */}
        <Card title="Order audit log" sub="Intent → approval → send, plus every refusal and error, newest last">
          {audit.length === 0
            ? <EmptyState icon="🧾" title="Nothing logged yet" body="Every prepared, approved, refused or failed order is written here. Prepare an order above to start the record." />
            : <div className="g-inset g-mono" style={{ maxHeight: 260, overflowY: 'auto', fontSize: 11.5 }}>
              {audit.map((e: Audit) => (
                <div key={e.id} style={{ padding: '2px 0', color: e.stage === 'error' || e.stage === 'refused' ? 'var(--danger)' : e.stage === 'sent' ? 'var(--success)' : 'var(--text-muted)' }}>
                  {e.time.slice(0, 19).replace('T', ' ')} [{e.stage}] {e.mode} {e.symbol ?? ''} {e.side ?? ''} {e.qty ?? (e.notional ? money(e.notional) : '')} — {e.detail}
                </div>
              ))}
            </div>}
        </Card>

      </div>
    </div>
  )
}
