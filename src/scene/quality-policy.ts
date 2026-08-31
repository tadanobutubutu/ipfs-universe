export const QUALITY_TIERS = [
  'cinema',
  'balanced',
  'efficient',
  'still',
] as const;

export type QualityTier = (typeof QUALITY_TIERS)[number];

export interface QualitySample {
  readonly frameP95Ms: number;
  /** Largest observed frame in the sample window, used for jank spikes. */
  readonly frameMaxMs?: number;
}

export interface QualityDecision {
  readonly changed: boolean;
  readonly tier: QualityTier;
  readonly pixelRatioScale: number;
  readonly reason: 'over-budget' | 'recovered' | 'steady';
}

const PIXEL_RATIO_SCALES: Record<QualityTier, number> = {
  cinema: 1,
  balanced: 0.86,
  efficient: 0.7,
  still: 0.55,
};

const DEFAULT_TARGET_MS = 16.7;
const DOWNGRADE_THRESHOLD = 1.25;
const SPIKE_THRESHOLD = 1.2;
const RECOVERY_THRESHOLD = 0.7;
const DOWNGRADE_STREAK = 2;
const RECOVERY_STREAK = 3;

export class QualityPolicy {
  readonly #targetMs: number;
  #tierIndex = 0;
  #overBudgetStreak = 0;
  #recoveryStreak = 0;

  constructor(targetMs = DEFAULT_TARGET_MS) {
    this.#targetMs =
      Number.isFinite(targetMs) && targetMs > 0 ? targetMs : DEFAULT_TARGET_MS;
  }

  get tier(): QualityTier {
    return QUALITY_TIERS[this.#tierIndex] ?? 'cinema';
  }

  observe(sample: QualitySample): QualityDecision {
    const p95 = sample.frameP95Ms;
    if (!Number.isFinite(p95) || p95 < 0) {
      return this.#decision(false, 'steady');
    }

    const frameMax = sample.frameMaxMs;
    const spike =
      frameMax !== undefined &&
      Number.isFinite(frameMax) &&
      frameMax > this.#targetMs * SPIKE_THRESHOLD;
    if (p95 > this.#targetMs * DOWNGRADE_THRESHOLD || spike) {
      this.#overBudgetStreak += 1;
      this.#recoveryStreak = 0;
      if (
        this.#overBudgetStreak >= DOWNGRADE_STREAK &&
        this.#tierIndex < QUALITY_TIERS.length - 1
      ) {
        this.#tierIndex += 1;
        this.#overBudgetStreak = 0;
        return this.#decision(true, 'over-budget');
      }
      return this.#decision(false, 'over-budget');
    }

    if (p95 < this.#targetMs * RECOVERY_THRESHOLD) {
      this.#recoveryStreak += 1;
      this.#overBudgetStreak = 0;
      if (this.#recoveryStreak >= RECOVERY_STREAK && this.#tierIndex > 0) {
        this.#tierIndex -= 1;
        this.#recoveryStreak = 0;
        return this.#decision(true, 'recovered');
      }
      return this.#decision(false, 'steady');
    }

    this.#overBudgetStreak = 0;
    this.#recoveryStreak = 0;
    return this.#decision(false, 'steady');
  }

  #decision(
    changed: boolean,
    reason: QualityDecision['reason'],
  ): QualityDecision {
    const tier = this.tier;
    return {
      changed,
      tier,
      pixelRatioScale: PIXEL_RATIO_SCALES[tier],
      reason,
    };
  }
}
