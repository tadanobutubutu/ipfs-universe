/** Normalize Three.js timestamp-query output for a stable diagnostic seam. */
export function normalizeGpuDuration(
  duration: number | undefined,
): number | undefined {
  if (duration === undefined || !Number.isFinite(duration) || duration < 0) {
    return undefined;
  }
  return duration;
}

export interface GpuDurationStats {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** Return percentile/max GPU timing values from a bounded sample window. */
export function gpuDurationStats(samples: ArrayLike<number>): GpuDurationStats {
  const values: number[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    if (value !== undefined && Number.isFinite(value) && value >= 0) {
      values.push(value);
    }
  }
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  values.sort((left, right) => left - right);
  const percentile = (rank: number): number =>
    values[
      Math.min(
        values.length - 1,
        Math.max(0, Math.ceil(values.length * rank) - 1),
      )
    ] ?? 0;
  return {
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: values[values.length - 1] ?? 0,
  };
}
