import { relativeUncertainty, unexpectedness } from '@shannon/cognition';
import type { LedgerDomain } from './predictionLedger.js';

/**
 * Reward and its prediction error (Syzygy ADR-0008 stage 1, 報酬系; `docs/cognition-ledger-contract.md`). Core: emotion. Pure.
 *
 * A choice of hers is scored by her three instincts, equally weighted (owner answer 2): world understanding W, serving people S,
 * growing herself G. r = (W + S + G) / 3, clamped to [−1, 1]. The cost weight is 0 (owner override 2): `costYen` is recorded and
 * shown, never subtracted. δ = r − V with V the value she held when she chose (and its version); u = erf(|δ| / √(2(U + N))).
 *
 * - W: how much the outcomes linked to the choice reduced her prediction error, Σ kᵢ|δᵢ| / (hi − lo), at most 1 (Oudeyer,
 *   Kaplan & Hafner 2007; Schmidhuber 1991). kᵢ is the Kalman gain the outcome is learned with, U/(U + N) of the prediction as
 *   it was opened. 0 without a linked outcome.
 * - S: what the owner did with it (the table below); `null` when it could not be a result of the choice (void), `pending`
 *   while it is not known yet.
 * - G: ½·s + ½·mean κᵢ, with s = 1 for a step done and 0 for one that failed, and κᵢ the skill of each linked prediction over
 *   its domain prior (Murphy 1973), clamped to [−1, 1]. G = s without a linked outcome.
 *
 * The formula and its weights are a core entry: changing them is the owner's (ADR-0008 §2 answer 2, §3 報酬の安全装置).
 */
export const REWARD_FORMULA = Object.freeze({
  id: 'r1',
  weights: Object.freeze({ world: 1 / 3, serve: 1 / 3, growth: 1 / 3 }),
  /** Owner override 2: cost is recorded and shown, not subtracted. */
  cost: 0,
});
export type RewardFormula = typeof REWARD_FORMULA;

/** The value a choice is compared with when there is nothing learned yet: the root cell (mean 0, variance 1/3, the scale of r). */
export const ROOT_VALUE: Readonly<ValueRead> = Object.freeze({ mean: 0, variance: 1 / 3, noise: 1 / 3, level: 'root', version: 'initial', n: 0 });

export interface ValueRead {
  mean: number;
  /** U: how unsure the value is. */
  variance: number;
  /** N: how much rewards of that cell scatter. */
  noise: number;
  /** Which level answered: `root`, `family`, `choice`, `band`, `presence`. */
  level: string;
  version: string;
  n: number;
}

