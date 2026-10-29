import React, { useEffect, useState } from 'react'
import type { BacktestRequest, MarketsState, SimulationPeriod } from '../../shared/markets'

function Chart({ values, label }: { values: number[]; label: string }) {
  if (!values.length) return null
  const min = Math.min(...values), range = Math.max(...values) - min || 1
  return <svg role="img" aria-label={label} viewBox="0 0 800 160" style={{ width: '100%', maxHeight: 180, background: 'var(--surface2)' }}><title>{label}; min {min.toFixed(2)}, max {Math.max(...values).toFixed(2)}</title><polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={values.map((v, i) => `${i / Math.max(1, values.length - 1) * 790 + 5},${150 - (v - min) / range * 140}`).join(' ')} /></svg>
}
function Period({ name, period: p }: { name: string; period: SimulationPeriod }) {
  return <section><h3>{name}: {p.start} – {p.end}</h3><p>Equity {p.finalEquity.toFixed(2)} · Return {p.returnPct.toFixed(2)}% · Max drawdown {p.maxDrawdownPct.toFixed(2)}% · Mean exposure {p.exposurePct.toFixed(2)}%</p><Chart values={p.curve.map(v => v.equity)} label={`${name} portfolio equity`} /><p>Final cash {p.curve[p.curve.length - 1].cash.toFixed(2)} · Shares {p.curve[p.curve.length - 1].quantity}</p><details><summary>Trade journal ({p.trades.length} events)</summary><div style={{ overflowX: 'auto' }}><table><thead><tr>{['Date', 'Side', 'Shares', 'Fill', 'Fee', 'Cash', 'Reason'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{p.trades.map((t, i) => <tr key={i}><td>{t.date}</td><td>{t.side}</td><td>{t.quantity}</td><td>{t.price.toFixed(4)}</td><td>{t.fee.toFixed(2)}</td><td>{t.cash.toFixed(2)}</td><td>{t.reason}</td></tr>)}</tbody></table></div></details></section>
}
export default function MarketsPage() {
  const [state, setState] = useState<MarketsState>({ datasets: [], watchlist: [], latest: null })
  const [symbol, setSymbol] = useState(''), [selected, setSelected] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [config, setConfig] = useState<BacktestRequest>({ symbol: '', initialCash: 10000, quantity: 10, lookback: 20, feeBps: 10, slippageBps: 5, evaluationStart: '' })
  async function action(work: () => Promise<MarketsState>) {
    setBusy(true); setError('')
    try { setState(await work()) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  useEffect(() => { void action(() => window.goga.invoke('markets:state')) }, [])
  const data = state.datasets.find(d => d.symbol === selected)
  return <div style={{ padding: 24, overflowY: 'auto', width: '100%' }}><h2>Markets</h2><p>Local historical research and simulated trading. Live trading is disabled. Ask chat <code>/markets</code> for verified data and results.</p><p>Import daily CSV with exactly <code>date,close</code> headers, ISO dates in ascending order, one row per date. Use consistent currency and adjusted prices; imports are user supplied and not independently verified.</p>
    <label>Symbol <input value={symbol} maxLength={20} onChange={e => setSymbol(e.target.value.toUpperCase())} /></label>{' '}
    <label>Import CSV <input type="file" accept=".csv,text/csv" disabled={busy || !symbol} onChange={e => { const file = e.target.files?.[0]; if (!file) return; const name = symbol; void action(async () => { if (file.size > 2000000) throw new Error('CSV exceeds 2 MB.'); const result = await window.goga.invoke('markets:import', name, await file.text()); setSelected(name); return result }); e.target.value = '' }} /></label>
    <p role="status">{busy ? 'Working…' : ''}</p>{error && <p role="alert">{error}</p>}
    <h3>Watchlist</h3>{state.watchlist.length === 0 && <p>No symbols watched.</p>}{state.watchlist.map(s => <span key={s}><button onClick={() => setSelected(s)}>{s}</button><button aria-label={`Remove ${s} from watchlist`} disabled={busy} onClick={() => void action(() => window.goga.invoke('markets:watchlist', state.watchlist.filter(x => x !== s)))}>×</button>{' '}</span>)}
    <p><label>Imported dataset <select value={selected} onChange={e => setSelected(e.target.value)}><option value="">Select symbol</option>{state.datasets.map(d => <option key={d.symbol}>{d.symbol}</option>)}</select></label>{data && !state.watchlist.includes(selected) && <button disabled={busy} onClick={() => void action(() => window.goga.invoke('markets:watchlist', [...state.watchlist, selected]))}>Watch</button>}</p>
    {data && <><p>{data.source} · Imported {data.importedAt} · Through {data.bars[data.bars.length - 1].date} · {Date.now() - Date.parse(data.bars[data.bars.length - 1].date) > 3 * 86400000 ? 'STALE (>3 calendar days)' : 'Historical; not live'}</p><p>{data.bars[0].date} – {data.bars[data.bars.length - 1].date} · Last close {data.bars[data.bars.length - 1].close}</p><Chart values={data.bars.map(b => b.close)} label={`${selected} historical closes`} /></>}
    <h3>Moving-average simulation</h3><p>Buy a fixed quantity when the previous close exceeds its trailing mean; sell when at or below it. Fill at next recorded close with adverse slippage and fees on both sides. Each period starts with fresh cash and its own warmup. Open positions are marked at the final close. No dividends, taxes, interest or liquidity model.</p>
    <form onSubmit={e => { e.preventDefault(); void action(() => window.goga.invoke('markets:backtest', { ...config, symbol: selected })) }}>
      {(['initialCash', 'quantity', 'lookback', 'feeBps', 'slippageBps'] as const).map(key => <label key={key} style={{ display: 'inline-block', marginRight: 12 }}>{({ initialCash: 'Starting cash', quantity: 'Shares per buy', lookback: 'Lookback bars', feeBps: 'Fee (basis points)', slippageBps: 'Slippage (basis points)' })[key]} <input type="number" required step="any" value={config[key]} onChange={e => setConfig({ ...config, [key]: Number(e.target.value) })} style={{ width: 95 }} /></label>)}
      <p><label>Evaluation starts <input type="date" required value={config.evaluationStart} onChange={e => setConfig({ ...config, evaluationStart: e.target.value })} /></label> <button disabled={busy || !data}>Run simulation</button></p></form>
    {state.latest && <><h3>Latest simulated portfolio: {state.latest.config.symbol}</h3><p>Parameters: {JSON.stringify(state.latest.config)} · Data imported {state.latest.dataImportedAt}</p><Period name="Development" period={state.latest.development} /><Period name="Evaluation" period={state.latest.evaluation} /></>}
  </div>
}
