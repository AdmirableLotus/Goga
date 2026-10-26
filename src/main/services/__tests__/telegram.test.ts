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
