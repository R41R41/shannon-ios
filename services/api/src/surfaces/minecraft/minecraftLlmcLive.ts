import type { PlanPromise } from '@shannon/mind';
import { shareStacks } from './minecraftLlmcPromises.js';
import type { BodyObservation, BodyValue } from '../../contracts/bodyControlContract.js';
import type { LlmCentricWorld } from '../../contracts/minecraftActContract.js';
import { carriedItemCounts, EDIBLE_FOOD } from './minecraftItems.js';
import { BLOCKS } from './minecraftLlmcPrepRules.js';
import { foodPreparation } from './minecraftFoodPreparation.js';
import { itemWords, reachSuffix } from './minecraftLlmcReachWords.js';
import { breathWords, timeWords } from './minecraftLlmcStateWords.js';
import { clean, cleanText, round1 } from './minecraftTransientObservation.js';

/**
 * The body part of a decision's live state in the LLM-centric mode (design mb-llm-centric 2.2, 2.3, 2.6): the
 * map first, then what is
 * off it (landmarks), the recent stops, her state, her food in points, the pack, what is near, and what happened
 * since the last decision.
 * Everything else the old live state carried (skill pointers and gists, milestone and route lines, phase facts,
 * the pace ledger) is
 * left out: the plan tree and the map say it. Bounded to `LLMC_LIVE_TOKENS` (the plan's path and this part
 * together), a bound nothing
 * reaches (人手の点検: 127 か所の `ほか N 件（長いため略）`, 848 lines unseen): every hostile, the whole pack. The map first and never cut,
 * then the rest cut in the order of `SHRINK` (the farther creatures, the pack's tail, the later landmarks, …).
 *
 * Token count: `llmcTokens`, fitted to the provider's count_tokens (scene replay r2, 2026-10-22: 149 texts of
 * six scenes' live states,
 * maps, layers and parts, and probes of each map symbol; `services/api/scripts/minecraft-llmc-scene.ts --count`
 * measures it again).
 * The first estimate (a map at 1.8 characters a token, the rest by `estimatedAnthropicTokens`) counted 10–48%
 * short: water (`~ `) was
 * three tokens a cell, `; @ ! $` two, a letter one; so the map now writes water `w` and sand and gravel `s`
 * (minecraftActContract.ts).
 */
export const LLMC_LIVE_TOKENS = 12_000;
/**
 * How old the body's last frame may be for a decision to read it (a command needs a frame of 3 s,
 * `MinecraftControl.frame`). mc-chat-stale-frame
 * (2026-10-26): an 8 s stall of the API's thread left the live saying `connected: false` and the chat request's
 * task waited for a body that
 * was there. Past this the body is taken for gone.
 */
export const LLMC_STALE_FRAME_MS = 15_000;
/** The live's one line for a body seen `ageMs` ago (older than a command's frame): how old, so the decision does
 * not take it for now. */
export const bodyAgeField = (line: string | null | undefined): { bodyAge?: string } => line ? { bodyAge: line } : {};
export function staleBodyLine(ageMs: number): string {
  return `体の様子は ${Math.max(1, Math.round(ageMs / 1000))} 秒前のもの（新しい観測がまだ届いていない。位置や敵はもう動いているかもしれない）`;
}
const THREATS = 24, OTHERS = 8, LANDMARKS = 12, STOPS = 5, INVENTORY = 80, EVENTS = 6;
type SeenMode = 'threat' | 'near';

/**
 * Tokens of a text as Claude counts it (Opus 5.5 / Sonnet 5.5 count_tokens), by character kind: non-ASCII 1.25,
 * `~` 2.45, `; @ ! $`
 * 1.4, a digit 0.67, a space 0.43, a line break (or its JSON escape) 3.2, any other 0.48; with 8% to spare (the
 * fit was within −6%…+4%
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

/** The name of the body's wood mark (the nearest plank or fence within 24 blocks: a mineshaft's supports, a hut),
 * told only while she is short of wood. */
