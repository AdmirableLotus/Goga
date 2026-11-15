/**
 * Camera framing for the living triangle.
 *
 * The scene is drawn into two very different boxes: a tall hero panel before a
 * conversation starts, and a short strip behind the messages afterwards. The
 * camera used to derive its field of view from the container's height, which
 * meant that as the strip got shorter the camera opened up — a wider view of the
 * same triangle, so the triangle got smaller in pixels exactly when it had the
 * least room to spare. Measured on this machine, a 235 px strip pulled the fov to
 * its 55° cap against 38° in the hero, which shrank the triangle to about two
 * thirds of its height.
 *
 * The framing is therefore fixed, not derived from the container. The camera sits
 * at a set distance and looks through a set vertical fov; the triangle is a set
 * size in world units, so it always occupies the same share of whatever height it
 * is given. A shorter box means fewer pixels, but never a shrunken triangle.
 */

/** World-space size of the outermost triangle layer (see LAYERS in useGogaScene). */
export const TRIANGLE_SIZE = 3.0

/** Camera distance along +Z. */
export const CAMERA_DISTANCE = 8.0

/**
 * Vertical field of view, in degrees. Fixed on purpose — see the note above.
 * 34° puts the triangle at roughly three fifths of the frame: large enough to
 * read at a glance in a 180 px strip, small enough that the outer glow and the
 * membrane lines are not cropped.
 */
export const CAMERA_FOV_DEG = 34

/** Height of the camera's view, in world units, at the triangle's plane. */
export function visibleHeightAt(fovDeg = CAMERA_FOV_DEG, distance = CAMERA_DISTANCE): number {
  return 2 * distance * Math.tan((fovDeg * Math.PI) / 360)
}

/** What fraction of the frame's height the triangle covers. */
export function triangleFrameShare(
  fovDeg = CAMERA_FOV_DEG,
  distance = CAMERA_DISTANCE,
  size = TRIANGLE_SIZE,
): number {
  return size / visibleHeightAt(fovDeg, distance)
}
