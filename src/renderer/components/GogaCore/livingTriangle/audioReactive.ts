import type { AudioReactiveState } from './types'

const ATTACK  = 0.35   // how fast smoothed rises  (per frame at 60fps)
const RELEASE = 0.08   // how fast smoothed falls
const PEAK_DECAY = 0.004

export function createAudioState(): AudioReactiveState {
  return { smoothed: 0, peak: 0, envelope: 0 }
}

/**
 * Call once per animation frame with the raw 0–1 amplitude sample.
 * Mutates `state` in place and returns it.
 */
export function tickAudio(state: AudioReactiveState, raw: number): AudioReactiveState {
  // Clamp input
  const v = Math.max(0, Math.min(1, raw))

  // Attack / release smoothing
  const rate = v > state.smoothed ? ATTACK : RELEASE
  state.smoothed += (v - state.smoothed) * rate

  // Peak hold with slow decay
  if (state.smoothed > state.peak) {
    state.peak = state.smoothed
  } else {
    state.peak = Math.max(0, state.peak - PEAK_DECAY)
  }

  // Envelope: snappier version of smoothed for driving visual bursts
  const eRate = v > state.envelope ? 0.5 : 0.12
  state.envelope += (v - state.envelope) * eRate

  return state
}