export const WOOD_MARK = '木材（板・柵）';
/** Planks she can make or holds under which wood is short: a table 4, a pickaxe 3, an axe 3 and the sticks 4. */
export const WOOD_SHORT_PLANKS = 12;
/** The planks she holds, a log counted as four. */
export function planksHeld(world: Record<string, unknown>, facts: Readonly<Record<string, unknown>>): number {
  let planks = 0;
  for (const [name, count] of carriedItemCounts(world, facts)) {
    if (name.endsWith('_planks')) planks += count;
    else if (name.endsWith('_log') || name.endsWith('_stem')) planks += count * 4;
  }
  return planks;
}
/** The landmark lines: the body's wood mark only while wood is short (run 39: no table below, 400 s, the mine's
 * planks 30 m off and unsaid). */
function landmarkLines(world: Record<string, unknown>, facts: Readonly<Record<string, unknown>>): string[] {
  const lines = strings(world.mapLandmarks, LANDMARKS);
  if (planksHeld(world, facts) < WOOD_SHORT_PLANKS) {
    return lines.map(line => line.includes(WOOD_MARK) ? `${line}（板が足りない間だけ出す。dig で取れる。作業台は板 4）` : line);
  }
  return lines.filter(line => !line.includes(WOOD_MARK));
}

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
/**
 * `mode` (mb-llmc-cand 10): `threat` writes how the hostile stands to her after its place (`reachSuffix`);
 * `near` names a dropped item
 * (`cobblestone×4`), leaves out an item she threw herself and the hostiles (the threats say them).
 */
const seenName = (entity: Record<string, unknown>, mode: SeenMode): string => mode === 'near' && entity.name === 'item'
  ? `item${itemWords(entity) ? ` ${itemWords(entity)}` : ''}` : cleanText(entity.name as string);
function seen(value: unknown, limit: number, mode: SeenMode): string[] {
  const items: Seen[] = (Array.isArray(value) ? value : []).flatMap(item => {
    const entity = record(item);
    if (!entity || typeof entity.name !== 'string') return [];
    if (mode === 'near' && (entity.droppedByMe === true || entity.kind === 'hostile')) return [];
    const distance = finite(entity.distance) ?? 99;
    const at = record(entity.position);
    const where = at && finite(at.x) !== null ? ` (${Math.floor(Number(at.x))},${Math.floor(Number(at.y))},${Math.floor(Number(at.z))})` : '';
    const id = finite(entity.id) !== null ? `#${entity.id} ` : '';
    return [{ line: `${id}${seenName(entity, mode)} ${round1(distance)}m${where}${mode === 'threat' ? reachSuffix(entity) : ''}`, distance }];
  });
  return items.sort((left, right) => left.distance - right.distance).slice(0, limit).map(item => item.line);
}

/** Whether a `near` line is a threat's creature too (the same `#id`: the threat's line has more words). */
const taken = (threats: readonly string[], line: string): boolean =>
  /^#\d+ /u.test(line) && threats.some(threat => threat.startsWith(`${line.split(' ')[0]} `));

export function stacks(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    if (typeof item === 'string') return [clean(item)];
    const stack = record(item);
    if (!stack || typeof stack.name !== 'string') return [];
    const durability = record(stack.durability);
    const worn = durability ? `(耐久${String(durability.left)}/${String(durability.max)})` : '';
    return [`${clean(stack.name.replace(/^minecraft:/u, ''))}×${finite(stack.count) ?? 1}${worn}`];
  });
}

/**
 * mb-llmc-cand 9 (run 37: "time":"99" with no unit): the time of day in words, from the body's numeric `timeOfDay`
 * (0–23999) first and its `time` string as the fallback; null when it is neither a number nor the Nether's or the End's.
 */
function timeOf(world: Record<string, unknown>, dimension: BodyValue | undefined): string | null {
  const raw = finite(world.timeOfDay) !== null ? String(world.timeOfDay) : String(world.time);
  return timeWords(raw, typeof dimension === 'string' ? dimension : undefined);
}

