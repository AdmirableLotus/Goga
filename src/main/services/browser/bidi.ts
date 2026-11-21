import WebSocket from 'ws'

/**
 * A small WebDriver BiDi client.
 *
 * Firefox 160 does not speak the Chrome DevTools Protocol: `--remote-debugging-port`
 * brings up a WebDriver BiDi endpoint, `/json/version` is a 404, and the only way in is
 * the BiDi websocket. This client speaks that protocol and nothing else.
 *
 * It is deliberately thin. It sends a command, waits for the reply with the matching id,
 * and hands back the result. It keeps no page state — the browser layer above it does.
 */

export interface BidiReply<T = unknown> {
  id: number
  result?: T
  error?: string
  message?: string
}

export class BidiError extends Error {
  constructor(message: string, readonly command: string) {
    super(message)
    this.name = 'BidiError'
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

const COMMAND_TIMEOUT_MS = 30_000

export class BidiClient {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private closed = false
  private onClosedCbs = new Set<() => void>()

  private constructor(
    private socket: WebSocket,
    readonly sessionId: string,
    readonly capabilities: Record<string, unknown>,
  ) {
    socket.on('message', (data: WebSocket.RawData) => this.onMessage(data))
    socket.on('close', () => this.failAll(new BidiError('the browser closed the connection', 'close')))
    socket.on('error', err => this.failAll(new BidiError(`browser connection error: ${err.message}`, 'socket')))
  }

  /** False once the socket has closed or errored, or the session was ended. */
  get isAlive(): boolean { return !this.closed }

  /**
   * Register a callback for when this connection dies — whether the browser closed the socket,
   * the socket errored, or the session was ended here. Fires exactly once. If the connection is
   * already dead, the callback runs now, so a caller can never miss the edge. This is how the
   * layer above drops a dead session instead of holding a corpse and failing every later call.
   */
  onClosed(cb: () => void): void {
    if (this.closed) { try { cb() } catch { /* a listener's own fault */ } return }
    this.onClosedCbs.add(cb)
  }

  private notifyClosed(): void {
    const cbs = [...this.onClosedCbs]
    this.onClosedCbs.clear()
    for (const cb of cbs) { try { cb() } catch { /* a listener's own fault */ } }
  }

  /**
   * Open a BiDi session against `wsUrl`.
   *
   * Firefox's BiDi endpoint creates one session per socket and refuses a second
   * `session.new` on the same connection, so a caller that already holds a session must
   * reuse it rather than call this again.
   */
  static open(wsUrl: string, timeoutMs = 15_000): Promise<BidiClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { maxPayload: 128 * 1024 * 1024 })
      const timer = setTimeout(() => {
        try { socket.close() } catch { /* already gone */ }
        reject(new BidiError(`the browser did not answer at ${wsUrl} within ${timeoutMs}ms`, 'connect'))
      }, timeoutMs)

      socket.once('error', err => {
        clearTimeout(timer)
        reject(new BidiError(`could not reach the browser at ${wsUrl}: ${err.message}`, 'connect'))
      })

      socket.once('open', async () => {
        try {
          // A bare handshake: no capabilities asked for, so Firefox grants the default set.
          const raw = await new Promise<{ result?: { sessionId?: string; capabilities?: Record<string, unknown> } }>((res, rej) => {
            const once = (data: WebSocket.RawData) => {
              try {
                const msg = JSON.parse(data.toString()) as { id?: number; result?: Record<string, unknown>; error?: string; message?: string }
                socket.off('message', once)
                if (msg.error) return rej(new BidiError(msg.message ?? msg.error, 'session.new'))
                res(msg as { result?: { sessionId?: string; capabilities?: Record<string, unknown> } })
              } catch (err) {
                socket.off('message', once)
                rej(err instanceof Error ? err : new Error(String(err)))
              }
            }
            socket.on('message', once)
            socket.send(JSON.stringify({ id: 1, method: 'session.new', params: { capabilities: {} } }))
          })
          clearTimeout(timer)
          const sessionId = raw.result?.sessionId
          if (!sessionId) throw new BidiError('the browser accepted the connection but sent no session id', 'session.new')
          resolve(new BidiClient(socket, sessionId, (raw.result?.capabilities ?? {}) as Record<string, unknown>))
        } catch (err) {
          clearTimeout(timer)
          try { socket.close() } catch { /* already gone */ }
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
  }

  /** Send one BiDi command and wait for its reply. */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new BidiError('the browser connection is closed', method))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BidiError(`the browser did not answer "${method}" within ${COMMAND_TIMEOUT_MS}ms`, method))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
        method,
      })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new BidiError(`could not send "${method}": ${err instanceof Error ? err.message : String(err)}`, method))
      }
    })
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: { id?: number; result?: unknown; error?: string; message?: string }
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (typeof msg.id !== 'number') return   // a broadcast event, not a reply
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) entry.reject(new BidiError(msg.message ?? msg.error, entry.method))
    else entry.resolve(msg.result)
  }

  private failAll(err: Error): void {
    if (this.closed) return
    this.closed = true
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(err)
    }
    this.notifyClosed()
  }

  async close(): Promise<void> {
    if (this.closed) {
      // Already dead from a socket close/error. Still make sure the socket is released and
      // listeners were told, so an explicit close() after a crash is not a silent no-op.
      try { this.socket.close() } catch { /* already closed */ }
      this.notifyClosed()
      return
    }
    this.closed = true
    try { await this.send('session.end') } catch { /* the socket is going anyway */ }
    try { this.socket.close() } catch { /* already closed */ }
    this.notifyClosed()
  }
}
