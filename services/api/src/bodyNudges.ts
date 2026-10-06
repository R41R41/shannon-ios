import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { BODY_LIMITS, type BodyNudge, type BodyNudgeScene } from './contracts/bodyContract.js';

/**
 * 軽い声かけ, stage 1: fixed lines the body may show at a suitable moment. No model is called.
 *
 * SEED SET, NEEDS OWNER REVIEW. `packages/cognition` has no canonical list of short lines,
 * and persona is core, so these five sentences are a placeholder written in the voice of the
 * existing fixed sentences (ボク, ライ氏, です・ます; see `autonomyShowing.ts` and
 * `pushNotificationSender.ts`). Replace them with the owner's wording; do not grow the set here.
 * `shannonAuthoredCopy.test.ts` checks this file with the other sentences spoken as Shannon.
 */
type NudgeSeed = Omit<BodyNudge, 'expiresAt'>;

const BODY_NUDGE_SEEDS: readonly NudgeSeed[] = Object.freeze([
  {
    id: 'seed-ownerReturned-1', scene: 'ownerReturned', audience: 'any', text: `おかえりなさい、${SHANNON_OWNER_NAME}。`,
    expression: 'joyful', voice: { affect: 'happy', intensity: 0.5, delivery: 'conversational' },
  },
  {
    id: 'seed-longQuiet-1', scene: 'longQuiet', audience: 'any', text: `${SHANNON_OWNER_NAME}、少し休憩しませんか。`,
    expression: 'tender', voice: { affect: 'caring', intensity: 0.4, delivery: 'gentle' },
  },
  {
    id: 'seed-morning-1', scene: 'morning', audience: 'any', text: `おはようございます、${SHANNON_OWNER_NAME}。`,
    expression: 'calm', voice: { affect: 'gentle', intensity: 0.4, delivery: 'conversational' },
  },
  {
    id: 'seed-lateNight-1', scene: 'lateNight', audience: 'any', text: `${SHANNON_OWNER_NAME}、そろそろ休みませんか。`,
    expression: 'concerned', voice: { affect: 'caring', intensity: 0.45, delivery: 'gentle' },
  },
  {
    // Says that she has written something, so it is for the owner alone.
    id: 'seed-awaitingReaction-1', scene: 'awaitingReaction', audience: 'owner', text: `${SHANNON_OWNER_NAME}、読んでほしいものがあります。`,
    expression: 'bashful', voice: { affect: 'shy', intensity: 0.45, delivery: 'gentle' },
  },
]);

const hourFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' });

/** The owner-local hour (0..23) of an instant. */
export function ownerHour(at: string): number {
  const time = Date.parse(at);
  return Number(hourFormatter.format(new Date(Number.isFinite(time) ? time : 0)));
}

function sceneOffered(scene: BodyNudgeScene, hour: number, awaitingReaction: number): boolean {
  if (scene === 'morning') return hour >= 5 && hour < 10;
  if (scene === 'lateNight') return hour >= 23 || hour < 4;
  if (scene === 'awaitingReaction') return awaitingReaction > 0;
  return true;
}

/** The lines that may be shown from `at` until they expire. */
export function bodyNudgeCandidates(at: string, awaitingReaction: number): readonly BodyNudge[] {
  const hour = ownerHour(at);
  const expiresAt = new Date(Date.parse(at) + BODY_LIMITS.nudgeLifetimeMilliseconds).toISOString();
  return BODY_NUDGE_SEEDS.filter(seed => sceneOffered(seed.scene, hour, awaitingReaction)).map(seed => ({ ...seed, expiresAt }));
}
