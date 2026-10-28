/**
 * Streamed speech: Goga starts talking at the end of the first sentence while the
 * brain is still writing, instead of waiting for the whole reply.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SentenceBuffer } from '../speech/sentenceBuffer'

vi.mock('../logs', () => ({
  LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }
}))

vi.mock('../settings', () => ({
  SettingsService: {
    getInstance: () => ({
      get: () => ({
        voiceEnabled: true, autoSpeakResponses: true,
        voiceRate: 1.0, voiceVolume: 1.0, voiceName: 'George (British, male)',
        allowBargeIn: true, wakePhrase: 'hey goga',
        conversationWindowSecs: 45, ttsProvider: 'sapi',
      })
    })
  }
}))

vi.mock('electron', () => ({ app: { getPath: () => 'C:\\fake\\userData' } }))

vi.mock('../speech/WhisperSttProvider', () => ({
  WhisperSttProvider: class {
    name = 'Whisper'
    recognize = vi.fn().mockResolvedValue({ transcript: '' })
    startContinuous = vi.fn(); stopContinuous = vi.fn(); abort = vi.fn()
    static scriptExists = () => false
  }
}))

vi.mock('../speech/ElevenLabsSttProvider', () => ({
  ElevenLabsSttProvider: class {
    name = 'ElevenLabsSTT'
    recognize = vi.fn().mockResolvedValue({ transcript: '' })
    startContinuous = vi.fn(); stopContinuous = vi.fn(); abort = vi.fn()
    static isConfigured = () => false
    static isAvailable = () => Promise.resolve(false)
  }
}))

vi.mock('../speech/ElevenLabsTtsProvider', () => ({
  ElevenLabsTtsProvider: class {
    name = 'ElevenLabs'
    speak = vi.fn().mockResolvedValue(undefined)
    stop = vi.fn(); getVoices = vi.fn().mockResolvedValue([])
    static isConfigured = () => false
  }
}))

vi.mock('../speech/KokoroTtsProvider', () => ({
  KokoroTtsProvider: class {
    name = 'Kokoro'
    speak = vi.fn().mockResolvedValue(undefined)
    stop = vi.fn(); getVoices = vi.fn().mockResolvedValue([])
    isModelReady = vi.fn().mockReturnValue(false)
  },
  KokoroModelMissingError: class extends Error { code = 'KOKORO_MODEL_MISSING' }
}))

import { VoiceOrchestrator } from '../voiceOrchestrator'

function freshOrchestrator() {
  ;(VoiceOrchestrator as any).instance = undefined
  return VoiceOrchestrator.getInstance()
}

/** A streaming voice that records what it is asked to say. */
function makeStreamingTts() {
  const pushed: string[] = []
  let finishStream: (() => void) | null = null
  let failStream: ((e: Error) => void) | null = null
  let failed = false
  const provider = {
    name: 'Kokoro',
    onPlaybackStart: undefined as (() => void) | undefined,
    onAmplitude: undefined as ((v: number) => void) | undefined,
    speak: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(() => { finishStream?.() }),
    getVoices: vi.fn().mockResolvedValue([]),
    speakStream: vi.fn(() => {
      let ended = false
      const done = new Promise<void>((res, rej) => { finishStream = res; failStream = rej })
      return {
        push: (t: string) => { if (!ended) pushed.push(t) },
        end: () => { ended = true; if (!failed) provider.onPlaybackStart?.(); finishStream?.() },
        done,
      }
    }),
    fail: (e: Error) => { failed = true; failStream?.(e) },
  }
  return { provider, pushed }
}

