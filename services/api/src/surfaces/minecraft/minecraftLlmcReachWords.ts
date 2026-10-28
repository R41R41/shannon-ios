import type { PlanKind } from '@shannon/mind';
import { factsIn, hasKind, nearKinds } from './minecraftPlanFacts.js';

/**
 * mb-llmc-cand 10 (mb-llmc v2, run 37): what the live state says of how a creature stands to her, in one set of words.
 * The model's instructions promised, for every hostile, 「見える（射線の中）／見えない…道はある／壁の向こうで届かない」, and the lines of
 * the hostiles that were not urgent carried none of them. The body's frame says it (`reach`: in_sight | path_no_sight | walled | unknown, within
 * 24 m; `canSee` and `canReachMe`, within 16 m, `canReachMe: false` up to 32 m; `shooter`; item entities: `itemName`, `itemCount`,
 * `droppedByMe`); nothing is said where the frame says nothing. Facts only: nothing here decides a hand.
 */
type Rec = Record<string, unknown>;

/** The ways a hostile stands to her, in the words of the live state. */
export const REACH_TEXT = Object.freeze({
  seen: '見える（射線の中）', path: '見えない・道はある（回って来る）', walled: '壁の向こうで届かない', unknown: '道は不明（体が測りきれなかった）',
});
export type ReachKind = keyof typeof REACH_TEXT;
/** The short form of the same, for the one line that folds the far hostiles. */
export const REACH_SHORT: Readonly<Record<ReachKind, string>> = Object.freeze({ seen: '見える', path: '見えない・道はある', walled: '壁の向こう', unknown: '道は不明' });
export const SHOOTER_WORD = '飛び道具';
/** A part of a hostile's line that is one of the reach words (a probe's own reach line wins over the frame's). */
export const isReachWord = (part: string): boolean => /^(?:見える|見えない|壁の向こう)/u.test(part) || part === REACH_TEXT.unknown;

/** The reach of a hostile as its entity says it, or null when the frame says nothing. */
export function reachOf(entity: Rec): ReachKind | null {
  switch (entity.reach) {
    case 'in_sight': return 'seen';
    case 'path_no_sight': return 'path';
    case 'walled': return 'walled';
    case 'unknown': return 'unknown';
    default: break;
  }
  if (entity.canSee === true) return 'seen';
  if (entity.canReachMe === false) return 'walled';
  return entity.canReachMe === true ? 'path' : null;
}
/** The words after a hostile's place: its reach, then 飛び道具 for a kind that hurts from a distance. */
export function reachSuffix(entity: Rec): string {
  const kind = reachOf(entity);
  return [...kind ? [REACH_TEXT[kind]] : [], ...entity.shooter === true ? [SHOOTER_WORD] : []].map(part => `・${part}`).join('');
}

/** What a dropped item is, `cobblestone×4`; empty for a stack the body did not name (the line then says just `item`). */
export function itemWords(entity: Rec): string {
  const name = typeof entity.itemName === 'string' && entity.itemName ? entity.itemName.replace(/^minecraft:/u, '') : null;
  const count = typeof entity.itemCount === 'number' && Number.isFinite(entity.itemCount) ? entity.itemCount : null;
  return name ? `${name}×${count ?? 1}` : '';
}

const FOOD_ANIMALS = new Set(['cow', 'pig', 'chicken', 'rabbit', 'mooshroom']);
const IRRELEVANT = new Set(['bat', 'cod', 'salmon', 'tropical_fish', 'pufferfish', 'squid', 'glow_squid', 'axolotl', 'parrot', 'bee', 'tadpole',
  'frog', 'turtle', 'dolphin']);
