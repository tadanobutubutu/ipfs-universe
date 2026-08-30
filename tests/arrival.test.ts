import { describe, expect, it } from 'vitest';

import {
  ARRIVAL_PHASES,
  advanceArrival,
  arrivalLinkProgress,
  arrivalScale,
  createArrival,
} from '../src/scene/arrival';

describe('evidence-backed peer arrival choreography', () => {
  it('advances through discovery, ping, link, settle, and reframe', () => {
    let arrival = createArrival('12D3KooWArrival');
    expect(arrival.phase).toBe('discovery');

    arrival = advanceArrival(arrival, 180, false);
    expect(arrival.phase).toBe('ping');
    arrival = advanceArrival(arrival, 240, false);
    expect(arrival.phase).toBe('link');
    arrival = advanceArrival(arrival, 340, false);
    expect(arrival.phase).toBe('settle');
    arrival = advanceArrival(arrival, 240, false);
    expect(arrival.phase).toBe('reframe');
    arrival = advanceArrival(arrival, 100, false);
    expect(arrival.phase).toBe('settled');
    expect(ARRIVAL_PHASES).toContain(arrival.phase);
  });

  it('reveals an evidence edge only during the link phase', () => {
    const beforeLink = advanceArrival(createArrival('peer'), 420 - 1, false);
    const linking = advanceArrival(createArrival('peer'), 420 + 170, false);
    const settled = advanceArrival(createArrival('peer'), 1_100, false);

    expect(arrivalLinkProgress(beforeLink)).toBe(0);
    expect(arrivalLinkProgress(linking)).toBeGreaterThan(0);
    expect(arrivalLinkProgress(linking)).toBeLessThan(1);
    expect(arrivalLinkProgress(settled)).toBe(1);
  });

  it('gives each cinematic stage a distinct spatial emphasis', () => {
    const discovery = advanceArrival(createArrival('peer'), 90, false);
    const ping = advanceArrival(createArrival('peer'), 300, false);
    const link = advanceArrival(createArrival('peer'), 600, false);
    const settle = advanceArrival(createArrival('peer'), 900, false);

    expect(arrivalScale(discovery)).toBeLessThan(arrivalScale(ping));
    expect(arrivalScale(ping)).toBeLessThan(arrivalScale(link));
    expect(arrivalScale(settle)).toBeGreaterThan(1);
  });

  it('settles immediately for reduced motion without intermediate frames', () => {
    const arrival = advanceArrival(createArrival('peer'), 1, true);

    expect(arrival.phase).toBe('settled');
    expect(arrival.progress).toBe(1);
  });
});
