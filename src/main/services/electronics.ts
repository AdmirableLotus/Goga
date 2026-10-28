import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Local circuit design with free KiCad and SKiDL. Goga looks parts up in KiCad's real
 * libraries (so he never invents a part or pin), then builds a circuit from a plain
 * description of parts and connections: a netlist KiCad's PCB editor (or Flux) can import,
 * a parts list, and an electrical rules check. The brain's description is data; the build
 * script that reads it is fixed, so no generated code ever runs.
 */

export interface SymbolInfo { lib: string; name: string; description: string; keywords: string; footprint: string }
export interface PinInfo { number: string; name: string; type: string }
export interface CircuitPart { ref: string; lib: string; symbol: string; value?: string; footprint?: string }
export interface CircuitNet { name: string; pins: string[] }
export interface CircuitDesign { name: string; parts: CircuitPart[]; nets: CircuitNet[] }

const MAX_RESULTS = 15

export function kicadShareDir(): string | undefined {
  const roots = [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'KiCad'), path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'KiCad')]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const versions = fs.readdirSync(root).filter(v => /^\d+(\.\d+)*$/.test(v)).sort((a, b) => parseFloat(b) - parseFloat(a))
    for (const v of versions) {
      const share = path.join(root, v, 'share', 'kicad')
      if (fs.existsSync(path.join(share, 'symbols'))) return share
    }
  }
  return undefined
}

