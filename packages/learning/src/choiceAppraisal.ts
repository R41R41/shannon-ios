import { appraiseTouch, stationaryBand, type ShannonEmotion, type ShannonTouchOutcome } from '@shannon/cognition';
import { moodEligible } from './reward.js';

/**
 * The mood exit of the reward system (Syzygy ADR-0008 §3, stage 1 step 7b; owner override 1). Core: emotion source. Pure.
 *
 * Every settled choice of hers that may move mood (`moodEligible`) moves it once, by the bounded step of ADR-0006 stage 2
 * (`appraiseTouch`): valence the share 1 − γ toward attractor + w_δ·δ + w_E·V, arousal toward its attractor raised by u
 * (γ 0.61, w_δ 1, w_E 0.4375: Rutledge et al. 2014, the stage-2 values). An outcome older than the episode she has learned
 * (`episodeBoundaryMs`) is stale and moves nothing; so is an expiry (override 1 and 5).
 *
 * Two safeguards of the coordinator, pending the owner's review:
 * - Warm-up (`warmedUp`): a choice whose V did not come from a cell of the choice level or below that had learned from at least
 *   three settled choices moves nothing (`warmup`, not counted against the cap); without it the root prior V = 0 turns every
 *   ordinary success into δ ≈ +0.33, a steady upward push.
 * - Hourly cap: the summed |valence step| of choice appraisals within any rolling hour is at most the stationary band (σ/√(2θ),
 *   0.15). A choice whose step would pass it moves her only the share that is left (`applied_capped`); once nothing is left it
 *   moves nothing (`rate_capped`).
 * Either way a choice stays settled and is learned from by the value table.
 */
export const REWARD_MOOD_WINDOW_MS = 60 * 60_000;

export function rewardMoodCap(): number {
  return stationaryBand();
}

export type RewardMoodCode = 'applied' | 'applied_capped' | 'stale' | 'ineligible' | 'warmup' | 'rate_capped';

export interface AppraisableChoice {
  status: string;
  settleCode: string | null;
  settledAt: string | null;
  delta: number | null;
  expected: number;
  unexpected: number | null;
  /** The level of the cell V was read from at choice time, and how many settled choices it had learned from. */
  expectedLevel: string;
  expectedN: number;
}

/**
 * Warm-up (coordinator, pending the owner's review): before the value table knows a choice, V is the root prior (0) and an
 * ordinary success gives δ ≈ +0.33, a steady upward push. A choice moves mood only when its V came from a cell of the choice
 * level or more specific that had learned from at least this many settled choices.
 */
export const REWARD_MOOD_WARMUP_N = 3;
const KNOWN_LEVELS = new Set(['choice', 'band', 'presence']);

export function warmedUp(choice: Pick<AppraisableChoice, 'expectedLevel' | 'expectedN'>): boolean {
  return KNOWN_LEVELS.has(choice.expectedLevel) && choice.expectedN >= REWARD_MOOD_WARMUP_N;
}

/** The outcome the reducer takes for a choice: its δ as the error, its V as the expectation, its u. */
export function choiceAppraisalOutcome(choice: Pick<AppraisableChoice, 'delta' | 'expected' | 'unexpected'>): ShannonTouchOutcome {
  return { error: choice.delta ?? 0, expectation: choice.expected, unexpected: choice.unexpected ?? 0 };
}

/** How far the step would move valence from where she is now. */
export function choiceMoodStep(emotion: ShannonEmotion, outcome: ShannonTouchOutcome): number {
  return Math.abs(appraiseTouch(emotion, outcome).valence - emotion.valence);
}

/** Whether a settled choice moves her mood now, by what share of its step, and if not, why (a closed code). */
export function rewardMoodDecision(input: {
  choice: AppraisableChoice; now: number; boundaryMs: number; recentSteps: number; step: number;
}): { code: RewardMoodCode; share: number } {
  if (!moodEligible(input.choice)) return { code: 'ineligible', share: 0 };
  if (!warmedUp(input.choice)) return { code: 'warmup', share: 0 };
  const settled = Date.parse(input.choice.settledAt ?? '');
  if (!Number.isFinite(settled) || input.now - settled > input.boundaryMs) return { code: 'stale', share: 0 };
  const left = rewardMoodCap() - Math.max(0, input.recentSteps);
  if (left <= 1e-9) return { code: 'rate_capped', share: 0 };
  return input.step <= left ? { code: 'applied', share: 1 } : { code: 'applied_capped', share: left / input.step };
}
