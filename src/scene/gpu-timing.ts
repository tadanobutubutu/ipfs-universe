/** Normalize Three.js timestamp-query output for a stable diagnostic seam. */
export function normalizeGpuDuration(
  duration: number | undefined,
): number | undefined {
  if (duration === undefined || !Number.isFinite(duration) || duration < 0) {
    return undefined;
  }
  return duration;
}
