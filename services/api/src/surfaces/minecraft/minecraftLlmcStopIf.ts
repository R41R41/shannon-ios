import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActHand, ActInput } from '../../contracts/minecraftActContract.js';

/**
 * mb-llmc r9 (run 33, +997: the urgent decision's act was `attack #1677` with `stopIf hpBelow 9`; it reached the body 4.4 s after the first hit,
 * when her health was 6.6, and stopped at once with 0 hands; the act before it, wait and look for an enderman, had no `hostileWithin` and the
 * piglin came up unseen): the stopIf the model wrote is looked at against the frame before it goes to the body.
 * - `hpBelow` at or above her health now would stop the act before its first hand: it is taken off, and the result says so.
 * - an act that waits for something to come to her (`attack` with `hold`, or a `wait` of 3 seconds or more) without `hostileWithin` gets
 *   `hostileWithin: 4` (a walking hostile this near stops it), unless a hostile that is not one she accepts and can reach her is already
 *   that near (it would stop the act before its first hand too), and the result says so.
 * Each change is one line for the fixes the result starts with ("頭が形を直して送った: …"); nothing else of the act is touched.
 */
export const WAIT_HOSTILE_METERS = 4;
/** A `wait` this long is a wait for something to come (a shorter one is a beat between two hands). */
const LONG_WAIT_SECONDS = 3;

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const shown = (value: number) => String(Math.round(value * 10) / 10);

/** The hostiles the frame lists that can reach her, nearest first: the body's `nearbyThreats` with `canReachMe` not false. */
function reachingThreats(observation: BodyObservation | null): Array<{ name: string; distance: number }> {
  const threats = (record(observation?.state.world)?.nearbyThreats ?? []) as unknown;
  return (Array.isArray(threats) ? threats : []).flatMap(item => {
    const threat = record(item), name = threat?.name, distance = finite(threat?.distance);
    return threat && typeof name === 'string' && distance !== null && threat.canReachMe !== false ? [{ name: name.toLowerCase(), distance }] : [];
  }).sort((left, right) => left.distance - right.distance);
}
/** Whether a hand waits for something to come to her. */
const waits = (hand: ActHand) => (hand.do === 'attack' && hand.hold === true) || (hand.do === 'wait' && (hand.seconds ?? 0) >= LONG_WAIT_SECONDS);

type StopIf = Record<string, unknown>;
/** hpBelow above her health is taken off (it would stop the act before its first hand); the line that says so, or null. */
function withoutDeadHp(stopIf: StopIf, health: number | null): string | null {
  const hpBelow = finite(stopIf.hpBelow);
  if (hpBelow === null || health === null || hpBelow <= health) return null;
  delete stopIf.hpBelow;
  return `stopIf hpBelow ${shown(hpBelow)} は今の体力 ${shown(health)} 以上なので外した（付けたままだと 1 手も動かずに止まる）`;
}
/** The hostileWithin a waiting act gets, or the line that says why it did not (a hostile that stops it at once is already that near). */
function waitDefault(act: Partial<ActInput>, observation: BodyObservation | null): { add: boolean; line: string } {
  const accepted = new Set((Array.isArray(act.accept) ? act.accept : []).map(name => String(name).toLowerCase()));
  const near = reachingThreats(observation).find(item => item.distance <= WAIT_HOSTILE_METERS && !accepted.has(item.name));
  return near
    ? { add: false, line: `待つ手に stopIf hostileWithin ${WAIT_HOSTILE_METERS} は足さなかった（${near.name} が既に ${shown(near.distance)}m にいて、足すと 1 手も動かずに止まる）` }
    : { add: true, line: `待つ手の act に stopIf hostileWithin ${WAIT_HOSTILE_METERS} を足した（歩く敵が ${WAIT_HOSTILE_METERS}m 内に来たら止まる。accept の種類は除く）` };
}

/** The act with its stopIf looked at against the frame (`observation`), and the lines that say what was changed (none: the act as it is). */
export function checkedStopIf(input: unknown, observation: BodyObservation | null): { input: unknown; fixes: string[] } {
  const act = record(input) as (Record<string, unknown> & Partial<ActInput>) | null;
  if (!act || !Array.isArray(act.hands)) return { input, fixes: [] };
  const fixes: string[] = [];
  const stopIf: StopIf = { ...record(act.stopIf) };
  const dead = withoutDeadHp(stopIf, finite(record(observation?.state.world)?.health));
  if (dead) fixes.push(dead);
  if (finite(stopIf.hostileWithin) === null && (act.hands as ActHand[]).some(hand => record(hand) && waits(hand))) {
    const chosen = waitDefault(act, observation);
    fixes.push(chosen.line);
    if (chosen.add) stopIf.hostileWithin = WAIT_HOSTILE_METERS;
  }
  if (!fixes.length) return { input, fixes };
  const { stopIf: _old, ...rest } = act;
  return { input: { ...rest, ...(Object.keys(stopIf).length ? { stopIf } : {}) }, fixes };
}