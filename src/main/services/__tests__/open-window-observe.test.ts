import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseOpenObserve, pickWindow, docNameFromTitle, findDocument, gatherOpenWindow, type ObserveDeps } from '../openWindowObserve'
import type { WindowInfo } from '../../adapters/desktop'

const SELF = 4242
const WINDOWS: WindowInfo[] = [
  { title: 'Goga', owner: '', pid: SELF, bounds: { x: 0, y: 0, width: 1200, height: 800 } },
  { title: 'Alma_NSF_PhaseI_RnD_and_Budget.pdf - Adobe Acrobat Reader (64-bit)', owner: '', pid: 100, bounds: { x: 0, y: 0, width: 1200, height: 800 } },
  { title: 'Bioimpedance explained - YouTube - Brave', owner: '', pid: 200, bounds: { x: 0, y: 0, width: 1200, height: 800 } },
  { title: 'Program Manager', owner: '', pid: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
]

describe('parseOpenObserve — the user pointing at something already open', () => {
  it("understands Ace's real requests", () => {
    expect(parseOpenObserve('please look at the paper I opened and analyze it')).toEqual({ kind: 'document', play: false })
    expect(parseOpenObserve('please go to the browser that I opened already and look at the video I have opened and play and look at it'))
      .toEqual({ kind: 'browser', play: true })
    expect(parseOpenObserve("what's on my screen")).toEqual({ kind: 'any', play: false })
    expect(parseOpenObserve('summarize this pdf')).toEqual({ kind: 'document', play: false })
    expect(parseOpenObserve('watch this video and tell me what it is about')).toEqual({ kind: 'browser', play: false })
  })

  it('leaves other requests to the normal routes', () => {
    for (const s of ['analyze AAPL', 'find a paper about bioimpedance', 'open the paper in my documents folder',
      'read my trading journal', 'review this folder C:/Users/me/Desktop/ring', 'write me a poem', 'hello'])
      expect(parseOpenObserve(s)).toBeNull()
  })
})

describe('pickWindow — never Goga itself', () => {
  it('finds the open document, the browser, or the top window', () => {
    expect(pickWindow(WINDOWS, 'document', SELF)?.pid).toBe(100)
    expect(pickWindow(WINDOWS, 'browser', SELF)?.pid).toBe(200)
    expect(pickWindow(WINDOWS, 'any', SELF)?.pid).toBe(100)
  })
  it('returns null when only Goga is open', () => {
    expect(pickWindow([WINDOWS[0]], 'any', SELF)).toBeNull()
  })

  it('for a video, prefers the browser window showing one; keeps minimized windows; knows Google Docs', () => {
    const brave = [
      { title: 'Cursor for Hardware | Schematik - Brave', owner: '', pid: 300, bounds: { x: 0, y: 0, width: 1200, height: 800 } },
      { title: 'pitch by november 4th - Google Docs - Brave', owner: '', pid: 300, bounds: { x: 0, y: 0, width: 1200, height: 800 } },
      { title: 'Lecture 3 - YouTube - Brave', owner: '', pid: 300, bounds: { x: 0, y: 0, width: 0, height: 0 } }, // minimized
    ]
    expect(pickWindow(brave, 'browser', SELF, true)?.title).toBe('Lecture 3 - YouTube - Brave')
    expect(pickWindow(brave, 'browser', SELF, false)?.title).toBe('Cursor for Hardware | Schematik - Brave')
    expect(pickWindow(brave, 'document', SELF)?.title).toBe('pitch by november 4th - Google Docs - Brave')
  })

  it('strips Word title decorations', () => {
    expect(docNameFromTitle('intellectual_merit_rd_plan (Last saved by user) - Word (Unlicensed Product)')).toBe('intellectual_merit_rd_plan')
    expect(docNameFromTitle('02_ReLume_Viora_NSF_RFI_Submission_Response (Last saved by user) [Compatibility Mode] - Word'))
      .toBe('02_ReLume_Viora_NSF_RFI_Submission_Response')
  })

  it("reads Edge's PDF tab title", () => {
    expect(docNameFromTitle('00_MASTER_RnD_PLAN_Alma_NSF_PhaseI.pdf and 5 more pages - Profile 1 - Microsoft​ Edge'))
      .toBe('00_MASTER_RnD_PLAN_Alma_NSF_PhaseI.pdf')
  })
})

describe('docNameFromTitle', () => {
  it('takes the file name out of app window titles', () => {
    expect(docNameFromTitle('Alma_NSF.pdf - Adobe Acrobat Reader (64-bit)')).toBe('Alma_NSF.pdf')
    expect(docNameFromTitle('ReLume_Viora_15_Page_Technical_Foundation - Word')).toBe('ReLume_Viora_15_Page_Technical_Foundation')
    expect(docNameFromTitle('Budget.docx [Compatibility Mode] - Word')).toBe('Budget.docx')
  })
})

describe('findDocument', () => {
  it('finds a file by exact name or by name without extension', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-find-'))
    const sub = path.join(root, 'paper work for ring')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'Alma_NSF.pdf'), 'x')
    fs.writeFileSync(path.join(sub, 'Tech_Foundation.docx'), 'x')
    expect(findDocument('Alma_NSF.pdf', [root])).toBe(path.join(sub, 'Alma_NSF.pdf'))
    expect(findDocument('Tech_Foundation', [root])).toBe(path.join(sub, 'Tech_Foundation.docx'))
    expect(findDocument('missing.pdf', [root])).toBeNull()
    fs.rmSync(root, { recursive: true, force: true })
  })
})

