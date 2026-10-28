import { describe, expect, it, vi } from 'vitest'
import { compareSnapshot, parseSnapshot, type PcSnapshot } from '../guardian'
import { ROUTINE_QUESTION, RoutineTracker } from '../routine'

const snap = (patch: Partial<PcSnapshot> = {}): PcSnapshot => ({
  startup: ['Ollama.lnk'], apps: ['Brave', 'Git'], services: ['Windows Update'],
  defender: { realtime: true, antivirus: true }, threats: ['{old}|Old.Threat'], usb: [],
  devices: ['3C-2D-9E-EC-81-CF|192.168.0.1'], ...patch,
})

describe('guardian', () => {
  it('learns the PC on the first look without raising alarms', () => {
    const { alerts, memory } = compareSnapshot(undefined, snap())
    expect(alerts).toEqual([])
    expect(memory.known.threats).toEqual(['{old}|Old.Threat'])
  })

  it('reports each kind of change once', () => {
    const base = compareSnapshot(undefined, snap()).memory
    const changed = snap({
      startup: ['Ollama.lnk', 'Updater.exe'], apps: ['Brave', 'Git', 'Zoom'], services: ['Windows Update', 'Remote Helper'],
      defender: { realtime: false, antivirus: true }, threats: ['{old}|Old.Threat', '{new}|Trojan:Win32/Fake'],
      usb: ['E: KINGSTON'], devices: ['3C-2D-9E-EC-81-CF|192.168.0.1', 'AA-BB-CC-DD-EE-FF|192.168.0.77'],
    })
    const { alerts, memory } = compareSnapshot(base, changed)
    expect(alerts.map(a => a.title)).toEqual([
      'Windows Defender found a threat', 'Real-time protection was turned off', 'New program set to start with Windows',
      'New background service installed', 'New device on your home network', 'New app installed', 'USB drive connected',
    ])
    expect(alerts[0]).toMatchObject({ severity: 'danger' })
    expect(alerts[0].detail).toContain('Trojan:Win32/Fake')
    expect(alerts[4].detail).toContain('192.168.0.77')
    // The same state again: nothing new to say.
    expect(compareSnapshot(memory, changed).alerts).toEqual([])
  })

  it('knows a device by its hardware address even when its IP changes, and USB only when plugged in', () => {
    const base = compareSnapshot(undefined, snap({ usb: ['E: KINGSTON'] })).memory
    expect(compareSnapshot(base, snap({ devices: ['3C-2D-9E-EC-81-CF|192.168.0.9'] })).alerts).toEqual([])
    const unplugged = compareSnapshot(base, snap({ usb: [] })).memory
    expect(compareSnapshot(unplugged, snap({ usb: ['E: KINGSTON'] })).alerts.map(a => a.title)).toEqual(['USB drive connected'])
  })

  it('sums up a big install instead of listing everything', () => {
    const base = compareSnapshot(undefined, snap()).memory
    const apps = ['Brave', 'Git', 'A', 'B', 'C', 'D', 'E']
    expect(compareSnapshot(base, snap({ apps })).alerts[0].detail).toBe('A, B, C and 2 more')
  })

  it('reads PowerShell output, where a one-item list arrives as a plain value', () => {
    const parsed = parseSnapshot('{"startup":"Ollama.lnk","apps":["Brave"],"services":[],"defender":null,"threats":[],"usb":null,"devices":["x|1"]}')
    expect(parsed.startup).toEqual(['Ollama.lnk'])
    expect(parsed.usb).toEqual([])
    expect(parsed.defender).toBeNull()
  })
})

describe('routine', () => {
  const log = { info: vi.fn(), warn: vi.fn() }
  const at = (h: number, m = 0) => new Date(2026, 9, 28, h, m).getTime()

  function tracker(windows: { owner: string; title: string }[], idle = 0) {
    let i = 0
    let now = at(9)
    const t = new RoutineTracker({
      activeWindow: async () => windows[i++ % windows.length],
      idleSeconds: () => idle, enabled: () => true, log, now: () => now,
    })
    return { t, setNow: (ms: number) => { now = ms } }
  }

  it('counts minutes per app and remembers recent window titles', async () => {
    const { t } = tracker([{ owner: 'Code.exe', title: 'longText.ts - Goga' }, { owner: 'Code.exe', title: 'longText.ts - Goga' }, { owner: 'brave.exe', title: 'NSF SBIR - Brave' }])
    for (let i = 0; i < 3; i++) await t.sample()
    const s = t.summary('Ace')
    expect(s).toContain('Code 2m, brave 1m')
    expect(s).toContain('Code: longText.ts - Goga; brave: NSF SBIR - Brave')
  })

  it('keeps private windows and password managers to the app name, and skips Goga itself', async () => {
    const { t } = tracker([{ owner: 'msedge.exe', title: 'Bank login - InPrivate' }, { owner: 'Bitwarden.exe', title: 'Vault' }, { owner: 'electron.exe', title: 'Goga' }])
    for (let i = 0; i < 3; i++) await t.sample()
    const s = t.summary('Ace')
    expect(s).toContain('msedge 1m, Bitwarden 1m')
    expect(s).not.toContain('Bank login')
    expect(s).not.toContain('Vault')
    expect(s).not.toContain('electron')
  })

  it('does not count time away from the PC', async () => {
    const { t } = tracker([{ owner: 'Code.exe', title: 'x' }], 600)
    await t.sample()
    expect(t.summary('Ace')).toBe('')
  })

  it('learns which apps are usual at an hour', async () => {
    const { t, setNow } = tracker([{ owner: 'Code.exe', title: 'x' }])
    for (let d = 0; d < 6; d++) { setNow(at(9, d)); await t.sample() }
    expect(t.summary('Ace')).toContain('Around this hour Ace usually uses: Code.')
  })

  it('answers questions about the day', () => {
    expect(ROUTINE_QUESTION.test('what was I working on this morning?')).toBe(true)
    expect(ROUTINE_QUESTION.test('how long did I spend in Brave today')).toBe(true)
    expect(ROUTINE_QUESTION.test('open youtube')).toBe(false)
  })
})
