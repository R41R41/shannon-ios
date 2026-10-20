import type { LiveMoment, LiveScalar } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carriedItemCounts, countMatching, type ItemCounts } from './minecraftItems.js';
import { fullArmor } from './minecraftStage.js';

/**
 * The moments worth a word, read from her body's frames (session dc-live; `SHANNON_MINECRAFT_LIVE`). A frame already carries all of it
 * (health, what she carries, the dimension, the clock, the map the body keeps, what stands near, what her reflexes did), so the moments
 * are found here by comparing one frame with the one before; the body sends nothing new. The first frame of a run is only remembered
 * (what she already carried is not news). Closed values only: an item id, a count, a place's name in the game's words, never a player's.
 */
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value : []).flatMap(item => {
  const row = record(item);
  return row ? [row] : [];
});
const NAME = /^[a-z][a-z0-9_]{0,40}$/u;

export type LiveDimension = 'overworld' | 'the_nether' | 'the_end';
export function dimensionOfWorld(world: Record<string, unknown>, facts: Readonly<Record<string, unknown>>): LiveDimension | null {
  const raw = String(world.dimension ?? facts.dimension ?? '').toLowerCase();
  if (raw.includes('nether')) return 'the_nether';
  if (raw.includes('end')) return 'the_end';
  return raw.includes('overworld') ? 'overworld' : null;
}

/** The game clock's tick within the day (0..23999), or null. */
export function dayTick(world: Record<string, unknown>): number | null {
  const tick = finite(Number(world.time));
  return tick === null ? null : ((Math.floor(tick) % 24_000) + 24_000) % 24_000;
}
export const isNightTick = (tick: number): boolean => tick >= 13_000 && tick < 23_000;

/** The structures of the body's map (`mapSummary`, the line 「構造物: 村: …／ネザー要塞: …」): name to the nearest one's distance. */
export function mapStructures(map: unknown): Map<string, number | null> {
  const found = new Map<string, number | null>();
  if (typeof map !== 'string') return found;
  const line = map.split('\n').find(item => item.startsWith('構造物:'));
  if (!line) return found;
  for (const part of line.slice('構造物:'.length).split('／')) {
    const colon = part.indexOf(':');
    const name = (colon < 0 ? part : part.slice(0, colon)).trim();
    const distance = /(\d+)m/u.exec(part.slice(colon + 1))?.[1];
    if (name && name.length <= 20) found.set(name, distance ? Number(distance) : null);
  }
  return found;
}

/** The distance in metres of the nearest lava pool the map knows (「溶岩の溜まり 5か所: 20m 西 …」), or null. */
export function mapLavaDistance(map: unknown): number | null {
  const match = typeof map === 'string' ? /溶岩の溜まり\s*\d+か所:\s*(\d+)m/u.exec(map) : null;
  return match ? Number(match[1]) : null;
}

/** How many places of diamond ore the map knows (「鉱石: ダイヤ 2か所（…）」), or 0. */
export function mapDiamondCount(map: unknown): number {
  return typeof map === 'string' ? Number(/ダイヤ\s*(\d+)か所/u.exec(map)?.[1] ?? 0) : 0;
}

const LAVA_NEAR = 6, LAVA_FAR = 14;
const SHOWN_STRUCTURES = new Set(['村', '荒廃したポータル', 'イグルー', '難破船', 'ネザー要塞', '砦の遺跡', '要塞', 'エンドポータル']);
const FIRST_ITEMS: ReadonlyArray<readonly [string, RegExp, number]> = [
  ['blaze_rod', /^blaze_rod$/u, 1], ['ender_pearl', /^ender_pearl$/u, 1], ['ender_eye', /^ender_eye$/u, 1], ['flint_and_steel', /^flint_and_steel$/u, 1],
  ['obsidian', /^obsidian$/u, 10], ['bed', /^[a-z]+(?:_[a-z]+)*_bed$/u, 1],
];

/** The nearest hostile within `within` metres that can reach her, as its name, or null. */
function nearestThreat(world: Record<string, unknown>, within: number): { name: string; distance: number } | null {
  const near = list(world.nearbyThreats).flatMap(threat => {
    const distance = finite(threat.distance);
    return distance !== null && distance <= within && threat.canReachMe !== false && typeof threat.name === 'string' && NAME.test(threat.name)
      ? [{ name: threat.name, distance }] : [];
  });
  return near.sort((a, b) => a.distance - b.distance)[0] ?? null;
}

/** She is in danger now: low health, or a hostile at her (the body's own `danger` measure). */
export function bodyInDanger(observation: BodyObservation): boolean {
  const world = record(observation.state.world) ?? {};
  const health = finite(world.health);
  return observation.facts.alive === true && ((health !== null && health > 0 && health <= 8) || nearestThreat(world, 5) !== null);
}

