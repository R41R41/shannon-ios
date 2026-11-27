import type { ActHand, ActPos, ActResult } from '../../contracts/minecraftActContract.js';
import type { ActTimeTuning } from '../../contracts/minecraftActTime.js';
import { finite as finiteOrNull, rec } from './minecraftLlmcHealth.js';
import { DESCENT_SURFACE_Y } from './minecraftPlanDone.js';

/**
 * What the head learns from a go that came back, and the line of height and speed made from it.
 *
 * A run underground (the one of 11/27: about 34 minutes below the surface, the model wrote 「地下は遅い・地表へ上がるべき」 in its thinking many times and sent the
 * same go with only `maxDig` changed more than twenty times) never saw a number for the height it was below its goal or for the speed of each way of going: the only
 * speed in the input was the surface's and the sea's. This module keeps what each go measured (metres made good, the stop, the seconds, the y at both ends) and
 * says, with the numbers, how far below the goal she is and what each way costs. It names no hand and sends nothing: the decision is the model's.
 */

/** A go's size at which it is a travelling move rather than a hop (the line of short hops is not said when the last go was this long). */
export const LONG_GO_M = 15;

/** One go that came back: the metres it made good, how far its goal was when it began, how it ended, and (when the act held no other slow hand) its seconds. */
export interface GoHop {
  /** Metres nearer the goal it made (the body's `progress.done`). */
  done: number;
  /** The goal's distance when the go began (`done` and what was left); null when the result does not say. */
  target: number | null;
  /** How a go that did not arrive ended (the body's code, in words); null for a go that arrived. */
  stop: string | null;
  /** The act's seconds when the go was its only slow hand; null otherwise. */
  seconds: number | null;
  /** The feet's y when the go began and when it ended (null: not known). */
  fromY: number | null;
  toY: number | null;
}

/** The size of a hop for the line of short moves: how far its goal was, else how far it got. */
export const hopSize = (hop: GoHop): number => hop.target ?? hop.done;

const STOP_WORDS: Readonly<Record<string, string>> = {
  limit_time: '秒数の上限', limit_dig: '掘る数の上限', dead_end: '道が行き止まり', stuck: '体が進めず止まった', unreachable: '届かない', stopIf: 'stopIf で止まった',
  stop_if_hostile: '敵で止まった', reflex: '反射で止まった', deadline: '時間切れ', noProgress: '進みが無く止まった', damage: '傷を受けて止まった', inventoryFull: '持ち物が満杯',
  cancelled: '取り消し', lost: '行き先を見失った', danger: '危険で止まった',
};
/** The words of how a go ended: the body's code (else the act's cut) as a short phrase; an unknown code is said as it is. */
export function stopWords(code: unknown, cutBy: unknown): string {
  const raw = typeof code === 'string' && code ? code : typeof cutBy === 'string' && cutBy && cutBy !== 'failure' ? cutBy : '';
  return raw ? STOP_WORDS[raw] ?? raw : '止まった';
}

const QUICK_HANDS = new Set(['drop', 'equip', 'eat', 'look', 'sneak', 'jump', 'wait']);
const posOf = (value: unknown): ActPos | null => {
  const at = rec(value);
  const x = finiteOrNull(at?.x), y = finiteOrNull(at?.y), z = finiteOrNull(at?.z);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
};
/** Where a go hand is going: its `to`, else the first of its `goals`, else the end of its `path`. */
export function goDestination(hand: Pick<ActHand, 'to' | 'goals' | 'path'> | undefined): ActPos | null {
  return hand ? posOf(hand.to) ?? posOf(hand.goals?.[0]) ?? posOf(hand.path?.at(-1)) : null;
}

/**
 * The hops of the go lines of one act's result (the lines that ran and gave a progress in metres, whether they arrived or stopped). A go that arrived is counted from
 * 1 m (0 m is a planned path, not a hop). A go that stopped is counted when it made headway or its goal was a travelling distance, and only when the result says how far the goal
 * was (`fromStopM` or `left`): a stop without it cannot be told from a short hop. `startY` is the feet's y when the act was sent, `endY` the y read when it came back.
 */
