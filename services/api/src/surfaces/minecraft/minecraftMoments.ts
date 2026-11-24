import type { LiveMoment, LiveScalar } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carriedItemCounts, countMatching, type ItemCounts } from './minecraftItems.js';
import { fullArmor } from './minecraftStage.js';
import { mobWords } from './minecraftLiveWords.js';

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

/** A hostile near her in a frame: its game name, how far, whether it can get to her, whether it is a creeper with its fuse lit, and its id when the body names one. */
interface Threat { name: string; distance: number; reach: boolean; lit: boolean; id: string }

interface Reading {
  alive: boolean; health: number | null; food: number | null; dimension: LiveDimension | null; tick: number | null; at: number;
  counts: ItemCounts; structures: Map<string, number | null>; diamondOre: number; lavaEscapes: number; blaze: boolean; dragon: boolean;
  crystals: number | null; armor: boolean; lavaDistance: number | null;
  threats: Threat[]; players: number[]; place: string;
}

/** The hostiles of a frame within 24 m, the nearest first (the body's own threats list: a hostile with rock all round it has `reach` false). */
function readThreats(world: Record<string, unknown>): Threat[] {
  return list(world.nearbyThreats).flatMap(threat => {
    const distance = finite(threat.distance);
    return distance !== null && distance <= 24 && typeof threat.name === 'string' && NAME.test(threat.name)
      ? [{ name: threat.name, distance, reach: threat.canReachMe !== false, lit: threat.ignited === true,
        id: threat.id === undefined || threat.id === null ? '' : String(threat.id).slice(0, 24) }] : [];
  }).sort((a, b) => a.distance - b.distance);
}

/** The hostiles that hurt from a distance (any within the 24 m the frame reads). */
const SHOOTERS = /^(?:skeleton|stray|bogged|pillager|blaze|ghast|witch|breeze|wither_skeleton)$/u;

/** The distances of the other people in the frame (the entities of kind `player`): never their names. */
function readPlayers(world: Record<string, unknown>): number[] {
  return list(world.nearbyEntities).flatMap(entity => {
    const distance = finite(entity.distance);
    return entity.kind === 'player' && distance !== null && distance <= 48 ? [distance] : [];
  }).sort((a, b) => a - b);
}

/** The biome's name in her words, for the biomes that have a plain one; '' for any other (a view is told only when it can be named). */
const PLACES: ReadonlyArray<readonly [RegExp, string]> = [
  [/cherry/u, '桜の林'], [/dark_forest/u, '暗い森'], [/bamboo/u, '竹林'], [/jungle/u, 'ジャングル'], [/taiga/u, 'タイガの森'], [/birch|forest/u, '森'],
  [/swamp|mangrove/u, '沼地'], [/desert/u, '砂漠'], [/badlands|mesa/u, '赤い荒野'], [/savanna/u, 'サバンナ'], [/snowy|ice|frozen|grove|peaks/u, '雪の世界'],
  [/mushroom/u, 'キノコの島'], [/meadow/u, '花の草原'], [/beach|shore/u, '浜辺'], [/river/u, '川'], [/ocean/u, '海'], [/plains/u, '広い平原'],
  [/dripstone|lush|deep_dark|cave/u, '洞窟'], [/mountain|hills|slopes/u, '山'],
];
const placeWords = (biome: unknown): string => {
  const id = typeof biome === 'string' ? biome.toLowerCase().replace(/^minecraft:/u, '').replace(/\s+/gu, '_') : '';
  return PLACES.find(([pattern]) => pattern.test(id))?.[1] ?? '';
};

