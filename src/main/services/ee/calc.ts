import type { CalcResult, ElectrodeImpedanceInput, FilterInput, PowerBudgetInput } from '../../../shared/ee'

/**
 * Deterministic calculator arithmetic. No model, no estimate: every number here is
 * produced by the formula printed beside it, from numbers the caller supplied.
 *
 * Formulas used (named so they can be checked against any textbook):
 *   P = V × I                              (electrical power, DC)
 *   runtime = capacity × usable / I        (hours, capacity in mAh, current in mA)
 *   R = V / I                              (Ohm's law, used for electrode impedance)
 *   f_c = 1 / (2πRC)                       (first-order RC corner frequency)
 *   |H(f)| = 1 / sqrt(1 + (f/f_c)²)        (first-order low-pass magnitude)
 *   |H(f)| = (f/f_c) / sqrt(1 + (f/f_c)²)  (first-order high-pass magnitude)
 */

const round = (n: number, digits = 4): string => {
  if (!Number.isFinite(n)) return 'not a finite number'
  const p = 10 ** digits
  return String(Math.round(n * p) / p)
}

export function powerBudget(input: PowerBudgetInput): CalcResult {
  const assumptions = [
    'Ideal DC summation: no regulator quiescent current, no switching losses, no battery derating with temperature or age.',
    'Currents are taken at the stated voltage. A load whose current varies with voltage needs its own worst-case number.',
    'Duty cycle multiplies the load\'s current; 100% when omitted.',
  ]
  const steps: { label: string; expression: string; value: string }[] = []
  let totalMw = 0
  const rows: Record<string, string> = {}
  for (const load of input.loads ?? []) {
    const duty = load.dutyCycle === undefined || load.dutyCycle === null ? 1 : Number(load.dutyCycle)
    const i = Number(load.currentMa) * (Number.isFinite(duty) && duty >= 0 ? duty : 1)
    const p = Number(load.voltage) * i
    totalMw += p
    rows[load.name] = `${load.currentMa} mA × ${load.dutyCycle === undefined ? '100%' : `${(duty * 100).toFixed(1)}%`} = ${round(i, 3)} mA at ${load.voltage} V → ${round(p, 3)} mW`
    steps.push({
      label: load.name,
      expression: `P = ${load.voltage} V × ${round(i, 4)} mA`,
      value: `${round(p, 3)} mW`,
    })
  }
  steps.push({ label: 'Total', expression: 'P_total = Σ P_load', value: `${round(totalMw, 3)} mW` })

  const result: Record<string, string> = {
    'Total power': `${round(totalMw, 3)} mW`,
    'Total current at the highest rail voltage': `${round(totalMw / Math.max(...(input.loads ?? [{ voltage: 1 }]).map(l => Number(l.voltage) || 1)), 3)} mA (approximate — see assumptions)`,
  }

  if (input.batteryMah && input.batteryMah > 0) {
    const usable = input.usableFraction === undefined ? 0.8 : input.usableFraction
    const eff = input.regulatorEfficiency === undefined ? 0.85 : input.regulatorEfficiency
    // Assume a single nominal battery voltage for the runtime figure.
    const vbat = 3.7
    const iAvgMa = totalMw / vbat / Math.max(eff, 0.01)
    const hours = (input.batteryMah * usable) / Math.max(iAvgMa, 1e-9)
    steps.push({ label: 'Battery current', expression: `I_batt = P_total / V_batt / η = ${round(totalMw, 3)} mW / ${vbat} V / ${eff}`, value: `${round(iAvgMa, 3)} mA` })
    steps.push({ label: 'Runtime', expression: `t = capacity × usable / I_batt = ${input.batteryMah} mAh × ${usable} / ${round(iAvgMa, 3)} mA`, value: `${round(hours, 2)} h` })
    result['Battery current'] = `${round(iAvgMa, 3)} mA at ${vbat} V nominal, ${(eff * 100).toFixed(0)}% regulator efficiency`
    result.Runtime = `${round(hours, 2)} hours (${round(hours / 24, 2)} days)`
    assumptions.push(`Runtime assumes a ${vbat} V nominal cell at ${(eff * 100).toFixed(0)}% conversion efficiency and ${(usable * 100).toFixed(0)}% usable capacity.`)
  }

  return { title: 'Power budget', inputs: { 'Loads': String((input.loads ?? []).length) }, steps, result, assumptions, formulaSource: null }
}