export function hopsOfResult(result: ActResult, hands: readonly Pick<ActHand, 'do'>[], ms: number, startY: number | null, endY: number | null): GoHop[] {
  const single = hands.filter(hand => hand.do === 'go').length === 1 && hands.every(hand => hand.do === 'go' || QUICK_HANDS.has(hand.do));
  const hops: GoHop[] = [];
  for (const line of result.lines) {
    const progress = line.progress;
    if (hands[line.i - 1]?.do !== 'go' || line.status === 'skipped' || progress?.unit !== 'meter' || typeof progress.done !== 'number') continue;
    const left = typeof progress.fromStopM === 'number' ? progress.fromStopM : typeof progress.left === 'number' ? progress.left : null;
    const base = { seconds: single && ms > 0 ? ms / 1000 : null, fromY: startY, toY: progress.at && typeof progress.at.y === 'number' ? progress.at.y : endY };
    if (line.status === 'done') {
      if (progress.done > 0) hops.push({ done: progress.done, target: progress.done + (left ?? 0), stop: null, ...base });
      continue;
    }
    if (left === null) continue;
    const target = progress.done + left;
    if (progress.done > 0 || target >= LONG_GO_M) hops.push({ done: progress.done, target, stop: stopWords(line.code, result.stoppedBy), ...base });
  }
  return hops;
}

// ---- what the gos measured, by where they went

/** One go's speed sample: the metres made good over the seconds, and whether it ended below the surface. */
export interface SpeedSample { metres: number; seconds: number; under: boolean }
export const SPEED_KEPT = 12;
/** A sample counts when the go made at least this many metres over at least this many seconds (shorter ones are the start and the stop). */
const SAMPLE_MIN_M = 8, SAMPLE_MIN_S = 5, MEASURED_MIN = 2;
/** The speed sample of a hop, or null when it is too short to say a speed. */
export function sampleOf(hop: GoHop): SpeedSample | null {
  if (hop.seconds === null || hop.seconds < SAMPLE_MIN_S || hop.done < SAMPLE_MIN_M || hop.toY === null) return null;
  return { metres: hop.done, seconds: hop.seconds, under: hop.toY < DESCENT_SURFACE_Y };
}
/** The measured speed of the gos that ended below (or above) the surface, in m/s over all of their metres and seconds; null with fewer than 2 samples. */
export function measuredSpeed(samples: readonly SpeedSample[], under: boolean): { mps: number; n: number } | null {
  const mine = samples.filter(sample => sample.under === under);
  if (mine.length < MEASURED_MIN) return null;
  const seconds = mine.reduce((sum, sample) => sum + sample.seconds, 0);
  return seconds > 0 ? { mps: mine.reduce((sum, sample) => sum + sample.metres, 0) / seconds, n: mine.length } : null;
}

/** The hops, the speed samples and the last goal of each task (newest last); the queue writes them as results settle. */
export const goSamples = new Map<string, SpeedSample[]>();
export const lastGoGoal = new Map<string, ActPos>();
export function forgetGoAltitude(): void { goSamples.clear(); lastGoGoal.clear(); }

// ---- the line

/** The first estimates, taken from the run of 11/26 to 11/27 (one world, one pack: a guide, not a law). */
const SURFACE_MPS = [2, 4] as const, DIG_MPS = [0.3, 0.5] as const, PILLAR_S = 1.7, STAIRS_S = 3.5;
const GAP_M = 20, FAR_M = 100, NEAR_ADVICE_M = 150;

