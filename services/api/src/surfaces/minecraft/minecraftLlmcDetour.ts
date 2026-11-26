import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { readActResult, type ActHand, type ActPos } from '../../contracts/minecraftActContract.js';
import { carriedItemCounts } from './minecraftItems.js';
import { world } from './minecraftLlmcHealth.js';

/**
 * Two facts for the head, said as facts; what to do with them is the model's (no hand is changed or refused).
 *
 * 1. `detourLines`: the go hands of the plan node she is on now. A long road in the Nether was walked as relay points; the head sent her back to
 *    the same relay point again and again (west, then east, then west: about nine minutes in one run) and did not see that the distance to
 *    where it was going did not shrink: each go's own result said only "the distance left of this go". The line says, for the node she is in:
 *    the minutes since its first go here, how many gos stopped short, how many times she went back to a relay point she had gone to before
 *    (with another one in between), and the distance to the present relay point at the first go and now.
 * 2. `scaffoldLine`: the blocks a go may place (canPlace) she carries, counted before a bridge or a climb is chosen. The same run started a bridge
 *    with 40 netherrack, spent it in two gos and stood in the air with 2 blocks; the rule "back to land under 16" was in the knowledge but no line
 *    of the live state counted what she had.
 */

/** Two relay points closer than this (blocks) are the same one. */
export const SAME_POINT = 6;
/** The fewest gos in a node before its line is said (and the stops at one relay point that make it worth saying). */
export const DETOUR_MIN_GOES = 3;
const KEPT = 40;
/** The node's gos older than this (ms) are not told: a node left open for hours is not one detour. */
const WINDOW_MS = 20 * 60_000;

interface Go { dest: ActPos; at: number; left: number | null; stopped: boolean }
interface NodeGoes { node: string; goes: Go[] }
const tasks = new Map<string, NodeGoes>();

export function forgetDetours(): void { tasks.clear(); }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const posOf = (value: unknown): ActPos | null => {
  const at = value as Partial<ActPos> | null | undefined;
  return at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: at.x, y: at.y, z: at.z } : null;
};
const gap = (left: ActPos, right: ActPos): number => Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
const cell = (at: ActPos): string => `(${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)})`;

/** Where a go hand is going: its `to`, else the last of its `path`, else the first of its `goals`. */
function destOf(hand: Partial<ActHand> | undefined): ActPos | null {
  if (!hand) return null;
  return posOf(hand.to) ?? posOf(hand.path?.[hand.path.length - 1]) ?? posOf(hand.goals?.[0]);
}

/**
 * The go hand a result line belongs to. The body numbers its lines from 1 (`i: index + 1`), so the hand is `hands[i - 1]`; a 0-based `i` is read too
 * (`hands[i]`) when the first is not a go. Same reading as the fight-repeat module's, kept here so the two do not depend on each other.
 */
function goHandOf(hands: readonly Partial<ActHand>[], i: number): Partial<ActHand> | undefined {
  return [hands[i - 1], hands[i]].find(hand => hand?.do === 'go');
}

function taskOf(taskId: string, node: string): NodeGoes {
  let state = tasks.get(taskId);
  if (!state) {
    state = { node, goes: [] };
    tasks.set(taskId, state);
    if (tasks.size > 32) tasks.delete(tasks.keys().next().value as string);
  }
  if (state.node !== node) { state.node = node; state.goes = []; }
  return state;
}

/**
 * An act of the task ended: its go hands (the act's input, and the receipt's result JSON), noted under the plan node she is on (`node`; a node
 * that is not the same as the last one starts the count again).
 */
export function noteGoes(taskId: string, node: string | null | undefined, input: unknown, resultJson: string | undefined, now: number): void {
  if (!node) return;
  const result = readActResult(resultJson);
  const hands = (input as { hands?: readonly Partial<ActHand>[] } | null | undefined)?.hands;
  if (!result || !Array.isArray(hands)) return;
  const state = taskOf(taskId, node);
  for (const line of result.lines) {
    if (line.do !== 'go' || line.end === 'not_run' || line.goal === 'not_started') continue;
    const dest = destOf(goHandOf(hands, line.i));
    if (!dest) continue;
    const stopped = !(line.goal === 'done' || line.goal === 'already');
    const fromStop = line.progress?.unit === 'meter' && finite(line.progress.fromStopM) ? line.progress.fromStopM : null;
    const left = stopped ? fromStop ?? (result.at ? gap(result.at, dest) : null) : 0;
    state.goes.push({ dest, at: now, left, stopped });
  }
  if (state.goes.length > KEPT) state.goes.splice(0, state.goes.length - KEPT);
}