describe('SentenceBuffer', () => {
  const feed = (chunks: string[]) => {
    const b = new SentenceBuffer()
    const out: string[] = []
    for (const c of chunks) out.push(...b.push(c))
    return { out, rest: b.flush() }
  }

  it('releases each sentence as soon as it is complete', () => {
    const b = new SentenceBuffer()
    expect(b.push('Sure, I can')).toEqual([])
    expect(b.push(' help. Your down')).toEqual(['Sure, I can help.'])
    expect(b.push('loads folder has 12 files! Want')).toEqual(['Your downloads folder has 12 files!'])
    expect(b.flush()).toBe('Want')
  })

  it('does not cut at decimals, numbered lists, initials or common abbreviations', () => {
    const { out, rest } = feed(['The model is 3.5 GB. ', 'Steps:\n1. Open it. ', 'Ask Dr. Smith or J. Doe, e.g. today. ', 'Done'])
    expect(out).toEqual(['The model is 3.5 GB.', 'Steps:', '1. Open it.', 'Ask Dr. Smith or J. Doe, e.g. today.'])
    expect(rest).toBe('Done')
  })

  it('keeps a code block in one piece and joins tiny pieces to the next sentence', () => {
    const { out, rest } = feed(['Run this:\n```\nls -la. rm x.\n```\nThen ', 'wait. Ok. ', 'Bye'])
    expect(out[0]).toBe('Run this:')
    expect(out[1]).toContain('```\nls -la. rm x.\n```')
    expect(rest).toBe('Bye')
  })

  it('handles questions, quotes and ellipses', () => {
    const { out } = feed(['Really?! "Yes." Hmm... ok then. '])
    expect(out).toEqual(['Really?!', '"Yes."', 'Hmm...', 'ok then.'])
  })
})

describe('VoiceOrchestrator.speakReply', () => {
  beforeEach(() => { (VoiceOrchestrator as any).instance = undefined })
  afterEach(() => { (VoiceOrchestrator as any).instance = undefined })

  it('starts speaking the first sentence before the reply is finished', async () => {
    const vo = freshOrchestrator()
    const { provider, pushed } = makeStreamingTts()
    vo.setTtsProvider(provider)

    const speech = vo.speakReply()
    speech.push('Hello **there**. I am ')
    expect(provider.speakStream).toHaveBeenCalledOnce()
    expect(pushed).toEqual(['Hello there.'])          // spoken while the rest is still coming
    speech.push('Goga. Nice to')
    expect(pushed).toEqual(['Hello there.', 'I am Goga.'])

    await speech.finish('Hello **there**. I am Goga. Nice to meet you.')
    expect(pushed).toEqual(['Hello there.', 'I am Goga.', 'Nice to'])   // only what was streamed
    expect(provider.speak).not.toHaveBeenCalled()
    expect(vo.getStatus()).toBe('idle')
  })

  it('speaks the final reply when nothing was streamed (tasks, instant answers)', async () => {
    const vo = freshOrchestrator()
    const { provider, pushed } = makeStreamingTts()
    vo.setTtsProvider(provider)

    await vo.speakReply().finish('On it. I will tell you when it is done.')
    expect(pushed).toEqual(['On it.', 'I will tell you when it is done.'])
  })

  it('goes quiet on cancel and never touches a newer reply', async () => {
    const vo = freshOrchestrator()
    const { provider, pushed } = makeStreamingTts()
    vo.setTtsProvider(provider)

    const old = vo.speakReply()
    old.push('First answer. ')
    const newer = vo.speakReply()
    old.cancel()                                // superseded: must not stop the newer reply
    expect(provider.stop).not.toHaveBeenCalled()
    old.push('More from the old turn. ')
    expect(pushed).toEqual(['First answer.'])

    newer.push('Second answer. ')
    newer.cancel()                              // the current reply: silence it
    expect(provider.stop).toHaveBeenCalledOnce()
  })

  it('falls back to the Windows voice when the streaming voice produced nothing', async () => {
    const vo = freshOrchestrator()
    const { provider } = makeStreamingTts()
    vo.setTtsProvider(provider)
    const fallback = { name: 'WindowsSpeech', speak: vi.fn().mockResolvedValue(undefined), stop: vi.fn(), getVoices: vi.fn() }
    ;(vo as any).fallbackTts = fallback

    const speech = vo.speakReply()
    speech.push('Hello. ')
    provider.fail(new Error('Kokoro model not ready'))
    await speech.finish('Hello. World.')
    expect(fallback.speak).toHaveBeenCalledWith('Hello. World.', 1, 1, 'George (British, male)')
  })

  it('uses the whole reply for voices that cannot stream', async () => {
    const vo = freshOrchestrator()
    const plain = { name: 'WindowsSpeech', speak: vi.fn().mockResolvedValue(undefined), stop: vi.fn(), getVoices: vi.fn() }
    vo.setTtsProvider(plain)

    const speech = vo.speakReply()
    speech.push('Hello. ')
    expect(plain.speak).not.toHaveBeenCalled()
    await speech.finish('Hello. World.')
    expect(plain.speak).toHaveBeenCalledWith('Hello. World.', 1, 1, 'George (British, male)')
  })
})
