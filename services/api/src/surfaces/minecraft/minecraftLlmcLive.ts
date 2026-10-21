import type { BodyObservation, BodyValue } from '../../contracts/bodyControlContract.js';
import type { LlmCentricWorld } from '../../contracts/minecraftActContract.js';
import { carriedItemCounts, EDIBLE_FOOD } from './minecraftItems.js';
import { clean, cleanText, round1 } from './minecraftTransientObservation.js';

/**
 * The body part of a decision's live state in the LLM-centric mode (design mb-llm-centric 2.2, 2.3, 2.6): the map first, then what is
 * off it (landmarks), the recent stops, her state, her food in points, the pack, what is near, and what happened since the last decision.
 * Everything else the old live state carried (skill pointers and gists, milestone and route lines, phase facts, the pace ledger) is
 * left out: the plan tree and the map say it. Bounded to `LLMC_LIVE_TOKENS` (the plan's path and this part together): the map first and
 * never cut, then the rest cut in the order of `SHRINK` (the farther creatures, the pack's tail, the later landmarks, …).
 *
 * Token count: `llmcTokens`, fitted to the provider's count_tokens (scene replay r2, 2026-10-22: 149 texts of six scenes' live states,
 * maps, layers and parts, and probes of each map symbol; `services/api/scripts/minecraft-llmc-scene.ts --count` measures it again).
 * The first estimate (a map at 1.8 characters a token, the rest by `estimatedAnthropicTokens`) counted 10–48% short: water (`~ `) was
 * three tokens a cell, `; @ ! $` two, a letter one; so the map now writes water `w` and sand and gravel `s` (minecraftActContract.ts).
 */
export const LLMC_LIVE_TOKENS = 3_000;
const THREATS = 8, OTHERS = 8, LANDMARKS = 12, STOPS = 5, INVENTORY = 36, EVENTS = 6;

/**
 * Tokens of a text as Claude counts it (Opus 5.5 / Sonnet 5.5 count_tokens), by character kind: non-ASCII 1.25, `~` 2.45, `; @ ! $`
 * 1.4, a digit 0.67, a space 0.43, a line break (or its JSON escape) 3.2, any other 0.48; with 8% to spare (the fit was within −6%…+4%
 * of the count on the scenes, and −13% on a plan path).
 */
export function llmcTokens(text: string): number {
  let wide = 0, tilde = 0, heavy = 0, digits = 0, spaces = 0, breaks = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code > 0x7f) wide += 1;
    else if (character === '~') tilde += 1;
    else if (character === ';' || character === '@' || character === '!' || character === '$') heavy += 1;
    else if (code >= 48 && code <= 57) digits += 1;
    else if (character === ' ') spaces += 1;
    else if (character === '\n') breaks += 1;
  }
  breaks += text.split('\\n').length - 1;
  const other = [...text].length - wide - tilde - heavy - digits - spaces - breaks;
  return Math.ceil(1.08 * (wide * 1.25 + tilde * 2.45 + heavy * 1.4 + digits * 0.67 + spaces * 0.43 + breaks * 3.2 + Math.max(0, other) * 0.48));
}

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
  /** r3: the whole texts of the last step's results the history keeps short (`llmcStoredResult`), shown this once. */
  lastResults?: readonly string[];
  /** r3: why this step is urgent (`urgentReasons`), when it is. */
  urgent?: readonly string[];
  /** r3: health lost since the last decision (a fall, a blast), for the hint to look round (`lookHint`). */
  healthLost?: number;
  /**
   * r4: the surprises of this step and what the head's probes found (`runInvestigation`, at most 600 tokens): first in the live state,
   * outside its bound, never cut here. Absent (and no key) when there was none.
   */
  investigation?: readonly string[];
  /** r4: the body's scan of the land, shown once when a new one came (`scanLines`, at most 10 lines): counted in the bound, never cut. */
  scan?: readonly string[];
}

/** The longest the shown results may be together (characters; a view's map is about 2,500). */
const LAST_RESULTS_CHARS = 8_000;
/**
 * A hint to look round with mc.view before the next act (r3; run 27: mc.view was never used, though she fell 20 blocks into a mine
 * and stopped six times at the same walls): the same stop twice or more at one place, or a fall or water that took her health or air.
 */
export function lookHint(world: Record<string, unknown>, healthLost = 0): string | null {
  const repeated = strings(world.recentStops, STOPS).some(line => Number(/×(\d+)/u.exec(line)?.[1] ?? 1) >= 2);
  if (repeated) return '同じ所で同じ止まりが続いている: 次の act の前に mc.view（slice で縦の断面か layers、radius 6〜10）で周りを広く見て、別の道・別の手を決める';
  const oxygen = finite(world.oxygen);
  if ((oxygen !== null && oxygen < 10) || healthLost >= 6) {
    return '落ちた・溺れかけた・大きく打たれた: 動く前に mc.view（slice で上下、layers で周り）で今いる所を見る（地図の外の空洞・水・敵）';
  }
  return null;
}

