import * as THREE from 'three'

const MAX_WAVES = 5
const WAVE_SPEED = 0.9      // units per second
const WAVE_LIFETIME = 1.2   // seconds

interface Wave {
  mesh: THREE.Line
  mat: THREE.LineBasicMaterial
  age: number
  active: boolean
}

function triOutline(size: number): THREE.BufferGeometry {
  const h = size * Math.sqrt(3) / 2
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0,          h * 0.6667, 0),
    new THREE.Vector3(-size / 2, -h * 0.3333, 0),
    new THREE.Vector3( size / 2, -h * 0.3333, 0),
    new THREE.Vector3(0,          h * 0.6667, 0),
  ])
}

export interface WaveSystem {
  waves: Wave[]
  lastPeak: number
}

export function createWaveSystem(scene: THREE.Scene): WaveSystem {
  const waves: Wave[] = []
  for (let i = 0; i < MAX_WAVES; i++) {
    const mat = new THREE.LineBasicMaterial({ color: 0x29d9ff, transparent: true, opacity: 0 })
    const mesh = new THREE.Line(triOutline(0.5), mat)
    mesh.visible = false
    scene.add(mesh)
    waves.push({ mesh, mat, age: 0, active: false })
  }
  return { waves, lastPeak: 0 }
}

export function fireWave(sys: WaveSystem, color: number) {
  const w = sys.waves.find(w => !w.active)
  if (!w) return
  w.active = true
  w.age = 0
  w.mat.color.set(color)
  w.mat.opacity = 0.7
  w.mesh.scale.setScalar(0.3)
  w.mesh.visible = true
}

export function tickWaves(sys: WaveSystem, dt: number, amp: number, peakColor: number) {
  // Fire a new wave when amplitude crosses threshold
  if (amp > 0.45 && Date.now() - sys.lastPeak > 300) {
    fireWave(sys, peakColor)
    sys.lastPeak = Date.now()
  }

  for (const w of sys.waves) {
    if (!w.active) continue
    w.age += dt
    const progress = w.age / WAVE_LIFETIME
    if (progress >= 1) {
      w.active = false
      w.mesh.visible = false
      w.mat.opacity = 0
      continue
    }
    const scale = 0.3 + progress * WAVE_SPEED * 3.5
    w.mesh.scale.setScalar(scale)
    w.mat.opacity = 0.7 * (1 - progress)
  }
}
