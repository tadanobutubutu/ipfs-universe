import { describe, expect, it } from 'vitest';

import {
  QUALITY_TIERS,
  QualityPolicy,
  type QualityTier,
} from '../src/scene/quality-policy';

describe('symmetric render quality policy', () => {
  it('does not downgrade for one isolated frame spike', () => {
    const policy = new QualityPolicy();

    const decision = policy.observe({ frameP95Ms: 42 });

    expect(decision.tier).toBe<QualityTier>('cinema');
    expect(decision.changed).toBe(false);
  });

  it('downgrades after sustained misses and reports the new pixel scale', () => {
    const policy = new QualityPolicy();

    policy.observe({ frameP95Ms: 28 });
    const decision = policy.observe({ frameP95Ms: 28 });

    expect(decision.tier).toBe('balanced');
    expect(decision.pixelRatioScale).toBe(0.86);
    expect(decision.reason).toBe('over-budget');
    expect(QUALITY_TIERS).toEqual(['cinema', 'balanced', 'efficient', 'still']);
  });

  it('recovers one tier only after a longer cool-down below budget', () => {
    const policy = new QualityPolicy();
    policy.observe({ frameP95Ms: 28 });
    policy.observe({ frameP95Ms: 28 });

    policy.observe({ frameP95Ms: 8 });
    policy.observe({ frameP95Ms: 8 });
    const decision = policy.observe({ frameP95Ms: 8 });

    expect(decision.tier).toBe('cinema');
    expect(decision.pixelRatioScale).toBe(1);
    expect(decision.reason).toBe('recovered');
  });

  it('downgrades on repeated long frame spikes even when p95 is healthy', () => {
    const policy = new QualityPolicy();

    policy.observe({ frameP95Ms: 10, frameMaxMs: 26 });
    const decision = policy.observe({ frameP95Ms: 10, frameMaxMs: 26 });

    expect(decision.changed).toBe(true);
    expect(decision.tier).toBe('balanced');
    expect(decision.reason).toBe('over-budget');
  });

  it('catches a repeated 20ms-class compositor spike', () => {
    const policy = new QualityPolicy();

    policy.observe({ frameP95Ms: 10, frameMaxMs: 20.5 });
    const decision = policy.observe({ frameP95Ms: 10, frameMaxMs: 20.5 });

    expect(decision.changed).toBe(true);
    expect(decision.tier).toBe('balanced');
  });

  it('downgrades immediately for a severe compositor stall', () => {
    const policy = new QualityPolicy();

    const decision = policy.observe({ frameP95Ms: 10, frameMaxMs: 27 });

    expect(decision.changed).toBe(true);
    expect(decision.tier).toBe('balanced');
  });

  it('does not treat one exactly-two-tick frame as severe on a 60 Hz cadence', () => {
    const policy = new QualityPolicy();

    const decision = policy.observe({
      frameP50Ms: 16.67,
      frameP95Ms: 16.67,
      frameMaxMs: 33.33,
    });

    expect(decision.changed).toBe(false);
    expect(decision.tier).toBe('cinema');
  });

  it('catches non-adjacent compositor spikes in the rolling sample window', () => {
    const policy = new QualityPolicy();

    policy.observe({ frameP95Ms: 10, frameMaxMs: 21 });
    policy.observe({ frameP95Ms: 10, frameMaxMs: 10 });
    const decision = policy.observe({ frameP95Ms: 10, frameMaxMs: 21 });

    expect(decision.changed).toBe(true);
    expect(decision.tier).toBe('balanced');
  });
});