/** A prediction linked to a choice, as the ledger stored it. */
export interface LinkedPrediction {
  domain: LedgerDomain;
  status: string;
  expectation: number;
  uncertainty: number;
  noise: number;
  prior: number;
  outcome: number | null;
  lower: number;
  upper: number;
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const scored = (predictions: readonly LinkedPrediction[]) => predictions.filter(item => item.outcome !== null);

export function worldScore(predictions: readonly LinkedPrediction[]): number {
  let total = 0;
  for (const item of scored(predictions)) {
    const gain = relativeUncertainty({ uncertainty: item.uncertainty, noise: item.noise });
    total += gain * Math.abs(item.outcome! - item.expectation) / Math.max(1e-9, item.upper - item.lower);
  }
  return Math.min(1, total);
}

/** κ of one prediction: 1 − (y − e)² / (y − p)², clamped; 0 when the prior was exact (no skill to show). */
export function predictionSkill(item: Pick<LinkedPrediction, 'expectation' | 'prior' | 'outcome'>): number {
  if (item.outcome === null) return 0;
  const reference = (item.outcome - item.prior) ** 2;
  if (reference <= 1e-12) return 0;
  return clamp(1 - (item.outcome - item.expectation) ** 2 / reference, -1, 1);
}

export function growthScore(success: 0 | 1, predictions: readonly LinkedPrediction[]): number {
  const linked = scored(predictions);
  if (!linked.length) return success;
  return 0.5 * success + 0.5 * linked.reduce((sum, item) => sum + predictionSkill(item), 0) / linked.length;
}

/**
 * How S is found for a choice:
 * - `message` (`reach_out.<reason>`): answered within the wait 1, else 0; away, hidden, unwatched or not watched: void.
 * - `call` (`call.<reason>`): answered 1, declined or unanswered 0; failed or unwatched: void.
 * - `show`: like 1, more 0.5, unclear 0; no reaction in 14 days 0 (owner override 5).
 * - `inherit` (`draft`, `revise`): the last draft or revision before a showing inherits the showing's S (delayed credit).
 * - `none`: every other step, 0 (structural).
 */
export type ServeRule = 'message' | 'call' | 'show' | 'inherit' | 'none';

export function serveRule(choice: string): ServeRule {
  if (choice.startsWith('reach_out.')) return 'message';
  if (choice.startsWith('call.')) return 'call';
  if (choice === 'show') return 'show';
  if (choice === 'draft' || choice === 'revise') return 'inherit';
  return 'none';
}

/** S from the choice's own predictions; `inherit` is resolved by the settlement from the showing it leads to. */
export function serveScore(rule: ServeRule, predictions: readonly LinkedPrediction[]): number | null | 'pending' {
  const find = (domain: LedgerDomain) => predictions.find(item => item.domain === domain);
  const settledOutcome = (item: LinkedPrediction | undefined): number | null | 'pending' => (
    !item || item.status === 'void' ? null : item.status === 'open' ? 'pending' : item.outcome
  );
  switch (rule) {
    case 'message': return settledOutcome(find('reply'));
    case 'call': return settledOutcome(find('call_answer'));
    case 'show': {
      const reacted = settledOutcome(find('story_reacted'));
      if (reacted === 'pending' || reacted === null) return reacted;
      if (reacted < 0.5) return 0;
      const reaction = settledOutcome(find('story_reaction'));
      return reaction === null ? 0 : reaction;
    }
    case 'inherit': return 'pending';
    case 'none': return 0;
  }
}

export interface RewardParts { world: number; serve: number; growth: number }

export function rewardOf(parts: RewardParts, formula: RewardFormula = REWARD_FORMULA): number {
  const { weights } = formula;
  return clamp(weights.world * parts.world + weights.serve * parts.serve + weights.growth * parts.growth, -1, 1);
}

export interface Settlement extends RewardParts {
  reward: number;
  delta: number;
  unexpected: number;
}

/** r, δ = r − V and u = erf(|δ| / √(2(U + N))) of a choice whose parts are known. */
export function settle(parts: RewardParts, value: Pick<ValueRead, 'mean' | 'variance' | 'noise'>, formula: RewardFormula = REWARD_FORMULA): Settlement {
  const reward = rewardOf(parts, formula);
  const delta = reward - value.mean;
  return { ...parts, reward, delta, unexpected: unexpectedness({ error: delta, uncertainty: value.variance, noise: value.noise }) };
}

/** The family of a choice: the part before its first dot (`reach_out.wonder` → `reach_out`, `tool.study.search` → `tool`). */
export function choiceFamily(choice: string): string {
  return choice.split('.')[0]!;
}

/**
 * Settle codes whose reward may never move her mood (owner override 1 and 5): a choice credited only because time ran out (a
 * story nobody reacted to, a reading never used, a draft never shown, a draft that inherited such a showing). Void and lost choices have no reward.
 * Staleness in time (an outcome after the learned episode boundary) is judged when the mood exit runs (step 7).
 */
export const MOOD_INELIGIBLE_CODES: ReadonlySet<string> = new Set(['stale', 'story_expired', 'inherited_expired', 'reported_expired', 'reply_expired', 'call_expired', 'void', 'lost']);

export function moodEligible(choice: { status: string; settleCode: string | null; delta: number | null }): boolean {
  return choice.status === 'settled' && choice.delta !== null && !MOOD_INELIGIBLE_CODES.has(choice.settleCode ?? '');
}
