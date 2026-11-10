import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { EyeLedger } from './minecraftEyeLedger.js';
import { bearingBetween, compassWord, type Fix } from './minecraftEyeTriangulation.js';
import { feetOf, readinessOf } from './minecraftLlmcReadiness.js';
import { framesOf } from './minecraftSeenMarks.js';

/**
 * The eyes kept for the frames (S5's rig of 11/5, 8a3c4fd2: after the sideways throw gave the point, she followed each fallen eye 10 to 15 m and
 * threw again, 27 throws, until none was left for the frames). A throw into the sky (`use item=ender_eye` with no `at`) is held when:
 * (a) the ledger has a point within `FRAME_SEARCH_RADIUS` (the frames' probe reaches it from there): walk to it and look for the frames.
 *     One throw goes from within that radius of the point while the ledger has none thrown there: the way out when the frames are not at the
 *     point (the eye sinks over the stronghold, or draws a new line from near it);
 * (b) there is no point yet and she stands within `SAME_LINE_BLOCKS` sideways of the last line: the throw draws the same line;
 * (c) the eyes in hand are no more than the frames still need (12 less those set, 12 before the frames are seen) while pearls and powder (or rods)
 *     are left to make more: each throw breaks one in five. With nothing left to make more, the throw goes (the point is needed all the same).
 * A fact with the hand held; it moves no node. The ledger of a task is registered by its step (`registerEyeLedger`).
 */
export const FRAME_SEARCH_RADIUS = 128;
const SAME_LINE_BLOCKS = 12;
const FRAMES = 12;
const ledgers = new Map<string, EyeLedger>();

/** The step's ledger, for the hold to read (the newest step of a task replaces the older one). */
export function registerEyeLedger(taskId: string, ledger: EyeLedger): void {
  if (!ledgers.has(taskId) && ledgers.size > 64) ledgers.delete(ledgers.keys().next().value as string);
  ledgers.set(taskId, ledger);
}

const objectOf = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' ? value as Record<string, unknown> : null;
const throwsEye = (hand: Record<string, unknown>): boolean => hand.do === 'use' && typeof hand.item === 'string'
  && hand.item.replace(/^minecraft:/u, '') === 'ender_eye' && !(Array.isArray(hand.at) && hand.at.length > 0);

/** (a): the words that hold a throw at a point within the probe's reach, or null (the one throw from near the point goes). */
function pointReason(ledger: EyeLedger, fix: Fix, feet: { x: number; z: number } | null, now: number): string | null {
  const near = (p: { x: number; z: number }): boolean => Math.hypot(p.x - fix.x, p.z - fix.z) <= FRAME_SEARCH_RADIUS;
  const thrownNear = ledger.throws(now).some(near);
  if (feet && near(feet) && !thrownNear) return null;
  const there = feet ? `あと ${compassWord(bearingBetween(feet, fix))} ${Math.round(Math.hypot(fix.x - feet.x, fix.z - feet.z))}m` : '';
  return `要塞の交点 (${fix.x},${fix.z})（誤差 ${Math.round(fix.errorBlocks)}m）がある${there ? `・${there}` : ''}。もう投げない: 交点まで歩き、`
    + `mc_probe kind=frames radius=${FRAME_SEARCH_RADIUS} で枠を探す（アイは枠 12 にそのまま要る。投げると 5 回に 1 回は割れる）`
    + (thrownNear ? '' : `。交点の ${FRAME_SEARCH_RADIUS}m 内まで来ても枠が見えない時だけ、そこで 1 回投げ直せる（沈めば要塞は真下）`);
}

/** Why a throw is held now, in words, or null. */
function reasonOf(ledger: EyeLedger | undefined, world: Record<string, unknown>, pack: ReadonlyMap<string, number>, now: number): string | null {
  const count = (name: string) => pack.get(name) ?? 0, eyes = count('ender_eye');
  const canMake = count('ender_pearl') > 0 && count('blaze_powder') + count('blaze_rod') > 0;
  const feet = feetOf(world);
  const fix = ledger?.fix(now) ?? null;
  const point = ledger && fix && fix.errorBlocks <= FRAME_SEARCH_RADIUS ? pointReason(ledger, fix, feet, now) : null;
  if (point) return point;
  const frames = framesOf(world), need = frames ? Math.max(0, frames.frames - frames.eyes) : FRAMES;
  if (eyes <= need && canMake) return `手持ちのアイ ${eyes} は枠に要る数（${need}）以下。投げると枠の分が減る: 粉と真珠で作り足すまで投げない`;
  const last = fix ? null : ledger?.throws(now).at(-1);
  if (!last || last.down || !feet) return null;
  const r = last.bearingDeg * Math.PI / 180;
  const side = Math.abs((feet.x - last.x) * -Math.cos(r) - (feet.z - last.z) * Math.sin(r));
  return side < SAME_LINE_BLOCKS ? `前の投げの線から横へ ${Math.round(side)}m: ここで投げても同じ線になり、交点は出ない。live の目玉の帳簿の「次は」の所（線の横 24m）へ動いて投げる`
    : null;
}

/** The hold (the hand, 1-based, its kind and its line) of a throw of an eye into the sky, or null. */
export function eyeThrowHold(input: unknown, frame: BodyObservation | null, taskId: string, now: () => number = Date.now):
  { hand: number; kind: string; line: string } | null {
  const hands = (input as { hands?: unknown } | null)?.hands;
  const facts = readinessOf(frame);
  if (!Array.isArray(hands) || !facts || facts.dimension !== 'overworld') return null;
  const at = hands.findIndex(raw => throwsEye(objectOf(raw) ?? {}));
  if (at < 0) return null;
  const line = reasonOf(ledgers.get(taskId), facts.world, facts.counts, now());
  return line ? { hand: at + 1, kind: 'use', line } : null;
}
