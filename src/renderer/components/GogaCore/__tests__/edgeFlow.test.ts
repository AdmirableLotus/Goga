import { describe, expect, it } from 'vitest'
import { perimeterPoint } from '../livingTriangle/edgeFlow'

const size = 3
const h = size * Math.sqrt(3) / 2
const top = { x: 0, y: h * 0.6667 }, left = { x: -size / 2, y: -h * 0.3333 }, right = { x: size / 2, y: -h * 0.3333 }

describe('perimeterPoint', () => {
  it('walks top → left → right → top over one lap, matching the triangle layers', () => {
    expect(perimeterPoint(size, 0)).toMatchObject({ x: top.x, y: top.y })
    expect(perimeterPoint(size, 1 / 3).x).toBeCloseTo(left.x)
    expect(perimeterPoint(size, 1 / 3).y).toBeCloseTo(left.y)
    expect(perimeterPoint(size, 2 / 3).x).toBeCloseTo(right.x)
    expect(perimeterPoint(size, 1).x).toBeCloseTo(top.x)          // wraps
    expect(perimeterPoint(size, -1 / 3).x).toBeCloseTo(right.x)   // negative phases wrap too
  })

  it('stays on the edge and points the normal outward', () => {
    for (let u = 0; u < 1; u += 0.07) {
      const p = perimeterPoint(size, u)
      expect(Math.hypot(p.nx, p.ny)).toBeCloseTo(1)
      // Outward: moving along the normal increases distance from the centre.
      expect(Math.hypot(p.x + p.nx * 0.1, p.y + p.ny * 0.1)).toBeGreaterThan(Math.hypot(p.x, p.y) - 1e-9)
    }
    const bottomMid = perimeterPoint(size, 0.5)
    expect(bottomMid.y).toBeCloseTo(left.y)
    expect(bottomMid.ny).toBeCloseTo(-1)
  })
})
