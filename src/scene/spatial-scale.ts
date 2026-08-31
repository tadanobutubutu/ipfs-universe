/** Numerical safety ceiling, deliberately far beyond the camera envelope.
 * There is no product-level spread cap: practical latency/source mapping stays
 * well below this value, while malformed input cannot create non-finite GPU
 * coordinates. */
export const MAX_PEER_WORLD_RADIUS = 2_048;
export const MIN_PEER_WORLD_RADIUS = 8;

export function clampPeerWorldRadius(radius: number): number {
  if (!Number.isFinite(radius)) return 40;
  return Math.min(
    MAX_PEER_WORLD_RADIUS,
    Math.max(MIN_PEER_WORLD_RADIUS, radius),
  );
}
