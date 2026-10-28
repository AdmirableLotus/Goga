import { describe, expect, it } from 'vitest'
import { checkDesign, parseSymbolLibrary, parseSymbolPins, searchSymbols } from '../electronics'

const LIB = `(kicad_symbol_lib
\t(symbol "LM358"
\t\t(property "Footprint" ""
\t\t)
\t\t(property "Description" "Low-Power, Dual Operational Amplifiers, DIP-8/SOIC-8"
\t\t)
\t\t(property "ki_keywords" "dual opamp"
\t\t)
\t\t(symbol "LM358_1_1"
\t\t\t(pin output line
\t\t\t\t(name ""
\t\t\t\t)
\t\t\t\t(number "1"
\t\t\t\t)
\t\t\t)
\t\t\t(pin input line
\t\t\t\t(name "-"
\t\t\t\t)
\t\t\t\t(number "2"
\t\t\t\t)
\t\t\t)
\t\t)
\t\t(symbol "LM358_3_1"
\t\t\t(pin power_in line
\t\t\t\t(name "V+"
\t\t\t\t)
\t\t\t\t(number "8"
\t\t\t\t)
\t\t\t)
\t\t)
\t)
\t(symbol "LM2904"
\t\t(extends "LM358")
\t\t(property "Description" "Dual op amp, automotive"
\t\t)
\t)
)`

describe('KiCad part libraries', () => {
  it('lists each part once with its description, not its units', () => {
    const parts = parseSymbolLibrary('Amplifier_Operational', LIB)
    expect(parts.map(p => p.name)).toEqual(['LM358', 'LM2904'])
    expect(parts[0]).toMatchObject({ lib: 'Amplifier_Operational', keywords: 'dual opamp' })
  })

  it('reads pins from every unit, and from the part a variant is based on', () => {
    expect(parseSymbolPins(LIB, 'LM358')).toEqual([
      { type: 'output', name: '', number: '1' }, { type: 'input', name: '-', number: '2' }, { type: 'power_in', name: 'V+', number: '8' },
    ])
    expect(parseSymbolPins(LIB, 'LM2904').map(p => p.number)).toEqual(['1', '2', '8'])
    expect(parseSymbolPins(LIB, 'NOPE')).toEqual([])
  })

  it('finds parts by what they are', () => {
    const index = parseSymbolLibrary('Amplifier_Operational', LIB)
    expect(searchSymbols(index, 'dual op amp automotive')[0].name).toBe('LM2904')
    expect(searchSymbols(index, 'LM358')[0].name).toBe('LM358')
    expect(searchSymbols(index, 'microcontroller')).toEqual([])
  })
})

describe('circuit descriptions', () => {
  it('catches mistakes before building', () => {
    expect(checkDesign({ name: 'ok-board', parts: [{ ref: 'R1', lib: 'Device', symbol: 'R' }], nets: [{ name: 'A', pins: ['R1.1'] }] })).toEqual([])
    const problems = checkDesign({ name: '../evil', parts: [{ ref: 'R1', lib: 'Device', symbol: 'R' }, { ref: 'R1', lib: '', symbol: '' }], nets: [{ name: 'A', pins: ['R2.1', 'R1'] }] })
    expect(problems.join('\n')).toMatch(/name must be/)
    expect(problems.join('\n')).toMatch(/R1 is used twice/)
    expect(problems.join('\n')).toMatch(/needs lib and symbol/)
    expect(problems.join('\n')).toMatch(/no part R2/)
    expect(problems.join('\n')).toMatch(/should be REF.PIN/)
  })
})