/** The live body of one decision, bounded (`LLMC_LIVE_TOKENS` with `planTokens` of the plan's path already used). */
export function minecraftLlmcLive(parts: LlmcLiveParts, planTokens = 0): Record<string, unknown> {
  const { observation } = parts;
  if (!observation) return { connected: false, events: parts.events.slice(-EVENTS) };
  const world = (record(observation.state.world) ?? {}) as Record<string, unknown> & LlmCentricWorld;
  const state = stateOf(world, observation);
  parts.trend.note(finite(world.food), finite(world.saturation));
  const food = carriedFood(world, observation.facts), threats = seen(world.nearbyThreats, THREATS);
  // r3: why the step is urgent (first) and the hint to look round (beside the stops): counted in the bound, never cut.
  const look = lookHint(world, parts.healthLost ?? 0);
  const live: Record<string, unknown> = {
    ...(parts.urgent?.length ? { urgent: parts.urgent.slice(0, 4) } : {}),
    map: typeof world.localMap === 'string' ? world.localMap : '（地図なし: 体が地図を送っていない。mc.view で見る）',
    landmarks: strings(world.mapLandmarks, LANDMARKS),
    ...(parts.scan?.length ? { scan: parts.scan.slice(0, 10) } : {}),
    stops: strings(world.recentStops, STOPS),
    ...(look ? { look } : {}),
    state: { ...state, ...(parts.elapsedMinutes !== null ? { minutes: round1(parts.elapsedMinutes) } : {}) },
    food: { points: food.points, items: food.items, lostIn5min: parts.trend.lostIn5min() },
    inventory: stacks(world.inventory).slice(0, INVENTORY),
    threats,
    near: seen(world.nearbyEntities, OTHERS + THREATS).filter(line => !threats.includes(line)).slice(0, OTHERS),
    ...(parts.jobs !== undefined ? { jobs: parts.jobs } : {}),
    ...(parts.events.length ? { events: parts.events.slice(-EVENTS) } : {}),
  };
  // r3: outside the bound (never cut, at most `LAST_RESULTS_CHARS`): the results shown this once.
  const shown = shownResults(parts.lastResults ?? []);
  // r4: the investigation first (outside the bound: it has its own, `LLMC_PROBE.tokens`).
  return { ...(parts.investigation?.length ? { investigation: [...parts.investigation] } : {}), ...fitLive(live, planTokens),
    ...(shown.length ? { lastResults: shown } : {}) };
}

/** The results shown this once, together at most `LAST_RESULTS_CHARS` (the last one cut). */
function shownResults(results: readonly string[]): string[] {
  const shown: string[] = [];
  let room = LAST_RESULTS_CHARS;
  for (const text of results) {
    if (room <= 0) break;
    shown.push(text.length <= room ? text : `${text.slice(0, room)}…（長いため後略）`);
    room -= text.length;
  }
  return shown;
}

/** The tokens of a live body as the decision sends it (its JSON). */
export function llmcLiveTokens(live: Record<string, unknown>): number {
  return llmcTokens(JSON.stringify(live));
}
/** The tokens of the plan's path as the decision reads it (counted against the same bound). */
export function llmcPlanTokens(plan: unknown): number {
  return plan ? llmcTokens(JSON.stringify(plan)) : 0;
}

/**
 * What is cut, in order, until the live body fits (the map is never cut; it comes first): a list kept to its first `keep` lines, or
 * (keep -1) a field left out. The farther creatures go first, the landmarks and the pack last: the furnace seven up and the stone to
 * craft with are what a decision needs most.
 */
const SHRINK: ReadonlyArray<readonly [string, number]> = [['near', 3], ['inventory', 24], ['landmarks', 8], ['near', 0], ['stops', 2],
  ['events', 3], ['threats', 4], ['inventory', 16], ['landmarks', 5], ['food.items', -1], ['jobs', -1], ['inventory', 10], ['landmarks', 3],
  ['threats', 2], ['stops', 1], ['events', 1],
  // A map of water (three tokens a cell) leaves little beside it: the last of the rest, the plan's path and her state kept.
  ['events', -1], ['near', -1], ['threats', 1], ['inventory', 6], ['landmarks', 2]];

/** Leaves out the parts that matter least until the live body fits beside the plan. */
function fitLive(live: Record<string, unknown>, planTokens: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...live };
  const budget = LLMC_LIVE_TOKENS - planTokens;
  for (const [key, keep] of SHRINK) {
    if (llmcLiveTokens(out) <= budget) break;
    if (key === 'food.items') {
      const food = out.food as Record<string, unknown> | undefined;
      if (food && 'items' in food) out.food = Object.fromEntries(Object.entries(food).filter(([name]) => name !== 'items'));
      continue;
    }
    if (keep < 0) {
      delete out[key];
      continue;
    }
    const whole = live[key];
    if (Array.isArray(whole) && whole.length > keep && Array.isArray(out[key])) {
      out[key] = [...whole.slice(0, keep), `ほか${whole.length - keep}件（長いため略）`];
    }
  }
  return out;
}
