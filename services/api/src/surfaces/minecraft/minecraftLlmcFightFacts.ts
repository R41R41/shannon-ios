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
/**
 * 11/24 try1124b (the owner's test, 07:12–07:15: a zombie came while she stood in a pool; 22 urgent decisions of gpt-6-luna each chose a go of 1 to 4 blocks
 * inside the water (7 hits, health 20 to 6.7), the land was 4 blocks east on the map she was given, and a swimmer moves at 1 to 2 m/s while a zombie on
 * the bank runs at about 3): where she stands (water) and the nearest land read from the surface map, as a fact. It decides no hand.
 * Said only while a hostile is within `WATER_ENEMY_METERS`.
 */
export const WATER_ENEMY_METERS = 12;
/** A land cell counts as one she reaches first when the enemy is at least this much farther from it than she is. */
export const LAND_GAP_METERS = 2;
const DIRECTIONS = ['東', '南東', '南', '南西', '西', '北西', '北', '北東'];
function directionWords(dx: number, dz: number): string {
  const parts = [...dx ? [`${dx > 0 ? '東' : '西'}${Math.abs(dx)}`] : [], ...dz ? [`${dz > 0 ? '南' : '北'}${Math.abs(dz)}`] : []];
  return parts.join('・') || 'ここ';
}
/** 'at' of a hostile as a bearing word from the feet (東 = +x, 南 = +z; the map's north is up). */
const bearing = (dx: number, dz: number): string => DIRECTIONS[(Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) + 8) % 8]!;
/** The surface map as a grid: the feet cell, and the symbol and height of each cell. Null for another mode or a map that does not read. */
function surfaceGrid(map: string): { feet: { x: number; y: number; z: number }; cells: Map<string, { sym: string; h: number }> } | null {
  const lines = map.split('\n');
  const head = /足=\((-?\d+),(-?\d+),(-?\d+)\) x=(-?\d+)\.\.(-?\d+) z=-?\d+\.\.-?\d+ 方式=surface/u.exec(lines[0] ?? '');
  if (!head) return null;
  const feet = { x: Number(head[1]), y: Number(head[2]), z: Number(head[3]) }, x0 = Number(head[4]), width = Number(head[5]) - x0 + 1;
  const cells = new Map<string, { sym: string; h: number }>();
  for (const line of lines.slice(2)) {
    const tokens = line.trim().split(/\s+/u);
    if (!/^-?\d+$/u.test(tokens[0] ?? '') || tokens.length !== width + 1) { if (cells.size) break; continue; }
    const z = Number(tokens[0]);
    tokens.slice(1).forEach((token, index) => {
      const height = /^(.)([0-9+a-iv])$/u.exec(token);
      if (height) cells.set(`${x0 + index},${z}`, { sym: height[1]!, h: /\d/u.test(height[2]!) ? Number(height[2]) : height[2] === '+' ? 10 : -1 });
    });
  }
  return cells.size ? { feet, cells } : null;
}
const WATER_SYMBOLS = new Set(['w', '-']);
const LAND_SYMBOLS = new Set([':', 's', '#', 'I', ',']);
/** Whether her feet are in water and where the nearest land (a ground cell level with her or one above) is, as a line; null when she is not in water, no hostile is near, or the map does not read. */
export function waterLine(world: Record<string, unknown>): string | null {
  const near = hostilesOf(world).filter(e => e.distance <= WATER_ENEMY_METERS).sort((a, b) => a.distance - b.distance);
  const map = typeof world.localMap === 'string' ? world.localMap : '';
  const grid = near.length && map ? surfaceGrid(map) : null;
  if (!grid) return null;
  const { feet, cells } = grid;
  let wet = 0, dry = 0;
  for (let dx = -1; dx <= 1; dx += 1) for (let dz = -1; dz <= 1; dz += 1) {
    if (!dx && !dz) continue;
    const sym = cells.get(`${feet.x + dx},${feet.z + dz}`)?.sym;
    if (sym && WATER_SYMBOLS.has(sym)) wet += 1; else if (sym && LAND_SYMBOLS.has(sym)) dry += 1;
  }
  if (wet < 4 || wet <= dry) return null;
  const enemy = near[0]!, at = enemy.at;
  interface Land { dx: number; dz: number; h: number; d: number; gap: number | null }
  const lands: Land[] = [];
  for (const [key, cell] of cells) {
    if (!LAND_SYMBOLS.has(cell.sym) || cell.h < 0 || cell.h > 2) continue;
    const [x, z] = key.split(',').map(Number) as [number, number];
    const dx = x - feet.x, dz = z - feet.z, d = Math.hypot(dx, dz);
    // gap: how much farther the enemy is from that cell than she is (positive: she gets there first).
    lands.push({ dx, dz, h: cell.h, d, gap: at ? Math.hypot(x + 0.5 - at.x, z + 0.5 - at.z) - d : null });
  }
  const nearest = lands.reduce<Land | null>((best, land) => !best || land.d < best.d ? land : best, null);
  const away = lands.filter(land => land.gap !== null && land.gap >= LAND_GAP_METERS).reduce<Land | null>((best, land) => !best || land.d < best.d ? land : best, null);
  const spot = (land: Land) => `${directionWords(land.dx, land.dz)}（約 ${Math.round(land.d)}m・立つ所 (${feet.x + land.dx},${feet.y + land.h},${feet.z + land.dz})）`;
  const side = at ? `敵 #${enemy.id} ${enemy.name} は ${bearing(at.x - feet.x - 0.5, at.z - feet.z - 0.5)} ${Math.round(enemy.distance)}m` : `敵 ${enemy.name} ${Math.round(enemy.distance)}m`;
  const land = !nearest ? '地図の中に陸が見えない'
    : away && away !== nearest && nearest.gap !== null && nearest.gap < LAND_GAP_METERS ? `最寄りの陸は ${spot(nearest)}だが敵に近い。敵より先に着ける陸は ${spot(away)}`
    : `最寄りの陸は ${spot(nearest)}`;
  return `今は水の中（周り 8 マスのうち水 ${wet}）・${land}・${side}。水の中の歩みは 1〜2 m/s で、陸の敵の走り（約 3 m/s）より遅い。水の中を数マス泳いでも距離は開かない: 陸へ上がり（go は waterOk を付ける。walk は付けずに泳ぐ）、陸で 10 マス以上離れる手を同じ act に入れる。敵が陸の側にいる時は、敵から遠い陸を選ぶ`;
}
export function fightLines(observation: BodyObservation | null, request: boolean): string[] {
  const world = rec(observation?.state.world);
  if (!world) return [];
  return [packLine(world, nightly(world), request), gearLine(observation, world), waterLine(world)].filter((line): line is string => !!line);
}
