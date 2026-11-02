import { randomBytes } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

const BOOK_FILE = /\.(pdf|epub|txt|docx|md|csv)$/i
const MAX_TELEGRAM_FILE = 20 * 1024 * 1024

interface Update {
  update_id: number
  message?: {
    date: number; text?: string; caption?: string; from?: { id: number }; chat: { id: number; type: string }
    document?: { file_id: string; file_name?: string; file_size?: number }
  }
}

let active: TelegramService | undefined
let enabled: () => boolean = () => true

/** Whether Goga may start Telegram messages (the "Message me on Telegram" setting). */
export function setPhoneMessagesEnabled(check: () => boolean): void { enabled = check }

/**
 * Send something Goga noticed or did on his own to the owner's Telegram — never a reply to a
 * Telegram message (those already go back). Markdown is stripped: Telegram shows it raw.
 */
export function messageOwnerOnPhone(text: string): void {
  if (!active || !enabled()) return
  void active.messageOwner(text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`/g, ''))
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
    // A book or document sent as a file: add it to the Library; returns the reply.
    private receiveDocument?: (file: string) => Promise<string>,
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

  stop(): void { this.abort.abort(); if (active === this) active = undefined }

  /** Goga starts the conversation: alerts, reminders, scheduled results. Only to the paired owner. */
  async messageOwner(text: string): Promise<boolean> {
    if (!this.owner || !text.trim()) return false
    try { await this.send(this.owner, text); return true } catch { return false }
  }

  /** The running bot, so the rest of Goga can message the owner. */
  makeActive(): void { active = this }

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
    if (!msg || msg.chat.type !== 'private' || msg.from?.id !== msg.chat.id || msg.date < this.startedAt) return
    if (msg.document && this.owner && msg.chat.id === this.owner) { await this.receiveFile(msg.document); return }
    if (!msg.text) return
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

  /** A file sent by the owner: download it (Telegram allows bots up to 20 MB) and hand it to the Library. */
  private async receiveFile(doc: { file_id: string; file_name?: string; file_size?: number }): Promise<void> {
    const owner = this.owner!
    const name = (doc.file_name ?? 'document').replace(/[^A-Za-z0-9 ._()-]/g, '_').slice(0, 120)
    if (!this.receiveDocument) { await this.send(owner, "I can't take files here yet."); return }
    if (!BOOK_FILE.test(name)) { await this.send(owner, 'I can read PDF, EPUB, Word (.docx), text, Markdown and CSV files. Send one of those, or a link with "read and learn".'); return }
    if ((doc.file_size ?? 0) > MAX_TELEGRAM_FILE) {
      await this.send(owner, `"${name}" is bigger than 20 MB, the most Telegram lets me download. Send me a link to it instead, for example "https://… read and learn".`)
      return
    }
    await this.send(owner, `Got "${name}". Reading it into my Library…`)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-telegram-'))
    try {
      const info = await this.api<{ file_path?: string }>('getFile', { file_id: doc.file_id })
      if (!info.file_path) throw new Error('no file path')
      // Never log this URL: it contains the bot token.
      const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${info.file_path}`, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(120_000)]) })
      if (!res.ok) throw new Error(`download failed (${res.status})`)
      const file = path.join(dir, name)
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
      await this.send(owner, await this.receiveDocument(file))
    } catch (err) {
      await this.send(owner, `I couldn't read "${name}": ${err instanceof Error ? err.message.replace(this.token, '…') : 'unknown error'}`).catch(() => {})
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}