function read(observation: BodyObservation, at: number): Reading {
  const world = record(observation.state.world) ?? {}, counts = carriedItemCounts(world, observation.facts);
  const entities = [...list(world.nearbyThreats), ...list(world.nearbyEntities)];
  const named = (name: string, within = 48) => entities.filter(entity => entity.name === name && (finite(entity.distance) ?? 999) <= within);
  const crystals = new Set(named('end_crystal', 128).map(entity => JSON.stringify(entity.position ?? entity.distance))).size;
  const lava = finite(record(record(world.reflexes)?.counts)?.lava) ?? 0;
  return { alive: observation.facts.alive === true, health: finite(world.health), food: finite(world.food),
    dimension: dimensionOfWorld(world, observation.facts), tick: dayTick(world), at, counts, structures: mapStructures(world.mapSummary),
    diamondOre: mapDiamondCount(world.mapSummary), lavaEscapes: lava, blaze: named('blaze', 32).length > 0, dragon: named('ender_dragon', 128).length > 0,
    crystals: crystals > 0 ? crystals : null, armor: fullArmor(counts), lavaDistance: mapLavaDistance(world.mapSummary),
    threats: readThreats(world), players: readPlayers(world), place: placeWords(world.biome) };
}

/**
 * What the game's own name for a death says, in her words (`minecraft:arrow` is an arrow, not a zombie): the writer is shown Japanese, so it
 * has no English name to guess a mob from. A cause not in the list is left out (the fact line then says it is not known), never guessed.
 */
const DEATH_CAUSES: Readonly<Record<string, string>> = Object.freeze({
  arrow: '矢で撃たれた', mob_attack: 'モンスターに殴られた', player_attack: '人に攻撃された', fall: '高い所から落ちた', drown: 'おぼれた', lava: '溶岩に落ちた',
  in_fire: '火に焼かれた', on_fire: '火に焼かれた', explosion: '爆発に巻き込まれた', 'explosion.player': '爆発に巻き込まれた', starve: 'お腹がすきすぎた', magic: '魔法のダメージ',
  fireball: '火の玉に当たった', thorns: 'とげにやられた', cactus: 'サボテンに刺された', fly_into_wall: '壁にぶつかった', out_of_world: '世界の外に落ちた',
  wither: 'ウィザーのダメージ', trident: 'トライデントに刺された', sting: '蜂に刺された', sweet_berry_bush: 'ベリーのとげにやられた', freeze: '凍えた',
  lightning_bolt: '雷に打たれた', hot_floor: '熱い床で焼けた', stalagmite: '鍾乳石に刺された', falling_anvil: 'かなとこが落ちてきた', falling_block: 'ブロックが落ちてきた',
});
export const deathCauseWords = (cause: string): string => DEATH_CAUSES[cause.replace(/^minecraft:/u, '')] ?? '';

type Facts = Record<string, LiveScalar>;
export interface MomentDetector {
  /** The moments this frame shows beside the one before (none for the first). `at`: milliseconds since the epoch. */
  observe(observation: BodyObservation, at: number): LiveMoment[];
  /** Forgets the frame before: the next one is only remembered (a new connection, a new world). */
  reset(): void;
  /** Forgets which of the wanted items were told (a new request wants them anew). */
  forgetWanted?(): void;
}

/** The id a promise or a condition names, as the pattern of the carried items it means (`planks` is every plank). */
const wantedPattern = (item: string): RegExp | null =>
  item === 'planks' ? /_planks$/u : NAME.test(item) ? new RegExp(`^${item}$`, 'u') : null;

/**
 * `wanted`: the items her work asks for now, with how many (read from the plan she keeps: its promises and the `have:` of a node's
 * condition). What she gets of those is a moment of its own (`material_got`): which items are worth a word is what her work needs, not a
 * table of names.
 */