function deps(over: Partial<ObserveDeps> = {}): ObserveDeps {
  return {
    listWindows: async () => WINDOWS,
    focus: vi.fn(async () => true),
    pressKey: vi.fn(async () => ({})),
    readWindowText: async () => ({ pid: 200, texts: ['Bioimpedance explained', '1.2M views', 'How tissue resists current'] }),
    screenshotBase64: async () => 'BASE64',
    describeImage: vi.fn(async () => 'A YouTube video showing a diagram of current flowing through a finger.'),
    readDocument: async () => 'Aim 1 — BioZ feasibility. Within-session CV ≤ 2%.',
    findDocument: () => 'C:/Users/me/Desktop/paper work for ring/Alma_NSF_PhaseI_RnD_and_Budget.pdf',
    wait: async () => {},
    selfPid: SELF,
    ...over,
  }
}

describe('gatherOpenWindow', () => {
  it('reads the real file for "the paper I opened" (no screenshot needed)', async () => {
    const d = deps()
    const ev = await gatherOpenWindow('please look at the paper I opened and analyze it', { kind: 'document', play: false }, d)
    expect(ev.ok).toBe(true)
    expect(ev.target).toBe('Alma_NSF_PhaseI_RnD_and_Budget.pdf')
    expect(ev.prompt).toContain('Within-session CV ≤ 2%')
    expect(d.focus).not.toHaveBeenCalled()
  })

  it('switches to the browser, presses play on YouTube, and looks at it', async () => {
    const d = deps()
    const ev = await gatherOpenWindow('go to my browser and play the video I opened', { kind: 'browser', play: true }, d)
    expect(d.focus).toHaveBeenCalledWith(200, WINDOWS[2].title)
    expect(d.pressKey).toHaveBeenCalledWith('K')
    expect(ev.prompt).toContain('diagram of current flowing through a finger')
    expect(ev.prompt).toContain('How tissue resists current')
    expect(ev.prompt).toMatch(/cannot hear the audio/)
  })

  it('looks at the document window when the file cannot be found', async () => {
    const d = deps({ findDocument: () => null })
    const ev = await gatherOpenWindow('look at the paper I opened', { kind: 'document', play: false }, d)
    expect(d.focus).toHaveBeenCalledWith(100, WINDOWS[1].title)
    expect(d.describeImage).toHaveBeenCalled()
    expect(ev.ok).toBe(true)
  })

  it('says honestly when nothing but Goga is open', async () => {
    const ev = await gatherOpenWindow('look at the video I opened', { kind: 'browser', play: false }, deps({ listWindows: async () => [WINDOWS[0]] }))
    expect(ev.ok).toBe(false)
    expect(ev.prompt).toMatch(/couldn't find/)
  })
})
