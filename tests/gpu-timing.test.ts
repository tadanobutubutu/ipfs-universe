import { describe, expect, it } from 'vitest';

import { normalizeGpuDuration } from '../src/scene/gpu-timing';

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
});
