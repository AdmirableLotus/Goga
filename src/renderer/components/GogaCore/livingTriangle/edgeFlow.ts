import * as THREE from 'three'
import type { GogaVisualState } from './types'

/**
 * Energy streaming along Goga's triangle: comets of light circle the outer edge
 * and (counter-rotating) the core. Speed follows Goga's state; while speaking,
 * Goga's voice level speeds them up, brightens them and makes the edges crackle.
 */

const TRAIL = 10                 // points per comet, head first
const OUTER_COMETS = 14
const INNER_COMETS = 6

// Perimeter laps per second for each state (outer stream; the core runs 1.8× faster).
const LAPS_PER_SEC: Record<GogaVisualState, number> = {
  idle: 0.018, listening: 0.05, transcribing: 0.06, thinking: 0.09, acting: 0.16,
  seeing: 0.07, searching: 0.11, speaking: 0.04, waitingApproval: 0.012,
  success: 0.12, error: 0.03, stopped: 0.004, wakeDetected: 0.2,
}

/** Point on an equilateral triangle outline (same vertices as Goga's layers), u ∈ [0, 1) per lap. */
export function perimeterPoint(size: number, u: number): { x: number; y: number; nx: number; ny: number } {
  const h = size * Math.sqrt(3) / 2
  const v = [[0, h * 0.6667], [-size / 2, -h * 0.3333], [size / 2, -h * 0.3333]]
  const wrapped = ((u % 1) + 1) % 1
  const seg = Math.min(2, Math.floor(wrapped * 3))
  const t = wrapped * 3 - seg
  const [ax, ay] = v[seg], [bx, by] = v[(seg + 1) % 3]
  const dx = bx - ax, dy = by - ay
  const len = Math.hypot(dx, dy)
  // Outward normal: the triangle is centred on the origin, so flip toward the edge midpoint.
  let nx = dy / len, ny = -dx / len
  if (nx * (ax + bx) + ny * (ay + by) < 0) { nx = -nx; ny = -ny }
  return { x: ax + dx * t, y: ay + dy * t, nx, ny }
}

/** Soft round glow so points read as light, not squares. */
function glowSprite(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.25, 'rgba(255,255,255,0.6)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

interface Stream {
  points: THREE.Points
  positions: Float32Array
  colors: Float32Array
  phases: Float32Array            // each comet's position along the lap
  size: number
  direction: 1 | -1
  speedFactor: number
  spacing: number                 // lap fraction between trail points
}

export interface EdgeFlow { outer: Stream; inner: Stream; time: number }

function createStream(parent: THREE.Object3D, size: number, comets: number, direction: 1 | -1,
  speedFactor: number, pointSize: number, sprite: THREE.Texture): Stream {
  const n = comets * TRAIL
  const positions = new Float32Array(n * 3)
  const colors = new Float32Array(n * 3)
  const phases = new Float32Array(comets)
  for (let i = 0; i < comets; i++) phases[i] = i / comets + Math.random() * 0.03
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({
    size: pointSize, map: sprite, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  })
  const points = new THREE.Points(geo, mat)
  parent.add(points)
  return { points, positions, colors, phases, size, direction, speedFactor, spacing: 0.0045 * 3 / size }
}

export function createEdgeFlow(group: THREE.Group, scene: THREE.Scene, outerSize: number, coreSize: number): EdgeFlow {
  const sprite = glowSprite()
  return {
    // Outer stream rides with the layered triangle (gestures rotate/scale it too).
    outer: createStream(group, outerSize, OUTER_COMETS, 1, 1, 0.17, sprite),
    // Core stream sits just in front of Goga's core, like the other core pieces.
    inner: createStream(scene, coreSize, INNER_COMETS, -1, 1.8, 0.11, sprite),
    time: 0,
  }
}

function tickStream(s: Stream, laps: number, energy: number, crackle: number, color: THREE.Color, z: number, time: number) {
  for (let c = 0; c < s.phases.length; c++) {
    s.phases[c] = (s.phases[c] + laps * s.speedFactor * s.direction + 1) % 1
    for (let k = 0; k < TRAIL; k++) {
      const i = c * TRAIL + k
      const p = perimeterPoint(s.size, s.phases[c] - s.direction * k * s.spacing)
      // Crackle: a small outward/inward flicker, stronger with Goga's voice.
      const off = Math.sin(time * 23 + c * 7.1 + k * 1.3) * crackle * (1 - k / TRAIL)
      s.positions[i * 3] = p.x + p.nx * off
      s.positions[i * 3 + 1] = p.y + p.ny * off
      s.positions[i * 3 + 2] = z
      const fade = energy * Math.pow(1 - k / TRAIL, 1.6)
      s.colors[i * 3] = color.r * fade
      s.colors[i * 3 + 1] = color.g * fade
      s.colors[i * 3 + 2] = color.b * fade
    }
  }
  s.points.geometry.attributes.position.needsUpdate = true
  s.points.geometry.attributes.color.needsUpdate = true
}

/**
 * dt: seconds since last frame. audio: Goga's smoothed voice level (0–1).
 * outerZ: depth of the outermost triangle layer, so the stream sits on it.
 */
export function tickEdgeFlow(flow: EdgeFlow, dt: number, vs: GogaVisualState, audio: number,
  color: THREE.Color, outerZ: number, coreZ: number) {
  flow.time += dt
  const speaking = vs === 'speaking'
  const laps = (LAPS_PER_SEC[vs] + (speaking ? audio * 0.3 : 0)) * dt
  const energy = (vs === 'stopped' ? 0.3 : 0.95) + (speaking ? audio * 0.6 : 0)
  const crackle = 0.008 + (speaking ? audio * 0.06 : 0) + (vs === 'error' ? 0.04 : 0)
  tickStream(flow.outer, laps, energy, crackle, color, outerZ + 0.02, flow.time)
  tickStream(flow.inner, laps, energy * 1.1, crackle * 0.6, color, coreZ, flow.time)
}
