import type { PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { DRAGON_MILESTONES, meterParts } from './minecraftLlmcRoad.js';
import type { Stall } from './minecraftLlmcStalls.js';

/** Five minutes past the meter's target warrants a new look, even while objective evidence keeps growing. */
export const PACE_GRACE_SECONDS = 300;
export interface PaceDelay {
  milestone: string;
  targetSeconds: number;
  secondsBehind: number;
}
export const paceKey = (delay: PaceDelay): string => `pace-${DRAGON_MILESTONES.findIndex(item => item.name === delay.milestone)}`;

/** The meter chooses the milestone; the running clock supplies the delay. Neither chooses a hand. */
export function paceDelay(tree: PlanTree, frame: BodyObservation | null, elapsedSeconds: number | null): PaceDelay | null {
  if (elapsedSeconds === null || !Number.isFinite(elapsedSeconds)) return null;
  const next = meterParts(tree, frame, elapsedSeconds / 60)?.next;
  const milestone = DRAGON_MILESTONES.find(item => item.name === next);
  if (!milestone) return null;
  const secondsBehind = Math.round(elapsedSeconds) - milestone.seconds;
  return secondsBehind >= PACE_GRACE_SECONDS ? { milestone: milestone.name, targetSeconds: milestone.seconds, secondsBehind } : null;
}

/** One notice per meter milestone, across plan changes and step/worker restarts, bounded by the road's closed list. */
export function createPaceWatch(saved: unknown) {
  const names = new Set(DRAGON_MILESTONES.map(item => item.name));
  const raised = new Set(Array.isArray(saved) ? saved.filter((name): name is string => typeof name === 'string' && names.has(name)) : []);
  return {
    note(tree: PlanTree, frame: BodyObservation | null, elapsedSeconds: number | null): Stall | null {
      const delay = paceDelay(tree, frame, elapsedSeconds);
      if (!delay || raised.has(delay.milestone)) return null;
      raised.add(delay.milestone);
      return { kind: 'behind_pace', key: paceKey(delay),
        why: `節目 ${delay.milestone}（目安 ${delay.targetSeconds} 秒）から ${delay.secondsBehind} 秒遅れ` };
    },
    checkpoint: () => ({ minecraftBehindPace: [...raised] }),
  };
}
