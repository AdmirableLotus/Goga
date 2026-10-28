import { ToolRegistry } from './registry'
import { ElectronicsService, type CircuitDesign } from '../services/electronics'

const reg = ToolRegistry.getInstance()
const electronics = new ElectronicsService()

reg.register({
  name: 'electronics.findPart',
  description: 'Search the KiCad part libraries on this PC for a schematic symbol (kind "symbol", e.g. "low noise op amp", "ESP32", "LDO 3.3V") or a footprint (kind "footprint", e.g. "SOIC-8", "0603 resistor"). Use it before electronics.buildCircuit: use only lib and symbol names it returns.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for, in a few words.' },
      kind: { type: 'string', enum: ['symbol', 'footprint'], description: 'symbol (default) or footprint.' },
    },
    required: ['query'],
  },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  try {
    const query = String(p.query ?? '')
    if (p.kind === 'footprint') {
      const found = electronics.findFootprints(query)
      return { success: true, data: found.length ? found.join('\n') : `No footprint matches "${query}". Try fewer or different words.` }
    }
    const found = electronics.findSymbols(query)
    return { success: true, data: found.length
      ? found.map(s => `${s.lib}:${s.name} — ${s.description}${s.footprint ? ` (footprint ${s.footprint})` : ''}`).join('\n')
      : `No part matches "${query}". Try fewer or different words.` }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

reg.register({
  name: 'electronics.partPins',
  description: 'List the pins (number, name, type) of a KiCad symbol, to know what to connect in electronics.buildCircuit.',
  parameters: {
    type: 'object',
    properties: {
      lib: { type: 'string', description: 'Library, e.g. "Amplifier_Operational".' },
      symbol: { type: 'string', description: 'Symbol, e.g. "OPA2333xxD".' },
    },
    required: ['lib', 'symbol'],
  },
  riskLevel: 'low', reversible: true, category: 'system',
}, async p => {
  try {
    const pins = electronics.pins(String(p.lib), String(p.symbol))
    if (pins.length === 0) return { success: false, error: `${p.lib}:${p.symbol} not found or has no pins — check the name with electronics.findPart` }
    return { success: true, data: pins.map(x => `${x.number}: ${x.name} (${x.type})`).join('\n') }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

reg.register({
  name: 'electronics.buildCircuit',
  description: 'Build a circuit on this PC with KiCad: give its parts and the nets (connections) between their pins. Writes a netlist for the KiCad PCB editor or Flux, a parts list (CSV), and runs an electrical rules check, into Documents\\Goga\\Electronics\\<name>. Pins are "REF.PIN" by number or name (U1.8, U1.VCC, R1.1).',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short project name, letters/digits/-/_ only, e.g. "viora-bioz-frontend".' },
      parts: { type: 'array', description: 'Parts: [{"ref":"R1","lib":"Device","symbol":"R","value":"10k","footprint":"Resistor_SMD:R_0603_1608Metric"}]' },
      nets: { type: 'array', description: 'Connections: [{"name":"VCC","pins":["U1.8","C1.1"]}]' },
    },
    required: ['name', 'parts', 'nets'],
  },
  riskLevel: 'medium', reversible: true, category: 'filesystem',
}, async (p, ctx) => {
  try {
    const r = await electronics.build({ name: String(p.name), parts: p.parts, nets: p.nets } as CircuitDesign, ctx.abortSignal)
    return { success: true, data: [
      `Built ${p.name}: ${r.errors} errors, ${r.warnings} warnings in the electrical rules check.`,
      r.report ? `Rule check findings:\n${r.report}` : '',
      `Netlist: ${r.netlist} (KiCad PCB editor: File → Import → Netlist)`,
      `Parts list: ${r.partsList}`,
    ].filter(Boolean).join('\n') }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})
