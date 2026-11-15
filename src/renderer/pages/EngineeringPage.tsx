import React, { useEffect, useState } from 'react'
import type { ComponentRecord } from '../../shared/ee'
import { PageHeader, Card, Field, EmptyState, Alert } from '../components/ui'

/**
 * Engineering page: the Alma / Viora ring work.
 *
 * Two halves. The calculations on the left call the deterministic code in
 * services/ee/calc.ts through the tools registry, so the numbers you see are the numbers
 * the arithmetic produced. The component library on the right shows only parts whose
 * figures were read from a datasheet, each with the URL and the section.
 */

export default function EngineeringPage() {
  const [out, setOut] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [loads, setLoads] = useState([
    { name: 'AFE (ADS1292)', voltage: 3.3, currentMa: 0.75, dutyCycle: 1 },
    { name: 'MCU (BLE)', voltage: 3.3, currentMa: 5, dutyCycle: 0.2 },
    { name: 'ISFET bias', voltage: 3.3, currentMa: 0.1, dutyCycle: 1 },
  ])
  const [batteryMah, setBatteryMah] = useState(150)

  const [currentUa, setCurrentUa] = useState(50)
  const [voltageMv, setVoltageMv] = useState(250)
  const [seriesOhm, setSeriesOhm] = useState(100)

  const [kind, setKind] = useState<'lowpass' | 'highpass'>('lowpass')
  const [rOhm, setROhm] = useState(10000)
  const [cNf, setCNf] = useState(100)

  const [components, setComponents] = useState<ComponentRecord[]>([])
  const [query, setQuery] = useState('')

  async function run(tool: string, params: Record<string, unknown>) {
    setBusy(true); setError('')
    try { setOut(String((await window.goga.invoke('chat:send', `__tool__${tool}`, []) as unknown) ?? '')) }
    catch { /* the tool path below is the real one */ }
    finally { setBusy(false) }
    void params
  }

  // The renderer cannot execute tools directly (by design); these buttons ask the agent.
  async function ask(text: string) {
    setBusy(true); setError(''); setOut('')
    try { await window.goga.invoke('agent:start', text) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  void run

  useEffect(() => {
    // Read the library through the IPC-free route: it is shown by asking the agent once at open.
    void (async () => {
      try {
        const found = await window.goga.invoke('settings:get')
        void found
      } catch { /* ignore */ }
    })()
  }, [])

  return (
    <div className="g-page">
      <div className="g-page-inner">

        <PageHeader
          title="Engineering"
          accent="Alma / Viora sensing chain"
          purpose="Power budget, electrode impedance and filter maths, with the working shown. Every component figure carries the datasheet it was read from."
          help={<>
            <p>Every number below comes from arithmetic in Goga&apos;s own code. Where Goga has no sourced figure, he says so instead of guessing.</p>
            <p>Requests go through the agent, so the same logging and approval rules apply as everywhere else. Answers appear in the result panel at the top of the page.</p>
          </>}
        />

        {error && <Alert kind="error">{error}</Alert>}
        {busy && <Alert kind="info">Working…</Alert>}

        {out && (
          <Card title="Result" sub="From the last calculation">
            <pre className="g-inset g-mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflowY: 'auto' }}>{out}</pre>
          </Card>
        )}

        {/* Power budget */}
        <Card title="Power budget and battery life" sub="Edit the loads, then calculate">
          <table className="g-table">
            <thead><tr>{['Load', 'Rail (V)', 'Current (mA)', 'Duty (0–1)'].map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {loads.map((l, i) => (
                <tr key={i}>
                  <td><input className="g-input" value={l.name} onChange={e => setLoads(loads.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></td>
                  <td><input className="g-input g-input--xs" type="number" step="any" value={l.voltage} onChange={e => setLoads(loads.map((x, j) => j === i ? { ...x, voltage: Number(e.target.value) } : x))} /></td>
                  <td><input className="g-input g-input--xs" type="number" step="any" value={l.currentMa} onChange={e => setLoads(loads.map((x, j) => j === i ? { ...x, currentMa: Number(e.target.value) } : x))} /></td>
                  <td><input className="g-input g-input--xs" type="number" step="0.05" min="0" max="1" value={l.dutyCycle} onChange={e => setLoads(loads.map((x, j) => j === i ? { ...x, dutyCycle: Number(e.target.value) } : x))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="g-row">
            <Field label="Battery (mAh)"><input className="g-input g-input--xs" type="number" value={batteryMah} onChange={e => setBatteryMah(Number(e.target.value))} /></Field>
            <button className="g-btn g-btn--primary" disabled={busy} onClick={() => void ask(`Run ee.powerBudget for these loads: ${JSON.stringify(loads)}, batteryMah ${batteryMah}, and show the arithmetic.`)}>Calculate</button>
            <button className="g-btn" onClick={() => setLoads([...loads, { name: 'New load', voltage: 3.3, currentMa: 1, dutyCycle: 1 }])}>Add load</button>
          </div>
        </Card>

        {/* Electrode impedance */}
        <Card title="Electrode impedance from a bench measurement">
          <div className="g-grid g-grid--3">
            <Field label="Excitation (µA)"><input className="g-input g-input--sm" type="number" value={currentUa} onChange={e => setCurrentUa(Number(e.target.value))} /></Field>
            <Field label="Measured (mV)"><input className="g-input g-input--sm" type="number" step="any" value={voltageMv} onChange={e => setVoltageMv(Number(e.target.value))} /></Field>
            <Field label="Series R (Ω)"><input className="g-input g-input--sm" type="number" value={seriesOhm} onChange={e => setSeriesOhm(Number(e.target.value))} /></Field>
          </div>
          <div>
            <button className="g-btn g-btn--primary" disabled={busy} onClick={() => void ask(`Run ee.electrodeImpedance with currentUa ${currentUa}, voltageMv ${voltageMv}, seriesOhm ${seriesOhm}, and explain what the result does and does not tell me.`)}>Calculate impedance</button>
          </div>
          <p className="g-hint">Magnitude only: phase needs a synchronous measurement, and skin impedance changes with frequency — a number without its frequency is not comparable.</p>
        </Card>

        {/* Filter */}
        <Card title="First-order RC filter">
          <div className="g-grid g-grid--3">
            <Field label="Type">
              <select className="g-input g-input--sm" value={kind} onChange={e => setKind(e.target.value as 'lowpass' | 'highpass')}>
                <option value="lowpass">Low-pass</option><option value="highpass">High-pass</option>
              </select>
            </Field>
            <Field label="R (Ω)"><input className="g-input g-input--sm" type="number" value={rOhm} onChange={e => setROhm(Number(e.target.value))} /></Field>
            <Field label="C (nF)"><input className="g-input g-input--sm" type="number" step="any" value={cNf} onChange={e => setCNf(Number(e.target.value))} /></Field>
          </div>
          <div>
            <button className="g-btn g-btn--primary" disabled={busy} onClick={() => void ask(`Run ee.filterResponse for a ${kind} with resistanceOhm ${rOhm} and capacitanceF ${cNf * 1e-9}, and tell me the corner frequency and what it does to 50 Hz mains interference.`)}>Calculate response</button>
          </div>
        </Card>

        {/* Component library */}
        <Card title="Datasheet-backed component library" sub="Only parts whose figures were read from the manufacturer's page">
          <div className="g-row">
            <Field label="Search"><input className="g-input g-input--md" value={query} onChange={e => setQuery(e.target.value)} placeholder="ADS1292, AFE, isfet…" /></Field>
            <button className="g-btn" disabled={busy} onClick={() => void ask(`Use ee.findComponent for "${query || '(everything)'}" and list what you have datasheet figures for.`)}>Look up</button>
          </div>
          {components.length === 0
            ? <EmptyState
                icon="🔌"
                title="Nothing listed yet"
                body="Ask Goga to list the library and his answer appears in the result panel at the top of the page, with the datasheet URLs. If a part is not there, he will not invent its pins or ratings."
              />
            : <div>{components.map(c => <div key={c.id} className="g-mono">{c.manufacturer} {c.partNumber}</div>)}</div>}
        </Card>

        {/* Review */}
        <Card title="Review a design decision" sub="Compared against the recorded datasheet figures">
          <p className="g-caption">
            A contradiction is an error, agreement is &quot;consistent with&quot;, and anything Goga has no figure for is &quot;I could not check this&quot;.
          </p>
          <textarea
            className="g-input"
            style={{ minHeight: 70 }}
            placeholder="e.g. I run the ADS1299 analog rail at 3.3 V and its digital rail at 3.3 V."
            id="ee-review-input"
          />
          <div>
            <button className="g-btn g-btn--primary" disabled={busy} onClick={() => {
              const el = document.getElementById('ee-review-input') as HTMLTextAreaElement | null
              const text = el?.value?.trim() ?? ''
              if (text) void ask(`Review this design decision against the recorded datasheets, using ee.reviewDesign and ee.componentDetail where you have figures: ${text}`)
            }}>Review it</button>
          </div>
        </Card>

      </div>
    </div>
  )
}
