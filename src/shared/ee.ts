/**
 * Electrical-engineering types. Every number Goga reports carries the arithmetic that
 * produced it and, for a component, the datasheet it came from.
 */

export interface CalcStep {
  label: string
  expression: string
  value: string
}

export interface CalcResult {
  title: string
  inputs: Record<string, string>
  steps: CalcStep[]
  result: Record<string, string>
  /** Human-readable caveats: what the calculation ignores. */
  assumptions: string[]
  formulaSource: { title: string; url: string } | null
}

export interface PowerBudgetInput {
  /** Every rail or load the design must feed. */
  loads: { name: string; voltage: number; currentMa: number; dutyCycle?: number; note?: string }[]
  /** Battery capacity in mAh, for the runtime estimate. */
  batteryMah?: number
  /** Fraction of the nominal capacity actually usable (default 0.8). */
  usableFraction?: number
  /** Regulator efficiency as a fraction (default 0.85 for a switching rail). */
  regulatorEfficiency?: number
}

export interface ElectrodeImpedanceInput {
  /** Excitation current in microamps (a common bioimpedance choice is 10–100 µA). */
  currentUa: number
  /** Measured differential voltage across the electrode pair, in millivolts. */
  voltageMv: number
  /** Series resistance of the wiring and contact, in ohms (default 0). */
  seriesOhm?: number
}

export interface FilterInput {
  kind: 'lowpass' | 'highpass'
  resistanceOhm: number
  capacitanceF: number
}

export interface ComponentRecord {
  id: string
  /** Manufacturer part number exactly as the datasheet prints it. */
  partNumber: string
  manufacturer: string
  category: 'afe' | 'mcu' | 'afe-afe' | 'pmic' | 'reference' | 'opamp' | 'adc' | 'sensor' | 'connector' | 'other'
  /** One-line role, e.g. "24-bit biopotential AFE with integrated PGA". */
  summary: string
  /** Key ratings, each with the datasheet section they come from. */
  ratings: { name: string; value: string; unit: string; where: string }[]
  /** Absolute maximum and operating conditions worth knowing before choosing it. */
  cautions: string[]
  datasheet: { title: string; url: string; revision?: string; retrieved: string }
  /** Where the record came from, so an unverified entry can be spotted. */
  provenance: 'datasheet-read' | 'user-entered'
}

export interface ReviewIssue {
  severity: 'error' | 'warning' | 'note'
  claim: string
  problem: string
  evidence: string
  datasheet: { title: string; url: string } | null
}