const mps = (value: number): string => String(Math.round(value * 10) / 10);
function duration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} 秒`;
  const minutes = seconds / 60;
  return minutes < 10 ? `${Math.round(minutes * 10) / 10} 分` : `${Math.round(minutes)} 分`;
}
const span = (low: number, high: number): string => {
  const a = duration(low), b = duration(high);
  return a === b ? `約 ${a}` : a.endsWith('分') && b.endsWith('分') ? `約 ${a.replace(' 分', '')}〜${b}` : `約 ${a}〜${b}`;
};

export interface AltitudeInput {
  /** The body's dimension name (「overworld」); anything else says nothing. */
  dimension: string | null;
  feet: ActPos | null;
  /** Where the hands go (the queue's last go, else the last go that came back). */
  goal: ActPos | null;
  /** The y the last go lost (feet y at its start less at its end, positive going down); null when not known. */
  lastDropM: number | null;
  samples: readonly SpeedSample[];
  /** The ms a step a vertical hand measured, by form. */
  tune: ActTimeTuning;
  /** Enemies on her or health low: the sentence that points at a way is left out, the facts stay. */
  underAttack: boolean;
}

/**
 * 「高さ：今 y=-24、行き先 y=64 → 88 m 下（地下）…」: said only in the overworld, with no sky over her (below the surface's y), when the goal is 20 m or more above her feet and 100 m or
 * more away on the level. The nether, the stronghold and the portal room (goals at her own depth) never meet it. The speeds are measured ones where the gos of this task measured them
 * (two or more, over the metres and seconds of all) and 「目安」 where they did not. The line gives the numbers and the comparison; the way is the model's to choose.
 */
export function altitudeLine(input: AltitudeInput): string | null {
  const { feet, goal } = input;
  if (input.dimension !== 'overworld' || !feet || !goal || feet.y >= DESCENT_SURFACE_Y) return null;
  const up = goal.y - feet.y, level = Math.hypot(goal.x - feet.x, goal.z - feet.z);
  if (up < GAP_M || level < FAR_M) return null;
  const surface = measuredSpeed(input.samples, false), dig = measuredSpeed(input.samples, true);
  const pillarS = input.tune.pillar ? input.tune.pillar / 1000 : null, stairsS = input.tune.stairs ? input.tune.stairs / 1000 : null;
  const walkWords = surface ? `地表を歩く 実測 約 ${mps(surface.mps)} m/s（直近 ${surface.n} 本の go）` : `地表を歩く 約 ${SURFACE_MPS[0]}〜${SURFACE_MPS[1]} m/s（目安）`;
  const digWords = dig ? `地下の go（掘り進み） 実測 約 ${mps(dig.mps)} m/s（直近 ${dig.n} 本の go。満杯・敵・つるはし作り直しを含む）`
    : `地下の水平掘り 約 ${DIG_MPS[0]}〜${DIG_MPS[1]} m/s（目安。満杯・敵・つるはし作り直しを含む）`;
  const pillarWords = pillarS ? `柱で上がる 実測 約 ${mps(pillarS)} 秒/段` : `柱で上がる 約 ${PILLAR_S} 秒/段（目安）`;
  const stairsWords = stairsS ? `階段で上がる 実測 約 ${mps(stairsS)} 秒/段` : `階段で上がる 約 ${STAIRS_S} 秒/段（目安）`;
  const walkLow = surface?.mps ?? SURFACE_MPS[1], walkHigh = surface?.mps ?? SURFACE_MPS[0];
  const digLow = dig?.mps ?? DIG_MPS[1], digHigh = dig?.mps ?? DIG_MPS[0];
  const pillar = pillarS ?? PILLAR_S, stairs = stairsS ?? STAIRS_S;
  const climbLow = up * Math.min(pillar, stairs), climbHigh = up * Math.max(pillar, stairs);
  const metres = Math.round(up), away = Math.round(level);
  const compare = `比べ：地下を掘り進めば ${span(away / digLow, away / digHigh)}／${metres} m 上がってから歩けば 上がり ${span(climbLow, climbHigh)}＋歩き ${span(away / walkLow, away / walkHigh)}`;
  const dropped = input.lastDropM !== null && input.lastDropM >= 5 ? `。直近の go で y が ${Math.round(input.lastDropM)} m 下がった（地下へ入った）` : '';
  const advice = input.underAttack || away < NEAR_ADVICE_M ? ''
    : `。地下にいて行き先が ${NEAR_ADVICE_M} m 以上先なら、石を掘って進むより、先に vertical up で地表へ上がってから go する方が速い目安（理由は上の比べ）`;
  return `高さ：今 y=${Math.round(feet.y)}、行き先 y=${Math.round(goal.y)} → ${metres} m 下（地下）。行き先まで水平 ${away} m${dropped}。`
    + `この実走で見えた速さ：${walkWords}・${digWords}・${pillarWords}・${stairsWords}（柱・階段は水中・封じながらの値）。${compare}${advice}`;
}
