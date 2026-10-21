import type { BodyObservation, BodyValue } from '../../contracts/bodyControlContract.js';
import type { LlmCentricWorld } from '../../contracts/minecraftActContract.js';
import { estimatedAnthropicTokens } from '../../infra/models/anthropic/anthropicFcaHistory.js';
import { carriedItemCounts, EDIBLE_FOOD } from './minecraftItems.js';
import { clean, cleanText, round1 } from './minecraftTransientObservation.js';

/**
 * The body part of a decision's live state in the LLM-centric mode (design mb-llm-centric 2.2, 2.3, 2.6): the map first, then what is
 * off it (landmarks), the recent stops, her state, her food in points, the pack, what is near, and what happened since the last decision.
 * Everything else the old live state carried (skill pointers and gists, milestone and route lines, phase facts, the pace ledger) is
 * left out: the plan tree and the map say it. Bounded to `LLMC_LIVE_TOKENS` (the plan's path and this part together), by leaving out
 * the farther entities, then the later landmarks, then the pack's tail; the map is never cut.
 *
 * Token estimate: the map is counted at `MAP_CHARS_PER_TOKEN` (one symbol and a space a cell, about one token a cell; calibrate with
 * `scripts/minecraft-llmc-count.ts`, which asks the provider's count_tokens), the rest by `estimatedAnthropicTokens`.
 */
export const LLMC_LIVE_TOKENS = 3_000;
export const MAP_CHARS_PER_TOKEN = 1.8;
const THREATS = 8, OTHERS = 8, LANDMARKS = 12, STOPS = 5, INVENTORY = 36, EVENTS = 6;

/** Food points of one item (hunger + saturation it restores), design 1.6. */
export const FOOD_POINTS: Readonly<Record<string, number>> = Object.freeze({
  cooked_beef: 20.8, cooked_porkchop: 20.8, steak: 20.8, cooked_mutton: 15.6, cooked_salmon: 15.6, cooked_chicken: 13.2, bread: 11,
  baked_potato: 11, cooked_cod: 11, cooked_rabbit: 11, golden_carrot: 20.4, pumpkin_pie: 12.8, mushroom_stew: 13.2, rabbit_stew: 22,
  beetroot_soup: 13.2, apple: 6.4, carrot: 6.6, potato: 1.6, beef: 4.8, porkchop: 4.8, mutton: 3.2, chicken: 3.2, rabbit: 4.8,
  cod: 2.4, salmon: 2.4, melon_slice: 3.2, sweet_berries: 2.4, dried_kelp: 1.6, beetroot: 2.2, cookie: 2.4,
});

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const strings = (value: unknown, limit: number): string[] => (Array.isArray(value) ? value : []).filter(item => typeof item === 'string')
  .slice(0, limit).map(item => clean(item as string).slice(0, 200));

/** The food she carries, as points (design 2.6): the total and each kind. */
export function carriedFood(world: Record<string, unknown>, facts: Readonly<Record<string, unknown>>): { points: number; items: string[] } {
  const counts = carriedItemCounts(world, facts);
  let points = 0;
  const items: string[] = [];
  for (const [name, count] of counts) {
    if (!EDIBLE_FOOD.test(name) && !(name in FOOD_POINTS)) continue;
    const each = FOOD_POINTS[name] ?? 2;
    points += each * count;
    items.push(`${name}×${count}(${round1(each * count)})`);
  }
  return { points: round1(points), items };
}

/** Her hunger and saturation over time, per task: how many points went in the last five minutes (eating counts as none gone). */
export function createFoodTrend(now: () => number = Date.now) {
  const samples: Array<{ at: number; value: number }> = [];
  return {
    note(food: number | null, saturation: number | null) {
      if (food === null) return;
      samples.push({ at: now(), value: food + (saturation ?? 0) });
      while (samples.length > 2 && now() - samples[0]!.at > 330_000) samples.shift();
    },
    /** Points used in the last five minutes (rises from eating are not subtracted), or null with too short a record. */
    lostIn5min(): number | null {
      const recent = samples.filter(sample => now() - sample.at <= 300_000);
      if (recent.length < 2 || recent.at(-1)!.at - recent[0]!.at < 60_000) return null;
      let lost = 0;
      for (let index = 1; index < recent.length; index += 1) lost += Math.max(0, recent[index - 1]!.value - recent[index]!.value);
      return round1(lost);
    },
  };
}
export type FoodTrend = ReturnType<typeof createFoodTrend>;

interface Seen { line: string; distance: number }
function seen(value: unknown, limit: number): string[] {
  const items: Seen[] = (Array.isArray(value) ? value : []).flatMap(item => {
    const entity = record(item);
    if (!entity || typeof entity.name !== 'string') return [];
    const distance = finite(entity.distance) ?? 99;
    const at = record(entity.position);
    const where = at && finite(at.x) !== null ? ` (${Math.floor(Number(at.x))},${Math.floor(Number(at.y))},${Math.floor(Number(at.z))})` : '';
    const id = finite(entity.id) !== null ? `#${entity.id} ` : '';
    return [{ line: `${id}${cleanText(entity.name)} ${round1(distance)}m${where}`, distance }];
  });
  return items.sort((left, right) => left.distance - right.distance).slice(0, limit).map(item => item.line);
}

