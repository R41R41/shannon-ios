import { carriedItemCounts, type ItemCounts } from './minecraftItems.js';

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const dimension = (value: unknown): string | null => typeof value === 'string' ? value.replace(/^minecraft:/u, '') : null;
const last = (world: Rec): Rec | null => rec((Array.isArray(world.deaths) ? world.deaths : []).at(-1));

/** The death's dimension, including older frames which name it only in the last-death line. */
export function deathDimensions(world: Rec): { here: string | null; there: string | null; apart: boolean } {
  const said = typeof world.lastDeath === 'string' ? world.lastDeath : '';
  const named = /(?:^|\s)(?:minecraft:)?(overworld|the_nether|the_end)(?:\s|$)/u.exec(said)?.[1];
  const here = dimension(world.dimension);
  const there = dimension(last(world)?.dimension) ?? named ?? null;
  return { here, there, apart: here !== null && there !== null && here !== there };
}

/** Drops are recovery facts, never inventory or a completed preparation, also across dimensions. */
export function deathDrops(world: Rec): ItemCounts | null {
  const said = typeof world.lastDeath === 'string' ? world.lastDeath : '';
  const lost = last(world)?.lostItems;
  if (!said.includes('拾いに戻れる') || !Array.isArray(lost) || !lost.length) return null;
  const counts = carriedItemCounts({ inventory: lost.slice(0, 64) }, {});
  return counts.size ? counts : null;
}

// Longest names first: a Wither Skeleton death must not be counted as an ordinary skeleton death.
const KILLERS = ['wither_skeleton', 'zombified_piglin', 'piglin_brute', 'elder_guardian', 'magma_cube', 'cave_spider',
  'zombie_villager', 'ender_dragon', 'blaze', 'skeleton', 'zombie', 'creeper', 'piglin', 'hoglin', 'ghast', 'enderman',
  'spider', 'witch', 'slime', 'stray', 'bogged', 'pillager', 'guardian', 'shulker', 'warden', 'wither'];

function killerOf(world: Rec): string | null {
  const said = typeof world.lastDeath === 'string' ? world.lastDeath : '';
  const cause = /「([^」]+)」/u.exec(said)?.[1] ?? said.split('落とした物')[0] ?? '';
  const words = cause.toLowerCase().replace(/_/gu, ' ');
  return KILLERS.find(kind => new RegExp(`(?:^|[^a-z])${kind.replace(/_/gu, ' ')}(?:$|[^a-z])`, 'u').test(words)) ?? null;
}

/** Current-frame counts are local to the current dimension; no claim that the individual killer survives. */
function killerCount(world: Rec, kind: string): string | null {
  if (!Array.isArray(world.nearbyThreats)) return null;
  const ids = new Set<unknown>();
  for (const raw of world.nearbyThreats) {
    const threat = rec(raw);
    if (threat?.name === kind) ids.add(threat.id ?? raw);
  }
  const where = deathDimensions(world).apart ? '今いる次元の frame' : '今の frame';
  return `死因と同種の ${kind} は${where} に ${ids.size} 体（死亡地点に残る数は未確認）`;
}

/** The body's hitsLeft is already measured for the current equipment; absent or unrelated values say nothing. */
export function deathRiskWords(world: Rec): string[] {
  const kind = killerOf(world);
  if (!kind) return [];
  const hits = rec(rec(world.margin)?.hitsLeft);
  const count = killerCount(world, kind);
  const measured = hits?.from === kind && typeof hits.hits === 'number' && Number.isFinite(hits.hits) && hits.hits >= 0
    ? `今の装備・体力では ${kind} のあと ${hits.hits} 打で倒れる（体の見積もり）` : null;
  return [count, measured].filter((line): line is string => line !== null);
}
