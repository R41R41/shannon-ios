import { orderedPlan, PLAN_LIMITS, type PlanKind, type PlanNode, type PlanTree, type PlanUpdate } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carried, clauseHolds, clauseLack, doneFacts, type DoneFacts } from './minecraftConditions.js';
import { newerClause, type ActClause } from '../../contracts/minecraftActCondition.js';
import { foodPointsWords } from './minecraftFoodWords.js';
import { kindOf } from './minecraftPlanFacts.js';

export { doneFacts, type DoneFacts };

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
 * - `at:<x>,<y>,<z>` or `at:<x>,<y>,<z>~<r>`: her feet within r blocks of it (4 when not given). r9 (run 33: `dim:overworld|at:40,64,96~200`
 *   was seen done while she stood in the Nether at x 250, the Nether's x being the overworld's eighth): a place is in one dimension.
 *   `at:x,y,z~r@nether` (or `@overworld`, `@end`) says which; else the dimension of a `dim:` in the same predicate, else that of the
 *   nearest `dim:` node before it in the plan (`nodesSeenDone`), else none is known and the place alone is compared.
 * - `food>=<n>`: the food she carries, in points (`carriedFood`).
 * - the task queue's forms (`minecraftConditions.ts`): `hp>=<n>`, `hunger>=<n>`, `free>=<n>`, `time:day|night` and `have:<item><<n>`, read on the frame
 *   when it shows them (a frame without the fact leaves the node as it is, never done).
 *
 * r9 (run 33: 3 nodes seen done that were not): a node is done by its own predicate only (or by the model's `plan.update`), never because
 * a parent is. A node that has children still open is done by a predicate of the pack (`have:`, `food>=`: what the work made is in hand),
 * never by a predicate of a place or a dimension (`dim:`, `at:`: true on arriving, before the work under it is done).
 */
export type DoneClause =
  | { kind: 'have'; item: string; count: number }
  | { kind: 'dim'; dimension: string }
  | { kind: 'at'; x: number; y: number; z: number; r: number; dimension?: string }
  | { kind: 'food'; points: number }
  /** A clause of the task queue's forms (`hp`, `hunger`, `free`, `time`, `have` with `<`), judged as the queue's conditions are. */
  | { kind: 'act'; clause: ActClause };
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
  const at = new RegExp(`^at:\\(?(${NUMBER}),(${NUMBER}),(${NUMBER})\\)?(?:~(\\d{1,3}))?(?:@([a-z_]{1,16}))?$`, 'u').exec(text);
  if (at) {
    const where = at[5] === undefined ? undefined : DIMENSIONS[at[5]];
    if (at[5] !== undefined && !where) return null;
    return { kind: 'at', x: Number(at[1]), y: Number(at[2]), z: Number(at[3]), r: Number(at[4] ?? 4), ...(where ? { dimension: where } : {}) };
  }
  const food = /^food>=(\d{1,4})$/u.exec(text);
  if (food) return { kind: 'food', points: Number(food[1]) };
  const newer = newerClause(text);
  return newer ? { kind: 'act', clause: newer } : null;
}

/** The one dimension a predicate's `dim:` clauses name, or null (none, or more than one). */
export function predicateDimension(predicate: DonePredicate): string | null {
  const dimensions = new Set(predicate.flatMap(clauses => clauses.flatMap(clause => clause.kind === 'dim' ? [clause.dimension] : [])));
  return dimensions.size === 1 ? [...dimensions][0]! : null;
}
/** The predicate with each place that names no dimension given `fallback` (the predicate's own `dim:` first, else `fallback`), or as it is. */
function withPlaces(predicate: DonePredicate, fallback: string | null): DonePredicate {
  const own = predicateDimension(predicate) ?? fallback;
  if (!own) return predicate;
  return predicate.map(clauses => clauses.map(clause => clause.kind === 'at' && !clause.dimension ? { ...clause, dimension: own } : clause));
}

/** The predicate a `doneWhen` is written as, or null when it is not one (free words, or any part that does not read). */
export function parseDoneWhen(text: string | undefined): DonePredicate | null {
  const compact = (text ?? '').replace(/\s+/gu, '').toLowerCase();
  if (!compact || compact.length > 120) return null;
  const alternatives = compact.split('|').map(part => part.split('&').map(clauseOf));
  return alternatives.every(clauses => clauses.length > 0 && clauses.every(clause => clause !== null))
    ? withPlaces(alternatives as DonePredicate, null) : null;
}

