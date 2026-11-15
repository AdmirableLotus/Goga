import { ToolRegistry } from './registry'
import { powerBudget, electrodeImpedance, filterResponse } from '../services/ee/calc'
import { findComponents, getComponent, sourceProblem } from '../services/ee/components'
import { reviewDesign, type DesignClaim } from '../services/ee/review'

/**
 * Electrical-engineering tools.
 *
 * Two rules the code enforces rather than the prompt asking for:
 *   - a component figure is only reported with its datasheet URL and the section it came
 *     from (components.ts refuses to store a record without a URL);
 *   - every calculation is done by ee/calc.ts and returned with its working shown.
 */

const reg = ToolRegistry.getInstance()
const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })

const stepsText = (r: ReturnType<typeof powerBudget>) => [
  r.title,
  '',
  ...r.steps.map(s => `  ${s.label}: ${s.expression} = ${s.value}`),
  '',
  'Result:',
  ...Object.entries(r.result).map(([k, v]) => `  ${k}: ${v}`),
  '',
  'Assumptions and limits:',
  ...r.assumptions.map(a => `  - ${a}`),
].join('\n')

reg.register({
  name: 'ee.powerBudget',
  description: 'Add up a design\'s power: each load\'s voltage, current and duty cycle, the total, and the battery runtime. Arithmetic is done in code and shown step by step. Use this instead of estimating watt-hours in your head.',
  parameters: {
    type: 'object',
    properties: {
      loads: { type: 'array', description: 'Loads: [{"name":"AFE","voltage":3.3,"currentMa":1.2,"dutyCycle":0.5}] — dutyCycle 0..1 is optional (default 1).' },
      batteryMah: { type: 'number', description: 'Battery capacity in mAh, for a runtime estimate. Optional.' },
      usableFraction: { type: 'number', description: 'Fraction of the rated capacity actually usable (default 0.8).' },
      regulatorEfficiency: { type: 'number', description: 'Regulator efficiency as a fraction (default 0.85).' },
    },
    required: ['loads'],
  },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  try {
    const loads = Array.isArray(p.loads) ? (p.loads as Record<string, unknown>[]).map(l => ({
      name: String(l.name ?? 'load'),
      voltage: Number(l.voltage),
      currentMa: Number(l.currentMa),
      dutyCycle: l.dutyCycle === undefined ? undefined : Number(l.dutyCycle),
      note: l.note === undefined ? undefined : String(l.note),
    })) : []
    if (!loads.length) return { success: false, error: 'give at least one load' }
    if (loads.some(l => !Number.isFinite(l.voltage) || l.voltage <= 0 || !Number.isFinite(l.currentMa) || l.currentMa < 0)) {
      return { success: false, error: 'every load needs a positive voltage and a current of zero or more' }
    }
    return { success: true, data: stepsText(powerBudget({ loads, batteryMah: p.batteryMah === undefined ? undefined : Number(p.batteryMah), usableFraction: p.usableFraction === undefined ? undefined : Number(p.usableFraction), regulatorEfficiency: p.regulatorEfficiency === undefined ? undefined : Number(p.regulatorEfficiency) })) }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'ee.electrodeImpedance',
  description: 'Work out electrode/contact impedance from an excitation current and the measured differential voltage, with the arithmetic shown. Returns magnitude only — it says so, because phase needs a synchronous measurement.',
  parameters: {
    type: 'object',
    properties: {
      currentUa: { type: 'number', description: 'Excitation current in microamps (e.g. 10 to 100).' },
      voltageMv: { type: 'number', description: 'Measured differential voltage in millivolts.' },
      seriesOhm: { type: 'number', description: 'Series resistance of wiring and contact, ohms. Optional.' },
    },
    required: ['currentUa', 'voltageMv'],
  },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  try {
    const i = Number(p.currentUa), v = Number(p.voltageMv)
    if (!(i > 0)) return { success: false, error: 'the excitation current must be above zero' }
    if (!(v >= 0)) return { success: false, error: 'the measured voltage must be zero or more' }
    return { success: true, data: stepsText(electrodeImpedance({ currentUa: i, voltageMv: v, seriesOhm: p.seriesOhm === undefined ? undefined : Number(p.seriesOhm) })) }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'ee.filterResponse',
  description: 'First-order RC low-pass or high-pass: corner frequency from R and C, time constant, and the response at several frequencies in dB. Arithmetic in code, shown.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['lowpass', 'highpass'], description: 'lowpass or highpass.' },
      resistanceOhm: { type: 'number', description: 'Resistance in ohms.' },
      capacitanceF: { type: 'number', description: 'Capacitance in farads (e.g. 1e-7 for 100 nF).' },
    },
    required: ['kind', 'resistanceOhm', 'capacitanceF'],
  },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  try {
    const r = Number(p.resistanceOhm), c = Number(p.capacitanceF)
    if (!(r > 0) || !(c > 0)) return { success: false, error: 'resistance and capacitance must both be above zero' }
    return { success: true, data: stepsText(filterResponse({ kind: p.kind === 'highpass' ? 'highpass' : 'lowpass', resistanceOhm: r, capacitanceF: c })) }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'ee.findComponent',
  description: 'Search the datasheet-backed component library for a part, or list what is in it. Every figure returned carries the datasheet URL and the section it came from. If a part is not in the library, say you have no datasheet figures for it — never guess a pinout or rating.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Part number or a few words, e.g. "ADS1292", "biopotential AFE". Empty lists everything.' },
    },
  },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  try {
    const found = findComponents(String(p.query ?? ''))
    if (!found.length) return { success: true, data: `Nothing in the component library matches "${p.query}". Goga has no datasheet figures for it — do not state a part number, pinout or rating from memory. Add the part with its datasheet URL, or look it up on the manufacturer's site.` }
    return { success: true, data: found.map(c => [
      `${c.manufacturer} ${c.partNumber} (${c.category})${c.provenance === 'user-entered' ? ' [user-entered]' : ''}: ${c.summary}`,
      ...c.ratings.map(r => `    ${r.name}: ${r.value} ${r.unit}  — ${r.where}`),
      `    Datasheet: ${c.datasheet.title} — ${c.datasheet.url} (read ${c.datasheet.retrieved})`,
    ].join('\n')).join('\n\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'ee.componentDetail',
  description: 'Every recorded figure for one part, each with the datasheet section it came from, plus the cautions recorded for it. Use before quoting anything about the part.',
  parameters: { type: 'object', properties: { partNumber: { type: 'string', description: 'Exact part number, e.g. ADS1299.' } }, required: ['partNumber'] },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  try {
    const rec = getComponent(String(p.partNumber))
    if (!rec) return { success: true, data: `No record for ${p.partNumber}. I will not state its pins, ratings or limits from memory — add its datasheet to the library first.` }
    const problem = sourceProblem(rec)
    return { success: true, data: [
      `${rec.manufacturer} ${rec.partNumber} — ${rec.summary}`,
      `Source: ${rec.datasheet.title}, ${rec.datasheet.url}${rec.datasheet.revision ? `, ${rec.datasheet.revision}` : ''} (read ${rec.datasheet.retrieved})`,
      problem ? `PROBLEM: ${problem}` : '',
      '',
      'Recorded figures:',
      ...rec.ratings.map(r => `  ${r.name}: ${r.value} ${r.unit}  [${r.where}]`),
      '',
      'Cautions:',
      ...rec.cautions.map(c => `  - ${c}`),
    ].filter(Boolean).join('\n') }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'ee.reviewDesign',
  description: 'Check a design decision against the recorded datasheet figures for a part — for example "the analog rail runs at 3.3 V" against a recorded 4.75–5.25 V. Reports a contradiction as an error, agreement as "consistent with", and anything it has no figure for as "I could not check this".',
  parameters: {
    type: 'object',
    properties: {
      claims: { type: 'array', description: 'Claims: [{"partNumber":"ADS1299","claim":"analog rail at 3.3 V","quantity":"Analog supply","value":3.3,"unit":"V"}]' },
    },
    required: ['claims'],
  },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  try {
    const claims = Array.isArray(p.claims) ? (p.claims as Record<string, unknown>[]).map(c => ({
      partNumber: String(c.partNumber ?? ''),
      claim: String(c.claim ?? ''),
      quantity: String(c.quantity ?? ''),
      value: Number(c.value),
      unit: String(c.unit ?? ''),
    })) as DesignClaim[] : []
    if (!claims.length) return { success: false, error: 'give at least one claim' }
    const { issues, summary } = reviewDesign(claims)
    return { success: true, data: [summary, '', ...issues.map(i => `[${i.severity.toUpperCase()}] ${i.claim}\n  ${i.problem}\n  Evidence: ${i.evidence}${i.datasheet ? `\n  Source: ${i.datasheet.url}` : ''}`)].join('\n') }
  } catch (err) { return failure(err) }
})