/** Her state in one object: where, the time, health, hunger, air, what she holds and wears. */
function stateOf(world: Record<string, unknown>, observation: BodyObservation): Record<string, BodyValue> {
  const at = record(world.position);
  const out: Record<string, BodyValue> = {};
  if (at && finite(at.x) !== null) out.at = `(${Math.floor(Number(at.x))},${Math.floor(Number(at.y))},${Math.floor(Number(at.z))})`;
  const dimension = world.dimension ?? observation.facts.dimension;
  if (typeof dimension === 'string') out.dimension = dimension.replace(/^minecraft:/u, '');
  for (const key of ['inside', 'biome', 'time', 'weather', 'heldItem', 'worn'] as const) {
    if (typeof world[key] !== 'string') continue;
    out[key] = (key === 'time' ? timeOf(world, out.dimension) : null) ?? cleanText(world[key] as string);
  }
  // Run 46: the body's own count of the empty pack slots (`freeSlots`), the pack lines' ground (the inventory is one line a kind).
  const free = finite(world.freeSlots);
  const validFreeSlots = (value: number | null): value is number => (value !== null && value >= 0 && value <= 36);
  if (validFreeSlots(free)) out.freeSlots = Math.floor(free);
  for (const key of ['health', 'food', 'saturation', 'oxygen', 'armor'] as const) {
    const value = finite(world[key]);
    // Run 37 (oxygen 400 on dry land, 20 later): one scale, 息 n/20.
    // Run 41: the hunger bar is `fullness` (満腹), apart from the food points she carries (`foodPoints`): both were
// `food`, and 「満腹 20」 read as the food being fine.
    if (value !== null) out[key === 'food' ? 'fullness' : key] = key === 'oxygen' ? breathWords(value)! : round1(value);
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
   * r4: the surprises of this step and what the head's probes found (`runInvestigation`, at most 600 tokens):
 * first in the live state,
   * outside its bound, never cut here. Absent (and no key) when there was none.
   */
  investigation?: readonly string[];
  /** r4: the body's scan of the land, shown once when a new one came (`scanLines`, at most 10 lines): counted in
 * the bound, never cut. */
  scan?: readonly string[];
  /**
   * r6 (run 29): just before the map, counted in the bound and never cut: the current plan node (`planNowLine`),
 * what its stage lacks
   * (`preparationShortage`), and health that does not come back with where food is (`recoveryLine`, `foodLeads`). Absent: no key.
   */
  planNow?: string | null;
  shortage?: string | null;
  recovery?: readonly string[];
  /**
   * r7 (runs 29–31): the near hostiles the body's sight found walled off (`urgentFacts`): after the plan's now,
 * the shortage and the
   * recovery, never before them, and no urgent step for them. Absent: no key.
   */
  unreachable?: readonly string[];
  /**
   * r8 (run 32: a one-wide bridge over the lava sea, the drop not on the map): the footing round her feet
 * (`footingLine`), after the
   * unreachable lines and before the map, counted in the bound and never cut. Absent: no key.
   */
  footing?: string | null;
  /** mc-chat-stale-frame: the body was last seen this long ago (`staleBodyLine`); absent: the frame is the current one. */
  bodyAge?: string | null;
  /** Task queue (design minebot-task-queue): the items the body runs and waits with, one line each
 * (`minecraftLlmcQueue.ts`), after the plan's now. */
  queue?: readonly string[];
  /** mb-llmc-cand 11 (a dragon task): the stage road and the pace against the milestones' targets
 * (`minecraftLlmcRoad.ts`), after the plan's now. */
  road?: string | null;
  meter?: string | null;
  /**
   * The continue contract, chapter 8 (「判断に届ける事実」): the facts a decision is given whatever version of the input it
 * reads (`minecraftLlmcFacts.ts`), one line each,
   * before the map, counted in the bound and never cut. `compressed` is the same facts as the shortened version
 * keeps them (the pack in one line, three food candidates):
   * the live state takes it in place of `lines` when it has to be shortened. Absent: no key.
   */
  facts?: { lines: readonly string[]; compressed?: readonly string[] };
  /** A-9: the plan's promises, whose shares are written beside the pack's lines (`shareStacks`). */
  promises?: readonly PlanPromise[];
  /**
   * The facts said once that the normal input takes (`onceFor`, the words of each), put first in `events`. A live
 * state that has to be shortened says none of them and so
   * does not deliver them (the request's bytes decide: `deliverOnceFacts`); they are offered again with the next input.
   */
  once?: readonly string[];
}

/** The longest the shown results may be together (characters; a view's map is about 2,500). */
const LAST_RESULTS_CHARS = 8_000;
/**
 * A hint to look round with mc.view before the next act (r3; run 27: mc.view was never used, though she fell 20
 * blocks into a mine
 * and stopped six times at the same walls): the same stop twice or more at one place, or a fall or water that
 * took her health or air.
 */
export function lookHint(world: Record<string, unknown>, healthLost = 0): string | null {
  const repeated = strings(world.recentStops, STOPS).some(line => Number(/×(\d+)/u.exec(line)?.[1] ?? 1) >= 2);
  if (repeated) return '同じ所で同じ止まりが続いている（原因は見えていない。mc_view の slice で縦の断面、layers で周りが見られる）';
  const oxygen = finite(world.oxygen);
  if ((oxygen !== null && oxygen < 10) || healthLost >= 6) {
    return '落ちた・溺れかけた・大きく打たれた（地図の外の空洞・水・敵があるかもしれない。mc_view の slice で上下、layers で周りが見られる）';
  }
  return null;
}

/** r6: the plan's now, the shortage and the recovery, each only when there is one; r7: then the walled-off
 * hostiles; r8: then the footing. */
function readinessFields(parts: Pick<LlmcLiveParts, 'planNow' | 'road' | 'meter' | 'queue' | 'shortage' | 'recovery' | 'unreachable' | 'footing'>)
  : Record<string, unknown> {
  return { ...(parts.planNow ? { planNow: parts.planNow } : {}), ...(parts.road ? { road: parts.road } : {}), ...(parts.meter ? { meter: parts.meter } : {}),
    ...(parts.queue?.length ? { queue: [...parts.queue] } : {}),
    ...(parts.shortage ? { shortage: parts.shortage } : {}),
    ...(parts.recovery?.length ? { recovery: [...parts.recovery] } : {}),
    ...(parts.unreachable?.length ? { unreachable: [...parts.unreachable] } : {}), ...(parts.footing ? { footing: parts.footing } : {}) };
}

/** The live body of one decision, bounded (`LLMC_LIVE_TOKENS` with `planTokens` of the plan's path already used). */
export function minecraftLlmcLive(parts: LlmcLiveParts, planTokens = 0): Record<string, unknown> {
  const { observation } = parts;
  if (!observation) return { connected: false, events: parts.events.slice(-EVENTS) };
  const world = (record(observation.state.world) ?? {}) as Record<string, unknown> & LlmCentricWorld;
  const state = stateOf(world, observation);
  parts.trend.note(finite(world.food), finite(world.saturation));
  const food = carriedFood(world, observation.facts), threats = seen(world.nearbyThreats, THREATS, 'threat');
  const preparation = foodPreparation(carriedItemCounts(world, observation.facts), food.points, FOOD_POINTS);
  // r3: why the step is urgent (first) and the hint to look round (beside the stops): counted in the bound, never cut.
  const look = lookHint(world, parts.healthLost ?? 0);
  const bodyFields = () => ({
    ...(parts.urgent?.length ? { urgent: parts.urgent.slice(0, 4) } : {}),
    ...bodyAgeField(parts.bodyAge),
    ...readinessFields(parts),
    ...(parts.facts?.lines.length ? { facts: [...parts.facts.lines] } : {}),
    map: typeof world.localMap === 'string' ? world.localMap : '（地図なし: 体が地図を送っていない。mc_view で見られる）',
    landmarks: landmarkLines(world, observation.facts),
    ...(parts.scan?.length ? { scan: parts.scan.slice(0, 10) } : {}),
    stops: strings(world.recentStops, STOPS),
    ...(look ? { look } : {}),
    state: { ...state, ...('fullness' in state ? { fullnessLostIn5min: parts.trend.lostIn5min() } : {}),
      ...(parts.elapsedMinutes !== null ? { minutes: round1(parts.elapsedMinutes) } : {}) },
    foodPoints: { total: food.points, items: food.items },
    ...(preparation ? { foodPreparation: preparation } : {}),
    inventory: shareStacks(stacks(world.inventory).slice(0, INVENTORY), parts.promises),
    threats,
    near: seen(world.nearbyEntities, OTHERS + THREATS, 'near').filter(line => !taken(threats, line)).slice(0, OTHERS),
    ...(parts.jobs !== undefined ? { jobs: parts.jobs } : {}),
    ...(parts.events.length || parts.once?.length ? { events: [...(parts.once ?? []), ...parts.events.slice(-EVENTS)] } : {}),
  });
  const live: Record<string, unknown> = bodyFields();
  // r3: outside the bound (never cut, at most `LAST_RESULTS_CHARS`): the results shown this once.
  const shown = shownResults(parts.lastResults ?? []);
  // r4: the investigation first (outside the bound: it has its own, `LLMC_PROBE.tokens`). r7 (run 31: stopped by
// its health stop in the
  // blaze's line, the next decision read the surprise first): the urgent lines before it (counted in the bound as
// before, never cut).
  const { urgent, ...rest } = fitLive(live, planTokens, parts);
  return { ...(urgent ? { urgent } : {}), ...(parts.investigation?.length ? { investigation: [...parts.investigation] } : {}), ...rest,
    ...(shown.length ? { lastResults: shown } : {}) };
}

/**
 * r8 (run 32: the decision for a wither skeleton in sight took 10.3 s, 696 tokens of answer): the live state of
 * an urgent decision, short:
 * the urgent lines (and the surprises' facts), the footing, the plan's now by its title, the map, her state, the
 * hostiles, what she holds,
 * the last events and the results shown this once (at most `URGENT_RESULTS_CHARS`), and how to answer
 * (`answer`). No landmarks, stops,
 * scan, food trend, near creatures or jobs: they come back with the next decision that is not urgent.
 */
export const URGENT_RESULTS_CHARS = 2_400;
const URGENT_THREATS = 4, URGENT_STACKS = 14, URGENT_EVENTS = 3;
export function minecraftLlmcUrgentLive(parts: Pick<LlmcLiveParts, 'observation' | 'elapsedMinutes' | 'events' | 'lastResults' | 'urgent' | 'investigation'
  | 'footing' | 'bodyAge' | 'queue' | 'recovery' | 'once' | 'promises'> & { planNowTitle: string | null; mode: string;
     /** The chapter 8 facts of the urgent version (`inputFacts(…, true)`). */ facts?: readonly string[] }): Record<string, unknown> {
  const { observation } = parts, urgent = parts.urgent?.length ? { urgent: parts.urgent.slice(0, 4) } : {};
  if (!observation) return { connected: false, ...urgent, events: parts.events.slice(-URGENT_EVENTS), mode: parts.mode };
  const world = (record(observation.state.world) ?? {}) as Record<string, unknown> & LlmCentricWorld;
  const results = shownResults(parts.lastResults ?? [], URGENT_RESULTS_CHARS), food = carriedFood(world, observation.facts);
  const urgentBodyFields = () => ({ ...urgent, ...bodyAgeField(parts.bodyAge), ...(parts.investigation?.length ? { investigation:
     [...parts.investigation] } : {}),
    ...(parts.planNowTitle ? { planNow: parts.planNowTitle } : {}),
    ...(parts.queue?.length ? { queue: [...parts.queue] } : {}), ...(parts.footing ? { footing: parts.footing } : {}),
    ...(parts.facts?.length ? { facts: [...parts.facts] } : {}),
    map: typeof world.localMap === 'string' ? world.localMap : '（地図なし: 体が地図を送っていない。mc_view で見られる）',
    state: { ...stateOf(world, observation), ...(parts.elapsedMinutes !== null ? { minutes: round1(parts.elapsedMinutes) } : {}) },
    foodPoints: { total: food.points, items: food.items },
    ...(parts.recovery?.length ? { recovery: [...parts.recovery] } : {}),
    threats: seen(world.nearbyThreats, URGENT_THREATS, 'threat'), inventory: shareStacks(shortStacks(world.inventory), parts.promises),
    ...(parts.events.length || parts.once?.length ? { events: [...(parts.once ?? []), ...parts.events.slice(-URGENT_EVENTS)] } : {}), ...(
      results.length ? { lastResults: results } : {}),
    mode: parts.mode });
  return urgentBodyFields();
}

/**
 * GPT's review 2026-10-28 (the urgent live showed the first 14 stacks in the alphabet, with the iron sword of
 * run 43 not among them, and the pack said 使用 14/36
 * while 31 were used): the stacks an urgent decision uses come first (what fights, what is eaten, what walls:
 * `urgentRank`), the rest in their order, cut to
 * `URGENT_STACKS`; the stacks left out are said as a number, in the line the pack's count and the live's other
 * readers take (`ほか N 件（長いため略）`).
 */
const WEAPON_OR_SHIELD = /^(?:shield|bow|crossbow|trident|mace|[a-z_]*(?:sword|axe|spear))$/u;
export function urgentRank(stack: string): number {
  const name = /^[a-z_0-9]+/u.exec(stack)?.[0] ?? '';
  if (WEAPON_OR_SHIELD.test(name)) return 0;
  if (EDIBLE_FOOD.test(name) || name in FOOD_POINTS) return 1;
  if (BLOCKS.test(name)) return 2;
  return 3;
}
export function shortStacks(value: unknown): string[] {
  const all = stacks(value);
  if (all.length <= URGENT_STACKS) return all;
  const shown = all.map((stack, index) => ({ stack, index, rank: urgentRank(stack) })).sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, URGENT_STACKS).sort((a, b) => a.index - b.index).map(item => item.stack);
  return [...shown, `ほか${all.length - URGENT_STACKS}件（長いため略）`];
}

