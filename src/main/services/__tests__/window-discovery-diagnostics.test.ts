import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('screenshot-desktop', () => ({ default: vi.fn() }))
vi.mock('@nut-tree-fork/nut-js', () => ({}))
vi.mock('../plannerDiagnostics', () => ({ plannerDiagnostic: vi.fn() }))
import { DesktopAdapter } from '../../adapters/desktop'
import { plannerDiagnostic } from '../plannerDiagnostics'

const previous = process.env.GOGA_PLANNER_TRACE
afterEach(() => {
  vi.clearAllMocks()
  if (previous === undefined) delete process.env.GOGA_PLANNER_TRACE
  else process.env.GOGA_PLANNER_TRACE = previous
})
const window = (hwnd: number) => ({ hwnd, pid: 77, title: 'Untitled - Notepad' })
function adapter(output: string | Error) {
  const desktop = new DesktopAdapter()
  Object.assign(desktop, { runPS: output instanceof Error ? vi.fn().mockRejectedValue(output) : vi.fn().mockResolvedValue(output) })
  return desktop
}
function outcomes() { return vi.mocked(plannerDiagnostic).mock.calls.filter(c => c[0] === 'windows.discovery.result').map(c => c[1].outcome) }

describe('window discovery diagnostics preserve selection', () => {
  for (const tracing of [false, true]) {
    for (const count of [0, 1, 2]) {
      it(`trace=${tracing}, ${count} new candidates retains exact-one rule`, async () => {
        if (tracing) process.env.GOGA_PLANNER_TRACE = 'trace.log'
        else delete process.env.GOGA_PLANNER_TRACE
        const matches = [window(100), ...Array.from({length: count}, (_, i) => window(200+i))]
        const output = tracing ? {matches,enumerationSucceeded:true,observations:matches.map(w => ({...w,visible:true,titleMatches:true,timestamp:'2026-10-17T00:00:00Z',className:'Notepad'}))} : matches
        const result = await adapter(JSON.stringify(output)).windowByTitleDiff('Notepad', new Set([100]))
        expect(result).toEqual(count === 1 ? window(200) : null)
        expect(outcomes()).toEqual([count === 0 ? 'zero_candidates' : count === 1 ? 'unique_candidate' : 'multiple_candidates'])
      })
    }
  }
  it('records baseline and exact rejection reasons', async () => {
    process.env.GOGA_PLANNER_TRACE = 'trace.log'
    await adapter(JSON.stringify({ matches:[], enumerationSucceeded:true, observations:[{...window(100),visible:true,titleMatches:true},{...window(200),visible:false,titleMatches:false,title:''}] })).windowByTitleDiff('Notepad', new Set([100]))
    const observations = vi.mocked(plannerDiagnostic).mock.calls.find(c=>c[0]==='windows.discovery.candidates')![1].observations as {rejectionReasons:string[]}[]
    expect(observations.map(w=>w.rejectionReasons)).toEqual([['baseline_hwnd'],['not_visible','empty_title','title_mismatch']])
  })
  it('rejects enumeration failure rather than returning the zero-match null', async () => {
    process.env.GOGA_PLANNER_TRACE = 'trace.log'
    await expect(adapter(JSON.stringify({matches:[],observations:[],enumerationSucceeded:false,enumerationError:5})).windowByTitleDiff('Notepad')).rejects.toThrow('discovery_enumeration_error')
  })
  it('propagates thrown enumeration errors to the tool caller', async () => {
    await expect(adapter(new Error('enumeration failed')).windowByTitleDiff('Notepad')).rejects.toThrow('discovery_enumeration_error')
    expect(plannerDiagnostic).toHaveBeenCalledWith('windows.enumeration_error', expect.objectContaining({error:'enumeration failed'}))
  })
  it('propagates parsing errors rather than treating them as zero candidates', async () => {
    await expect(adapter('invalid json').windowByTitleDiff('Notepad')).rejects.toThrow('discovery_parsing_error')
    expect(plannerDiagnostic).toHaveBeenCalledWith('windows.parsing_error', expect.objectContaining({error:expect.any(String)}))
  })
  it('propagates real subtree adapter failures through the OrThrow seam', async () => {
    await expect(adapter(new Error('PowerShell failed')).findSaveAsInSubtree(100)).rejects.toThrow('discovery_enumeration_error')
  })
  it.each(['', 'garbage', '100|bad|Save as', '100|0|Save as'])('rejects malformed subtree output %j', async output => {
    await expect(adapter(output).findSaveAsInSubtree(100)).rejects.toThrow('discovery_parsing_error')
  })
  it('returns null only for clean absence and preserves valid identities', async () => {
    expect(await adapter('null').findSaveAsInSubtree(100)).toBeNull()
    expect(await adapter('200|77|Save as').findSaveAsInSubtree(100)).toEqual({hwnd:200,pid:77,title:'Save as'})
  })
})
