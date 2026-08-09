import type { GogaVisualState } from '../GogaVisualState'

export interface LTStatePreset {
  bloomStrength: number
  outerScale: number
  edgeTurbulence: number
  rotSpeed: number
  particleSpeed: number
  coreOpacity: number
  haloOpacity: number
  outerColor: number
  innerColor: number
  coreColor: number
  particleColor: number
  zSpread: number
}

export interface AudioReactiveState {
  smoothed: number
  peak: number
  envelope: number
}

export interface MembranePoint {
  baseX: number
  baseY: number
  dx: number
  dy: number
  phase: number
}

export type { GogaVisualState }