export function electrodeImpedance(input: ElectrodeImpedanceInput): CalcResult {
  const iA = Number(input.currentUa) * 1e-6
  const vV = Number(input.voltageMv) * 1e-3
  const series = Number(input.seriesOhm ?? 0)
  const z = iA > 0 ? vV / iA : NaN
  const chargeOnly = Number.isFinite(z) ? z - series : NaN
  const steps = [
    { label: 'Excitation current', expression: 'I = µA × 10⁻⁶', value: `${round(iA, 9)} A` },
    { label: 'Measured voltage', expression: 'V = mV × 10⁻³', value: `${round(vV, 6)} V` },
    { label: 'Impedance', expression: `Z = V / I = ${round(vV, 6)} V / ${round(iA, 9)} A`, value: `${round(z, 2)} Ω` },
    { label: 'Less series resistance', expression: `Z_electrode = Z − R_series = ${round(z, 2)} Ω − ${series} Ω`, value: `${round(chargeOnly, 2)} Ω` },
  ]
  return {
    title: 'Electrode impedance from a measured voltage',
    inputs: { 'Current (µA)': String(input.currentUa), 'Voltage (mV)': String(input.voltageMv), 'Series R (Ω)': String(series) },
    steps,
    result: { Impedance: `${round(z, 2)} Ω`, 'Electrode-only': `${round(chargeOnly, 2)} Ω` },
    assumptions: [
      'This gives the magnitude of the impedance at the excitation frequency only. Phase — the part that separates the resistive and reactive components — needs a synchronous measurement, which a magnitude-only reading cannot supply.',
      'The voltage is assumed to be the differential voltage across the electrode pair at the same instant the current is applied.',
      'Skin impedance falls as frequency rises; a number without its excitation frequency is not comparable to another number.',
    ],
    formulaSource: null,
  }
}

export function filterResponse(input: FilterInput): CalcResult {
  const r = Number(input.resistanceOhm)
  const c = Number(input.capacitanceF)
  const fc = 1 / (2 * Math.PI * r * c)
  const points = [0.01, 0.1, 0.5, 1, 2, 10, 100]
  const steps = [
    { label: 'Corner frequency', expression: `f_c = 1 / (2πRC) = 1 / (2π × ${r} Ω × ${c} F)`, value: `${round(fc, 3)} Hz` },
    { label: 'Time constant', expression: `τ = R × C = ${r} Ω × ${c} F`, value: `${round(r * c, 6)} s` },
    ...points.map(k => {
      const ratio = k
      const mag = input.kind === 'lowpass'
        ? 1 / Math.sqrt(1 + ratio * ratio)
        : ratio / Math.sqrt(1 + ratio * ratio)
      return {
        label: `At ${k} × f_c (${round(fc * k, 2)} Hz)`,
        expression: input.kind === 'lowpass' ? `|H| = 1/√(1+(f/f_c)²) with f/f_c = ${k}` : `|H| = (f/f_c)/√(1+(f/f_c)²) with f/f_c = ${k}`,
        value: `${round(mag, 4)} (${round(20 * Math.log10(Math.max(mag, 1e-12)), 2)} dB)`,
      }
    }),
    { label: 'Roll-off', expression: 'first order: 20 dB per decade beyond the corner', value: '−20 dB/decade' },
  ]
  return {
    title: `First-order RC ${input.kind}`,
    inputs: { 'R (Ω)': String(r), 'C (F)': String(c) },
    steps,
    result: {
      'Corner frequency (−3 dB)': `${round(fc, 3)} Hz`,
      'Attenuation one decade past the corner': input.kind === 'lowpass' ? '≈ −20 dB' : '≈ +20 dB relative to passband',
    },
    assumptions: [
      'First-order RC only: a real filter adds the source impedance, the load impedance and the op-amp\'s own bandwidth.',
      'Component tolerances are not included. A 10% capacitor moves the corner about 10%.',
    ],
    formulaSource: null,
  }
}
