import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
vi.mock('screenshot-desktop', () => ({default:vi.fn()}))
vi.mock('@nut-tree-fork/nut-js', () => ({}))
vi.mock('../focusManager', () => ({FocusManager:{getInstance:()=>({})}}))
// Retain the production discovery error class; no desktop operations are run.
vi.mock('../../adapters/desktop', async importOriginal => {
  const actual = await importOriginal<typeof import('../../adapters/desktop')>()
  return {...actual,DesktopAdapter:vi.fn(()=>({windowByTitleDiff:vi.fn().mockResolvedValue(null)}))}
})
import { ToolRegistry } from '../../tools/registry'
import '../../tools/computer'
const childProcess = require('child_process') as typeof import('child_process')
afterEach(() => vi.restoreAllMocks())
function respond(output: string, code = 0, stderr = '') {
  vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), {stdout:new EventEmitter(),stderr:new EventEmitter()})
    queueMicrotask(() => { proc.stdout.emit('data',Buffer.from(output)); proc.stderr.emit('data',Buffer.from(stderr)); proc.emit('close',code) })
    return proc as any
  })
}
async function snapshot() {
  return ToolRegistry.getInstance().execute('computer.snapshotHwnds', {}, {abortSignal:new AbortController().signal})
}
describe('actual baseline tool preserves discovery errors', () => {
  it('fails closed on enumeration errors instead of returning an empty baseline', async () => {
    respond('',1,'fixture enumeration failure')
    expect(await snapshot()).toMatchObject({success:false,error:expect.stringContaining('discovery_enumeration_error')})
  })
  it('distinguishes parsing errors from zero windows', async () => {
    respond('invalid HWND list')
    expect(await snapshot()).toMatchObject({success:false,error:expect.stringContaining('discovery_parsing_error')})
  })
  it('preserves clean zero-window snapshots', async () => {
    respond('')
    expect(await snapshot()).toMatchObject({success:true,data:{hwnds:[]}})
  })
  it('preserves valid baseline identities', async () => {
    respond('100,200')
    expect(await snapshot()).toMatchObject({success:true,data:{hwnds:[100,200]}})
  })
})
