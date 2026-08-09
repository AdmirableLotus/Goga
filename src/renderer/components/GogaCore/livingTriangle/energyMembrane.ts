import * as THREE from 'three'
import type { MembranePoint } from './types'

const SEGMENTS = 24   // points per edge

/** Build the 3 edges of an equilateral triangle, each subdivided into SEGMENTS points */
export function buildMembranePoints(size: number): MembranePoint[] {
  const h = size * Math.sqrt(3) / 2
  const verts: [number, number][] = [
    [0,          h * 0.6667],
    [-size / 2, -h * 0.3333],
    [ size / 2, -h * 0.3333],
  ]

  const pts: MembranePoint[] = []
  for (let e = 0; e < 3; e++) {
    const [ax, ay] = verts[e]
    const [bx, by] = verts[(e + 1) % 3]
    for (let s = 0; s < SEGMENTS; s++) {
      const t = s / SEGMENTS
      pts.push({
        baseX: ax + (bx - ax) * t,
        baseY: ay + (by - ay) * t,
        dx: 0, dy: 0,
        phase: Math.random() * Math.PI * 2,
      })
    }
  }
  return pts
}

/** Build a THREE.BufferGeometry line loop from membrane points */
export function buildMembraneGeometry(pts: MembranePoint[]): THREE.BufferGeometry {
  const positions = new Float32Array((pts.length + 1) * 3)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  updateMembraneGeometry(geo, pts)
  return geo
}

/** Update existing geometry positions from current membrane point state */
export function updateMembraneGeometry(geo: THREE.BufferGeometry, pts: MembranePoint[]) {
  const pos = geo.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pts.length; i++) {
    pos.setXYZ(i, pts[i].baseX + pts[i].dx, pts[i].baseY + pts[i].dy, 0)
  }
  // Close the loop
  pos.setXYZ(pts.length, pts[0].baseX + pts[0].dx, pts[0].baseY + pts[0].dy, 0)
  pos.needsUpdate = true
}

/**
 * Tick membrane displacement.
 * turbulence = base turbulence from state preset (0–1)
 * amp        = audio envelope (0–1), adds extra displacement
 */
export function tickMembrane(pts: MembranePoint[], t: number, turbulence: number, amp: number) {
  const base = turbulence * 0.18
  const extra = amp * 0.32

  for (const p of pts) {
    // Two overlapping sine waves per point for organic feel
    const n1 = Math.sin(t * 1.7 + p.phase) * Math.cos(t * 0.9 + p.phase * 1.3)
    const n2 = Math.sin(t * 3.1 + p.phase * 2.1) * 0.4

    // Outward normal direction: normalize (baseX, baseY)
    const len = Math.sqrt(p.baseX * p.baseX + p.baseY * p.baseY) || 1
    const nx = p.baseX / len
    const ny = p.baseY / len

    const disp = (n1 + n2) * (base + extra)
    p.dx = nx * disp
    p.dy = ny * disp
  }
}
