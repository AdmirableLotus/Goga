import React, { useCallback, useEffect, useState } from 'react'
import type {
  BacktestResult, JournalEntry, PaperRunState, ReviewResult, StrategyDefinition, StrategyId,
  StrategyPageState, StrategyParams, StrategySettings,
} from '../../shared/strategy'
import { PageHeader, Card, Field, EmptyState, Alert, Chip } from '../components/ui'

/**
 * Strategy page.
 *
 * Four things, in the order they matter: what the rules are, what they would have done
 * (backtest), what the paper loop is doing now, and what actually happened (journal).
 *
 * Nothing on this page sends an order. The paper loop prepares one paper intent and this
 * page asks for that intent by name before it sends it. Live trading is not reachable here
 * at all — that stays on the Trading page behind its own switch and the REAL MONEY phrase.
 */

const pct = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`
const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const when = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace('T', ' ')}Z` : '—')

const KIND_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'accent' | undefined> = {
  signal: 'accent', intent: 'warn', 'auto-approved': 'bad', 'awaiting-approval': 'warn',
  sent: 'ok', refused: 'bad', exit: undefined, note: undefined,
}

export default function StrategyPage() {
  const [state, setState] = useState<StrategyPageState | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const [selected, setSelected] = useState<StrategyId>('sma-cross')
  const [params, setParams] = useState<StrategyParams>({})
  const [symbol, setSymbol] = useState('SPY')
  const [days, setDays] = useState(400)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [review, setReview] = useState<ReviewResult | null>(null)

  const load = useCallback(async () => {
    try {
      const s = await window.goga.invoke('strategy:state')
      setState(s)
      return s
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return null }
  }, [])

  useEffect(() => {
    void load().then(s => {
      if (!s) return
      setSelected(s.settings.strategyId)
      setParams({ ...s.settings.params })
      setSymbol(s.settings.symbol)
    })
  }, [load])

  const definition: StrategyDefinition | null = state?.strategies.find(s => s.id === selected) ?? null

  function pickStrategy(id: StrategyId) {
    setSelected(id)
    setResult(null); setReview(null)
    const def = state?.strategies.find(s => s.id === id)
    // Start from the strategy's own defaults, not the previous strategy's parameters.
    const fresh: StrategyParams = {}
    for (const spec of def?.params ?? []) fresh[spec.key] = spec.default
    setParams(fresh)
  }

  const saveSettings = useCallback(async (patch: Partial<StrategySettings>) => {
    try {
      const next = await window.goga.invoke('strategy:saveSettings', patch)
      setState(next)
      setNotice('Saved.')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  async function runBacktest() {
    setBusy(true); setError(''); setNotice(''); setResult(null); setReview(null)
    try {
      const r = await window.goga.invoke('strategy:backtest', { strategyId: selected, symbol, params, days })
      setResult(r)
      if (r.warnings.length) setNotice(r.warnings[0])
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function runReview() {
    setBusy(true); setError(''); setNotice('')
    try { setReview(await window.goga.invoke('strategy:review', selected, symbol)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function setPaperRun(enabled: boolean) {
    try {
      const r: PaperRunState = await window.goga.invoke('strategy:setPaperRun', enabled)
      setNotice(enabled ? `Paper run ON, every ${state?.settings.intervalMinutes ?? 30} minutes. It prepares paper orders only.` : 'Paper run OFF.')
      setState(s => (s ? { ...s, paperRun: r, settings: { ...s.settings, paperRunEnabled: r.enabled } } : s))
      void load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function setAutoApprove(enabled: boolean) {
    try {
      const r: PaperRunState = await window.goga.invoke('strategy:setAutoApprove', enabled)
      setState(s => (s ? { ...s, paperRun: r, settings: { ...s.settings, autoApprovePaper: r.autoApprovePaper } } : s))
      setNotice(enabled
        ? 'Auto-approve PAPER is on: the loop will send paper orders without a click. Live orders are unaffected and still need approval.'
        : 'Auto-approve paper is off: the loop prepares a paper order and waits for you.')
      void load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function runOnce() {
    setBusy(true); setError(''); setNotice('')
    try { setNotice(await window.goga.invoke('strategy:runOnce')) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false); void load() }
  }

  async function approvePending() {
    setBusy(true); setError(''); setNotice('')
    try {
      const r = await window.goga.invoke('strategy:approvePending')
      if (r.ok) setNotice(r.message); else setError(r.message)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false); void load() }
  }

  async function discardPending() {
    try { setNotice((await window.goga.invoke('strategy:discardPending')).message) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { void load() }
  }

  const settings = state?.settings
  const live = state?.paperRun

  return (
    <div className="g-page">
      <div className="g-page-inner">

        <PageHeader
          title="Strategy"
          accent="rules, backtests and the paper journal"
          purpose="A rule the code can state, tested on real history, then run on paper and measured. Nothing here sends a live order."
          help={<>
            <p>A signal is decided on a bar&apos;s close and filled at the next bar&apos;s open, so the rules never see a price they could not have known. Slippage and commission are charged on every fill.</p>
            <p>The paper loop prepares one PAPER order at a time. With auto-approve off it waits for you; with it on, it sends that paper order without a click. Live trading is unaffected either way.</p>
          </>}
          actions={<>
            <Chip tone={live?.enabled ? 'ok' : undefined}>Paper run {live?.enabled ? 'ON' : 'off'}</Chip>
            <Chip tone={live?.autoApprovePaper ? 'warn' : undefined}>Auto-approve paper {live?.autoApprovePaper ? 'ON' : 'off'}</Chip>
            <Chip tone={state?.paperKeyStored ? 'ok' : 'bad'}>Paper key {state?.paperKeyStored ? 'stored' : 'missing'}</Chip>
            <button className="g-btn g-btn--sm" onClick={() => void load()} disabled={busy}>Refresh</button>
          </>}
        />

        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="ok">{notice}</Alert>}

        {!state && !error && <Card><p className="g-caption">Reading the strategy settings…</p></Card>}

        {/* ── 1. the rules ───────────────────────────────────────────────── */}
        {state && (
          <Card
            title="Strategies"
            sub="Pick one, change its parameters, and see exactly what it does"
            actions={<Chip>{state.strategies.length} available</Chip>}
          >
            <div className="g-seg" role="group" aria-label="Strategy">
              {state.strategies.map(s => (
                <button key={s.id} aria-pressed={selected === s.id} onClick={() => pickStrategy(s.id)}>{s.name}</button>
              ))}
            </div>

            {definition && (
              <>
                <p className="g-caption">{definition.summary}</p>
                <div className="g-inset">
                  <div style={{ fontSize: 'var(--fs-body)' }}><strong>Entry:</strong> {definition.entryRule}</div>
                  <div style={{ fontSize: 'var(--fs-body)', marginTop: 4 }}><strong>Exit:</strong> {definition.exitRule}</div>
                  <div className="g-caption" style={{ marginTop: 6 }}><strong>Sizing:</strong> {definition.sizing}</div>
                </div>

                <div className="g-grid g-grid--4">
                  {definition.params.map(spec => (
                    <Field key={spec.key} label={spec.label} hint={`${spec.min}–${spec.max}. ${spec.help}`}>
                      <input
                        className="g-input g-input--sm"
                        type="number"
                        min={spec.min}
                        max={spec.max}
                        step={spec.step}
                        value={params[spec.key] ?? spec.default}
                        onChange={e => setParams(p => ({ ...p, [spec.key]: Number(e.target.value) }))}
                      />
                    </Field>
                  ))}
                  <Field label="Interval (minutes)" hint="How often the paper loop checks the last closed bar.">
                    <input
                      className="g-input g-input--sm" type="number" min={5} max={1440}
                      value={settings?.intervalMinutes ?? 30}
                      onChange={e => void saveSettings({ intervalMinutes: Number(e.target.value) })}
                    />
                  </Field>
                </div>

                <div className="g-row">
                  <button className="g-btn g-btn--primary" onClick={() => void saveSettings({ strategyId: selected, symbol, params })}>
                    Save this strategy and its parameters
                  </button>
                  <span className="g-caption g-faint">
                    Saved settings apply to the next paper run. Risk {settings?.riskPct}% to the stop, cap {settings?.maxPositionPct}%.
                  </span>
                </div>

                <details className="g-details">
                  <summary>Risk and cost assumptions used by the backtest and the paper loop</summary>
                  <div className="g-grid g-grid--4" style={{ marginTop: 8 }}>
                    <Field label="Risk % to stop">
                      <input className="g-input g-input--xs" type="number" min={0.1} max={10} step={0.1}
                        defaultValue={settings?.riskPct}
                        onBlur={e => void saveSettings({ riskPct: Number(e.target.value) })} />
                    </Field>
                    <Field label="Max % per position">
                      <input className="g-input g-input--xs" type="number" min={1} max={100}
                        defaultValue={settings?.maxPositionPct}
                        onBlur={e => void saveSettings({ maxPositionPct: Number(e.target.value) })} />
                    </Field>
                    <Field label="Stop × ATR">
                      <input className="g-input g-input--xs" type="number" min={0} max={10} step={0.5}
                        defaultValue={settings?.stopAtrMultiple}
                        onBlur={e => void saveSettings({ stopAtrMultiple: Number(e.target.value) })} />
                    </Field>
                    <Field label="Slippage (bps)">
                      <input className="g-input g-input--xs" type="number" min={0} max={200}
                        defaultValue={settings?.slippageBps}
                        onBlur={e => void saveSettings({ slippageBps: Number(e.target.value) })} />
                    </Field>
                  </div>
                  <p className="g-caption g-faint" style={{ marginTop: 6 }}>
                    A stop of 0 turns the stop off. These are the same numbers the Trading page limits sit on top of; nothing here raises them.
                  </p>
                </details>
              </>
            )}
          </Card>
        )}

        {/* ── 2. backtest ────────────────────────────────────────────────── */}
        {state && (
          <Card title="Backtest" sub="What these exact rules would have done on this history">
            <div className="g-row">
              <Field label="Symbol"><input className="g-input g-input--sm" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} maxLength={10} /></Field>
              <Field label="Days of daily bars" hint="Maximum 1000."><input className="g-input g-input--sm" type="number" min={60} max={1000} value={days} onChange={e => setDays(Number(e.target.value))} /></Field>
              <button className="g-btn g-btn--primary" onClick={() => void runBacktest()} disabled={busy || !symbol.trim()}>
                {busy ? 'Running…' : 'Run backtest'}
              </button>
              <button className="g-btn" onClick={() => void runReview()} disabled={busy}>
                Compare with paper results
              </button>
              <span className="g-caption g-faint">Places no order.</span>
            </div>

            {!result && (
              <EmptyState
                icon="📊"
                title="No backtest yet"
                body={state.paperKeyStored
                  ? 'Run one to see the trades, the win rate and the drawdown for this strategy on this symbol.'
                  : 'No Alpaca paper key is stored, so a backtest will use a clearly-labelled synthetic series rather than market data. Add a paper key on the Trading page for real history.'}
              />
            )}

            {result && (
              <>
                <Alert kind={result.dataSource === 'synthetic' ? 'info' : 'ok'}>
                  Data source: {result.dataSource === 'alpaca' ? 'Alpaca market data' : result.dataSource === 'cache' ? 'a saved copy of real bars' : 'SYNTHETIC — not market data'}. {result.dataNote}
                </Alert>

                <div className="g-grid g-grid--4">
                  {[
                    ['Return', pct(result.totalReturn)],
                    ['Buy and hold', pct(result.buyHoldReturn)],
                    ['Worst drawdown', `${(result.maxDrawdown * 100).toFixed(2)}%`],
                    ['Trades', String(result.tradeCount)],
                    ['Win rate', `${(result.winRate * 100).toFixed(0)}%`],
                    ['Profit factor', Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : 'no losses'],
                    ['Exposure', `${(result.exposure * 100).toFixed(0)}%`],
                    ['Ending equity', money(result.endingEquity)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <span className="g-label">{label}</span>
                      <div className="g-value" style={{ fontSize: 18 }}>{value}</div>
                    </div>
                  ))}
                </div>

                <p className="g-caption">
                  {result.symbol}: {result.barCount} bars, {result.from.slice(0, 10)} to {result.to.slice(0, 10)}.
                  Average win {money(result.avgWin)}, average loss {money(result.avgLoss)}.
                </p>

                {result.warnings.length > 0 && (
                  <Alert kind="info">
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {result.warnings.map(w => <li key={w}>{w}</li>)}
                    </ul>
                  </Alert>
                )}

                {result.trades.length > 0 && (
                  <details className="g-details">
                    <summary>{result.trades.length} trade(s), newest last</summary>
                    <table className="g-table" style={{ marginTop: 8 }}>
                      <thead>
                        <tr>{['Entry', 'Exit', 'Qty', 'Entry $', 'Exit $', 'P/L', '%', 'Bars', 'Why out'].map(h => <th key={h}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {result.trades.slice(-40).map((t, i) => (
                          <tr key={`${t.entryIndex}-${i}`}>
                            <td>{t.entryTime.slice(0, 10)}</td>
                            <td>{t.exitTime.slice(0, 10)}</td>
                            <td className="num">{t.qty}</td>
                            <td className="num">{t.entryPrice.toFixed(2)}</td>
                            <td className="num">{t.exitPrice.toFixed(2)}</td>
                            <td className="num" style={{ color: t.pnl >= 0 ? 'var(--success)' : 'var(--danger)' }}>{money(t.pnl)}</td>
                            <td className="num">{pct(t.pnlPct)}</td>
                            <td className="num">{t.barsHeld}</td>
                            <td>{t.exitReason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}

                <details className="g-details">
                  <summary>What this result assumes</summary>
                  <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, marginTop: 4 }}>
                    {result.assumptions.map(a => <li key={a}>{a}</li>)}
                  </ul>
                </details>
              </>
            )}

            {review && (
              <div className="g-inset">
                <div className="g-section-title" style={{ marginBottom: 6 }}>
                  Paper vs backtest — {review.verdict.replace(/-/g, ' ')}
                </div>
                <p style={{ fontSize: 'var(--fs-body)' }}>{review.headline}</p>
                <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, marginTop: 6 }}>
                  {review.findings.map(f => <li key={f}>{f}</li>)}
                </ul>
              </div>
            )}
          </Card>
        )}

        {/* ── 3. paper run ───────────────────────────────────────────────── */}
        {state && (
          <Card
            title="Paper run"
            sub="Runs the saved strategy on the paper account only"
            actions={<Chip tone={live?.enabled ? 'ok' : undefined}>{live?.enabled ? `next ${when(live.nextRunAt)}` : 'stopped'}</Chip>}
          >
            <div className="g-row" style={{ alignItems: 'center' }}>
              <button
                className={live?.enabled ? 'g-btn g-btn--risk' : 'g-btn g-btn--primary'}
                onClick={() => void setPaperRun(!live?.enabled)}
              >
                {live?.enabled ? 'Turn paper run OFF' : 'Turn paper run ON'}
              </button>
              <button className="g-btn" onClick={() => void runOnce()} disabled={busy || !live?.enabled}>Run one pass now</button>
              <Field label="Auto-approve paper orders">
                <input
                  type="checkbox"
                  checked={!!live?.autoApprovePaper}
                  onChange={e => void setAutoApprove(e.target.checked)}
                  aria-label="Auto-approve paper orders"
                />
              </Field>
            </div>

            <p className="g-caption">
              With auto-approve off, a signal becomes a prepared paper order and waits here for you. With it on, that paper order is sent
              without a click — and the journal records the moment you turned it on. It can never apply to a live order.
            </p>

            {live?.lastResult && <Alert kind="info">{live.lastResult}</Alert>}

            {live?.pendingIntent ? (
              <div className="g-inset" style={{ borderColor: 'var(--accent-line)' }}>
                <div className="g-section-title" style={{ marginBottom: 6 }}>Waiting for your approval</div>
                <p style={{ fontSize: 15, fontWeight: 600 }}>{live.pendingIntent.confirmation}</p>
                <p className="g-caption g-faint">Intent <span className="g-mono">{live.pendingIntent.intentId}</span> · expires {when(live.pendingIntent.expiresAt)}</p>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="g-btn g-btn--danger" onClick={() => void approvePending()} disabled={busy}>Approve and send this PAPER order</button>
                  <button className="g-btn" onClick={() => void discardPending()} disabled={busy}>Discard</button>
                </div>
              </div>
            ) : (
              <p className="g-caption g-faint">No paper order is waiting.</p>
            )}

            {!state.paperKeyStored && (
              <Alert kind="error">No Alpaca paper key is stored, so the paper loop cannot place anything. Add one on the Trading page.</Alert>
            )}
          </Card>
        )}

        {/* ── 4. performance + journal ───────────────────────────────────── */}
        {state && (
          <Card title="Results so far" sub="Closed paper trades only, from the journal">
            {state.summaries.length === 0 ? (
              <EmptyState icon="🧾" title="No closed paper trades yet" body="A trade appears here once the paper loop has opened and closed a position. Backtest results do not count as paper results." />
            ) : (
              <table className="g-table">
                <thead>
                  <tr>{['Strategy', 'Symbol', 'Closed', 'Win rate', 'Total P/L', 'Avg win', 'Avg loss', 'Avg %', 'Last trade'].map(h => <th key={h}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {state.summaries.map(s => (
                    <tr key={`${s.strategyId}-${s.symbol}`}>
                      <td>{s.strategyId}</td>
                      <td>{s.symbol}</td>
                      <td className="num">{s.closedTrades}</td>
                      <td className="num">{(s.winRate * 100).toFixed(0)}%</td>
                      <td className="num" style={{ color: s.totalPnl >= 0 ? 'var(--success)' : 'var(--danger)' }}>{money(s.totalPnl)}</td>
                      <td className="num">{money(s.avgWin)}</td>
                      <td className="num">{money(s.avgLoss)}</td>
                      <td className="num">{pct(s.avgPnlPct)}</td>
                      <td>{when(s.lastTradeAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {state.baselines.length > 0 && (
              <details className="g-details">
                <summary>Saved backtests the review compares against ({state.baselines.length})</summary>
                <table className="g-table" style={{ marginTop: 8 }}>
                  <thead><tr>{['Strategy', 'Symbol', 'Saved', 'Trades', 'Win rate', 'Avg trade', 'Total'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    {state.baselines.map(b => (
                      <tr key={`${b.strategyId}-${b.symbol}`}>
                        <td>{b.strategyId}</td>
                        <td>{b.symbol}</td>
                        <td>{when(b.at)}</td>
                        <td className="num">{b.tradeCount}</td>
                        <td className="num">{(b.winRate * 100).toFixed(0)}%</td>
                        <td className="num">{pct(b.avgTradePct)}</td>
                        <td className="num">{pct(b.totalReturn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </Card>
        )}

        {state && (
          <Card title="Trade journal" sub="Every signal, prepared order, approval, refusal and closed trade, with the reason">
            {state.journal.length === 0 ? (
              <EmptyState icon="📓" title="The journal is empty" body="Entries appear when the paper loop looks at the market: every signal, prepared order, approval, refusal and closed trade, including the passes that do nothing. A backtest does not write here — it is a test, not a trade." />
            ) : (
              <div className="g-inset g-mono" style={{ maxHeight: 320, overflowY: 'auto', fontSize: 11.5 }}>
                {state.journal.map((e: JournalEntry) => (
                  <div key={e.id} style={{ padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                    <span className="g-faint">{when(e.time)}</span>{' '}
                    <Chip tone={KIND_TONE[e.kind]}>{e.kind}</Chip>{' '}
                    <span className="g-faint">{e.mode}</span> {e.strategyId} {e.symbol} {e.side ?? ''} {e.qty ?? ''} — {e.reason}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

      </div>
    </div>
  )
}