/** The distinct relay points in the order first gone to, and for each how many times a go came back to it after another one. */
function visits(goes: readonly Go[]): { centers: ActPos[]; returns: number[]; last: number } {
  const centers: ActPos[] = [], returns: number[] = [];
  let before = -1;
  for (const go of goes) {
    let index = centers.findIndex(center => gap(center, go.dest) <= SAME_POINT);
    if (index < 0) { centers.push(go.dest); returns.push(0); index = centers.length - 1; }
    else if (before >= 0 && before !== index) returns[index] = (returns[index] ?? 0) + 1;
    before = index;
  }
  return { centers, returns, last: before };
}

/**
 * The line, or none: said when the node's gos went back to a relay point, or three stopped short at one place (otherwise it adds nothing).
 * Facts only: it asks for no change of road.
 */
export function detourLines(taskId: string, node: string | null | undefined, now: number): string[] {
  const state = tasks.get(taskId);
  if (!node || !state || state.node !== node) return [];
  const goes = state.goes.filter(go => now - go.at <= WINDOW_MS);
  if (goes.length < DETOUR_MIN_GOES) return [];
  const { centers, returns, last } = visits(goes);
  const stoppedCount = goes.filter(go => go.stopped).length;
  const back = returns.reduce((best, count, index) => count > (returns[best] ?? 0) ? index : best, 0);
  const returned = (returns[back] ?? 0) >= 1;
  const here = centers[last];
  const toHere = here ? goes.filter(go => gap(go.dest, here) <= SAME_POINT) : [];
  const stopsHere = toHere.filter(go => go.stopped).length;
  if (!returned && stopsHere < DETOUR_MIN_GOES) return [];
  const minutes = Math.max(1, Math.round((now - goes[0]!.at) / 60_000));
  const parts = [`この段の go: 最初の go から ${minutes} 分で ${goes.length} 回（止まった ${stoppedCount} 回）`];
  if (returned && centers[back]) {
    const between = centers.filter((_, index) => index !== back).slice(0, 2).map(cell).join('・');
    parts.push(`同じ中継点 ${cell(centers[back]!)} へ ${returns[back]} 回戻った${between ? `（間に向かった所: ${between}）` : ''}`);
  }
  const firstLeft = toHere.find(go => go.left !== null)?.left ?? null, lastLeft = [...toHere].reverse().find(go => go.left !== null)?.left ?? null;
  if (here && toHere.length >= 2 && firstLeft !== null && lastLeft !== null) {
    parts.push(`今の行き先 ${cell(here)} までの距離: 最初の go で ${Math.round(firstLeft)} m → 今 ${Math.round(lastLeft)} m（${toHere.length} 回目）`);
  }
  return [`${parts.join('。')}。戻りと同じ所での停止は行き先に近づかない。道を変えるか続けるかは、この距離の変わり方を見て決める`];
}

// ---- the blocks she can place

/** What a go or a vertical may lay down and a body that carries it can stand on (the guard's own list of what is never placed is `minecraftLlmcGoGuard.ts`). */
const SCAFFOLD = /^(?:cobblestone|cobbled_deepslate|netherrack|blackstone|basalt|nether_bricks|stone|dirt|end_stone|[a-z_]+_planks)$/u;
/** The pack's count under which a bridge or a climb is not started (the knowledge: back to land under 16, and 64 before a long road). */
export const SCAFFOLD_LOW = 16, SCAFFOLD_LONG = 64;

/**
 * 「置ける足場: netherrack×40・nether_bricks×6（合計 46 個）」: in the Nether and the End, where a bridge or a climb is a go with canPlace, the count of
 * what she may place (bridge, climb, and the roof block of a fight), before the hand is chosen. The body's dimension name is `the_nether`. None elsewhere (the pack's own line counts the stacks).
 */
export function scaffoldLine(observation: BodyObservation | null): string | null {
  const w = world(observation);
  const dimension = typeof w.dimension === 'string' ? w.dimension.replace(/^minecraft:/u, '') : null;
  if (dimension !== 'nether' && dimension !== 'the_nether' && dimension !== 'the_end' && dimension !== 'end') return null;
  const found = [...carriedItemCounts(w, observation?.facts ?? {})].filter(([name, count]) => SCAFFOLD.test(name) && count > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = found.reduce((sum, [, count]) => sum + count, 0);
  const list = found.length ? found.map(([name, count]) => `${name}×${count}`).join('・') : 'なし';
  const level = total < SCAFFOLD_LOW ? `${SCAFFOLD_LOW} 個を切っている。橋・登りを始めても途中で尽きて宙に残る`
    : total < SCAFFOLD_LONG ? `長い橋・登りには ${SCAFFOLD_LONG} 個の目安に足りない（go の置く数 maxPlace はこの合計の中で決める）`
      : `go の置く数 maxPlace はこの合計の中で決める`;
  return `置ける足場（go の canPlace・vertical・fight の屋根に使える物）: ${list}（合計 ${total} 個）。${level}`;
}
