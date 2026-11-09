import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { readinessOf } from './minecraftLlmcReadiness.js';
import { BED, canSleepNow, dayTick, enemyNear, minutes, NIGHT_FROM, NIGHT_TO, thunderstorm } from './minecraftNightArms.js';

/**
 * Sleep before the evening's work (the whole-run audit of 11/4, order 1; run60 took planks from a village's houses for three minutes as the night
 * came and died to four zombies; the fact lines of the night and the bed moved no choice in the replays of 11/4). In the overworld from tick
 * 12,542 (a bed can be slept in) until 23,000, with a bed in the pack and no hostile within 8 m, the first work hand of an act (`WORK`) is held
 * unless a `use` or the `place` of a bed comes before it: the sleep comes first. Digging (room for the bed), moving, fighting, eating and getting
 * into cover go through. Bounded: at most `SLEEP_HOLDS` holds of a task in `SLEEP_WINDOW_MS` (a night is about 8 minutes); past them the work goes,
 * for the sleep did not come (no place for the bed, a hostile the frame does not list). A fact with the hand held, as the other gates say theirs;
 * it moves no node (its code is not `gate_required`).
 * The same bounded hold applies during an overworld thunderstorm at any hour; ordinary rain does not enable daytime sleep.
 */
export const SLEEP_HOLDS = 3;
export const SLEEP_WINDOW_MS = 10 * 60_000;
const WORK: ReadonlySet<string> = new Set(['mine', 'make', 'craft', 'smelt', 'furnace', 'obsidian', 'fill', 'chest']);
const holds = new Map<string, number[]>();

/** For tests: no task has held a sleep. */
export function forgetSleepHolds(): void { holds.clear(); }

const objectOf = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' ? value as Record<string, unknown> : null;
const sleeps = (hand: Record<string, unknown>): boolean => hand.do === 'sleep' || hand.do === 'use'
  || (hand.do === 'place' && typeof hand.block === 'string' && BED.test(hand.block));

function sleepWhen(world: Record<string, unknown>): string {
  if (thunderstorm(world)) return '雷雨（時刻に関係なく寝られる）';
  const tick = dayTick(world)!;
  return tick >= NIGHT_FROM ? `夜（朝まで ${minutes(NIGHT_TO - tick)}）` : `夕方（夜まで ${minutes(NIGHT_FROM - tick)}。もう寝られる）`;
}

/**
 * The hold (the hand, 1-based, and its line) of an act sent at night with a bed in the pack, or null. `commit` counts it against the bound: the
 * caller calls it when this hold is the one that stops the act (another guard may stop an earlier hand).
 */
export function sleepFirstHold(input: unknown, frame: BodyObservation | null, taskId: string, now: () => number = Date.now):
  { hand: number; kind: string; line: string; commit(): void } | null {
  const hands = (input as { hands?: unknown } | null)?.hands;
  const facts = readinessOf(frame);
  if (!Array.isArray(hands) || !facts || facts.dimension !== 'overworld') return null;
  if (!canSleepNow(facts.world) || enemyNear(facts.world)) return null;
  const bed = [...facts.counts].find(([name, count]) => BED.test(name) && count > 0)?.[0];
  if (!bed) return null;
  const at = hands.findIndex(raw => WORK.has(String(objectOf(raw)?.do ?? '')));
  if (at < 0 || hands.slice(0, at).some(raw => sleeps(objectOf(raw) ?? {}))) return null;
  const clock = now(), recent = (holds.get(taskId) ?? []).filter(when => clock - when < SLEEP_WINDOW_MS);
  if (recent.length >= SLEEP_HOLDS) return null;
  const when = sleepWhen(facts.world);
  const effect = thunderstorm(facts.world) ? '雷雨が止む' : '夜が飛び、朝になる';
  const line = `${when}・ベッドを持っている（${bed.replace(/^minecraft:/u, '')}）・8m 内に敵はいない。寝る前の作業（掘る・作る・焼く・箱）は送らない`
    + `（${recent.length + 1}/${SLEEP_HOLDS} 回目。${SLEEP_HOLDS} 回止めた後は通す）: sleep の手（ベッドを置いて寝て、朝に拾い直す）で${effect}（地下でも寝られる。`
    + 'ネザー・エンドでは爆発する）。'
    + '寝られなかった時は返った理由（置けない・敵が近い）を直す手（dig で 2 マス空ける・離れる・囲う）を出す。'
    + '作業は寝た後にもう一度出す';
  return { hand: at + 1, kind: String(objectOf(hands[at])?.do), line, commit: () => { holds.set(taskId, [...recent, clock]); } };
}
