import { LEDGER_LINES } from './minecraftLedgerTypes.js';
import type { LedgerSeen, LedgerBy, LedgerInput, Seen, Relation } from './minecraftLedgerTypes.js';
import type { PlanPromise, PromiseEvent } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActClause, ActCondition } from '../../contracts/minecraftActCondition.js';
import { type InventoryEvent } from '../../contracts/continueContract.js';
import { carried, clauseHolds, clauseLack, conditionHolds, doneFacts, validCondition, type DoneFacts } from './minecraftConditions.js';
import { carriedFood } from './minecraftLlmcLive.js';
import { recipeOf } from './minecraftLlmcRecipes.js';

export const round1 = (value: number) => Math.round(value * 10) / 10;

export const key = (run: { bodyBoot: string; connectionId: string }) => `${run.bodyBoot}/${run.connectionId}`;

export const sumShown = (list: ReadonlyArray<{ shown: number }>) => round1(list.reduce((total, item) => total + item.shown, 0));

/** The reasons the body gives (`InventoryEvent.reason`) as the ledger names them. `ingredient` of a smelt is told
 * by the hand's verb. */
export const REASONS: Readonly<Record<string, string>> = {
  ingredient: 'craft_ingredient',
  fuel: 'smelt_fuel',
  food: 'eat',
  placed: 'place',
  thrown: 'thrown',
  tool_broke: 'tool_broke',
  crafted: 'crafted',
  picked: 'picked',
  mined: 'mined',
  smelted: 'smelted',
  reflex_eat: 'reflex_eat',
  reflex_armor: 'reflex_armor',
  death: 'death',
  unexplained: 'unexplained',
  stored: 'stored',
  retrieved: 'retrieved',
};

/** The reasons of the body's events the ledger names (any other is read as `unexplained`). */
export const LEDGER_REASONS: readonly string[] = Object.keys(REASONS);

export function reasonOf(event: InventoryEvent, by: LedgerBy | undefined, hands?: LedgerInput['hands']): string {
  const reason = event.reason as string;
  return reason === 'ingredient' && (hands?.[event.id] ?? by?.do) === 'smelt' ? 'smelt_ingredient' : (REASONS[reason] ?? 'unexplained');
}

export function seenOf(observation: BodyObservation | null): Seen | null {
  const facts = doneFacts(observation);
  if (!observation || !facts || !Number.isFinite(observation.sequence)) return null;
  const run = observation.state.bodyRun as { bodyBoot?: unknown; connectionId?: unknown } | undefined;
  const life = observation.state.life as { deathEpoch?: unknown; deathSeq?: unknown } | undefined;
  return {
    run: {
      bodyBoot: typeof run?.bodyBoot === 'string' ? run.bodyBoot : '',
      connectionId: typeof run?.connectionId === 'string' ? run.connectionId : '',
    },
    obsSeq: observation.sequence,
    facts,
    frame: observation,
    life: life && typeof life === 'object' ? life : {},
  };
}

/** What she carries of a promise's item in a frame: the food points for `food`, else the count the conditions' `have` reads. */
export const haveIn = (item: string, facts: DoneFacts): number => (item === 'food' ? facts.food : carried(facts.counts, item));

/** The food points of `count` of an item (0 when it is not food: `food` is counted as the live state counts it). */
export const foodOf = (item: string, count: number): number => carriedFood({ inventory: [{ name: item, count: 1 }] }, {}).points * count;

/** The change an event makes to what a promise of `item` counts (in food points for `food`), 0 when it is not that. */
export function deltaFor(item: string, event: InventoryEvent): number {
  if (item === 'food') return round1(foodOf(event.item, event.count));
  return carried(new Map([[event.item, 1]]), item) > 0 ? event.count : 0;
}

export function relationOf(seen: LedgerSeen, now: Seen): Relation {
  const last = seen.lastObs;
  if (!last) return 'newer';
  if (last.bodyBoot === now.run.bodyBoot && last.connectionId === now.run.connectionId)
    return now.obsSeq > last.obsSeq ? 'newer' : now.obsSeq === last.obsSeq ? 'same' : 'older';
  return (seen.connections ?? []).includes(key(now.run)) ? 'older' : 'newer';
}

/**
 * Amendment A-2 3: armour put on (the body's `reflex_armor`: the `equip` of a head, torso, legs or feet slot) is
 * the item going from the pack to the armour slot, not a use. The frame
 * counts what she wears (`carriedItemCounts`: `worn`), so the count of her `have` does not move: the event is
 * told as `moved` and takes nothing off `have`.
 */
export const WORN_REASONS: ReadonlySet<string> = new Set(['reflex_armor']);