/**
 * run 26 (2026-10-26: Opus's p1 `have:log>=8` never held, since the logs went into planks, a table and a pickaxe as they came (5 at most at once), and the
 * plan's now said 原木を集める 未: log 0/8 for 471 s): what is made of the materials that are used up as they are gathered. A `have:` of such a material
 * (a count the work could need: `MADE_FROM_UP_TO`) also holds when she carries what it was made into, which does not go back the way the material does.
 * A bigger count (`have:cobblestone>=64`, blocks to stand on) is a stock, and is only the pack's.
 */
const TOOL = (kind: string) => new RegExp(`^(?:wooden|stone|golden|iron|diamond|netherite)_${kind}$`, 'u');
const MADE_INTO: ReadonlyArray<{ material: RegExp; into: RegExp; upTo: number; together?: readonly RegExp[] }> = [
  // Run 39 (2026-10-26: p1.1 `have:log>=8|have:wooden_pickaxe` was done at 3 logs the moment the pickaxe was made, and no axe was made): the wood of the
  // table, the pickaxe and the axe is used up, so it is made into once she carries both a pickaxe and an axe (or an iron pickaxe, past the wood's tools);
  // a wooden pickaxe alone is not that much.
  { material: /^(?:log|planks|stick)$/u, upTo: 24, together: [TOOL('pickaxe'), TOOL('axe')],
    into: /^(?:shield|chest|[a-z]+_bed|(?:iron|diamond|netherite)_pickaxe)$/u },
  { material: /^cobblestone$/u, upTo: 8, into: /^(?:furnace|(?:stone|iron|diamond|netherite)_(?:pickaxe|axe|shovel|hoe|sword))$/u },
];
function madeInto(counts: ReadonlyMap<string, number>, clause: Extract<DoneClause, { kind: 'have' }>): boolean {
  const rule = MADE_INTO.find(item => item.material.test(clause.item) && clause.count <= item.upTo);
  const has = (pattern: RegExp) => [...counts].some(([name, count]) => count > 0 && pattern.test(name));
  return !!rule && (has(rule.into) || (!!rule.together && rule.together.every(has)));
}
function holds(clause: DoneClause, facts: DoneFacts): boolean {
  switch (clause.kind) {
    case 'have': return carried(facts.counts, clause.item) >= clause.count || madeInto(facts.counts, clause);
    case 'dim': return facts.dimension === clause.dimension;
    case 'food': return facts.food >= clause.points;
    case 'act': return clauseHolds(clause.clause, facts) === true;
    case 'at': return !!facts.feet && (!clause.dimension || facts.dimension === null || facts.dimension === clause.dimension)
      && Math.hypot(facts.feet.x - clause.x, facts.feet.y - clause.y, facts.feet.z - clause.z) <= clause.r;
  }
}
/** The alternative with the most of its clauses holding. */
function bestAlternative(predicate: DonePredicate, facts: DoneFacts): DoneClause[] {
  const share = (clauses: DoneClause[]) => clauses.filter(clause => holds(clause, facts)).length / clauses.length;
  return [...predicate].sort((a, b) => share(b) - share(a))[0]!;
}
export function predicateHolds(predicate: DonePredicate, facts: DoneFacts): boolean {
  return predicate.some(clauses => clauses.every(clause => holds(clause, facts)));
}
/** A clause as the status says it: `iron_leggings 0/1`, `食料 32/40 点`, `次元 the_nether`, `(10,64,5) から 12m`. */
function clauseWords(clause: DoneClause, facts: DoneFacts): string {
  switch (clause.kind) {
    case 'have': return `${clause.item} ${Math.min(carried(facts.counts, clause.item), clause.count)}/${clause.count}`;
    case 'act': return clauseLack(clause.clause, facts);
    case 'food': return foodPointsWords(facts.food, clause.points);
    case 'dim': return `次元 ${clause.dimension}（今 ${facts.dimension ?? '不明'}）`;
    case 'at': return facts.feet ? `(${clause.x},${clause.y},${clause.z}) から ${Math.round(Math.hypot(facts.feet.x - clause.x, facts.feet.y - clause.y,
      facts.feet.z - clause.z))}m（${clause.r}m 内で済む）` : `(${clause.x},${clause.y},${clause.z}) までは不明`;
  }
}
/**
 * Notion 09-1c 2-5 (the current node's done-condition read beside it): how far the frame meets a `doneWhen`, from the observation alone. 「満たしている」;
 * 「未: iron_leggings 0/1・iron_helmet 0/1」 (the alternative with the most clauses holding, its missing ones); 「観測では確かめられない」 for free words; null
 * with no frame (unknown, not unmet).
 */
