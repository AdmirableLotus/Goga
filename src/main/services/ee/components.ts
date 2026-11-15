import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { ComponentRecord } from '../../../shared/ee'

/**
 * The component library.
 *
 * This file does NOT contain a catalogue of parts chosen from memory. It contains only
 * parts whose figures were read off the manufacturer's own product/datasheet page, with
 * the URL and the retrieval date recorded per record. Anything else has to be added by
 * the user (or by a future import) and is marked `user-entered`, so a claim can always be
 * traced back to where it came from.
 *
 * When a part is not in here, the answer is "I don't have datasheet figures for that" —
 * never a guessed pinout or rating.
 */

const RETRIEVED = '2026-11-08'

const SEED: ComponentRecord[] = [
  {
    id: 'ti-ads1292',
    partNumber: 'ADS1292',
    manufacturer: 'Texas Instruments',
    category: 'afe',
    summary: '24-bit, 2-channel, low-power analog front end for ECG applications, with two low-noise PGAs and two high-resolution ADCs.',
    ratings: [
      { name: 'Resolution', value: '24', unit: 'bits', where: 'product page: Resolution (Bits)' },
      { name: 'Input channels', value: '2', unit: 'channels', where: 'product page: Number of input channels' },
      { name: 'Data rate', value: '125 to 8000', unit: 'SPS', where: 'product page: Data rate' },
      { name: 'Input-referred noise', value: '8', unit: 'µVpp (150 Hz BW, G = 6)', where: 'product page: Input-referred noise' },
      { name: 'Programmable gain', value: '1, 2, 3, 4, 6, 8, 12', unit: 'V/V', where: 'product page: Programmable gain' },
      { name: 'Analog supply', value: '2.7 to 5.25', unit: 'V', where: 'product page: Supplies' },
      { name: 'Digital supply', value: '1.7 to 3.6', unit: 'V', where: 'product page: Supplies' },
    ],
    cautions: [
      'The product page states the package both as a 4 mm × 4 mm 32-pin VQFN and as a 32-pin TQFP, and its package table gives the TQFP as 7 mm × 7 mm while the description says 5 mm × 5 mm. Confirm the exact orderable part number and package drawing in the datasheet before laying out a board.',
      'The 8 µVpp noise figure is quoted at G = 6 with a 150 Hz bandwidth. A different gain or bandwidth gives a different noise number — do not quote 8 µVpp for another configuration.',
      'The ADS1292R is a different orderable part with respiration support; check which one a circuit was drawn for.',
    ],
    datasheet: { title: 'TI ADS1292 product page (specifications table)', url: 'https://www.ti.com/product/ADS1292', retrieved: RETRIEVED },
    provenance: 'datasheet-read',
  },
  {
    id: 'ti-ads1299',
    partNumber: 'ADS1299',
    manufacturer: 'Texas Instruments',
    category: 'afe',
    summary: 'Low-noise, 8-channel, 24-bit simultaneous-sampling ADC for biopotential measurements, with a built-in PGA, internal reference and onboard oscillator.',
    ratings: [
      { name: 'Resolution', value: '24', unit: 'bits', where: 'product page: Resolution' },
      { name: 'Input channels', value: '8', unit: 'channels', where: 'product page: Number of input channels' },
      { name: 'Data rate', value: '250 to 16000', unit: 'SPS', where: 'product page: Data rate' },
      { name: 'Input-referred noise', value: '1', unit: 'µVpp (70 Hz BW)', where: 'product page: Input-referred noise' },
      { name: 'Programmable gain', value: '1, 2, 4, 6, 8, 12, 24', unit: 'V/V', where: 'product page: Programmable gain' },
      { name: 'Analog supply', value: '4.75 to 5.25', unit: 'V', where: 'product page: Unipolar or bipolar supplies' },
      { name: 'Digital supply', value: '1.8 to 3.6', unit: 'V', where: 'product page: Unipolar or bipolar supplies' },
    ],
    cautions: [
      'The family name covers ADS1299-4, ADS1299-6 and ADS1299 (four, six and eight channels). Channel count and pinout depend on which one is ordered.',
      'The 1 µVpp figure is at a 70 Hz bandwidth. Wider bandwidth means more noise.',
      'The analog supply range is 4.75–5.25 V, which is narrower than the ADS1292 range — a 3.3 V-only design cannot run this part on its analog rail.',
    ],
    datasheet: { title: 'TI ADS1299 product page (specifications table)', url: 'https://www.ti.com/product/ADS1299', revision: 'Datasheet Rev. C, 25 Jan 2017 (as listed on the product page)', retrieved: RETRIEVED },
    provenance: 'datasheet-read',
  },
]

interface Store { records: ComponentRecord[] }

function file(): string { return path.join(app.getPath('userData'), 'goga-ee-components.json') }

function loadUser(): ComponentRecord[] {
  try { return (JSON.parse(fs.readFileSync(file(), 'utf8')) as Store).records ?? [] } catch { return [] }
}

function saveUser(records: ComponentRecord[]): void {
  const target = file()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify({ records }, null, 2), { mode: 0o600 })
}

export function allComponents(): ComponentRecord[] {
  return [...SEED, ...loadUser()]
}

export function findComponents(query: string): ComponentRecord[] {
  const words = String(query ?? '').toLowerCase().split(/[\s,]+/).filter(w => w.length > 1)
  const all = allComponents()
  if (!words.length) return all
  return all
    .map(rec => {
      const hay = `${rec.partNumber} ${rec.manufacturer} ${rec.summary} ${rec.category} ${rec.ratings.map(r => r.name).join(' ')}`.toLowerCase()
      return { rec, score: words.filter(w => hay.includes(w)).length }
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(r => r.rec)
}

export function getComponent(partNumber: string): ComponentRecord | null {
  const want = String(partNumber ?? '').trim().toLowerCase()
  return allComponents().find(c => c.partNumber.toLowerCase() === want) ?? null
}

/** Add a part the user typed in. Always marked user-entered, and a datasheet URL is required. */
export function addUserComponent(input: Omit<ComponentRecord, 'id' | 'provenance'>): ComponentRecord {
  if (!input.partNumber?.trim()) throw new Error('a part number is required')
  if (!input.datasheet?.url?.trim()) throw new Error('a datasheet URL is required — a part with no source cannot be used for a claim')
  const record: ComponentRecord = {
    ...input,
    id: `user-${input.partNumber.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    provenance: 'user-entered',
  }
  const existing = loadUser().filter(r => r.id !== record.id)
  saveUser([...existing, record])
  return record
}

/**
 * Every claim about a part must name its source. This is the check the tools run before
 * they report a figure: a record without a datasheet URL cannot be quoted.
 */
export function sourceProblem(record: ComponentRecord): string | null {
  if (!record.datasheet?.url) return `${record.partNumber} has no datasheet URL, so its figures cannot be quoted`
  if (record.provenance === 'user-entered') return null
  if (!record.ratings?.length) return `${record.partNumber} has no ratings recorded`
  return null
}
