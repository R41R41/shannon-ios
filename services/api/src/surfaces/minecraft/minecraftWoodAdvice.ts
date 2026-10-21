import { structureEntries, treeEntries, mapText, type MapCell } from './minecraftMapRead.js';

/**
 * Where wood is, when the body's map shows none (mb-r24, Minecraft run 24, first world: a desert with no log in 128 m; the planner read
 * "river 東 64m" in the biomes passed as "trees by the river", the decisions went for a village for 419 s, and not one log was cut. The
 * map lists structures and ores but no tree, and nothing said that a shipwreck 149 m south is oak and spruce). From the map's words and
 * the biomes passed: the trees the body lists, the structures that are made of wood, the way the trees grow, and what to do when none is in
 * sight. Pure; the same words go into the route planner's input, the decision's route lines and the procedure's search.
 */
export const WOOD_STRUCTURES: readonly string[] = Object.freeze(['難破船', '廃坑', '廃鉱', '森の洋館', '洋館', '前哨基地', '村']);
/** A structure this far (blocks) is worth a walk for its wood; farther, the planner decides. */
export const WOOD_WALK = 250;
/** Biomes where trees grow thick enough to be a way to go; and those where a river or an ocean by them says nothing of trees. */
const TREE_BIOME = /forest|taiga|jungle|swamp|savanna|grove|wooded_badlands|cherry|mangrove|birch|dark_forest/u;
const BARE_BIOME = /desert|ocean|river|beach|badlands|ice|frozen|peaks|stony|mushroom|dripstone|snowy_plains|snowy_slopes|lush|deep_dark/u;

export interface BiomeSeen { name: string; direction: string | null; distance: number | null }
export const CARDINALS = ['north', 'south', 'east', 'west'] as const;
export type Cardinal = (typeof CARDINALS)[number];

/** The biomes passed, from the body's line (`desert（ここ）・warm_ocean 南西 60m・river 東 64m`) or a list of such words. */
export function biomesOf(value: unknown): BiomeSeen[] {
  const text = Array.isArray(value) ? value.filter(item => typeof item === 'string').join('・') : typeof value === 'string' ? value : '';
  return text.split(/[・、,\n]/u).flatMap(part => {
    const match = /([a-z][a-z_]*)(?:[^a-z0-9]*?\s+(\S+?)\s*(\d+)m)?/u.exec(part.trim());
    return match ? [{ name: match[1]!, direction: match[2] ?? null, distance: match[3] ? Number(match[3]) : null }] : [];
  }).slice(0, 16);
}

const toCardinal = (direction: string | null): Cardinal | null => {
  const first = direction?.[0];
  return first === '北' ? 'north' : first === '南' ? 'south' : first === '東' ? 'east' : first === '西' ? 'west' : null;
};

export interface WoodAdvice {
  /** The body lists trees (a `木:` line). */
  trees: boolean;
  /** The wooden structures within `WOOD_WALK`, nearest first. */
  sources: Array<{ name: string; distance: number; at: MapCell; direction: string; extra: string }>;
  /** The way the trees grow: the nearest biome passed that grows them (null: none passed), and the way to it. */
  grows: { name: string; heading: Cardinal | null; distance: number | null } | null;
  /** Biomes passed that say nothing of trees (a river, an ocean, the desert). */
  bare: string[];
  lines: string[];
}

const where = (entry: { distance: number; direction: string; at: MapCell }) => {
  const { x, y, z } = entry.at;
  return `${entry.distance}m ${entry.direction} (${x},${y},${z})`;
};

/** What the map and the biomes say of wood, in fixed words (`lines`); `grows` and `sources` are for the procedure. */
export function woodAdvice(world: Record<string, unknown> | null | undefined): WoodAdvice {
  const map = mapText(world?.mapSummary);
  const trees = treeEntries(map);
  const sources = structureEntries(map, WOOD_STRUCTURES).filter(item => item.distance <= WOOD_WALK);
  const seen = biomesOf(world?.biomesSeen);
  const growing = seen.filter(item => TREE_BIOME.test(item.name)).sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))[0];
  const bare = seen.filter(item => !TREE_BIOME.test(item.name) && BARE_BIOME.test(item.name)).map(item => item.name);
  const grows = growing ? { name: growing.name, heading: toCardinal(growing.direction), distance: growing.distance } : null;
  const lines = [
    trees.length ? `見えている木: ${trees.slice(0, 2).map(tree => `${where(tree)} ×${tree.count}`).join('、')}`
      : '見えている木: 無し（読み込み済みの範囲に原木が見つかっていない。川・海・砂漠が見えるだけでは、木があるとは言えない）',
    ...(sources.length ? [`木材の出どころ（原木・板材が取れる構造物）: ${sources.slice(0, 3).map(item => `${item.name} ${where(item)}`).join('、')}`] : []),
    ...(growing ? [`木の生える所: ${growing.name}${growing.direction ? ` ${growing.direction}` : ''}${growing.distance !== null ? ` ${growing.distance}m` : ''}`]
      : bare.length && !trees.length ? [`通った所（${bare.slice(0, 4).join('・')}）に木はほぼ無い。木の生えるバイオームはまだ見ていない`] : []),
    ...(trees.length ? [] : [WOOD_RULE]),
  ];
  return { trees: trees.length > 0, sources, grows, bare, lines };
}

/** The rule shown when no log is in sight: where to look, in order. */
export const WOOD_RULE = '原木が近くに無い時: (1) 難破船・廃坑・村など木材の出どころが近ければそこへ（原木・板材が取れる）、'
  + '(2) 無ければ木の生えるバイオームの方角へ mc.explore-for-structure（structureType=tree、direction）で、区間ごとに原木を探しながら進む、'
  + '(3) 海の上と砂漠の奥へは伸ばさない（泳ぎは遅くスタックする）。村は木の当てにしない';
