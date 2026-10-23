/**
 * mb-llmc-cand 10 (SHANNON_MINECRAFT_LLMC_V2, run 37): what the live state says of how a creature stands to her, in one set of words.
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

/** What a dropped item is, `cobblestone×4`; a stack the body did not name is `item`. */
export function itemWords(entity: Rec): string {
  const name = typeof entity.itemName === 'string' && entity.itemName ? entity.itemName.replace(/^minecraft:/u, '') : null;
  const count = typeof entity.itemCount === 'number' && Number.isFinite(entity.itemCount) ? entity.itemCount : null;
  return name ? `${name}×${count ?? 1}` : 'item';
}

const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const IRRELEVANT = new Set(['bat', 'cod', 'salmon', 'tropical_fish', 'pufferfish', 'squid', 'glow_squid', 'axolotl', 'parrot', 'bee', 'tadpole',
  'frog', 'turtle', 'dolphin']);
const VILLAGE_FOLK = new Set(['villager', 'wandering_trader', 'iron_golem']);
/** How far a dropped item, a villager and anything else is worth a line (a pickup reaches a few metres); food animals only when the plan wants food. */
export const NEAR_METERS = Object.freeze({ item: 16, folk: 12, other: 16, food: 24 });
const FOOD_PLAN = /食料|食べ物|食べる|肉|動物|牧場|畑|food/u;

/** Whether the plan (its current node and the next ones) asks for food, which makes the food animals nearby worth a line. */
export const planWantsFood = (planText: string): boolean => FOOD_PLAN.test(planText);

/**
 * Whether a line of `near` (`#id name 12.3m (x,y,z)`) is worth showing: a dropped item within 16 m (not one she threw away herself), a villager within
 * 12 m, a food animal within 24 m when the plan wants food, any other creature within 16 m; never bats, fish and the like.
 */
export function nearWorthy(name: string, distance: number, foodWanted: boolean): boolean {
  const kind = name.replace(/^item .*/u, 'item');
  if (kind === 'item') return distance <= NEAR_METERS.item;
  if (IRRELEVANT.has(kind)) return false;
  if (FOOD_ANIMALS.has(kind)) return foodWanted && distance <= NEAR_METERS.food;
  if (VILLAGE_FOLK.has(kind)) return distance <= NEAR_METERS.folk;
  return distance <= NEAR_METERS.other;
}
