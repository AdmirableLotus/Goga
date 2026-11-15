import { describe, expect, it } from 'vitest'
import {
  CAMERA_DISTANCE, CAMERA_FOV_DEG, TRIANGLE_SIZE, triangleFrameShare, visibleHeightAt,
} from '../sceneCamera'

/**
 * The framing bug this pins down: the camera used to derive its fov from the
 * container's height, so the compact strip's camera opened to its 55° cap and the
 * triangle shrank to roughly a third of the strip exactly when it had least room.
 * The fov is fixed now, so the triangle's share of the frame is a constant.
 */
describe('triangle framing', () => {
  it('covers a readable share of the frame height', () => {
    const share = triangleFrameShare()
    expect(share).toBeGreaterThan(0.5)
    expect(share).toBeLessThan(0.8)
  })

  it('does not depend on the container at all', () => {
    // Nothing in the signature takes a height, and the number is stable.
    expect(triangleFrameShare()).toBeCloseTo(TRIANGLE_SIZE / visibleHeightAt(), 10)
    expect(triangleFrameShare(CAMERA_FOV_DEG, CAMERA_DISTANCE, TRIANGLE_SIZE))
      .toBe(triangleFrameShare())
  })

  it('keeps the whole outer glow inside a 180 px strip', () => {
    // The membrane and glow layers extend past the outline; leave them room.
    expect(triangleFrameShare()).toBeLessThan(0.72)
    // In a 180 px strip the triangle is still at least 90 px tall.
    expect(triangleFrameShare() * 180).toBeGreaterThan(90)
  })
})
