import { describe, expect, it } from 'vitest';

import {
  capAutoCameraDistance,
  capPortraitDistance,
  fitBoundsRadius,
  fitBoundsRadiusP90,
  fitCompositionRadius,
  fitPerspectiveDistance,
} from '../src/scene/camera-fit';

describe('perspective observatory framing', () => {
  it('uses the narrow horizontal frustum in a portrait viewport', () => {
    const landscape = fitPerspectiveDistance(
      Math.SQRT2 * 10,
      Math.PI / 4,
      1.6,
      1.2,
    );
    const portrait = fitPerspectiveDistance(
      Math.SQRT2 * 10,
      Math.PI / 4,
      0.45,
      1.2,
    );

    expect(portrait).toBeGreaterThan(landscape);
    expect(portrait).toBeCloseTo(92.61, 1);
    expect(capPortraitDistance(portrait, 0.45)).toBeCloseTo(92.61, 1);
    expect(capPortraitDistance(240, 0.45)).toBe(145);
  });

  it('returns a safe finite distance for empty or invalid bounds', () => {
    expect(fitPerspectiveDistance(0, Math.PI / 4, 1, 1.2)).toBe(28);
    expect(fitPerspectiveDistance(Number.NaN, Math.PI / 4, 1, 1.2)).toBe(28);
    expect(fitBoundsRadius(new Float32Array())).toBe(0);
  });

  it('caps wide-field framing so the observatory core stays prominent', () => {
    expect(fitPerspectiveDistance(10_000, Math.PI / 4, 1.6, 1.2)).toBe(180);
    expect(capAutoCameraDistance(180, 1.6)).toBe(150);
    expect(capAutoCameraDistance(180, 0.45)).toBe(145);
  });

  it('finds the furthest live peer radius without allocating vectors', () => {
    const points = new Float32Array([3, 4, 0, -8, 0, 6, 0, 0, 1]);
    expect(fitBoundsRadius(points)).toBeCloseTo(10, 6);
  });

  it('keeps one far outlier from shrinking the observatory composition', () => {
    const regularPoints: number[] = Array.from(
      { length: 19 * 3 },
      (_, index) => (index % 3 === 0 ? 6 : index % 3 === 1 ? 8 : 0),
    );
    const points = new Float32Array(regularPoints.concat([0, 0, 120]));

    expect(fitBoundsRadius(points)).toBeCloseTo(120, 6);
    expect(fitBoundsRadiusP90(points)).toBeCloseTo(10, 6);
    expect(fitCompositionRadius(points)).toBeCloseTo(81.6, 6);
  });
});
