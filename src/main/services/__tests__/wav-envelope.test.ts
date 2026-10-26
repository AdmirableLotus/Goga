import { describe, expect, it } from 'vitest'
import { wavEnvelope } from '../speech/wavEnvelope'

function wav(samples: number[], format: 'int16' | 'float32', sampleRate = 1000): Buffer {
  const bits = format === 'int16' ? 16 : 32
  const data = Buffer.alloc(samples.length * bits / 8)
  samples.forEach((s, i) => format === 'int16' ? data.writeInt16LE(Math.round(s * 32767), i * 2) : data.writeFloatLE(s, i * 4))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(format === 'int16' ? 1 : 3, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * bits / 8, 28); h.writeUInt16LE(bits / 8, 32); h.writeUInt16LE(bits, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

// 1 kHz sample rate, 50 ms windows → 50 samples per window: loud, silent, quiet.
const speechLike = [...Array(50).fill(0.8), ...Array(50).fill(0), ...Array(50).fill(0.2)]
  .map((a, i) => a * (i % 2 ? 1 : -1))

describe('wavEnvelope', () => {
  it.each(['int16', 'float32'] as const)('follows loud, silent and quiet parts of a %s clip', format => {
    const e = wavEnvelope(wav(speechLike, format), 50)
    expect(e).toHaveLength(3)
    expect(e[0]).toBeCloseTo(1, 2)            // loudest window normalised to 1
    expect(e[1]).toBe(0)                      // pause
    expect(e[2]).toBeCloseTo(Math.sqrt(0.25), 2)  // quiet syllable lifted by the sqrt curve
  })

  it('returns nothing for data it cannot read', () => {
    expect(wavEnvelope(Buffer.from('not a wav file at all, just some text here....'))).toEqual([])
    const unsupported = wav(speechLike, 'int16'); unsupported.writeUInt16LE(8, 34)   // 8-bit PCM
    expect(wavEnvelope(unsupported)).toEqual([])
  })

  it('handles an all-silent clip', () => {
    expect(wavEnvelope(wav(Array(100).fill(0), 'float32'), 50)).toEqual([0, 0])
  })
})
