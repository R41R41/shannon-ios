import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActClause, ActCondition } from '../../contracts/minecraftActCondition.js';
import { carriedItemCounts } from './minecraftItems.js';
import { carriedFood, FOOD_POINTS } from './minecraftLlmcLive.js';
import { foodPreparation } from './minecraftFoodPreparation.js';
import { foodPointsWords, type CookingGain } from './minecraftFoodWords.js';
import { crystalsLeft } from './minecraftEndView.js';
import { seenMarks } from './minecraftSeenMarks.js';
import { foodNearOf, villageFoodOf, woodNearFromResources, woodNearOf } from './minecraftStockLevels.js';

export { parseCondition, conditionText, validCondition, parseClause, newerClause, clauseText, CONDITION_SCHEMA, CONDITION_FORMS,
  type ActClause, type ActCondition, type Dim, type ParsedCondition } from '../../contracts/minecraftActCondition.js';

/**
 * The task queue's conditions read on the head's frame (design section 4). `pre` and `done` are checked by the
 * body on the body itself; the
 * head checks the same JSON on the newest frame only where the frame shows it (the pack, health, hunger, the
 * dimension, the place, the time):
 * `furnace` and `safe` need the world around her and are unknown here (null; `near` is told from the body's scan,
 * `state.world.utilities`), and so is anything the frame does not carry. Unknown is
 * never taken for no: a `pre` the head cannot tell is sent, and the body says.
 */

/** What a predicate is checked against: the frame's counts (worn included), dimension, feet and food points, and
 * the facts a frame
 * may lack (null). */
export interface DoneFacts { counts: ReadonlyMap<string, number>; dimension: string | null; feet: { x: number; y: number; z: number } | null;
  food: number; hp?: number | null; hunger?: number | null; free?: number | null; night?: boolean | null;
  /** The body's scan of the utilities around her (`state.world.utilities`, the continue contract chapter 3): what it found within
 * `radius`; null when the frame has none. */
  utilities?: UtilitiesScan | null;
  /** The marks in view now (`see:fortress`, `minecraftSeenMarks.ts`) and the end crystals left (`crystals<=0`); the frame may say neither. */
  seen?: ReadonlySet<string>;
  crystals?: number | null;
  /** The village the landmarks name: its beds (the body's count of beds, not halves), the seconds a round is said to take (null: not said) and its distance. */
  village?: { beds: number; seconds: number | null; distance: number } | null;
  /** The logs and trees the body counted near her (`state.world.woodNear`; null: the frame has none, an older body). */
  woodNear?: { logs: number; trees: number; withinM: number } | null;
  /** The food animals and the village's food the body counted near her (`nearbyResources`); null: the frame has no count. */
  foodNear?: number | null;
  /** The village's food and its hay near her (`nearbyResources`, purpose food_village); null: the frame has no count. */
  foodVillage?: number | null;
  foodHay?: number | null }
/** What the body scanned for a work table, a furnace, a chest or a bed near her: `scanned` false is "not looked",
 * never "none". */
export interface UtilitiesScan { radius: number; dim: string | null; scanned: boolean; found: ReadonlyArray<{ block: string; distance: number }> }
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
/** The body's `state.world.utilities` as the head reads it (the shape of chapter 3), or null when the frame has
 * none or it does not read. */
function utilitiesOf(world: Record<string, unknown>): UtilitiesScan | null {
  const raw = world.utilities;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const scan = raw as Record<string, unknown>, radius = finite(scan.radius);
  if (radius === null || typeof scan.scanned !== 'boolean') return null;
  const found = (Array.isArray(scan.found) ? scan.found : []).flatMap(item => {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null, distance = finite(entry?.distance);
    return entry && typeof entry.block === 'string' && distance !== null ? [{ block: entry.block.replace(/^minecraft:/u, ''), distance }] : [];
  });
  return { radius, dim: typeof scan.dim === 'string' ? scan.dim.replace(/^minecraft:/u, '') : null, scanned: scan.scanned, found };
}
/** Night as a bed counts it (ticks 12542–23459 of an overworld day, or a thunderstorm); null where the frame has
 * no time (the Nether, the End). */