/** Fish she can eat (chapter 8: when food is what she is short of they are food candidates, not creatures to leave out; a pufferfish is not food). */
export const FOOD_FISH: ReadonlySet<string> = new Set(['cod', 'salmon', 'tropical_fish']);
const VILLAGE_FOLK = new Set(['villager', 'wandering_trader', 'iron_golem']);
/** How far a dropped item, a villager and anything else is worth a line; food animals and sheep only when the plan needs them. */
export const NEAR_METERS = Object.freeze({ item: 16, folk: 12, tradeFolk: 24, other: 16, food: 24 });
/** The kinds of the plan's nodes that need food animals, sheep (wool for a bed) and villagers (chapter 7: the kind the model wrote, not the plan's words). */
const FOOD_KINDS: ReadonlySet<PlanKind> = new Set<PlanKind>(['food', 'prep_descent']);
const BED_KINDS: ReadonlySet<PlanKind> = new Set<PlanKind>(['bed']);
const VILLAGE_KINDS: ReadonlySet<PlanKind> = new Set<PlanKind>(['village']);
/** Food below this many points is short for the first night's iron (the instructions' stage knowledge: 40〜60 before it). */
const FOOD_SHORT_POINTS = 40;
const FOOD_SHORT_LEVEL = 14;

/** What the situation needs of the creatures nearby: food animals, sheep (wool for beds), villagers to trade with. */
export interface NearNeeds { food: boolean; sheep: boolean; folk: boolean }
const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join(' ') : '';
/**
 * From the body of the live state: food animals when the current node or one of the next is of the kind food, her food level is 14 or less, her food points
 * are below 40, the shortage names food or the recovery says health does not come back; sheep too when a node is of the kind bed or the shortage names a bed;
 * villagers within 24 m (not 12) when a node is of the kind village. The kinds are the body's `planFacts` (none: only the pack and her food decide).
 */
export function nearNeeds(body: Rec): NearNeeds {
  const state = (body.state && typeof body.state === 'object' ? body.state : {}) as Rec;
  const food = (body.foodPoints && typeof body.foodPoints === 'object' ? body.foodPoints : {}) as Rec;
  const level = typeof state.fullness === 'number' ? state.fullness : 20, points = typeof food.total === 'number' ? food.total : Infinity;
  const kinds = nearKinds(factsIn(body)), shortage = text(body.shortage);
  const hungry = level <= FOOD_SHORT_LEVEL || points < FOOD_SHORT_POINTS || /食料/u.test(shortage) || text(body.recovery) !== '';
  const wantsFood = hasKind(kinds, FOOD_KINDS) || hungry;
  return { food: wantsFood, sheep: wantsFood || hasKind(kinds, BED_KINDS) || /ベッド/u.test(shortage), folk: hasKind(kinds, VILLAGE_KINDS) };
}

/**
 * Whether a line of `near` (`#id name 12.3m (x,y,z)`) is worth showing: a dropped item within 16 m, a villager within 12 m (24 m when the plan trades),
 * a food animal within 24 m when she needs food (a sheep also when she needs wool), any other creature within 16 m; never bats, fish and the like.
 */
export function nearWorthy(name: string, distance: number, needs: NearNeeds): boolean {
  const kind = name.replace(/^item .*/u, 'item');
  if (kind === 'item') return distance <= NEAR_METERS.item;
  if (FOOD_FISH.has(kind)) return needs.food && distance <= NEAR_METERS.food;
  if (IRRELEVANT.has(kind)) return false;
  if (FOOD_ANIMALS.has(kind)) return needs.food && distance <= NEAR_METERS.food;
  if (kind === 'sheep') return needs.sheep && distance <= NEAR_METERS.food;
  if (VILLAGE_FOLK.has(kind)) return distance <= (needs.folk ? NEAR_METERS.tradeFolk : NEAR_METERS.folk);
  return distance <= NEAR_METERS.other;
}

/** The kinds that hurt from where they see her (by name: the frame says `shooter` only within 24 m). */
export const SHOOTER_KINDS: ReadonlySet<string> = new Set(['skeleton', 'stray', 'bogged', 'blaze', 'ghast', 'pillager', 'witch', 'breeze', 'shulker',
  'guardian', 'elder_guardian', 'wither', 'ender_dragon']);
/** How far a hostile still gets a line of its own: a shooter 48 m, a creeper or an enderman 32 m, any other `LINE_METERS` (24 m). */
export function lineMeters(name: string): number {
  return SHOOTER_KINDS.has(name) ? 48 : name === 'creeper' || name === 'enderman' ? 32 : 24;
}