interface Reading {
  alive: boolean; health: number | null; food: number | null; dimension: LiveDimension | null; tick: number | null; at: number;
  counts: ItemCounts; structures: Map<string, number | null>; diamondOre: number; lavaEscapes: number; blaze: boolean; dragon: boolean;
  crystals: number | null; armor: boolean; lavaDistance: number | null;
}

function read(observation: BodyObservation, at: number): Reading {
  const world = record(observation.state.world) ?? {}, counts = carriedItemCounts(world, observation.facts);
  const entities = [...list(world.nearbyThreats), ...list(world.nearbyEntities)];
  const named = (name: string, within = 48) => entities.filter(entity => entity.name === name && (finite(entity.distance) ?? 999) <= within);
  const crystals = new Set(named('end_crystal', 128).map(entity => JSON.stringify(entity.position ?? entity.distance))).size;
  const lava = finite(record(record(world.reflexes)?.counts)?.lava) ?? 0;
  return { alive: observation.facts.alive === true, health: finite(world.health), food: finite(world.food),
    dimension: dimensionOfWorld(world, observation.facts), tick: dayTick(world), at, counts, structures: mapStructures(world.mapSummary),
    diamondOre: mapDiamondCount(world.mapSummary), lavaEscapes: lava, blaze: named('blaze', 32).length > 0, dragon: named('ender_dragon', 128).length > 0,
    crystals: crystals > 0 ? crystals : null, armor: fullArmor(counts), lavaDistance: mapLavaDistance(world.mapSummary) };
}

type Facts = Record<string, LiveScalar>;
export interface MomentDetector {
  /** The moments this frame shows beside the one before (none for the first). `at`: milliseconds since the epoch. */
  observe(observation: BodyObservation, at: number): LiveMoment[];
  /** Forgets the frame before: the next one is only remembered (a new connection, a new world). */
  reset(): void;
}

