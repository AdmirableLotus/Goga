import * as THREE from 'three'

const COUNT = 140

export interface ParticleSystem {
  points: THREE.Points
  positions: Float32Array
  velocities: Float32Array   // angular velocity per particle
  radii: Float32Array
}

export function createParticles(scene: THREE.Scene): ParticleSystem {
  const positions  = new Float32Array(COUNT * 3)
  const velocities = new Float32Array(COUNT)
  const radii      = new Float32Array(COUNT)

  for (let i = 0; i < COUNT; i++) {
    const angle = Math.random() * Math.PI * 2
    const r = 1.1 + Math.random() * 2.0
    radii[i] = r
    positions[i*3]   = Math.cos(angle) * r
    positions[i*3+1] = Math.sin(angle) * r * 0.88
    positions[i*3+2] = (Math.random() - 0.5) * 1.8
    velocities[i] = (0.0002 + Math.random() * 0.0004) * (Math.random() < 0.5 ? 1 : -1)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))

  const mat = new THREE.PointsMaterial({
    color: 0x8b5cff, size: 0.022, transparent: true,
    opacity: 0.5, sizeAttenuation: true,
  })

  const points = new THREE.Points(geo, mat)
  scene.add(points)

  return { points, positions, velocities, radii }
}

export function tickParticles(sys: ParticleSystem, amp: number, targetColor: THREE.Color) {
  const pos = sys.positions
  const speedBoost = 1 + amp * 6

  for (let i = 0; i < COUNT; i++) {
    const px = pos[i*3], py = pos[i*3+1]
    const angle = Math.atan2(py, px) + sys.velocities[i] * speedBoost
    // Amplitude burst: push particles outward slightly
    const r = sys.radii[i] + amp * 0.4
    pos[i*3]   = Math.cos(angle) * r
    pos[i*3+1] = Math.sin(angle) * r * 0.88
  }

  ;(sys.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  ;(sys.points.material as THREE.PointsMaterial).color.lerp(targetColor, 0.05)
  ;(sys.points.material as THREE.PointsMaterial).opacity = 0.4 + amp * 0.35
}
