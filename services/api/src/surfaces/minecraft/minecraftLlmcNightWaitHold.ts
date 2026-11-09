import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { lowestReach, readinessOf } from './minecraftLlmcReadiness.js';
import { enemyNear, nightChoiceLine } from './minecraftNightArms.js';
import { doneFacts, undergroundInOverworld } from './minecraftPlanDone.js';
import { roofedInRock } from './minecraftOreRoute.js';

/**
 * The night's wait while the way down is open (the coordinator, 11/10 6:55; end1110r1 night 2, end1109o13 two nights, o10 three nights): with no
 * bed, a pickaxe and the night line's way to the ore said as one act (`nightChoiceLine`), Haiku sealed a hole and sent `wait 30` ten times; the
 * words of the line (「地下の暗さは昼も夜も同じ」) moved 0〜2 of 6 in the replays. In the overworld, with the line's dig choice open and no hostile
 * within 8 m, the first `wait` of an act is held unless a hand before it already works down (a `mine`, a `craft`, or a hand reaching 4 or more
 * below the feet); the hands before it (the seal) are sent. The hold says the line's act. Bounded like the sleep hold: `NIGHT_WAIT_HOLDS` in
 * `NIGHT_WAIT_WINDOW_MS` for a task, past which the wait goes (the way failed: water, lava, a refusal the frame does not show). It moves no node.
 */
export const NIGHT_WAIT_HOLDS = 3;
export const NIGHT_WAIT_WINDOW_MS = 10 * 60_000;
const holds = new Map<string, number[]>();
const WORKS_DOWN = 4;

/** For tests: no task has held a night's wait. */
export function forgetNightWaitHolds(): void { holds.clear(); }

const objectOf = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' ? value as Record<string, unknown> : null;

/** The hold (the hand, 1-based, its kind and its line) of a night's wait with the way down open, or null; `commit` counts it when it stops the act. */
export function nightWaitHold(input: unknown, frame: BodyObservation | null, taskId: string, now: () => number = Date.now):
  { hand: number; kind: string; line: string; commit(): void } | null {
  const hands = (input as { hands?: unknown } | null)?.hands;
  const facts = readinessOf(frame);
  if (!Array.isArray(hands) || !facts || facts.dimension !== 'overworld' || enemyNear(facts.world)) return null;
  const at = hands.findIndex(raw => objectOf(raw)?.do === 'wait');
  if (at < 0) return null;
  const position = objectOf(facts.world.position);
  const feetY = typeof position?.y === 'number' ? Math.floor(position.y) : null;
  const before = hands.slice(0, at);
  if (before.some(raw => ['mine', 'craft'].includes(String(objectOf(raw)?.do ?? ''))))
    return null;
  if (feetY !== null && feetY - lowestReach(before, feetY) >= WORKS_DOWN) return null;
  const done = doneFacts(frame);
  const underground = (!!done && undergroundInOverworld(done)) || roofedInRock(facts.world);
  const line = nightChoiceLine(facts.world, facts.counts, facts.dimension, underground, facts.food);
  const act = line && /を掘り進む/u.test(line) ? /mc_act (\[[^\]]*\])/u.exec(line)?.[1] : undefined;
  if (!act) return null;
  const clock = now(), recent = (holds.get(taskId) ?? []).filter(when => clock - when < NIGHT_WAIT_WINDOW_MS);
  if (recent.length >= NIGHT_WAIT_HOLDS) return null;
  const text = `夜・ベッドを持っていない・8m 内に敵はいない・地下へ掘る手が開いている。穴で待つ wait は送らない`
    + `（${recent.length + 1}/${NIGHT_WAIT_HOLDS} 回目。${NIGHT_WAIT_HOLDS} 回止めた後は通す）: 地下の暗さは昼も夜も同じで、待てば朝に同じ所から始まるだけ。`
    + `代わりに次の 1 手 mc_act ${act}（夜の行と同じ手。掘った壁に鉱石が見えたら mine）。掘る手が断られた・水や溶岩で止まった時は、その理由を直す手を出す`;
  return { hand: at + 1, kind: 'wait', line: text, commit: () => { holds.set(taskId, [...recent, clock]); } };
}