export function createMomentDetector(): MomentDetector {
  let before: Reading | null = null;
  // What was told in this run, so a thing is news once: the items, the pickaxe tiers, the structures, the diamond places.
  const told = { items: new Set<string>(), tools: new Set<string>(), structures: new Set<string>(), diamondOre: 0, armor: false };
  // Edges that re-arm: the near death after her health recovers, the blaze and the dragon after they were gone.
  const armed = { life: true, hunger: true, blaze: true, dragon: true, lava: true };
  let serial = 0;
  const make = (kind: LiveMoment['kind'], at: number, facts: Facts, key?: string): LiveMoment => ({ kind, key: key ?? `${kind}:${++serial}`, at, facts });

  function life(now: Reading, prev: Reading, observation: BodyObservation, at: number): LiveMoment[] {
    const world = record(observation.state.world) ?? {};
    if (prev.alive && !now.alive) {
      const last = list(world.deaths).at(-1), cause = typeof last?.cause === 'string' && /^[a-z_:]{1,40}$/u.test(last.cause) ? last.cause : '';
      armed.life = true;
      return [make('died', at, { cause })];
    }
    return now.alive ? [...health(now, prev, world, at), ...hunger(now, prev, at)] : [];
  }

  function health(now: Reading, prev: Reading, world: Record<string, unknown>, at: number): LiveMoment[] {
    if (now.health === null) return [];
    if (armed.life && now.health <= 6 && (prev.health ?? 20) > 6) {
      armed.life = false;
      return [make('near_death', at, { health: Math.round(now.health), from: nearestThreat(world, 12)?.name ?? '' })];
    }
    if (now.health >= 12) armed.life = true;
    return [];
  }

  function hunger(now: Reading, prev: Reading, at: number): LiveMoment[] {
    if (now.food === null) return [];
    if (armed.hunger && now.food <= 6 && (prev.food ?? 20) > 6) {
      armed.hunger = false;
      return [make('hungry', at, { food: now.food })];
    }
    if (now.food >= 12) armed.hunger = true;
    return [];
  }

  function clock(now: Reading, prev: Reading, at: number): LiveMoment[] {
    if (now.dimension !== 'overworld' || prev.dimension !== 'overworld' || now.tick === null || prev.tick === null) return [];
    const wasNight = isNightTick(prev.tick), isNight = isNightTick(now.tick);
    if (!wasNight && isNight) return [make('night_fell', at, {})];
    if (!(wasNight && !isNight)) return [];
    // The clock jumped (a bed), or it ran on at the game's own pace (twenty ticks a second).
    const wall = (at - prev.at) / 1000, ran = ((now.tick - prev.tick + 24_000) % 24_000);
    return [ran - 20 * wall > 2_000 ? make('slept', at, {}) : make('morning', at, {})];
  }

  function places(now: Reading, prev: Reading, at: number): LiveMoment[] {
    if (now.dimension !== prev.dimension) return [];
    const out: LiveMoment[] = [];
    for (const [name, distance] of now.structures) {
      if (prev.structures.has(name) || told.structures.has(name) || !SHOWN_STRUCTURES.has(name)) continue;
      told.structures.add(name);
      out.push(make('structure_found', at, { name, distance: distance ?? '' }, `structure:${name}`));
    }
    if (now.diamondOre > told.diamondOre && now.diamondOre > prev.diamondOre) {
      told.diamondOre = now.diamondOre;
      out.push(make('diamond_found', at, { count: now.diamondOre, carried: false }, `diamond-ore:${now.diamondOre}`));
    }
    return out;
  }

  function belongings(now: Reading, prev: Reading, at: number): LiveMoment[] {
    const out: LiveMoment[] = [];
    const diamonds = countMatching(now.counts, /^diamond$/u);
    if (diamonds > countMatching(prev.counts, /^diamond$/u)) {
      out.push(make('diamond_found', at, { count: diamonds, carried: true }, `diamond-carried:${diamonds}`));
    }
    if (now.armor && !prev.armor && !told.armor) {
      told.armor = true;
      out.push(make('armor_complete', at, {}, 'armor'));
    }
    for (const tool of ['iron_pickaxe', 'diamond_pickaxe']) {
      const has = (counts: ItemCounts) => countMatching(counts, new RegExp(`^${tool}$`, 'u')) > 0;
      if (has(now.counts) && !has(prev.counts) && !told.tools.has(tool)) {
        told.tools.add(tool);
        out.push(make('tool_made', at, { item: tool }, `tool:${tool}`));
      }
    }
    for (const [item, pattern, least] of FIRST_ITEMS) {
      const have = countMatching(now.counts, pattern);
      if (have >= least && countMatching(prev.counts, pattern) < least && !told.items.has(item)) {
        told.items.add(item);
        out.push(make('item_got', at, { item, count: have }, `item:${item}`));
      }
    }
    return out;
  }

  function surroundings(now: Reading, prev: Reading, at: number): LiveMoment[] {
    const out: LiveMoment[] = [];
    if (now.dimension !== prev.dimension && now.dimension && prev.dimension) out.push(make('dimension_entered', at, { dimension: now.dimension }));
    if (now.lavaEscapes > prev.lavaEscapes) out.push(make('lava_escape', at, {}, `lava:${now.lavaEscapes}`));
    out.push(...lavaNear(now, at));
    if (now.dimension === 'the_nether') {
      if (now.blaze && !prev.blaze && armed.blaze) {
        armed.blaze = false;
        out.push(make('blaze_seen', at, {}));
      } else if (!now.blaze) armed.blaze = true;
    }
    if (now.dimension === 'the_end') out.push(...endStage(now, prev, at));
    return out;
  }

  /** A lava pool the map knows within LAVA_NEAR metres, once, and again after she was LAVA_FAR away. */
  function lavaNear(now: Reading, at: number): LiveMoment[] {
    if (now.lavaDistance === null || now.lavaDistance > LAVA_FAR) {
      armed.lava = true;
      return [];
    }
    if (!armed.lava || now.lavaDistance > LAVA_NEAR) return [];
    armed.lava = false;
    return [make('lava_near', at, { distance: now.lavaDistance })];
  }

  function endStage(now: Reading, prev: Reading, at: number): LiveMoment[] {
    const out: LiveMoment[] = [];
    if (now.dragon && !prev.dragon && armed.dragon) {
      armed.dragon = false;
      out.push(make('dragon_stage', at, { stage: 'seen' }));
    } else if (!now.dragon) armed.dragon = true;
    if (now.crystals !== null && prev.crystals !== null && now.crystals < prev.crystals && now.crystals <= 9) {
      out.push(make('dragon_stage', at, { stage: 'crystals', crystals: now.crystals }, `crystals:${now.crystals}`));
    }
    return out;
  }

  return {
    observe(observation, at) {
      const now = read(observation, at), prev = before;
      before = now;
      if (!prev && now.lavaDistance !== null && now.lavaDistance <= LAVA_NEAR) armed.lava = false;
      if (!prev || !observation.connected) return [];
      return [...life(now, prev, observation, at), ...clock(now, prev, at), ...places(now, prev, at), ...belongings(now, prev, at),
        ...surroundings(now, prev, at)];
    },
    reset() { before = null; },
  };
}
