import { afterEach, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { TelegramService } from '../telegram'

const dirs: string[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

it('requires local pairing, persists the owner, and rejects other chats and stale updates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-telegram-')); dirs.push(dir)
  const processMessage = vi.fn().mockResolvedValue('hello')
  const stop = vi.fn()
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: {} }) })
  vi.stubGlobal('fetch', fetchMock)
  const service = new TelegramService('test-token', path.join(dir, 'owner.json'), processMessage, stop)
  const internal = service as any
  const message = (id: number, text: string, type = 'private', date = Math.floor(Date.now() / 1000)) =>
    ({ update_id: 1, message: { date, text, from: { id }, chat: { id, type } } })
  await internal.handle(message(1, 'run something'))
  await internal.handle(message(1, `/pair ${internal.pairingCode}`, 'group'))
  expect(processMessage).not.toHaveBeenCalled()
  expect(fs.existsSync(path.join(dir, 'owner.json'))).toBe(false)
  await internal.handle(message(1, `/pair ${internal.pairingCode}`))
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')).chatId).toBe(1)
  await internal.handle(message(2, 'run something'))
  await internal.handle(message(1, 'old task', 'private', 1))
  expect(processMessage).not.toHaveBeenCalled()
  await internal.handle(message(1, 'hello'))
  await vi.waitFor(() => expect(processMessage).toHaveBeenCalledOnce())
  await internal.handle(message(1, '/stop'))
  expect(stop).toHaveBeenCalledOnce()
  service.stop()
})

it('lets Goga message only the paired owner, and only when allowed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-telegram-')); dirs.push(dir)
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: {} }) })
  vi.stubGlobal('fetch', fetchMock)
  const { messageOwnerOnPhone, setPhoneMessagesEnabled } = await import('../telegram')
  const sent = () => fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/sendMessage')).map(c => JSON.parse(c[1].body))

  const unpaired = new TelegramService('t', path.join(dir, 'none.json'), vi.fn(), vi.fn())
  expect(await unpaired.messageOwner('hi')).toBe(false)

  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ chatId: 42 }))
  const service = new TelegramService('t', path.join(dir, 'owner.json'), vi.fn(), vi.fn())
  messageOwnerOnPhone('before the bot is running')
  service.makeActive()
  let allowed = false
  setPhoneMessagesEnabled(() => allowed)
  messageOwnerOnPhone('turned off')
  allowed = true
  messageOwnerOnPhone('**Daily summary.** No trades today.')
  await vi.waitFor(() => expect(sent()).toHaveLength(1))
  expect(sent()[0]).toEqual({ chat_id: 42, text: 'Daily summary. No trades today.' })
  service.stop()
  messageOwnerOnPhone('after stop')
  expect(sent()).toHaveLength(1)
})

it('takes a book sent as a file from the owner, and only a supported one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goga-telegram-')); dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ chatId: 7 }))
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/getFile')) return { ok: true, json: async () => ({ ok: true, result: { file_path: 'documents/file_1.pdf' } }) }
    if (url.includes('/file/bot')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 book').buffer }
    return { ok: true, json: async () => ({ ok: true, result: {} }), init }
  })
  vi.stubGlobal('fetch', fetchMock)
  let received = ''
  const receive = vi.fn(async (file: string) => { received = fs.readFileSync(file, 'utf8'); return 'Added "Deep Learning".' })
  const service = new TelegramService('tok', path.join(dir, 'owner.json'), vi.fn(), vi.fn(), receive)
  const internal = service as any
  const doc = (chat: number, file_name: string, file_size = 1000) =>
    ({ update_id: 1, message: { date: Math.floor(Date.now() / 1000) + 5, from: { id: chat }, chat: { id: chat, type: 'private' }, document: { file_id: 'f1', file_name, file_size } } })
  const replies = () => fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/sendMessage')).map(c => JSON.parse((c[1] as { body: string }).body).text)

  await internal.handle(doc(99, 'book.pdf'))
  expect(receive).not.toHaveBeenCalled()
  await internal.handle(doc(7, 'song.mp3'))
  await internal.handle(doc(7, 'huge.pdf', 30 * 1024 * 1024))
  expect(receive).not.toHaveBeenCalled()
  await internal.handle(doc(7, 'Deep Learning.pdf'))
  expect(received).toBe('%PDF-1.4 book')
  expect(replies()).toEqual([
    expect.stringMatching(/I can read PDF, EPUB/),
    expect.stringMatching(/bigger than 20 MB[\s\S]*read and learn/),
    'Got "Deep Learning.pdf". Reading it into my Library…',
    'Added "Deep Learning".',
  ])
  service.stop()
})
