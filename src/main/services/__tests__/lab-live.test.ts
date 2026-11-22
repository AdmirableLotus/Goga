import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The live view, and the three ways it could lie.
 *
 *   1. It could assemble the log when the run ends instead of streaming it. The first test
 *      holds an entry arriving while the run is still working.
 *   2. It could show activity when nothing is running. The second test opens the idle view and
 *      finds no entries, no picture, and a status that says so in words.
 *   3. It could show an old picture as if it were current. The third test ends a run and holds
 *      that the last real capture is kept and marked as not live, and that an empty capture
 *      never replaces it.
 *
 * There is no electron here: the module under test imports only the id generator and shared
 * types, which is deliberate — the live view must be testable without an app.
 */

import type { LabLiveEvent } from '../../shared/lab'

async function fresh() {
  const mod = await import('../lab/liveRun')
  mod.resetLiveRunForTests()
  return mod
}

afterEach(() => {
  vi.useRealTimers()
})

describe('an entry reaches the renderer before the run completes', () => {
  it('publishes each entry as it happens, while the run is still active', async () => {
    const live = await fresh()
    const seen: LabLiveEvent[] = []
    live.setLivePublisher(e => seen.push(e))

    live.beginLiveRun('wp-xss', 'Local WordPress XSS path on sink.php')
    const first = live.publishEntry('source', 'Reading sink.php', '420 bytes')
    live.publishEntry('validator', 'The confirming observable is present', 'the value reaches the page')

    // Two entries are already out, and the run has NOT ended.
    const entryEvents = seen.filter(e => e.type === 'entry')
    expect(entryEvents).toHaveLength(2)
    expect(live.liveState().active).toBe(true)
    expect(live.liveState().endedAt).toBeNull()

    // Each one carried its own timestamp and kind, so the view can colour it.
    expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(first.kind).toBe('source')
    expect(entryEvents[0]).toMatchObject({ type: 'entry', entry: { kind: 'source' } })
  })

  it('carries the state with every entry, so a late listener can catch up', async () => {
    const live = await fresh()
    const seen: LabLiveEvent[] = []
    live.setLivePublisher(e => seen.push(e))
    live.beginLiveRun('wp-xss', 'run')
    live.publishEntry('send', 'Sending the payload', 'to 127.0.0.1')
    const last = seen.filter(e => e.type === 'entry').pop()
    expect(last && last.type === 'entry' && last.state.entries).toHaveLength(1)
  })
})

describe('the view says idle when nothing is running', () => {
  it('opens empty, with a status that says idle and no picture to animate', async () => {
    const live = await fresh()
    const state = live.liveState()
    expect(state.active).toBe(false)
    expect(state.entries).toEqual([])
    expect(state.frame).toBeNull()
    expect(state.status).toMatch(/idle/i)
    expect(state.startedAt).toBeNull()
  })

  it('does not add an entry of its own when a run ends', async () => {
    const live = await fresh()
    live.beginLiveRun('wp-xss', 'run')
    live.publishEntry('source', 'Reading a file')
    live.endLiveRun('Done. The payload did not take as markup.')
    const state = live.liveState()
    // Exactly one real entry plus the closing note — nothing else invented.
    expect(state.entries).toHaveLength(2)
    expect(state.entries[state.entries.length - 1].kind).toBe('stop')
    expect(state.active).toBe(false)
    expect(state.status).toMatch(/finished|no longer working/i)
  })

  it('a new run starts from empty, so an old log cannot be read as this run', async () => {
    const live = await fresh()
    live.beginLiveRun('wp-xss', 'first run')
    live.publishEntry('source', 'Reading a file')
    live.endLiveRun('done')
    live.beginLiveRun('payload', 'second run')
    expect(live.liveState().entries).toEqual([])
  })
})

describe('the pane shows the last real capture, never a stale one presented as current', () => {
  it('keeps the last real picture after the run ends, and marks it as not live', async () => {
    const live = await fresh()
    live.beginLiveRun('wp-xss', 'run')
    live.recordFrame({ base64: 'AAAA', url: 'http://127.0.0.1:1234/sink?v=x' })
    expect(live.liveState().frame?.live).toBe(true)
    live.endLiveRun('Done.')
    const frame = live.liveState().frame
    expect(frame).not.toBeNull()
    expect(frame?.url).toBe('http://127.0.0.1:1234/sink?v=x')
    expect(frame?.live).toBe(false)
  })

  it('refuses an empty capture, so it cannot overwrite the last real one', async () => {
    const live = await fresh()
    live.beginLiveRun('wp-xss', 'run')
    const real = live.recordFrame({ base64: 'AAAA', url: 'http://127.0.0.1:1/a' })
    expect(real).not.toBeNull()
    const empty = live.recordFrame({ base64: '', url: 'http://127.0.0.1:1/b' })
    expect(empty).toBeNull()
    expect(live.liveState().frame?.url).toBe('http://127.0.0.1:1/a')
  })

  it('pushes nothing when the browser has no picture to give', async () => {
    vi.useFakeTimers()
    const live = await fresh()
    const frames: LabLiveEvent[] = []
    live.setLivePublisher(e => { if (e.type === 'frame') frames.push(e) })
    live.beginLiveRun('wp-xss', 'run')
    let calls = 0
    live.startFrameLoop(async () => { calls++; return null }, 500)
    await vi.advanceTimersByTimeAsync(1600)
    live.stopFrameLoop()
    expect(calls).toBeGreaterThan(0)
    expect(frames).toHaveLength(0)
    expect(live.liveState().frame).toBeNull()
  })

  it('stops asking for pictures once the run has ended', async () => {
    vi.useFakeTimers()
    const live = await fresh()
    live.beginLiveRun('wp-xss', 'run')
    let calls = 0
    live.startFrameLoop(async () => { calls++; return { base64: 'AAAA', url: 'http://x/1' } }, 400)
    await vi.advanceTimersByTimeAsync(900)
    live.endLiveRun('done')
    const after = calls
    await vi.advanceTimersByTimeAsync(1200)
    expect(calls).toBe(after)
    live.stopFrameLoop()
  })
})