export function doneStatusWords(doneWhen: string | undefined, facts: DoneFacts | null): string | null {
  if (!doneWhen?.trim()) return null;
  const predicate = parseDoneWhen(doneWhen);
  if (!predicate) return '観測では確かめられない（済んだら set state=done）';
  if (!facts) return null;
  if (predicateHolds(predicate, facts)) return '満たしている';
  return `未: ${bestAlternative(predicate, facts).filter(clause => !holds(clause, facts)).map(clause => clauseWords(clause, facts)).join('・')}`;
}
/** Whether the alternative of the predicate that holds says only what the pack holds (`have:`, `food>=`): what the work made is in hand. */
function holdsByThePack(predicate: DonePredicate, facts: DoneFacts): boolean {
  const alternative = predicate.find(clauses => clauses.every(clause => holds(clause, facts)));
  const pack = (clause: DoneClause) => clause.kind === 'have' || clause.kind === 'food' || (clause.kind === 'act' && clause.clause.k === 'have');
  return !!alternative && alternative.every(pack);
}

/** What she wears and carries to use again, which the work does not use up: a pickaxe, a sword, armour, a shield. */
const GEAR = /^(?:(?:[a-z]+_)?(?:helmet|chestplate|leggings|boots|shield|sword|pickaxe|axe|shovel|hoe|bucket)|flint_and_steel|shears|fishing_rod|brush)$/u;
/**
 * run 39 (2026-10-26: p3 `have:iron_chestplate&have:iron_pickaxe` was seen done with the pickaxe and the chestplate, and p3.3 (a shield) and p3.4 (the helmet,
 * the legs) closed with it; the legs and the shield were never made): whether a node's own predicate is unmet for want of gear only. Such a child holds its
 * parent open, so the plan's next open node is that child and not the node after the parent.
 */
function unmetGear(predicate: DonePredicate | undefined, facts: DoneFacts): boolean {
  if (!predicate || predicateHolds(predicate, facts)) return false;
  const unmet = bestAlternative(predicate, facts).filter(clause => !holds(clause, facts));
  return unmet.length > 0 && unmet.every(clause => clause.kind === 'have' && GEAR.test(clause.item));
}

/** Each node's predicate, its places given the dimension of the nearest `dim:` node before it (itself first) when they name none. */
export function predicatesOf(tree: PlanTree): Map<string, DonePredicate> {
  const out = new Map<string, DonePredicate>();
  let near: string | null = null;
  for (const node of orderedPlan(tree.nodes)) {
    const own = parseDoneWhen(node.doneWhen);
    if (own) out.set(node.id, withPlaces(own, near));
    near = (own ? predicateDimension(own) : null) ?? near;
  }
  return out;
}

/**
 * The nodes the frame shows done: each node not yet done or blocked whose `doneWhen` reads as a predicate that holds. r9 (run 33: p2 `dim:the_nether`
 * was true at the start and closed p2.3 `have:blaze_rod>=7` with 0 rods; p4 `dim:overworld` was true after the respawn and closed the three
 * steps of throwing the eyes; both parents' children were closed with them): a node is done by its own predicate and never because a parent
 * is, a parent whose children are still open is done by the pack alone (`holdsByThePack`), and a place is checked in its dimension. A
 * parent done by the pack leaves its open children as they are (the plan's own rule: nothing under a done node is picked as the next).
 * In the tree's order; empty when none.
 */
export function nodesSeenDone(tree: PlanTree, facts: DoneFacts, inOrder = false): string[] {
  const out = new Set<string>(), predicates = predicatesOf(tree);
  const open = (node: PlanNode) => node.state !== 'done' && node.state !== 'blocked' && !out.has(node.id);
  // Deepest first: a parent is judged after its children, so that a child its own predicate closed does not hold it open.
  for (const node of orderedPlan(tree.nodes).reverse()) {
    if (node.state === 'done' || node.state === 'blocked') continue;
    const predicate = predicates.get(node.id);
    if (!predicate || !predicateHolds(predicate, facts)) continue;
    const kids = tree.nodes.filter(child => child.parentId === node.id && open(child));
    if (kids.length && !holdsByThePack(predicate, facts)) continue;
    if (kids.some(child => unmetGear(predicates.get(child.id), facts))) continue;
    out.add(node.id);
  }
  const ids = orderedPlan(tree.nodes).map(node => node.id).filter(id => out.has(id));
  return inOrder ? afterEarlier(tree, ids, predicates, facts) : ids;
}

