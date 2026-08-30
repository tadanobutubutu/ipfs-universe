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
});
