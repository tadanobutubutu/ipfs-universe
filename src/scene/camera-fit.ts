const MIN_CAMERA_DISTANCE = 28;
// Never let a dense import pull the camera so far back that the observatory
// core becomes a speck. Nodes beyond this composition envelope remain
// reachable through orbiting and the anchored picker, while the host star
// keeps its visual weight at every density.
const MAX_CAMERA_DISTANCE = 180;
// Keep the observatory core visually present on narrow screens. The distance
// is still derived from the full peer field; this is only a guard against a
// single outer observation making every node a pinprick.
const PORTRAIT_FOCAL_MAX_DISTANCE = 145;

/**
 * Return the camera distance required to keep a spherical peer field inside
 * both the vertical and horizontal perspective frusta.
 *
 * The horizontal half-angle becomes the limiting angle on a phone. Using the
 * smaller of the two angles prevents the portrait composition from hiding
 * peers to either side of the canvas.
 */
export function fitPerspectiveDistance(
  radius: number,
  fovYRadians: number,
  aspect: number,
  padding = 1.18,
): number {
  const safeRadius = Number.isFinite(radius) ? Math.max(0, radius) : 0;
  const safeFov = Number.isFinite(fovYRadians)
    ? Math.min(Math.PI - 0.02, Math.max(0.02, fovYRadians))
    : Math.PI / 4;
  const safeAspect = Number.isFinite(aspect) ? Math.max(0.01, aspect) : 1;
  const safePadding = Number.isFinite(padding) ? Math.max(1, padding) : 1.18;
  const verticalHalfAngle = safeFov / 2;
  const horizontalHalfAngle = Math.atan(
    Math.tan(verticalHalfAngle) * safeAspect,
  );
  const limitingAngle = Math.min(verticalHalfAngle, horizontalHalfAngle);
  const distance =
    (safeRadius / Math.max(0.01, Math.sin(limitingAngle))) * safePadding;

  return Math.min(
    MAX_CAMERA_DISTANCE,
    Math.max(
      MIN_CAMERA_DISTANCE,
      Number.isFinite(distance) ? distance : MIN_CAMERA_DISTANCE,
    ),
  );
}

/** Keep the phone composition anchored on the observatory core. */
export function capPortraitDistance(distance: number, aspect: number): number {
  const safeDistance = Number.isFinite(distance)
    ? Math.max(MIN_CAMERA_DISTANCE, distance)
    : MIN_CAMERA_DISTANCE;
  return Number.isFinite(aspect) && aspect < 0.72
    ? Math.min(PORTRAIT_FOCAL_MAX_DISTANCE, safeDistance)
    : safeDistance;
}

/** Find the furthest point from the local browser origin in a packed XYZ view. */
export function fitBoundsRadius(points: ArrayLike<number>): number {
  let radiusSquared = 0;
  for (let offset = 0; offset + 2 < points.length; offset += 3) {
    const x = points[offset] ?? 0;
    const y = points[offset + 1] ?? 0;
    const z = points[offset + 2] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }
    radiusSquared = Math.max(radiusSquared, x * x + y * y + z * z);
  }
  return Math.sqrt(radiusSquared);
}

/**
 * Return a robust composition radius for a peer field. A single very distant
 * observation should remain an outer orbit, not force the entire observatory
 * to become a tiny dot. This helper runs only when peers or viewport bounds
 * change, never in the render loop.
 */
export function fitBoundsRadiusP90(points: ArrayLike<number>): number {
  const radii: number[] = [];
  for (let offset = 0; offset + 2 < points.length; offset += 3) {
    const x = points[offset] ?? 0;
    const y = points[offset + 1] ?? 0;
    const z = points[offset + 2] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }
    radii.push(Math.hypot(x, y, z));
  }
  if (radii.length === 0) return 0;
  radii.sort((left, right) => left - right);
  const index = Math.min(radii.length - 1, Math.ceil(radii.length * 0.9) - 1);
  return radii[index] ?? 0;
}

/**
 * Balance a readable core against the outer orbit. The robust radius carries
 * the main composition, while a bounded fraction of the furthest observation
 * prevents an isolated peer from disappearing entirely.
 */
export function fitCompositionRadius(points: ArrayLike<number>): number {
  const furthest = fitBoundsRadius(points);
  const robust = fitBoundsRadiusP90(points);
  if (furthest <= 0 && robust <= 0) return 0;
  return Math.max(18, robust * 0.82, furthest * 0.68);
}

export const CAMERA_MIN_DISTANCE = MIN_CAMERA_DISTANCE;
export const CAMERA_MAX_DISTANCE = MAX_CAMERA_DISTANCE;
export const CAMERA_PORTRAIT_MAX_DISTANCE = PORTRAIT_FOCAL_MAX_DISTANCE;
