import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The regression this file guards: a Firefox session whose socket died must NOT be treated as
 * live. Before the fix, the layer held the dead BidiClient, `isAttached` stayed true, and every
 * later command rejected with "the browser connection is closed" forever — which is exactly the
 * loop that stopped a real run. Now a closed connection drops the attachment so the next action
 * can relaunch, and a command never runs through a dead socket.
 *
 * Everything is mocked: no Firefox is launched, no socket is opened, no site is reached.
 */

const h = vi.hoisted(() => {
  class FakeClient {
    alive = true
    private cbs: Array<() => void> = []
    capabilities = { browserName: 'firefox', browserVersion: '160' }
    get isAlive() { return this.alive }
    onClosed(cb: () => void) { if (!this.alive) cb(); else this.cbs.push(cb) }
    async send() {
      if (!this.alive) throw new Error('the browser connection is closed')
      return {}
    }
    async close() { this.die() }
    /** Simulate the socket dying (crash / window closed): flip and fire listeners, once. */
    die() {
      if (!this.alive) return
      this.alive = false
      const cbs = [...this.cbs]; this.cbs = []
      for (const cb of cbs) cb()
    }
  }
  return { FakeClient, state: { last: null as InstanceType<typeof FakeClient> | null } }
})

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/goga-test' } }))
vi.mock('../../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
vi.mock('../firefox', () => ({
  DEFAULT_DEBUG_PORT: 9333,
  bidiUrl: (p: number) => `ws://127.0.0.1:${p}/session`,
  resolveFirefoxPath: () => 'C:\\firefox.exe',
  launchFirefox: () => ({ launched: true, pid: 1, message: 'started' }),
  probePort: vi.fn(async () => ({ listening: true, bidi: true, browserName: 'firefox', browserVersion: null, detail: 'bidi' })),
}))
vi.mock('../bidi', () => ({
  BidiClient: { open: vi.fn(async () => { const c = new h.FakeClient(); h.state.last = c; return c }) },
  BidiError: class BidiError extends Error {},
}))

import { BrowserLayer } from '../layer'

function liveClient() {
  if (!h.state.last) throw new Error('no client was created')
  return h.state.last
}

beforeEach(() => { h.state.last = null })

describe('BrowserLayer session liveness', () => {
  it('is attached after a successful attach', async () => {
    const layer = new BrowserLayer()
    await layer.attach()
    expect(layer.isAttached).toBe(true)
  })

  it('drops the attachment when the browser closes the connection', async () => {
    const layer = new BrowserLayer()
    await layer.attach()
    expect(layer.isAttached).toBe(true)

    liveClient().die()   // the browser crashed / the window was closed

    // The dead session is not a live one. This is the whole fix: isAttached flips, so the next
    // action relaunches instead of forever hitting "the browser connection is closed".
    expect(layer.isAttached).toBe(false)
  })

  it('does not run a command through a dead socket — it reports "not attached" instead', async () => {
    const layer = new BrowserLayer()
    await layer.attach()
    liveClient().die()
    await expect(layer.screenshot()).rejects.toThrow(/not attached to Firefox/i)
  })

  it('reaps a dead session even if the close callback had not run yet (a raced command)', async () => {
    const layer = new BrowserLayer()
    await layer.attach()
    // Flip liveness without firing onClosed, to model a command that raced the close event.
    liveClient().alive = false
    expect(layer.isAttached).toBe(false)
    await expect(layer.listTabs()).rejects.toThrow(/not attached to Firefox/i)
  })

  it('re-attaches cleanly after a death (a fresh client, a live session)', async () => {
    const layer = new BrowserLayer()
    await layer.attach()
    const first = liveClient()
    first.die()
    expect(layer.isAttached).toBe(false)

    await layer.attach()   // the next attach makes a new client
    expect(layer.isAttached).toBe(true)
    expect(liveClient()).not.toBe(first)
  })
})
