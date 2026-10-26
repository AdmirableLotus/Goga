/**
 * Loudness envelope of a WAV file, so the Goga visual can pulse with the words
 * actually being spoken instead of a synthetic rhythm.
 *
 * Supports PCM int16 and IEEE float32 (what kokoro-js writes). Returns one value
 * per window in 0–1, normalised so the loudest part of the clip reaches ~1.
 */
export function wavEnvelope(wav: Buffer, windowMs = 50): number[] {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return []

  let format = 0, channels = 0, sampleRate = 0, bits = 0
  let dataStart = -1, dataLength = 0
  for (let p = 12; p + 8 <= wav.length;) {
    const id = wav.toString('ascii', p, p + 4)
    const size = wav.readUInt32LE(p + 4)
    if (id === 'fmt ') {
      format = wav.readUInt16LE(p + 8)
      channels = wav.readUInt16LE(p + 10)
      sampleRate = wav.readUInt32LE(p + 12)
      bits = wav.readUInt16LE(p + 22)
    } else if (id === 'data') {
      dataStart = p + 8
      dataLength = Math.min(size, wav.length - dataStart)
      break
    }
    p += 8 + size + (size % 2)
  }

  const isFloat = format === 3 && bits === 32
  const isInt16 = format === 1 && bits === 16
  if (dataStart < 0 || channels < 1 || sampleRate < 1 || (!isFloat && !isInt16)) return []

  const bytesPerFrame = (bits / 8) * channels
  const frames = Math.floor(dataLength / bytesPerFrame)
  const perWindow = Math.max(1, Math.round(sampleRate * windowMs / 1000))
  const rms: number[] = []
  for (let start = 0; start < frames; start += perWindow) {
    const end = Math.min(frames, start + perWindow)
    let sum = 0
    for (let f = start; f < end; f++) {
      const at = dataStart + f * bytesPerFrame   // first channel is enough for loudness
      const s = isFloat ? wav.readFloatLE(at) : wav.readInt16LE(at) / 32768
      sum += s * s
    }
    rms.push(Math.sqrt(sum / (end - start)))
  }

  const peak = Math.max(...rms, 0)
  if (peak <= 0) return rms.map(() => 0)
  // Square-root curve lifts quiet syllables so the pulse reads as speech, not just peaks.
  return rms.map(v => Math.min(1, Math.sqrt(v / peak)))
}
