import { describe, expect, it } from 'vitest';

import {
  frameElapsedMs,
  simulationDeltaSeconds,
} from '../src/scene/frame-stats';

describe('frame telemetry boundaries', () => {
  it('keeps raw long-task duration separate from clamped simulation delta', () => {
    const raw = frameElapsedMs(1_250, 1_000);

    expect(raw).toBe(250);
    expect(simulationDeltaSeconds(raw)).toBe(0.05);
  });

  it('rejects backwards and non-finite timestamps without poisoning telemetry', () => {
    expect(frameElapsedMs(10, 20)).toBe(0);
    expect(frameElapsedMs(Number.NaN, 20)).toBe(0);
    expect(simulationDeltaSeconds(Number.NaN)).toBe(0);
  });
});