function stacks(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    if (typeof item === 'string') return [clean(item)];
    const stack = record(item);
    if (!stack || typeof stack.name !== 'string') return [];
    const durability = record(stack.durability);
    const worn = durability ? `(耐久${String(durability.left)}/${String(durability.max)})` : '';
    return [`${clean(stack.name.replace(/^minecraft:/u, ''))}×${finite(stack.count) ?? 1}${worn}`];
  });
}

/** Her state in one object: where, the time, health, hunger, air, what she holds and wears. */
function stateOf(world: Record<string, unknown>, observation: BodyObservation): Record<string, BodyValue> {
  const at = record(world.position);
  const out: Record<string, BodyValue> = {};
  if (at && finite(at.x) !== null) out.at = `(${Math.floor(Number(at.x))},${Math.floor(Number(at.y))},${Math.floor(Number(at.z))})`;
  const dimension = world.dimension ?? observation.facts.dimension;
  if (typeof dimension === 'string') out.dimension = dimension.replace(/^minecraft:/u, '');
  for (const key of ['inside', 'biome', 'time', 'weather', 'heldItem', 'worn'] as const) {
    if (typeof world[key] === 'string') out[key] = cleanText(world[key] as string);
  }
  for (const key of ['health', 'food', 'saturation', 'oxygen', 'armor'] as const) {
    const value = finite(world[key]);
    if (value !== null) out[key] = round1(value);
  }
  return out;
}

export interface LlmcLiveParts {
  observation: BodyObservation | null;
  elapsedMinutes: number | null;
  trend: FoodTrend;
  /** What happened since the last decision (reflex, death, arrival, a furnace done), newest last. */
  events: readonly string[];
  /** The external jobs the frame reports (a furnace and its finish time), as given. */
  jobs?: BodyValue;
}

/** The live body of one decision, bounded (`LLMC_LIVE_TOKENS` with `planTokens` of the plan's path already used). */
export function minecraftLlmcLive(parts: LlmcLiveParts, planTokens = 0): Record<string, unknown> {
  const { observation } = parts;
  if (!observation) return { connected: false, events: parts.events.slice(-EVENTS) };
  const world = (record(observation.state.world) ?? {}) as Record<string, unknown> & LlmCentricWorld;
  const state = stateOf(world, observation);
  parts.trend.note(finite(world.food), finite(world.saturation));
  const food = carriedFood(world, observation.facts), threats = seen(world.nearbyThreats, THREATS);
  const live: Record<string, unknown> = {
    map: typeof world.localMap === 'string' ? world.localMap : '（地図なし: 体が地図を送っていない。mc.view で見る）',
    landmarks: strings(world.mapLandmarks, LANDMARKS),
    stops: strings(world.recentStops, STOPS),
    state: { ...state, ...(parts.elapsedMinutes !== null ? { minutes: round1(parts.elapsedMinutes) } : {}) },
    food: { points: food.points, items: food.items, lostIn5min: parts.trend.lostIn5min() },
    inventory: stacks(world.inventory).slice(0, INVENTORY),
    threats,
    near: seen(world.nearbyEntities, OTHERS + THREATS).filter(line => !threats.includes(line)).slice(0, OTHERS),
    ...(parts.jobs !== undefined ? { jobs: parts.jobs } : {}),
    ...(parts.events.length ? { events: parts.events.slice(-EVENTS) } : {}),
  };
  return fitLive(live, planTokens);
}

/** The estimated tokens of a live body (the map at `MAP_CHARS_PER_TOKEN`). */
export function llmcLiveTokens(live: Record<string, unknown>): number {
  const map = typeof live.map === 'string' ? live.map : '';
  return Math.ceil(map.length / MAP_CHARS_PER_TOKEN) + estimatedAnthropicTokens({ ...live, map: '' });
}

/** Leaves out the parts that matter least until the live body fits beside the plan. */
function fitLive(live: Record<string, unknown>, planTokens: number): Record<string, unknown> {
  const out = { ...live };
  const budget = LLMC_LIVE_TOKENS - planTokens;
  const shrink: Array<[string, number]> = [['near', 3], ['landmarks', 6], ['inventory', 20], ['threats', 4], ['stops', 2], ['near', 0],
    ['landmarks', 3], ['inventory', 12]];
  for (const [key, keep] of shrink) {
    if (llmcLiveTokens(out) <= budget) break;
    if (Array.isArray(out[key]) && (out[key] as unknown[]).length > keep) {
      const list = out[key] as unknown[];
      out[key] = [...list.slice(0, keep), `ほか${list.length - keep}件（長いため略）`];
    }
  }
  return out;
}
