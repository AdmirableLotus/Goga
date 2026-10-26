import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'

interface Update {
  update_id: number
  message?: { date: number; text?: string; from?: { id: number }; chat: { id: number; type: string } }
}

// Transport is separate from the desktop orchestrator to keep authentication testable.
export class TelegramService {
  private abort = new AbortController()
  private offset = 0
  private owner: number | undefined
  private pairingCode = randomBytes(16).toString('hex')
  private startedAt = Math.floor(Date.now() / 1000)
  private busy = false

  constructor(
    private token: string,
    private ownerFile: string,
    private processMessage: (text: string, completed: (reply: string) => void) => Promise<string>,
    private stopTask: () => void,
  ) {
    if (fs.existsSync(ownerFile)) {
      const value = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
      if (!Number.isSafeInteger(value.chatId) || value.chatId <= 0) throw new Error('Invalid Telegram owner file')
      this.owner = value.chatId
    }
  }

  async start(): Promise<void> {
    await this.api('getMe', {})
    if (!this.owner) console.info(`[Telegram] In your private bot chat send: /pair ${this.pairingCode}`)
    console.info('[Telegram] Connected')
    void this.poll()
  }

  stop(): void { this.abort.abort() }

  private async api<T>(method: string, body: object): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(40_000)]),
    })
    const data = await response.json() as { ok: boolean; result: T }
    // Never log fetch exceptions or request URLs: they contain the bot token.
    if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed (${response.status})`)
    return data.result
  }

  private async send(chatId: number, text: string): Promise<void> {
    for (let i = 0; i < text.length; i += 4000) {
      await this.api('sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000) })
    }
  }

  private async poll(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const updates = await this.api<Update[]>('getUpdates', {
          offset: this.offset, timeout: 25, allowed_updates: ['message'],
        })
        for (const update of updates) {
          this.offset = update.update_id + 1
          await this.handle(update)
        }
      } catch {
        if (this.abort.signal.aborted) return
        console.warn('[Telegram] Connection interrupted; retrying in 5 seconds')
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, 5000)
          this.abort.signal.addEventListener('abort', done, { once: true })
        })
      }
    }
  }

  private async handle(update: Update): Promise<void> {
    const msg = update.message
    if (!msg?.text || msg.chat.type !== 'private' || msg.from?.id !== msg.chat.id || msg.date < this.startedAt) return
    const text = msg.text.trim()
    if (!this.owner) {
      if (text !== `/pair ${this.pairingCode}`) return
      fs.mkdirSync(path.dirname(this.ownerFile), { recursive: true })
      fs.writeFileSync(this.ownerFile, JSON.stringify({ chatId: msg.chat.id }), { mode: 0o600 })
      this.owner = msg.chat.id
      this.pairingCode = ''
      await this.send(this.owner, 'Paired with Goga. Send a message or task. Use /stop to stop a task. Approvals remain in the desktop app.')
      return
    }
    if (msg.chat.id !== this.owner) return
    if (text === '/stop') { this.stopTask(); await this.send(this.owner, 'Stop requested.'); return }
    if (text === '/start' || text === '/help') {
      await this.send(this.owner, 'Send a message or task to Goga. /stop stops a task. Keep Goga open on your PC; approve sensitive actions in the desktop app.')
      return
    }
    if (!text) return
    if (this.busy) { await this.send(this.owner, 'Goga is processing a message. Please wait or use /stop.'); return }
    this.busy = true
    const chatId = this.owner
    // Keep polling during inference so /stop remains responsive.
    void this.processMessage(text, reply => {
      void this.send(chatId, reply).catch(() => console.warn('[Telegram] Could not deliver task result'))
    }).then(reply => this.send(chatId, reply))
      .catch(() => this.send(chatId, 'Goga could not process that message. Check the desktop app.').catch(() => {}))
      .finally(() => { this.busy = false })
  }
}