/**
 * mb-llmc v2 (run 35: p2 `at:310,66,74~10@nether` was closed at the start, in the overworld, while p1 was open; p5 `dim:overworld` was closed on the
 * food trip while p3 was pending): a node a place or a dimension shows done is closed only when every node before it in the plan (but its own
 * ancestors) is done, blocked or closed in this pass: the place is passed through on the way to work not yet done. What the pack shows
 * (`have:`, `food>=`) is closed whenever it is true, as before.
 */
function afterEarlier(tree: PlanTree, seen: string[], predicates: Map<string, DonePredicate>, facts: DoneFacts): string[] {
  const order = orderedPlan(tree.nodes), byId = new Map(order.map(node => [node.id, node] as const));
  const closed = new Set<string>();
  const ancestors = (node: PlanNode): Set<string> => {
    const out = new Set<string>();
    for (let up = byId.get(node.parentId ?? ''); up && !out.has(up.id); up = byId.get(up.parentId ?? '')) out.add(up.id);
    return out;
  };
  const open = (other: PlanNode) => other.state !== 'done' && other.state !== 'blocked' && !closed.has(other.id);
  for (const node of order) {
    if (node.state === 'done' || node.state === 'blocked') continue;
    if (!seen.includes(node.id)) continue;
    const byPack = holdsByThePack(predicates.get(node.id)!, facts);
    const mine = ancestors(node);
    const earlier = order.slice(0, order.indexOf(node)).some(other => !mine.has(other.id) && open(other));
    if (byPack || !earlier) closed.add(node.id);
  }
  return seen.filter(id => closed.has(id));
}

/**
 * The nodes whose predicate holds while a child of theirs is still open and the predicate is of a place or a dimension (so the node is not
 * done): `p2 [dim:the_nether] ← p2.1・p2.3`, for the log only, once per change of the set.
 */
export function nodesHeldOpen(tree: PlanTree, facts: DoneFacts, inOrder = false): Array<{ id: string; open: string[] }> {
  const predicates = predicatesOf(tree), done = new Set(nodesSeenDone(tree, facts, inOrder));
  return orderedPlan(tree.nodes).flatMap(node => {
    const predicate = predicates.get(node.id);
    if (!predicate || node.state === 'done' || node.state === 'blocked' || done.has(node.id) || !predicateHolds(predicate, facts)) return [];
    const open = tree.nodes.filter(child => child.parentId === node.id && child.state !== 'done' && child.state !== 'blocked' && !done.has(child.id));
    return open.length ? [{ id: node.id, open: open.map(child => child.id) }] : [];
  });
}

export interface SeenDone { update: PlanUpdate; ids: string[]; held?: string[]; closed?: string[] }

/**
 * A plan node for the preparation before the descent: its kind is `prep_descent` (chapter 7: the kind the model wrote; no title or condition decides it).
 * The meter's preparation milestone points at it.
 */
export const isPrepMilestoneNode = (node: Pick<PlanNode, 'kind'>): boolean => kindOf(node) === 'prep_descent';
/**
 * The preparation before the descent has three ends (GPT's review 2026-10-28: 「済ませた」 and 「省いて下りた」 were both `done`): met, skipped (she went down
 * with it unmet and the model wrote `prep: skipped`), and not to be met now (`unmet_now`, written by the model too). Only the first is a milestone reached.
 * The code writes none of the words (chapter 7); it reads them, and says the fact when she goes down with the node unmet (`prepUnmetFacts`).
 */
export const PREP_SKIPPED = '準備を省いた';
export const prepSkipped = (node: Pick<PlanNode, 'prep'>): boolean => node.prep?.state === 'skipped';
/** The preparation that the model said is not to be met now (written by it: `prep: unmet_now`). */
export const prepUnmetNow = (node: Pick<PlanNode, 'prep'>): boolean => node.prep?.state === 'unmet_now';
/** What she has of the preparation's three things: the food points, the table, the planks (the meter's "now" and the fact of a descent). */
export const prepNowWords = (facts: DoneFacts): string =>
  `${foodPointsWords(facts.food, 40)}・作業台 ${carried(facts.counts, 'crafting_table') > 0 ? '有' : '無'}・板 ${carried(facts.counts, 'planks')}`;
