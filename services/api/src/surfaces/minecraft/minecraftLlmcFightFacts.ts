import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carriedItemCounts, wornItems } from './minecraftItems.js';
import { carriedFood } from './minecraftLlmcLive.js';
import { SHOOTER_KINDS } from './minecraftLlmcReachWords.js';
import type { PlanFacts } from './minecraftPlanFacts.js';

/**
 * 11/24 (the night of 11/23: the first act was a go and a fight, 39 m, into a pack of three zombies and a skeleton, with no gear; the input said
 * 「ほか 15 体（creeper 3・spider 2・zombie 6・skeleton 4）」 and a worn line of 「なし」 five times, with no place for the pack and no word of what the gear
 * could do): the two facts a decision to go to a fight needs, said as facts and not as advice, in the facts of both the normal and the urgent live state.
 * - the pack: the hostiles within `PACK_METERS` of the one she would go to (the nearest shooter within `SHOOTER_METERS`, else the nearest hostile), their
 *   kinds and number, the distance to it, and at dusk and at night the limit of the one-thing request's night line (`NIGHT_LIMIT_METERS`);
 * - the gear: weapon, armour pieces, shield and food points, and whether that reaches the skeleton rule's yardstick (a sword, a shield or three iron
 *   pieces, health 10 or more: `minecraftLlmcV2Knowledge.ts`), or that a body with no weapon does not cut (its reflex skips the fight).
 */
export const PACK_METERS = 10;
export const SHOOTER_METERS = 48;
export const NIGHT_LIMIT_METERS = 25;
const FIGHT_HEALTH = 10;
const rec = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const MATERIAL: Record<string, string> = { wooden: '木', stone: '石', golden: '金', iron: '鉄', diamond: 'ダイヤ', netherite: 'ネザライト' };
const ORDER = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
const BLADE = /^(?:wooden|stone|golden|iron|diamond|netherite)_(?:sword|axe)$/u;

/** Flow design: a part of the request's facts the plan says (`planFacts.request`) for the context of the facts. */
export const requestFlag = (planFacts: PlanFacts | undefined): { request?: true } => planFacts?.request === true ? { request: true } : {};

interface Seen { id: string; name: string; distance: number; at: { x: number; y: number; z: number } | null }
const pointOf = (value: unknown): Seen['at'] => {
  const at = rec(value), x = finite(at?.x), y = finite(at?.y), z = finite(at?.z);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
};
function hostilesOf(world: Record<string, unknown>): Seen[] {
  return (Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []).flatMap(raw => {
    const item = rec(raw), distance = finite(item?.distance);
    if (!item || distance === null || typeof item.name !== 'string') return [];
    return [{ id: String(item.id ?? ''), name: item.name, distance, at: pointOf(item.position) }];
  });
}
const apart = (a: NonNullable<Seen['at']>, b: NonNullable<Seen['at']>): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** The hostile she would go to: the nearest shooter within `SHOOTER_METERS`, else the nearest. */
function targetOf(all: readonly Seen[]): Seen | undefined {
  const byDistance = [...all].sort((a, b) => a.distance - b.distance);
  return byDistance.find(e => SHOOTER_KINDS.has(e.name) && e.distance <= SHOOTER_METERS) ?? byDistance[0];
}

/** The pack line: the hostile she would go to, the others within `PACK_METERS` of it, and the way there. Null when it stands alone. */
export function packLine(world: Record<string, unknown>, night: boolean, request: boolean): string | null {
  const all = hostilesOf(world), target = targetOf(all), at = target?.at;
  if (!target || !at) return null;
  const around = all.filter(e => e !== target && e.at && apart(e.at, at) <= PACK_METERS);
  if (!around.length) return null;
  const kinds = new Map<string, number>();
  for (const e of [target, ...around]) kinds.set(e.name, (kinds.get(e.name) ?? 0) + 1);
  const limit = night && request ? `（夜の上限 ${NIGHT_LIMIT_METERS}m）` : '';
  const counts = [...kinds].map(([name, n]) => `${name} ${n}`).join('・');
  return `#${target.id} ${target.name} の周り ${PACK_METERS}m: ${counts}（本人を含め ${around.length + 1} 体）・そこまで ${Math.round(target.distance)}m${limit}`;
}

const WORD_NO_WEAPON = '→ 武器が無いので体は斬らない（体の反射は武器なしの戦いを飛ばす）';
const WORD_SHORT = '→ 射手へ詰める目安（剣と、盾か鉄の防具 3 部位・体力 10 以上）に届かない';
/** The best sword or axe carried, as 「剣 石」, or null. */
function weaponOf(counts: ReadonlyMap<string, number>): string | null {
  const blades = [...counts].filter(([name, n]) => n > 0 && BLADE.test(name)).map(([name]) => name);
  const best = blades.sort((a, b) => ORDER.indexOf(a.split('_')[0]!) - ORDER.indexOf(b.split('_')[0]!))[0];
  return best ? `${best.endsWith('sword') ? '剣' : '斧'} ${MATERIAL[best.split('_')[0]!] ?? ''}` : null;
}
/** The gear line: weapon, armour, shield, food points, and what that comes to. Null when no hostile is listed. */
export function gearLine(observation: BodyObservation | null, world: Record<string, unknown>): string | null {
  if (!hostilesOf(world).length) return null;
  const counts = carriedItemCounts(world, observation?.facts), worn = wornItems(world.worn), weapon = weaponOf(counts);
  const pieces = worn.filter(name => /_(?:helmet|chestplate|leggings|boots)$/u.test(name));
  const iron = pieces.filter(name => /^(?:iron|diamond|netherite)_/u.test(name)).length;
  const held = worn.includes('shield'), shield = held ? '構えている' : (counts.get('shield') ?? 0) > 0 ? '持っているが構えていない' : 'なし';
  const health = finite(world.health), fit = !!weapon && (held || iron >= 3) && (health === null || health >= FIGHT_HEALTH);
  const verdict = !weapon ? WORD_NO_WEAPON : fit ? '→ 射手 1 体へ詰める目安に届く' : WORD_SHORT;
  const food = Math.round(carriedFood(world, observation?.facts ?? {}).points);
  return `戦う装備: ${weapon ?? '武器 なし'}・防具 ${pieces.join('・') || 'なし'}（${pieces.length}/4）・盾 ${shield}・食べ物 ${food} 点 ${verdict}`;
}

/** Dusk or night in the overworld (the day's tick from 12000: the one-thing request's night line applies). */
const nightly = (world: Record<string, unknown>): boolean =>
  (finite(world.timeOfDay) ?? -1) >= 12_000 && (world.dimension === undefined || world.dimension === 'overworld');
export function fightLines(observation: BodyObservation | null, request: boolean): string[] {
  const world = rec(observation?.state.world);
  if (!world) return [];
  return [packLine(world, nightly(world), request), gearLine(observation, world)].filter((line): line is string => !!line);
}
