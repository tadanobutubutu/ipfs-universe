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
const SEVERE_SPIKE_THRESHOLD = 1.6;
const SPIKE_WINDOW_SIZE = 5;
const SPIKE_WINDOW_REQUIRED = 2;
const RECOVERY_THRESHOLD = 0.7;
const DOWNGRADE_STREAK = 2;
const RECOVERY_STREAK = 3;

export class QualityPolicy {
  readonly #targetMs: number;
  #tierIndex = 0;
  #overBudgetStreak = 0;
  #recoveryStreak = 0;
  // A two-second sample can contain a single compositor hitch. Keep a short
  // rolling window of spike observations so repeated, non-adjacent hitches
  // are still actionable without downgrading for one isolated frame.
  readonly #spikeHistory = new Uint8Array(SPIKE_WINDOW_SIZE);
  #spikeHistoryCount = 0;
  #spikeHistoryCursor = 0;

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
    const severeSpike =
      frameMax !== undefined &&
      Number.isFinite(frameMax) &&
      frameMax > this.#targetMs * SEVERE_SPIKE_THRESHOLD;
    this.#spikeHistory[this.#spikeHistoryCursor] = spike ? 1 : 0;
    this.#spikeHistoryCursor =
      (this.#spikeHistoryCursor + 1) % SPIKE_WINDOW_SIZE;
    this.#spikeHistoryCount = Math.min(
      this.#spikeHistoryCount + 1,
      SPIKE_WINDOW_SIZE,
    );
    let recentSpikes = 0;
    for (let index = 0; index < this.#spikeHistoryCount; index += 1) {
      recentSpikes += this.#spikeHistory[index] ?? 0;
    }
    const repeatedSpike = spike && recentSpikes >= SPIKE_WINDOW_REQUIRED;
    if (
      p95 > this.#targetMs * DOWNGRADE_THRESHOLD ||
      repeatedSpike ||
      severeSpike
    ) {
      // A repeated spike is already two independent observations in the
      // rolling window; count it as a complete downgrade signal even when a
      // healthy sample sits between the two hitches.
      this.#overBudgetStreak =
        repeatedSpike || severeSpike
          ? DOWNGRADE_STREAK
          : this.#overBudgetStreak + 1;
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