/** Whether the frame meets the preparation before the descent: 40 food points and a table or 4 planks (the meter's milestone). */
export const prepHolds = (facts: DoneFacts): boolean => facts.food >= 40 && (carried(facts.counts, 'crafting_table') > 0 || carried(facts.counts, 'planks') >= 4);
/** What of the preparation is missing, as the fact says it (「食料 17.6 点・作業台 無・板 0」), or null when it is met. */
function prepLack(facts: DoneFacts): string | null {
  const food = facts.food < 40 ? [`食料 ${Math.round(facts.food * 10) / 10} 点`] : [];
  const table = carried(facts.counts, 'crafting_table') > 0 || carried(facts.counts, 'planks') >= 4 ? [] : [`作業台 無・板 ${carried(facts.counts, 'planks')}`];
  return [...food, ...table].join('・') || null;
}
/** The kinds of the work down there (the iron and what comes after it): the preparation before the descent comes before the first node of one. */
const UNDERGROUND_KINDS: ReadonlySet<PlanKind> = new Set<PlanKind>(['iron', 'iron_armor', 'diamond', 'obsidian', 'nether']);
/** Below this y in the overworld the body is underground (the descent's own line, `minecraftLlmcReadiness.ts`). */
export const DESCENT_SURFACE_Y = 45;
/** Whether the body has gone down from the surface: underground in the overworld, or in the Nether or the End. */
export function belowTheSurface(facts: DoneFacts): boolean {
  const dimension = facts.dimension ?? 'overworld';
  if (dimension === 'the_nether' || dimension === 'the_end') return true;
  return dimension === 'overworld' && facts.feet !== null && facts.feet.y < DESCENT_SURFACE_Y;
}
/** Underground in the overworld: where a preparation before the descent cannot be filled any more (the Nether and the End have their own). */
export const undergroundInOverworld = (facts: DoneFacts): boolean => belowTheSurface(facts) && (facts.dimension ?? 'overworld') === 'overworld';
/** A fact for the model that the head says once (`minecraftLlmcOnceFacts.ts`): its key (one per fact) and its words. */
export interface OnceFactDraft { key: string; text: string }
/**
 * Run 44 (p2.2 「箱と畑で食料」 `food>=40`, the now from +154 for about 609 s) and run 43 (p3 「食料40点と下る準備」, 2,126 s): a node of the preparation before the
 * descent is for being met before going down; down there her food points only go down, so its condition can no longer be met, the node held the now and the
 * meter's 「地下の準備 … 遅れ」 stayed. The code closed it and wrote 「準備を省いた」 in its note (the old `descentClosed`). The continue contract (chapter 7, the plan's
 * kinds): the head does not decide that a preparation is skipped. Once she is below the surface with such a node (kind `prep_descent`, before the first node
 * of the work down there, still open, and with no `prep` written on it) the head says the fact, once: 「準備の節 p3（…）は満たしていない（食料 17.6 点）が、y=16 まで
 * 下りている」. Whether to write `prep: skipped`, to go back or to go on is the model's (`plan.update`); the node's state is not touched. Never a blocked node.
 * An unmet node it cannot judge (a condition in free words that is not the standard one) is told only when the standard preparation is unmet.
 */
export function prepUnmetFacts(tree: PlanTree, facts: DoneFacts): OnceFactDraft[] {
  if (!belowTheSurface(facts)) return [];
  const order = orderedPlan(tree.nodes), down = order.findIndex(node => UNDERGROUND_KINDS.has(kindOf(node)));
  if (down < 0) return [];
  const seen = nodesSeenDone(tree, facts, true);
  const where = (facts.dimension ?? 'overworld') === 'overworld' && facts.feet ? `y=${Math.round(facts.feet.y)}` : String(facts.dimension);
  return order.slice(0, down).flatMap(node => {
    if (node.state === 'done' || node.state === 'blocked' || seen.includes(node.id) || !isPrepMilestoneNode(node) || node.prep !== undefined) return [];
    const parsed = parseDoneWhen(node.doneWhen);
    const lack = parsed ? doneStatusWords(node.doneWhen, facts)?.replace(/^未: /u, '') ?? null : prepLack(facts);
    if (!lack || (parsed && predicateHolds(parsed, facts))) return [];
    const need = node.doneWhen ? `済む条件: ${node.doneWhen}` : '食料 40・作業台か板 4';
    return [{ key: `prep_unmet:${node.id}`, text: `準備の節 ${node.id}（${need}）は満たしていない（${lack}）が、${where} まで下りている` }];
  });
}