export const isWorn = (event: InventoryEvent): boolean => WORN_REASONS.has(event.reason as string);

/** `stored` and `retrieved` (a chest) and putting armour on are the item changing place: told as `moved`, never
 * as consumed or gained. */
export const isMoved = (event: InventoryEvent): boolean => event.reason === 'stored' || event.reason === 'retrieved' || isWorn(event);

/** Where an event came from: the call's `by`, and what its id says (`${command}:${pass}:${hand}:${seq}`) where
 * the call does not. */
export function byOf(by: LedgerBy | undefined, id: string): PromiseEvent['by'] | undefined {
  const { do: _do, ...given } = by ?? {};
  const match = id.startsWith('reflex:') ? null : /^(.+):(\d+):(\d+):\d+$/u.exec(id);
  const value = match ? { command: match[1]!, pass: Number(match[2]), hand: Number(match[3]), ...given } : given;
  return Object.keys(value).length ? value : undefined;
}

/** A promise with lines added to its ledger: the oldest go past 32, and how many went is kept. */
export function appended(promise: PlanPromise, lines: readonly PromiseEvent[]): PlanPromise {
  if (!lines.length) return promise;
  let ledger = [...promise.ledger, ...lines],
    dropped = promise.dropped ?? 0;
  if (ledger.length > LEDGER_LINES) {
    dropped += ledger.length - LEDGER_LINES;
    ledger = ledger.slice(-LEDGER_LINES);
  }
  return { ...promise, ledger, ...(dropped ? { dropped } : {}) };
}

/** Why a promise's period is over: its node is done, or its condition holds (the words for the ledger line), or null. */
export function closedWhy(promise: PlanPromise, now: Seen, nodes: LedgerInput['nodes']): string | null {
  const until = promise.until;
  if (!until) return null;
  if (until.node && nodes?.find((node) => node.id === until.node)?.state === 'done') return `節 ${until.node} が済んだ`;
  if (until.condition && validCondition(until.condition) && conditionHolds(until.condition as ActCondition, now.frame) === true)
    return '期限の条件を満たした';
  return null;
}

/** What the `instead` lacks, in words (the alternative nearest to holding): the clauses the frame shows unmet. */
export function insteadLack(condition: ActCondition, facts: DoneFacts): string | null {
  const rank = (clauses: ActClause[]) => clauses.filter((clause) => clauseHolds(clause, facts) === true).length / clauses.length;
  const best = [...condition].sort((left, right) => rank(right) - rank(left))[0];
  const lacking = (best ?? [])
    .filter((clause) => clauseHolds(clause, facts) === false)
    .map((clause) => (clause.k === 'near' ? `${itemWord(clause.block)}が ${clause.r}m 内に無い` : clauseLack(clause, facts)));
  return lacking.length ? lacking.join('・') : null;
}

// ---- the live state's line
// --------------------------------------------------------------------------------------------------------------
// ------

/** The names of the few items a promise or a condition says in words; any other is said by its id. */
export const WORDS: Readonly<Record<string, string>> = {
  planks: '板',
  food: '食料',
  crafting_table: '作業台',
  furnace: 'かまど',
  chest: 'チェスト',
  bed: 'ベッド',
  coal: '石炭',
  cobblestone: '丸石',
  stick: '棒',
  torch: '松明',
  water_bucket: '水入りバケツ',
  bucket: 'バケツ',
  flint_and_steel: '火打石と打ち金',
  obsidian: '黒曜石',
  shield: '盾',
};

export const itemWord = (item: string): string => WORDS[item] ?? item;

/** Whether a name in the pack is the item of a promise (the same match the conditions use: the name, or a kind
 * ending in it: `spruce_planks` is `planks`). */
export const isItemOf = (name: string, item: string): boolean => name === item || name.endsWith(`_${item}`);

/** Only literal recipe item names and unambiguous product labels, not an inference from a free-form purpose. */
export function purposeProduct(use: string): string | null {
  const literal = use.trim().replace(/(?:用|を作る)$/u, '');
  const aliases: Readonly<Record<string, string>> = {
    火打ち金: 'flint_and_steel',
    火打石と打ち金: 'flint_and_steel',
    作業台: 'crafting_table',
    かまど: 'furnace',
    バケツ: 'bucket',
    盾: 'shield',
    松明: 'torch',
  };
  const item = aliases[literal] ?? literal.replace(/^minecraft:/u, '');
  return recipeOf(item) ? item : null;
}

export function sameHand(left: string, right: string): boolean {
  const hand = (id: string) => /^(.+:\d+:\d+):\d+$/u.exec(id)?.[1];
  const a = hand(left),
    b = hand(right);
  return a !== undefined && a === b;
}
