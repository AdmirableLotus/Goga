import fs from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../logs', () => ({ LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }))
import { KOKORO_VOICES, kokoroVoiceId } from '../speech/KokoroTtsProvider'

describe('Kokoro voices', () => {
  it('offers only voices that ship with kokoro-js, including male ones', () => {
    const dir = path.join(path.dirname(path.dirname(require.resolve('kokoro-js'))), 'voices')
    for (const id of Object.values(KOKORO_VOICES)) expect(fs.existsSync(path.join(dir, `${id}.bin`)), id).toBe(true)
    expect(Object.keys(KOKORO_VOICES).filter(n => n.includes('male)') && !n.includes('female')).length).toBeGreaterThan(5)
  })

  it('maps the Settings name to a voice, and anything unknown to the default', () => {
    expect(kokoroVoiceId('George (British, male)')).toBe('bm_george')
    expect(kokoroVoiceId('Kokoro (local)')).toBe('af_heart')            // the old single entry
    expect(kokoroVoiceId('Microsoft David Desktop')).toBe('af_heart')   // a Windows voice name
    expect(kokoroVoiceId('')).toBe('af_heart')
  })
})
