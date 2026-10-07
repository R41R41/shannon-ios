import { rewardOf } from './reward.js';

/** Owner-approved ADR-0008 stage 5 policy. This is used by value versions only, never by settlement or mood. */
export const FEEDBACK_POLICY = Object.freeze({ id: 'owner_feedback_80_20_v1', natural: 0.8, optional: 0.2 });
export function feedbackServe(natural: number, reaction: 'good' | 'bad' | null): number {
  if (!Number.isFinite(natural)) throw new Error('FEEDBACK_NATURAL_INVALID');
  return reaction === null ? natural : FEEDBACK_POLICY.natural * natural + FEEDBACK_POLICY.optional * (reaction === 'good' ? 1 : 0);
}
export function feedbackReward(parts: { world: number; serve: number; growth: number }, reaction: 'good' | 'bad' | null): { reward: number; serve: number } {
  const serve = feedbackServe(parts.serve, reaction);
  return { reward: rewardOf({ ...parts, serve }), serve };
}