function nightOf(world: Record<string, unknown>, dimension: string | null): boolean | null {
  const tick = finite(world.timeOfDay);
  if (tick === null || (dimension !== null && dimension !== 'overworld')) return null;
  const at = tick % 24_000;
  return (at >= 12_542 && at <= 23_459) || /thunder|雷/u.test(String(world.weather ?? ''));
}
/** The village the body's landmarks name (`B 村 (x,y,z) …ベッド9台、…、一周 約160秒…`): its beds, the seconds a round is said to take and how far it is; null when none reads. */
function villageOf(world: Record<string, unknown>, feet: { x: number; y: number; z: number } | null): DoneFacts['village'] {
  const marks = Array.isArray(world.mapLandmarks) ? world.mapLandmarks : [];
  for (const line of marks) {
    const found = typeof line === 'string' ? /^[A-Z]\s*村\s*\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(line) : null;
    if (!found) continue;
    const beds = /ベッド\s*(\d+)\s*台/u.exec(line as string), seconds = /一周\s*約\s*(\d+)\s*秒/u.exec(line as string);
    if (!beds) return null;
    const [x, y, z] = [Number(found[1]), Number(found[2]), Number(found[3])];
    return { beds: Number(beds[1]), seconds: seconds ? Number(seconds[1]) : null,
      distance: feet ? Math.round(Math.hypot(x - feet.x, y - feet.y, z - feet.z)) : 0 };
  }
  return null;
}
export function doneFacts(observation: BodyObservation | null): DoneFacts | null {
  const world = observation?.state.world;
  if (!world || typeof world !== 'object' || Array.isArray(world)) return null;
  const frame = world as Record<string, unknown>;
  const at = frame.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  const feet = at && [at.x, at.y, at.z].every(value => typeof value === 'number' && Number.isFinite(value))
    ? { x: at.x as number, y: at.y as number, z: at.z as number } : null;
  const dimension = frame.dimension ?? observation!.facts.dimension;
  const dim = typeof dimension === 'string' ? dimension.replace(/^minecraft:/u, '') : null;
  return { counts: carriedItemCounts(frame, observation!.facts), feet, food: carriedFood(frame, observation!.facts).points, dimension: dim,
    hp: finite(frame.health), hunger: finite(frame.food), free: finite(frame.freeSlots), night: nightOf(frame, dim), utilities: utilitiesOf(frame),
    seen: seenMarks(frame), crystals: crystalsLeft(observation), village: villageOf(frame, feet), woodNear: woodNearOf(frame.woodNear) ?? woodNearFromResources(frame.nearbyResources), foodNear: foodNearOf(frame.nearbyResources),
    foodVillage: villageFoodOf(frame.nearbyResources)?.food ?? null, foodHay: villageFoodOf(frame.nearbyResources)?.hay ?? null };
}

/** r9: `gold_armor` stands for any piece of golden armour (the check before the Nether's depth asks for one: a
 * piglin does not attack her in it). */
const GOLD_ARMOUR = /^golden_(?:helmet|chestplate|leggings|boots)$/u;
/**
 * How many of `item` she has: the id itself, or every id that ends in `_<item>`. Crying obsidian is not obsidian (the whole-run audit of 11/4: it
 * is no frame of a portal, and the count of `obsidian` for the gate and the End's fight is of the plain one).
 */
export function carried(counts: ReadonlyMap<string, number>, item: string): number {
  let total = 0;
  for (const [name, count] of counts) {
    if (item === 'obsidian' && name.endsWith('crying_obsidian')) continue;
    if (name === item || name.endsWith(`_${item}`) || (item === 'gold_armor' && GOLD_ARMOUR.test(name))) total += count;
  }
  return total;
}

/**
 * How many of an item she has taken in over the task, for a plan node whose goal is that item: what she carries, and what the work
 * made of it counted back (a blaze rod becomes two powder, a powder with a pearl becomes an eye). Without this, the rods of 「ブレイズロッド 7」
 * that were made into eyes before the seventh came would make the node unmeetable. Any other item is what she carries.
 */
export function acquired(counts: ReadonlyMap<string, number>, item: string): number {
  const own = carried(counts, item);
  if (item === 'blaze_rod') return own + Math.ceil((carried(counts, 'blaze_powder') + carried(counts, 'ender_eye')) / 2);
  return item === 'ender_pearl' ? own + carried(counts, 'ender_eye') : own;
}

type Judge<K extends ActClause['k']> =(clause: Extract<ActClause, { k: K }>, facts: DoneFacts) => boolean | null;
type Judges = { [K in ActClause['k']]: Judge<K> };
const atLeast = (value: number | null | undefined, n: number): boolean | null => value === null || value === undefined ? null : value >= n;
const JUDGES: Judges = {
  have: (c, facts) => c.op === '<' ? carried(facts.counts, c.item) < c.n : carried(facts.counts, c.item) >= c.n,
  food: (c, facts) => facts.food >= c.n,
  hunger: (c, facts) => atLeast(facts.hunger, c.n),
  hp: (c, facts) => atLeast(facts.hp, c.n),
  dim: (c, facts) => facts.dimension === null ? null : facts.dimension === c.dim,
  at: (c, facts) => {
    if (!facts.feet) return null;
    if (c.dim && facts.dimension !== null && facts.dimension !== c.dim) return false;
    return Math.hypot(facts.feet.x - c.x, facts.feet.y - c.y, facts.feet.z - c.z) <= c.r;
  },
  free: (c, facts) => atLeast(facts.free, c.n),
  time: (c, facts) => facts.night === null || facts.night === undefined ? null : facts.night === (c.t === 'night'),
  // The body's scan, only where it looked (`scanned`), looked as far as the clause asks (`radius`), and looked in
// the dimension she is in; else it cannot be told.
  near: (c, facts) => {
    const scan = facts.utilities;
    if (!scan || !scan.scanned || c.r > scan.radius || scan.dim === null || facts.dimension === null || scan.dim !== facts.dimension) return null;
    return scan.found.some(found => found.block === c.block && found.distance <= c.r);
  },
  furnace: () => null,
  safe: () => null,
};
/** Whether the frame shows the clause: true, false, or null when it cannot be told from a frame. */
export function clauseHolds(clause: ActClause, facts: DoneFacts): boolean | null {
  return (JUDGES[clause.k] as Judge<ActClause['k']>)(clause as never, facts);
}