export function createMomentDetector(options: { wanted?: () => ReadonlyMap<string, number> } = {}): MomentDetector {
  let before: Reading | null = null;
  // What was told in this run, so a thing is news once: the items, the pickaxe tiers, the structures, the diamond places.
  const told = { items: new Set<string>(), tools: new Set<string>(), structures: new Set<string>(), diamondOre: 0, armor: false,
    wanted: new Set<string>() };
  // Edges that re-arm: the near death after her health recovers, the blaze and the dragon after they were gone.
  const armed = { life: true, hunger: true, blaze: true, dragon: true, lava: true, attack: true, scare: true };
  // The fight as it goes: when she was last hurt by a hostile or had one near (the calm re-arms the hit), whether a fight is on (so that
  // getting away is told once), when the nearest hostile left her, and when another person was last near (a person coming back is news).
  const fight = { calmSince: null as number | null, on: false, clearSince: null as number | null, playerSeen: null as number | null };
  let serial = 0;
  const make = (kind: LiveMoment['kind'], at: number, facts: Facts, key?: string): LiveMoment => ({ kind, key: key ?? `${kind}:${++serial}`, at, facts });

  function life(now: Reading, prev: Reading, observation: BodyObservation, at: number): LiveMoment[] {
    const world = record(observation.state.world) ?? {};
    if (prev.alive && !now.alive) {
      const last = list(world.deaths).at(-1), cause = deathCauseWords(typeof last?.cause === 'string' && /^[a-z_:]{1,40}$/u.test(last.cause) ? last.cause : '');
      armed.life = true;
      fight.on = false;
      const from = prev.threats.find(threat => threat.distance <= 12);
      return [make('died', at, { cause, ...(from ? { from: mobWords(from.name) } : {}) })];
    }
    if (!prev.alive && now.alive) return [make('respawned', at, {})];
    return now.alive ? [...health(now, prev, world, at), ...hunger(now, prev, at), ...fights(now, prev, at)] : [];
  }

  /**
   * What happens to her in a fight, from one frame to the next (the frame already carries it: her health, the hostiles that can reach her,
   * where the people are): the first hit of a hostile (told at once, and not again until it has been calm for twenty seconds), a creeper
   * at her side, a blow with no hostile near (a fall, a fire), getting away (the hostiles have been gone for eight seconds), and a hostile
   * that was at her and is gone (told only as "gone, it seems": the frame cannot tell a kill from a retreat).
   */
  function fights(now: Reading, prev: Reading, at: number): LiveMoment[] {
    const out: LiveMoment[] = [];
    const lost = now.health !== null && prev.health !== null ? prev.health - now.health : 0;
    const close = now.threats.filter(threat => threat.reach && threat.distance <= 6);
    // A hit from a shooter far off (an arrow, a fireball) is a hit from a hostile too: what hurts her need not be within reach of a sword.
    const hurtFrom = close.length ? close : now.threats.filter(threat => threat.reach && SHOOTERS.test(threat.name));
    const hurtByMob = lost >= 1 && hurtFrom.length > 0;
    if (hurtByMob && armed.attack) {
      armed.attack = false;
      fight.on = true;
      const first = hurtFrom[0]!;
      out.push(make('attacked', at, { from: mobWords(first.name), count: hurtFrom.length, health: Math.round(now.health ?? 0) }));
    }
    if (hurtByMob || close.length > 0) fight.calmSince = null;
    else if (fight.calmSince === null) fight.calmSince = at;
    if (!armed.attack && fight.calmSince !== null && at - fight.calmSince >= 20_000) armed.attack = true;
    // A blow of five or more at once with no hostile at her: a fall, a fire, an arrow from far.
    if (lost >= 5 && hurtFrom.length === 0) out.push(make('surprised', at, { amount: Math.round(lost), health: Math.round(now.health ?? 0) }));
    const creeper = now.threats.find(threat => threat.name === 'creeper' && threat.reach && (threat.distance <= 3.5 || (threat.lit && threat.distance <= 6)));
    if (creeper && armed.scare) {
      armed.scare = false;
      out.push(make('scared', at, { from: mobWords('creeper'), distance: Math.round(creeper.distance), lit: creeper.lit }));
    } else if (!now.threats.some(threat => threat.name === 'creeper' && threat.distance <= 8)) armed.scare = true;
    // A hostile that stood at her (within 5 m) and is no longer in the frame at all.
    for (const threat of prev.threats) {
      // A creeper that is gone blew up or ran off: that is not a kill.
      if (threat.distance > 5 || !threat.reach || lost >= 1 || threat.name === 'creeper') continue;
      const same = (other: Threat) => (threat.id && other.id ? other.id === threat.id : other.name === threat.name);
      const stillAround = now.threats.filter(same).length >= prev.threats.filter(same).length;
      if (!stillAround) {
        out.push(make('killed', at, { name: mobWords(threat.name) }, `killed:${threat.id || threat.name}:${Math.round(at / 1000)}`));
        break;
      }
    }
    // Getting away: the fight was on, and nothing that can reach her has been within eight metres for eight seconds.
    const near = now.threats.some(threat => threat.reach && threat.distance <= 8);
    if (near) fight.clearSince = null;
    else if (fight.clearSince === null) fight.clearSince = at;
    if (fight.on && fight.clearSince !== null && at - fight.clearSince >= 8_000 && (now.health ?? 0) > 0) {
      fight.on = false;
      out.push(make('got_away', at, { health: Math.round(now.health ?? 0) }));
    }
    return out;
  }

  /** The view changing (a biome she can name) and another person coming near after a while without one. */
  function company(now: Reading, prev: Reading, at: number): LiveMoment[] {
    const out: LiveMoment[] = [];
    if (now.place && prev.place && now.place !== prev.place && now.dimension === 'overworld') out.push(make('scenery', at, { place: now.place }));
    const near = now.players.find(distance => distance <= 12);
    if (near !== undefined && (fight.playerSeen === null || at - fight.playerSeen >= 45_000)) out.push(make('player_near', at, { distance: Math.round(near) }));
    if (now.players.some(distance => distance <= 24)) fight.playerSeen = at;
    return out;
  }

  function health(now: Reading, prev: Reading, world: Record<string, unknown>, at: number): LiveMoment[] {
    if (now.health === null) return [];
    if (armed.life && now.health <= 6 && (prev.health ?? 20) > 6) {
      armed.life = false;
      const from = nearestThreat(world, 12)?.name;
      return [make('near_death', at, { health: Math.round(now.health), from: from ? mobWords(from) : '' })];
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
    return [...out, ...wanted(now, prev, at)];
  }

  /** An item her work asks for: told when she first has one, and again when she has all that was asked. */
  function wanted(now: Reading, prev: Reading, at: number): LiveMoment[] {
    const out: LiveMoment[] = [];
    for (const [item, asked] of options.wanted?.() ?? []) {
      const pattern = wantedPattern(item);
      if (!pattern || FIRST_ITEMS.some(([id]) => id === item)) continue;
      const have = countMatching(now.counts, pattern), was = countMatching(prev.counts, pattern), need = Math.max(1, Math.min(asked, 4_096));
      // One moment for a jump that crosses both (the first one and all of it): the higher is what she says.
      const crossed = [...new Set([1, need])].filter(step => have >= step && was < step && !told.wanted.has(`${item}:${step}`));
      crossed.forEach(step => told.wanted.add(`${item}:${step}`));
      const top = crossed.at(-1);
      if (top !== undefined) out.push(make('material_got', at, { item, count: have, ...(need > 1 ? { need } : {}) }, `material:${item}:${top}`));
    }
    return out.slice(0, 3);
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
      if (!prev && now.players.some(distance => distance <= 24)) fight.playerSeen ??= at;
      if (!prev || !observation.connected) return [];
      return [...life(now, prev, observation, at), ...clock(now, prev, at), ...places(now, prev, at), ...belongings(now, prev, at),
        ...surroundings(now, prev, at), ...company(now, prev, at)];
    },
    reset() { before = null; },
    forgetWanted() { told.wanted.clear(); },
  };
}
