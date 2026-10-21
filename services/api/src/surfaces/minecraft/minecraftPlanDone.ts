import { orderedPlan, type PlanNode, type PlanTree, type PlanUpdate } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carriedItemCounts } from './minecraftItems.js';
import { carriedFood } from './minecraftLlmcLive.js';

/**
 * mb-llmc r5 (run 28: Sonnet never called plan.update; the live state's "now" said 「p1.1 原木を集める」 to the end, 0 of 39 nodes done,
 * while she had an iron pickaxe): a plan node whose `doneWhen` is written as an observation is marked done by the head's code when the
 * body's frame shows it, and the current node moves on (`applyPlanUpdate`'s own rule). The first plan is asked to write it so
 * (`FIRST_PLAN_SYSTEM_R5`), and the seed plan is written so. A `doneWhen` in free words is left to the model, as before.
 *
 * The form (ASCII, no spaces needed): clauses joined by `&` (all), alternatives by `|` (any; `&` binds first).
 * - `have:<item>` or `have:<item>>=<n>`: she carries (or wears) n of it (1 when no count). `<item>` is an id (`stone_pickaxe`) or the end of
 *   ids (`log` is any `*_log`, `bed` any `*_bed`, `bucket` any `*_bucket`); the counts of every id it names are added.
 * - `dim:<the_nether|the_end|overworld>` (`nether`, `end` too): the dimension she is in.
 * - `at:<x>,<y>,<z>` or `at:<x>,<y>,<z>~<r>`: her feet within r blocks of it (4 when not given).
 * - `food>=<n>`: the food she carries, in points (`carriedFood`).
 */
export type DoneClause =
  | { kind: 'have'; item: string; count: number }
  | { kind: 'dim'; dimension: string }
  | { kind: 'at'; x: number; y: number; z: number; r: number }
  | { kind: 'food'; points: number };
/** Alternatives, each a list of clauses that must all hold. */
export type DonePredicate = DoneClause[][];

const DIMENSIONS: Readonly<Record<string, string>> = { nether: 'the_nether', the_nether: 'the_nether', end: 'the_end', the_end: 'the_end',
  overworld: 'overworld' };
const ITEM = /^[a-z][a-z0-9_]{0,63}$/u;
const NUMBER = '-?\\d{1,7}';

function clauseOf(text: string): DoneClause | null {
  const have = /^have:([a-z][a-z0-9_]{0,63})(?:>=(\d{1,5}))?$/u.exec(text);
  if (have) return ITEM.test(have[1]!) ? { kind: 'have', item: have[1]!, count: Math.max(1, Number(have[2] ?? 1)) } : null;
  const dim = /^dim:([a-z_]{1,16})$/u.exec(text);
  if (dim) return DIMENSIONS[dim[1]!] ? { kind: 'dim', dimension: DIMENSIONS[dim[1]!]! } : null;
  const at = new RegExp(`^at:\\(?(${NUMBER}),(${NUMBER}),(${NUMBER})\\)?(?:~(\\d{1,3}))?$`, 'u').exec(text);
  if (at) return { kind: 'at', x: Number(at[1]), y: Number(at[2]), z: Number(at[3]), r: Number(at[4] ?? 4) };
  const food = /^food>=(\d{1,4})$/u.exec(text);
  return food ? { kind: 'food', points: Number(food[1]) } : null;
}

/** The predicate a `doneWhen` is written as, or null when it is not one (free words, or any part that does not read). */
export function parseDoneWhen(text: string | undefined): DonePredicate | null {
  const compact = (text ?? '').replace(/\s+/gu, '').toLowerCase();
  if (!compact || compact.length > 120) return null;
  const alternatives = compact.split('|').map(part => part.split('&').map(clauseOf));
  return alternatives.every(clauses => clauses.length > 0 && clauses.every(clause => clause !== null)) ? alternatives as DonePredicate : null;
}

/** What a predicate is checked against: the frame's counts (worn included), dimension, feet and food points. */
export interface DoneFacts { counts: ReadonlyMap<string, number>; dimension: string | null; feet: { x: number; y: number; z: number } | null;
  food: number }
export function doneFacts(observation: BodyObservation | null): DoneFacts | null {
  const world = observation?.state.world;
  if (!world || typeof world !== 'object' || Array.isArray(world)) return null;
  const frame = world as Record<string, unknown>;
  const at = frame.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  const feet = at && [at.x, at.y, at.z].every(value => typeof value === 'number' && Number.isFinite(value))
    ? { x: at.x as number, y: at.y as number, z: at.z as number } : null;
  const dimension = frame.dimension ?? observation!.facts.dimension;
  return { counts: carriedItemCounts(frame, observation!.facts), feet, food: carriedFood(frame, observation!.facts).points,
    dimension: typeof dimension === 'string' ? dimension.replace(/^minecraft:/u, '') : null };
}

/** How many of `item` she has: the id itself, or every id that ends in `_<item>`. */
function carried(counts: ReadonlyMap<string, number>, item: string): number {
  let total = 0;
  for (const [name, count] of counts) if (name === item || name.endsWith(`_${item}`)) total += count;
  return total;
}
function holds(clause: DoneClause, facts: DoneFacts): boolean {
  switch (clause.kind) {
    case 'have': return carried(facts.counts, clause.item) >= clause.count;
    case 'dim': return facts.dimension === clause.dimension;
    case 'food': return facts.food >= clause.points;
    case 'at': return !!facts.feet && Math.hypot(facts.feet.x - clause.x, facts.feet.y - clause.y, facts.feet.z - clause.z) <= clause.r;
  }
}
export function predicateHolds(predicate: DonePredicate, facts: DoneFacts): boolean {
  return predicate.some(clauses => clauses.every(clause => holds(clause, facts)));
}

/**
 * The nodes the frame shows done: each node not yet done or blocked whose `doneWhen` reads as a predicate that holds, with every node under
 * it that is still open (a done parent leaves nothing under it to do). In the tree's order; empty when none.
 */
export function nodesSeenDone(tree: PlanTree, facts: DoneFacts): string[] {
  const out = new Set<string>();
  const below = (id: string): PlanNode[] => tree.nodes.filter(node => node.parentId === id).flatMap(node => [node, ...below(node.id)]);
  for (const node of orderedPlan(tree.nodes)) {
    if (node.state === 'done' || node.state === 'blocked' || out.has(node.id)) continue;
    const predicate = parseDoneWhen(node.doneWhen);
    if (!predicate || !predicateHolds(predicate, facts)) continue;
    out.add(node.id);
    for (const child of below(node.id)) if (child.state !== 'done' && child.state !== 'blocked') out.add(child.id);
  }
  return orderedPlan(tree.nodes).map(node => node.id).filter(id => out.has(id));
}

/** The update that marks them done (the current node then moves on by itself), or null when the frame shows none. */
export function seenDoneUpdate(tree: PlanTree, observation: BodyObservation | null): { update: PlanUpdate; ids: string[] } | null {
  const facts = doneFacts(observation);
  if (!facts || !tree.nodes.length) return null;
  const ids = nodesSeenDone(tree, facts);
  return ids.length ? { update: { ops: ids.slice(0, 24).map(id => ({ op: 'set' as const, id, state: 'done' as const })) }, ids: ids.slice(0, 24) } : null;
}