type Lacks = { [K in ActClause['k']]: (clause: Extract<ActClause, { k: K }>, facts: DoneFacts) => string };
const round1 = (value: number) => Math.round(value * 10) / 10;
const LACKS: Lacks = {
  have: (c, facts) => c.op === '<' ? `${c.item} が ${carried(facts.counts, c.item)} 個（${c.n} 未満が条件）`
    : `${c.item} ${Math.min(carried(facts.counts, c.item), c.n)}/${c.n}`,
  food: (c, facts) => foodPointsWords(facts.food, c.n, facts.foodHay, cookingOf(facts.counts)),
  hunger: (c, facts) => `満腹 ${round1(facts.hunger ?? 0)}/${c.n}`,
  hp: (c, facts) => `体力 ${round1(facts.hp ?? 0)}/${c.n}`,
  dim: (c, facts) => `次元は ${c.dim}（今 ${facts.dimension ?? '不明'}）`,
  at: (c, facts) => {
    const dim = c.dim && facts.dimension !== null && facts.dimension !== c.dim ? `、次元は ${c.dim}` : '';
    const far = facts.feet ? Math.round(Math.hypot(facts.feet.x - c.x, facts.feet.y - c.y, facts.feet.z - c.z)) : null;
    return far === null ? `(${c.x},${c.y},${c.z}) までは不明` : `(${c.x},${c.y},${c.z}) から ${far}m（${c.r}m 内が条件${dim}）`;
  },
  free: (c, facts) => `持ち物の空き ${facts.free ?? 0}/${c.n}`,
  time: (c, facts) => `今は${facts.night ? '夜' : '昼'}（${c.t === 'night' ? '夜' : '昼'}が条件）`,
  near: c => `${c.block} が ${c.r}m 内に無い`,
  furnace: c => `かまど (${c.x},${c.y},${c.z}) の焼きはまだ`,
  safe: c => `${c.r}m 内に敵がいる`,
};
/** What a clause the frame shows unmet lacks, in words: `raw_iron 1/3`, `体力 12/15`. */
export function clauseLack(clause: ActClause, facts: DoneFacts): string {
  return (LACKS[clause.k] as (clause: ActClause, facts: DoneFacts) => string)(clause, facts);
}

/**
 * Whether the condition holds on the frame: true when some alternative's clauses all hold, false only when every
 * alternative has a clause the
 * frame shows unmet, else null (a clause the frame cannot show, or no frame).
 */
export function conditionHolds(condition: ActCondition, frame: BodyObservation | null): boolean | null {
  const facts = doneFacts(frame);
  if (!facts) return null;
  const verdicts = condition.map(clauses => clauses.map(clause => clauseHolds(clause, facts)));
  if (verdicts.some(alternative => alternative.every(item => item === true))) return true;
  return verdicts.every(alternative => alternative.some(item => item === false)) ? false : null;
}

/** What is unmet, in words, of the alternative nearest to holding (the clauses the frame shows unmet, joined by
 * `・`); null when there is nothing to say. */
export function conditionWords(condition: ActCondition, frame: BodyObservation | null): string | null {
  const facts = doneFacts(frame);
  if (!facts) return null;
  const rank = (clauses: ActClause[]) => clauses.filter(clause => clauseHolds(clause, facts) === true).length / clauses.length;
  const best = [...condition].sort((a, b) => rank(b) - rank(a))[0];
  const lacking = best?.filter(clause => clauseHolds(clause, facts) === false).map(clause => clauseLack(clause, facts)) ?? [];
  return lacking.length ? lacking.join('・') : null;
}

/**
 * What cooking the raw meat in the pack would add (points and seconds in one furnace), or null when there is none: a fact for the words of a food
 * shortage (`foodPointsWords`), so that the way to fill it names the meat she carries before bread she does not have.
 */
export function cookingOf(counts: ReadonlyMap<string, number>): CookingGain | null {
  const made = foodPreparation(counts, 0, FOOD_POINTS);
  if (!made?.raw.length) return null;
  const gain = made.raw.reduce((sum, item) => sum + item.pointsIfCooked - item.pointsNow, 0);
  return gain > 0 ? { gain: Math.round(gain * 10) / 10, seconds: made.raw.reduce((sum, item) => sum + item.count * 10, 0) } : null;
}