/**
 * mb-llmc v2 (run 36, task 40bd0b3e: p1 `have:bed>=3` was seen done at 104 s with 「村の箱を開ける」「鍛冶屋の箱を開ける」 open, p4
 * `have:iron_ingot>=24|have:iron_chestplate` with 「洞窟で鉄鉱石を掘る」「鉄を焼く」 open: a parent done by the pack leaves its children
 * `continue` for good, and the plan shows work to do under a node that is done): a node open under one that is done (or seen done in this pass) is
 * not needed any more, and is closed as done with the reason in its note. Its nearest done ancestor is named. Never a blocked node.
 */
export function closedUnder(tree: PlanTree, seen: readonly string[]): Array<{ id: string; by: string; note: string }> {
  const byId = new Map(tree.nodes.map(node => [node.id, node] as const));
  const done = new Set([...tree.nodes.filter(node => node.state === 'done').map(node => node.id), ...seen]);
  const out: Array<{ id: string; by: string; note: string }> = [];
  for (const node of orderedPlan(tree.nodes)) {
    if (done.has(node.id) || node.state === 'blocked') continue;
    let by: PlanNode | undefined;
    for (let up = byId.get(node.parentId ?? ''); up && !by; up = byId.get(up.parentId ?? '')) if (done.has(up.id)) by = up;
    if (!by) continue;
    const why = `不要になった（${by.id} が済んだ${by.doneWhen ? `: ${by.doneWhen}` : ''}）`;
    out.push({ id: node.id, by: by.id, note: (node.note ? `${why} ${node.note}` : why).slice(0, PLAN_LIMITS.text) });
  }
  return out;
}
/**
 * The update that marks them done (the current node then moves on by itself), or null when the frame shows none. r9: `held` names the
 * nodes whose place or dimension holds while a child is open (`p2←p2.1,p2.3`), for the log; with no node done and some held, the update is empty.
 */
export function seenDoneUpdate(tree: PlanTree, observation: BodyObservation | null): SeenDone | null {
  const facts = doneFacts(observation);
  if (!facts || !tree.nodes.length) return null;
  const seen = nodesSeenDone(tree, facts, true).slice(0, 24);
  // The preparation before the descent is not closed here (chapter 7): the head says the fact once (`prepUnmetFacts`) and the model decides.
  const under = closedUnder(tree, seen);
  const held = nodesHeldOpen(tree, facts, true).slice(0, 6).map(item => `${item.id}←${item.open.slice(0, 4).join(',')}`);
  if (!seen.length && !under.length && !held.length) return null;
  const ops = [...seen.map(id => ({ op: 'set' as const, id, state: 'done' as const })),
    ...under.map(item => ({ op: 'set' as const, id: item.id, state: 'done' as const, note: item.note }))].slice(0, PLAN_LIMITS.ops);
  return { update: { ops }, ids: [...seen, ...under.map(item => item.id)].slice(0, PLAN_LIMITS.ops),
    ...(held.length ? { held } : {}), ...(under.length ? { closed: under.map(item => `${item.id}←${item.by}`).slice(0, 8) } : {}) };
}

/** Run 42: the chest nodes an opened chest closes (`chestNodesDone`), after the nodes the frame shows done (each id once, within the ops' bound). */
export function withChestsDone(seen: SeenDone | null, chests: { update: PlanUpdate; ids: readonly string[] } | null): SeenDone | null {
  if (!chests?.ids.length) return seen;
  const ids = chests.ids.filter(id => !seen?.ids.includes(id));
  if (!ids.length) return seen;
  const ops = [...(seen?.update.ops ?? []), ...(chests.update.ops ?? []).filter(op => 'id' in op && ids.includes(String(op.id)))].slice(0, PLAN_LIMITS.ops);
  return { ...(seen ?? {}), update: { ...(seen?.update ?? {}), ops }, ids: [...(seen?.ids ?? []), ...ids].slice(0, PLAN_LIMITS.ops) };
}