/** Top-level symbols of one .kicad_sym library, with what is needed to choose one. */
export function parseSymbolLibrary(lib: string, text: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = []
  // Top-level symbols sit one level deep; their units ("Name_0_1") two levels.
  const starts = [...text.matchAll(/^\t\(symbol "([^"]+)"/gm)]
  starts.forEach((m, i) => {
    const body = text.slice(m.index!, starts[i + 1]?.index ?? text.length)
    const prop = (key: string) => body.match(new RegExp(`\\(property "${key}" "((?:[^"\\\\]|\\\\.)*)"`))?.[1] ?? ''
    symbols.push({ lib, name: m[1], description: prop('Description'), keywords: prop('ki_keywords'), footprint: prop('Footprint') })
  })
  return symbols
}

/** Pins of a symbol (following "extends" to the symbol it is based on). */
export function parseSymbolPins(text: string, name: string): PinInfo[] {
  const start = text.search(new RegExp(`^\\t\\(symbol "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'm'))
  if (start < 0) return []
  const next = text.slice(start + 1).search(/^\t\(symbol "/m)
  const body = text.slice(start, next < 0 ? text.length : start + 1 + next)
  const parent = body.match(/\(extends "([^"]+)"\)/)?.[1]
  if (parent) return parseSymbolPins(text, parent)
  const pins: PinInfo[] = []
  for (const m of body.matchAll(/\(pin (\w+) \w+[\s\S]*?\(name "((?:[^"\\]|\\.)*)"[\s\S]*?\(number "((?:[^"\\]|\\.)*)"/g)) {
    if (!pins.some(p => p.number === m[3])) pins.push({ type: m[1], name: m[2], number: m[3] })
  }
  return pins
}

/** Search scored by how many query words appear in the name, description and keywords. */
export function searchSymbols(index: SymbolInfo[], query: string): SymbolInfo[] {
  const words = query.toLowerCase().split(/[\s,]+/).filter(w => w.length > 1)
  return index
    .map(s => {
      const name = `${s.lib}:${s.name}`.toLowerCase()
      const text = `${s.description} ${s.keywords}`.toLowerCase()
      const score = words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (text.includes(w) ? 1 : 0), 0)
      return { s, score }
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length)
    .slice(0, MAX_RESULTS)
    .map(r => r.s)
}

/** Problems with a design that are cheaper to catch here than in a failed build. */
export function checkDesign(design: CircuitDesign): string[] {
  const problems: string[] = []
  if (!/^[\w-]{1,60}$/.test(design.name ?? '')) problems.push('name must be letters, digits, - or _ (up to 60)')
  const refs = new Set<string>()
  for (const p of design.parts ?? []) {
    if (!/^[A-Za-z]+\d+$/.test(p.ref ?? '')) problems.push(`part ref "${p.ref}" should look like R1, C2, U3`)
    if (refs.has(p.ref)) problems.push(`part ref ${p.ref} is used twice`)
    refs.add(p.ref)
    if (!p.lib || !p.symbol) problems.push(`part ${p.ref} needs lib and symbol (find them with electronics.findPart)`)
  }
  for (const n of design.nets ?? []) {
    if (!n.name) problems.push('every net needs a name')
    for (const pin of n.pins ?? []) {
      const ref = pin.split('.')[0]
      if (!pin.includes('.')) problems.push(`pin "${pin}" in net ${n.name} should be REF.PIN, like U1.8 or U1.VCC`)
      else if (!refs.has(ref)) problems.push(`net ${n.name} uses ${pin}, but there is no part ${ref}`)
    }
  }
  if ((design.parts ?? []).length === 0) problems.push('no parts')
  return problems
}

// Reads the design from design.json next to it; never changes with the design.
const BUILD_SCRIPT = `import csv, json, sys
from skidl import Part, Net, ERC, generate_netlist

design = json.load(open('design.json', encoding='utf-8'))
parts = {}
for p in design['parts']:
    kw = {'ref': p['ref']}
    if p.get('value'): kw['value'] = p['value']
    if p.get('footprint'): kw['footprint'] = p['footprint']
    parts[p['ref']] = Part(p['lib'], p['symbol'], **kw)

def pin(ref, key):
    part = parts[ref]
    for p in part.pins:
        if str(p.num) == key: return p
    named = [p for p in part.pins if p.name == key]
    if len(named) == 1: return named[0]
    if named: sys.exit(f"PIN_ERROR {ref} has several pins named {key!r} (" + ", ".join(str(p.num) for p in named) + "); use the pin number")
    sys.exit(f"PIN_ERROR {ref} has no pin {key!r}. Its pins: " + ", ".join(f"{p.num}:{p.name}" for p in part.pins))

for n in design['nets']:
    net = Net(n['name'])
    for ref_pin in n['pins']:
        ref, key = ref_pin.split('.', 1)
        net += pin(ref, key)

ERC()
generate_netlist(file_=design['name'] + '.net')
with open(design['name'] + '-parts.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f)
    w.writerow(['Ref', 'Value', 'Part', 'Footprint'])
    for p in design['parts']:
        w.writerow([p['ref'], p.get('value', ''), p['lib'] + ':' + p['symbol'], p.get('footprint', '')])
print('BUILD_OK')
`

export interface BuildResult { folder: string; netlist: string; partsList: string; errors: number; warnings: number; report: string }

export class ElectronicsService {
  private index: SymbolInfo[] | null = null

  constructor(private share = kicadShareDir(), private outRoot = path.join(os.homedir(), 'Documents', 'Goga', 'Electronics')) {}

  available(): boolean { return !!this.share }

  findSymbols(query: string): SymbolInfo[] {
    return searchSymbols(this.symbolIndex(), query)
  }

  findFootprints(query: string): string[] {
    const dir = this.requireShare('footprints')
    const words = query.toLowerCase().split(/[\s,]+/).filter(w => w.length > 1)
    const all: string[] = []
    for (const lib of fs.readdirSync(dir).filter(d => d.endsWith('.pretty'))) {
      for (const f of fs.readdirSync(path.join(dir, lib)).filter(f => f.endsWith('.kicad_mod'))) all.push(`${lib.replace(/\.pretty$/, '')}:${f.replace(/\.kicad_mod$/, '')}`)
    }
    return all
      .map(name => ({ name, score: words.filter(w => name.toLowerCase().includes(w)).length }))
      .filter(r => r.score === words.length)
      .sort((a, b) => a.name.length - b.name.length)
      .slice(0, MAX_RESULTS)
      .map(r => r.name)
  }

  pins(lib: string, symbol: string): PinInfo[] {
    const file = path.join(this.requireShare('symbols'), `${lib}.kicad_sym`)
    if (!/^[\w.+-]+$/.test(lib) || !fs.existsSync(file)) throw new Error(`no KiCad library named ${lib}`)
    return parseSymbolPins(fs.readFileSync(file, 'utf8'), symbol)
  }

  async build(design: CircuitDesign, signal?: AbortSignal): Promise<BuildResult> {
    const problems = checkDesign(design)
    if (problems.length > 0) throw new Error(`The design needs fixing first: ${problems.join('; ')}`)
    const share = this.requireShare('symbols').replace(/[\\/]symbols$/, '')
    const folder = path.join(this.outRoot, design.name)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'design.json'), JSON.stringify(design, null, 2))
    fs.writeFileSync(path.join(folder, 'build.py'), BUILD_SCRIPT)
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' }
    for (const v of ['', '6', '7', '8', '9', '10']) {
      env[`KICAD${v}_SYMBOL_DIR`] = path.join(share, 'symbols')
      env[`KICAD${v}_FOOTPRINT_DIR`] = path.join(share, 'footprints')
    }
    const output = await new Promise<string>((resolve, reject) => {
      // Not isolated (-I): SKiDL is installed for the user. The folder holds only Goga's own files.
      execFile('python', ['build.py'], { cwd: folder, env, windowsHide: true, timeout: 120_000, signal, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const text = `${stdout}\n${stderr}`
        const pinError = text.match(/PIN_ERROR (.*)/)?.[1]
        if (pinError) reject(new Error(pinError))
        else if (err && !text.includes('BUILD_OK')) reject(new Error(`Circuit build failed: ${(stderr || err.message).split('\n').filter(l => /error|Error|not found|No such/.test(l)).slice(0, 5).join(' | ') || err.message}`))
        else resolve(text)
      })
    })
    const count = (kind: string) => Number(output.match(new RegExp(`(\\d+) ${kind} found during ERC`))?.[1] ?? output.match(new RegExp(`(\\d+) ${kind} found`))?.[1] ?? 0)
    const ercFile = path.join(folder, 'build.erc')
    const report = fs.existsSync(ercFile) ? fs.readFileSync(ercFile, 'utf8').split('\n').filter(l => /ERROR|WARNING/.test(l) && !/Missing tag|Random tag/.test(l)).slice(0, 12).join('\n') : ''
    return {
      folder,
      netlist: path.join(folder, `${design.name}.net`),
      partsList: path.join(folder, `${design.name}-parts.csv`),
      errors: count('errors'),
      warnings: count('warnings'),
      report,
    }
  }

  private symbolIndex(): SymbolInfo[] {
    if (this.index) return this.index
    const dir = this.requireShare('symbols')
    this.index = fs.readdirSync(dir).filter(f => f.endsWith('.kicad_sym'))
      .flatMap(f => parseSymbolLibrary(f.replace(/\.kicad_sym$/, ''), fs.readFileSync(path.join(dir, f), 'utf8')))
    return this.index
  }

  private requireShare(sub: 'symbols' | 'footprints'): string {
    if (!this.share) throw new Error('KiCad is not installed — install it (free) from kicad.org, then try again')
    return path.join(this.share, sub)
  }
}