/** The results shown this once, together at most `room` characters (the last one cut). */
function shownResults(results: readonly string[], limit = LAST_RESULTS_CHARS): string[] {
  const shown: string[] = [];
  let room = limit;
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
 * What is cut, in order, until the live body fits (the map is never cut; it comes first): a list kept to its
 * first `keep` lines, or
 * (keep -1) a field left out. The farther creatures go first, the landmarks and the pack last: the furnace seven
 * up and the stone to
 * craft with are what a decision needs most.
 */
const SHRINK: ReadonlyArray<readonly [string, number]> = [['near', 3], ['inventory', 24], ['landmarks', 8], ['near', 0], ['stops', 2], ['foodPreparation', -1],
  ['events', 3], ['threats', 4], ['inventory', 16], ['landmarks', 5], ['foodPoints.items', -1], ['jobs', -1], ['inventory', 10], ['landmarks', 3],
  ['threats', 2], ['stops', 1], ['events', 1],
  // A map of water (three tokens a cell) leaves little beside it: the last of the rest, the plan's path and her state kept.
  ['events', -1], ['near', -1], ['threats', 1], ['inventory', 6], ['landmarks', 2]];

/**
 * The live state when it has to be shortened (chapter 8's table, 「圧縮の後」): the facts in their shortened form (the
 * pack in one line, three food candidates), and the facts said
 * once left out (the table's 「—」: not in this version, so not delivered; they are offered again with the next input).
 */
function shortened(live: Record<string, unknown>, parts: Pick<LlmcLiveParts, 'facts' | 'once'>): Record<string, unknown> {
  const out = { ...live };
  if (parts.facts?.compressed) {
    if (parts.facts.compressed.length) out.facts = [...parts.facts.compressed];
    else delete out.facts;
  }
  const once = parts.once?.length ?? 0;
  if (once && Array.isArray(live.events)) {
    const rest = live.events.slice(once);
    if (rest.length) out.events = rest;
    else delete out.events;
  }
  return out;
}

/** Leaves out the parts that matter least until the live body fits beside the plan. */
function fitLive(input: Record<string, unknown>, planTokens: number, parts: Pick<LlmcLiveParts, 'facts' | 'once'> = {}): Record<string, unknown> {
  const budget = LLMC_LIVE_TOKENS - planTokens;
  const live = llmcLiveTokens(input) > budget ? shortened(input, parts) : input;
  const out: Record<string, unknown> = { ...live };
  for (const [key, keep] of SHRINK) {
    if (llmcLiveTokens(out) <= budget) break;
    if (key === 'foodPoints.items') {
      const food = out.foodPoints as Record<string, unknown> | undefined;
      if (food && 'items' in food) out.foodPoints = Object.fromEntries(Object.entries(food).filter(([name]) => name !== 'items'));
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
