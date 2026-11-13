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
 * (c) the eyes in hand are no more than the frames still need (12 less those set; 13 before the frames are seen, one over for the one in five that breaks:
 *     run 9, 11/13, the same 13 as the pearls' target) while pearls and powder (or rods) are left to make more: each throw breaks one in five. With
 *     nothing left to make more, the throw goes once after a point is out (the point is needed all the same, a second one only spends the frames' eyes).
 * (d) never for good: what is held is a throw from where one was thrown already. With the frames not seen, one more goes from the point itself (her feet
 *     within `AT_POINT_BLOCKS` of it and no throw from there: the way a good player checks the bearing when the frames are not where the point says) and,
 *     while the point is wider than the probe's reach, from outside its circle (within twice its radius) at least `NEW_PLACE_BLOCKS` from every throw
 *     (a line from a new side closes the crossing). A hold kept only by the ledger's 4 hours would leave a point the probe missed with no throw left
 *     (the review of 11/14: a point drawn by lines that disagree stays over 128 m whatever is thrown from it). One throw in five breaks; the rest are
 *     picked up.
 * A fact with the hand held; it moves no node. The ledger of a task is registered by its step (`registerEyeLedger`).
 */
export const FRAME_SEARCH_RADIUS = 128;
const SAME_LINE_BLOCKS = 12;
const FRAMES = 13;
/** Her feet this near the point: she is at it. */
export const AT_POINT_BLOCKS = 24;
/** Outside the circle of a wide point, a place this far from every throw is a new one (S5's 27 throws were 10 to 15 m apart). */
export const NEW_PLACE_BLOCKS = 64;
const ledgers = new Map<string, EyeLedger>();

/** The step's ledger, for the hold to read (the newest step of a task replaces the older one). */
export function registerEyeLedger(taskId: string, ledger: EyeLedger): void {
  if (!ledgers.has(taskId) && ledgers.size > 64) ledgers.delete(ledgers.keys().next().value as string);
  ledgers.set(taskId, ledger);
}

const objectOf = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' ? value as Record<string, unknown> : null;
const throwsEye = (hand: Record<string, unknown>): boolean => hand.do === 'use' && typeof hand.item === 'string'
  && hand.item.replace(/^minecraft:/u, '') === 'ender_eye' && !(Array.isArray(hand.at) && hand.at.length > 0);

type Place = { x: number; z: number };
const apart = (a: Place, b: Place): number => Math.hypot(a.x - b.x, a.z - b.z);

/** (d): one more throw that repeats none (the frames not seen): at the point with none thrown there, or outside a wide point's circle from a new place. */
function againFrom(throws: readonly Place[], fix: Fix, feet: Place | null): boolean {
  if (!feet) return false;
  const away = apart(feet, fix);
  if (away <= AT_POINT_BLOCKS) return throws.every(item => apart(item, feet) > AT_POINT_BLOCKS);
  return fix.errorBlocks > FRAME_SEARCH_RADIUS && away > fix.errorBlocks && away <= 2 * fix.errorBlocks && throws.every(item => apart(item, feet) >= NEW_PLACE_BLOCKS);
}

/** (a): the words that hold a throw at a point within the probe's reach, or null (the one throw from near the point goes). */
function pointReason(ledger: EyeLedger, fix: Fix, feet: Place | null, now: number, again: boolean): string | null {
  const near = (p: Place): boolean => apart(p, fix) <= FRAME_SEARCH_RADIUS;
  const throws = ledger.throws(now), thrownNear = throws.some(near);
  if (feet && near(feet) && (!thrownNear || again)) return null;
  const there = feet ? `あと ${compassWord(bearingBetween(feet, fix))} ${Math.round(Math.hypot(fix.x - feet.x, fix.z - feet.z))}m` : '';
  return `要塞の交点 (${fix.x},${fix.z})（誤差 ${Math.round(fix.errorBlocks)}m）がある${there ? `・${there}` : ''}。もう投げない: 交点まで歩き、`
    + `mc_probe kind=frames radius=${FRAME_SEARCH_RADIUS} で枠を探す（アイは枠 12 にそのまま要る。投げると 5 回に 1 回は割れる。落ちたアイ（割れなかった物）は拾う）`
    + (thrownNear ? '' : `。交点の ${FRAME_SEARCH_RADIUS}m 内まで来ても枠が見えない時だけ、そこで 1 回投げ直せる（沈めば要塞は真下）`)
    + (throws.some(item => apart(item, fix) <= AT_POINT_BLOCKS) ? '' : `。交点（${AT_POINT_BLOCKS}m 内）に着いても枠が見えない時は、そこで 1 回投げて向きを確かめられる`);
}

/** Why a throw is held now, in words, or null. */
function reasonOf(ledger: EyeLedger | undefined, world: Record<string, unknown>, pack: ReadonlyMap<string, number>, now: number): string | null {
  const count = (name: string) => pack.get(name) ?? 0, eyes = count('ender_eye');
  const canMake = count('ender_pearl') > 0 && count('blaze_powder') + count('blaze_rod') > 0;
  const feet = feetOf(world);
  const fix = ledger?.fix(now) ?? null;
  const frames = framesOf(world), need = frames ? Math.max(0, frames.frames - frames.eyes) : FRAMES;
  const throws = ledger?.throws(now) ?? [];
  const again = !frames && fix !== null && againFrom(throws, fix, feet);
  const point = ledger && fix && fix.errorBlocks <= FRAME_SEARCH_RADIUS ? pointReason(ledger, fix, feet, now, again) : null;
  if (point) return point;
  if (eyes <= need && canMake) return `手持ちのアイ ${eyes} は枠に要る数（${need}）以下。投げると枠の分が減る: 粉と真珠で作り足すまで投げない`;
  // With nothing to make more from, one throw after a point is out is all there is to spend (a throw near the point draws it again; a second only costs a frame's eye).
  // Not for good (d): from the point itself, or from a new place outside a wide point's circle, one more goes.
  const circle = fix ? Math.max(FRAME_SEARCH_RADIUS, fix.errorBlocks) : 0;
  if (!canMake && fix && eyes > 0 && !again && throws.some(item => apart(item, fix) <= circle)) {
    const wide = fix.errorBlocks > FRAME_SEARCH_RADIUS ? `、誤差 ${Math.round(fix.errorBlocks)}m の円の外（交点から ${Math.round(2 * fix.errorBlocks)}m 内）で前に投げた所から ${NEW_PLACE_BLOCKS}m 以上離れた所` : '';
    return `要塞の交点 (${fix.x},${fix.z}) は出ている。作る材料（パールと粉）が無いので、同じ辺りから投げ直さない（5 回に 1 回は割れる）: 交点まで歩いて枠を探す。落ちたアイ（割れなかった物）は拾う。`
      + `枠が見えない時は、交点（${AT_POINT_BLOCKS}m 内）${wide}から 1 回投げられる`;
  }
  const last = fix ? null : throws.at(-1);
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
