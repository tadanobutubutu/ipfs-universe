import { describe, expect, it } from 'vitest';

import {
  gpuDurationStats,
  normalizeGpuDuration,
} from '../src/scene/gpu-timing';

describe('GPU timing telemetry', () => {
  it('keeps finite non-negative durations in milliseconds', () => {
    expect(normalizeGpuDuration(4.75)).toBe(4.75);
    expect(normalizeGpuDuration(0)).toBe(0);
  });

  it('omits unsupported, invalid, or negative durations', () => {
    expect(normalizeGpuDuration(undefined)).toBeUndefined();
    expect(normalizeGpuDuration(Number.NaN)).toBeUndefined();
    expect(normalizeGpuDuration(-1)).toBeUndefined();
  });

  it('summarizes a bounded GPU sample window like CPU telemetry', () => {
    expect(gpuDurationStats([1, 4, 2, 8, 3])).toEqual({
      p50: 3,
      p95: 8,
      max: 8,
    });
    expect(gpuDurationStats([])).toEqual({ p50: 0, p95: 0, max: 0 });
  });
});
