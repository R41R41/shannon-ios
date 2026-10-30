import { orderedPlan, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { doneFacts, isPrepMilestoneNode, parseDoneWhen, predicateHolds, prepHolds, prepNowWords, prepSkipped, PREP_SKIPPED, prepUnmetNow, undergroundInOverworld,
  type DoneFacts } from './minecraftPlanDone.js';
import { kindOf } from './minecraftPlanFacts.js';

/**
 * mb-llmc v2 (mb-llmc-cand 11, chapter 4 A: the goal's yardstick and the stage road): for a task that goes for the dragon, two lines of the live
 * state that the code makes from facts, never the model: `road`, the plan's top-level nodes in their order with what is done and where she is
 * (「準備✓ 鉄✓ ダイヤ◀今 → 黒曜石 → ゲート → ネザー…」), and `meter`, the seconds since the task began against the owner's targets for the route's milestones
 * (「今 812 秒・次の節目 ダイヤのツルハシ 目安 1,000 秒（あと 188 秒）」). A milestone is reached when its done-condition holds in the frame (`doneWhen`, the plan's own
 * predicates: `minecraftPlanDone.ts`). Both are absent for a task that is not after the dragon. The targets are the owner's (2026-10-24); the
 * instructions say the same numbers (`milestoneWords`), from this one constant. They measure; they decide no hand.
 */
export interface Milestone {
  name: string; seconds: number; doneWhen: string;
  /** The name in the instructions' list of targets, when the meter's own is longer. */
  short?: string;
  /** Passed over, it is still said while a plan node for it is open (the pack's item stays, so is kept; the food and the table are used, but a node open says it is not met). */
  kept?: boolean;
  /** Run 41: the plan's node for it, beside its own condition (a node open that names it points the meter at it; one done holds it reached). */
  node?: (node: PlanNode) => boolean;
  /**
   * A word beside the milestone while it is the one pointed at or passed over (a fact). The meter says no cost and no order: the rule and its
   * reason are in the instructions' 「準備の決まり」.
   */
  cost?: string;
  /**
   * Whether the frame meets it, for a milestone whose condition the plan's predicates read wrongly (`have:planks>=4` also holds once a bed is carried, which the planks were
   * made into; the preparation asks for the planks themselves). Absent: the `doneWhen` is read.
   */
  holds?: (facts: DoneFacts) => boolean;
  /** What the frame has of it now (「食料 0/40 点・作業台 無・板 2」), said beside it while it is not reached. */
  now?: (facts: DoneFacts) => string;
}
/**
 * Run 41 (2026-10-27: she went down with no food hunted and no table, stood 372 s with no table and died on the way up; the meter had a target and the seconds
 * left for the speed's milestones only, so the preparation looked like one condition among others): the preparation before the descent is a milestone of the
 * meter like the speed's, with its target and its seconds behind. Its target is inside the iron pickaxe's 250 s, which the descent begins after.
 */
export const PREP_MILESTONE_NAME = '地下の準備（食料 40 点・作業台か板 4）';
/** A plan node for the preparation before the descent (the kind `prep_descent`, `minecraftPlanDone.ts`, where the fact of a descent without it is made). */
export { isPrepMilestoneNode } from './minecraftPlanDone.js';
const prepNow = prepNowWords;
export const DRAGON_MILESTONES: readonly Milestone[] = Object.freeze([
  { name: 'ベッド', seconds: 150, doneWhen: 'have:bed' },
  // 300 s: the quickest preparation of runs 39-41 (run 40: two village chests, 39.6 points at +298; the table or planks 4 at +45 to +94).
  { name: PREP_MILESTONE_NAME, seconds: 300, doneWhen: 'food>=40&have:crafting_table|food>=40&have:planks>=4', short: '地下の準備', kept: true, holds: prepHolds,
    node: isPrepMilestoneNode, now: prepNow },
  // 350 s, after the preparation (it was 250, before a preparation that takes 300): run 38 had it at +342 from a village chest.
  { name: '鉄のツルハシ', seconds: 350, doneWhen: 'have:iron_pickaxe' },
  { name: 'バケツ', seconds: 600, doneWhen: 'have:bucket' },
  { name: 'ダイヤのツルハシ', seconds: 1_000, doneWhen: 'have:diamond_pickaxe' },
  { name: '水バケツ', seconds: 1_000, doneWhen: 'have:water_bucket' },
  { name: '黒曜石 10 個', seconds: 1_500, doneWhen: 'have:obsidian>=10' },
  { name: 'ネザー', seconds: 1_800, doneWhen: 'dim:the_nether' },
]);
/** The milestones whose item stays in the pack (a bed, the pickaxes, the bucket): one passed over is still to do. */
const KEPT_MILESTONES: ReadonlySet<string> = new Set(['have:bed', 'have:iron_pickaxe', 'have:bucket', 'have:diamond_pickaxe']);
const isKept = (item: Milestone): boolean => item.kept === true || KEPT_MILESTONES.has(item.doneWhen);
const grouped = (seconds: number): string => seconds.toLocaleString('en-US');
/** The targets as the instructions say them: 「ベッド 150・地下の準備 300・鉄のツルハシ 350・…・ネザー 1,800」. */
export const milestoneWords = (): string => DRAGON_MILESTONES.map(item => `${item.short ?? item.name} ${grouped(item.seconds)}`).join('・');

/** Whether the plan is the dragon's: a node of it has the kind `dragon` (chapter 7: the kind the model wrote, not the title's words; the seeded plan's last node, 「エンドでドラゴン」). */
export const isDragonPlan = (tree: PlanTree | null | undefined): boolean => !!tree && tree.nodes.some(node => kindOf(node) === 'dragon');

const SHOWN_AFTER = 5, SHOWN_DONE = 3;
const MARKS: Readonly<Record<string, string>> = { blocked: '（止）', done: '✓' };
/** Run 41: a node before the one she is in that is neither done nor blocked (the preparation was passed over and vanished from the road without a mark). */
const SKIPPED_MARK = '（未・飛ばした）';
const label = (node: PlanNode): string => node.title.replace(/[（(].*$/u, '').trim().slice(0, 12) || node.id;
/** The top-level node the current node is under (or is). */
function topOf(tree: PlanTree): string | null {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  let at = tree.current ? byId.get(tree.current) : undefined;
  while (at?.parentId) at = byId.get(at.parentId);
  return at?.id ?? null;
}
/**
 * `body.road`: the top-level nodes in order, the last few done ones with ✓, the one she is in with ◀今, the next five, and how many are left; a blocked one
 * with 止. Run 41: a node before the one she is in that is still open stays on the road with 「（未・飛ばした）」 (it does not count in 「済み n 節」).
 * Null when the plan is not the dragon's.
 */
export function roadLine(tree: PlanTree | null | undefined): string | null {
  if (!tree || !isDragonPlan(tree)) return null;
  const top = orderedPlan(tree.nodes).filter(node => node.parentId === null), current = topOf(tree);
  const here = Math.max(0, top.findIndex(node => node.id === current));
  const passed = top.slice(0, here), settled = passed.filter(node => node.state === 'done' || node.state === 'blocked'), open = top.slice(here);
  const kept = new Set(settled.slice(-SHOWN_DONE).map(node => node.id));
  const early = settled.length > SHOWN_DONE ? `済み ${settled.length - SHOWN_DONE} 節 ` : '';
  const mark = (node: PlanNode, index: number): string => index === 0 && current ? '◀今' : MARKS[node.state] ?? '';
  const shown = open.slice(0, SHOWN_AFTER + 1).map((node, index) => `${label(node)}${mark(node, index)}`);
  const left = open.length - shown.length;
  const before = passed.filter(node => kept.has(node.id) || (node.state !== 'done' && node.state !== 'blocked'))
    .map(node => `${label(node)}${MARKS[node.state] ?? SKIPPED_MARK}`).join(' ');
  return `道のり: ${early}${before}${before ? ' → ' : ''}${shown.join(' → ')}${left > 0 ? ` → ほか ${left} 節` : ''}`;
}

/** Whether a node the plan holds done names the milestone's own condition: reached, whatever the frame shows now (the pack used up, the dimension left). */
const doneInPlan = (tree: PlanTree, item: Milestone): boolean => tree.nodes.some(node => {
  const text = (node.doneWhen ?? '').replace(/\s+/gu, '').toLowerCase(), clause = item.doneWhen;
  if (node.state !== 'done') return false;
  // GPT's review 2026-10-28: a preparation skipped (or not to be met now: the model wrote `prep`) is not a milestone reached.
  if (prepSkipped(node) || prepUnmetNow(node)) return false;
  if (item.node?.(node)) return true;
  // A dimension in an alternative (「have:obsidian>=10|dim:the_nether」) is not what the node being done says: only a node that names it alone counts.
  return text.split(/[|&]/u).includes(clause) && (!clause.startsWith('dim:') || !text.includes('|'));
});
/**
 * GPT's review 2026-10-28: the preparation before the descent skipped (the model wrote `prep: skipped`), or open with she below the surface, is not the next
 * milestone and not a late one; it is said as the fact it is, and it is not counted as reached (`reached` is the meter's own list). Chapter 7 (decision 9): a
 * node the model wrote `prep: unmet_now` on is counted late like any other (the meter points at it with its seconds behind) and says why it cannot be met now.
 */
function prepEnd(tree: PlanTree, facts: DoneFacts, reached: readonly boolean[]): { index: number; over: boolean; fact: string } {
  const index = DRAGON_MILESTONES.findIndex(item => item.node !== undefined), item = DRAGON_MILESTONES[index];
  const skippedNode = item ? tree.nodes.find(node => prepSkipped(node) && item.node!(node)) : undefined;
  const isOpen = (node: PlanNode) => node.state !== 'done' && node.state !== 'blocked';
  const unmetNode = item && !reached[index] ? tree.nodes.find(node => prepUnmetNow(node) && isOpen(node) && item.node!(node)) : undefined;
  const open = !!item && tree.nodes.some(node => isOpen(node) && item.node!(node) && !prepUnmetNow(node));
  const over = !!item && !reached[index] && (!!skippedNode || (undergroundInOverworld(facts) && open));
  if (unmetNode && !over) {
    const why = unmetNode.prep?.why;
    return { index, over, fact: `・準備は今は満たせない（${why ? `理由: ${why.slice(0, 60)}` : `今 ${item!.now!(facts)}`}）` };
  }
  if (!over) return { index, over, fact: '' };
  const said = skippedNode?.prep?.why;
  return { index, over, fact: skippedNode ? `・${PREP_SKIPPED}${said ? `（${said.slice(0, 60)}）` : ''}` : `・準備は今は満たせない（地下。今 ${item!.now!(facts)}）` };
}
/**
 * The names of the milestones the frame shows reached, or the plan holds a node done for (the meter's own list; null without a dragon plan or a frame). Said as a list of facts, e.g. beside a current
 * node that no condition can move (run 48: 「[n1] 食料不足のまま鉄へ」 stayed the current node from +190 s to the end, past the iron pickaxe, the diamond pickaxe and the obsidian).
 */
export function reachedMilestoneNames(tree: PlanTree | null | undefined, observation: BodyObservation | null): string[] | null {
  const facts = doneFacts(observation);
  if (!tree || !isDragonPlan(tree) || !facts) return null;
  return DRAGON_MILESTONES.filter(item => {
    const predicate = parseDoneWhen(item.doneWhen);
    return (item.holds ? item.holds(facts) : !!predicate && predicateHolds(predicate, facts)) || doneInPlan(tree, item);
  }).map(item => item.short ?? item.name);
}
/**
 * Chapter 8 (the meter's clock): the minutes the task has run, without the time it was held (`heldMs`, the operator's hold to its resume: the same count the time limit leaves out,
 * `operatorAuditStore.heldMs`). The wall clock since the task began also counts the hold (run 45: 「今 5,693 秒」 at +944 s of running).
 */
export function activeMinutes(elapsedMinutes: number | null, heldMs = 0): number | null {
  return elapsedMinutes === null ? null : Math.max(0, elapsedMinutes - Math.max(0, heldMs) / 60_000);
}
/**
 * `body.meter`: the seconds since the task began, and the next milestone (the first after the last one reached) with its target and how far ahead or
 * behind. A milestone is reached when the frame shows it or when the plan holds a node done by that very condition, so it stays reached when the
 * obsidian is used up or she is back in the overworld: the plan carries it, nothing else is kept. After the last one only the seconds are said.
 * Null when the plan is not the dragon's or the time is not known.
 */
export function meterLine(tree: PlanTree | null | undefined, observation: BodyObservation | null, elapsedMinutes: number | null, heldMs = 0): string | null {
  return meterParts(tree, observation, elapsedMinutes, heldMs)?.line ?? null;
}
/**
 * The meter's line and the name of the milestone it points at (`next`, null after the last one). The seconds do not change the milestone, so a reader that only wants to know
 * whether the task moved on to another one (amendment A-12's `node_stalled`) asks with any time.
 */
export function meterParts(tree: PlanTree | null | undefined, observation: BodyObservation | null, elapsedMinutes: number | null, heldMs = 0): { line: string; next: string | null } | null {
  const facts = doneFacts(observation);
  if (!tree || !isDragonPlan(tree) || elapsedMinutes === null || !facts) return null;
  // The seconds are the task's running seconds (`activeMinutes`: the wall clock less the time it was held); a task that was held says how many seconds the clock leaves out, so that the state's own minutes are not read against it.
  const now = Math.round((activeMinutes(elapsedMinutes, heldMs) ?? 0) * 60);
  const clock = `今 ${grouped(now)} 秒${heldMs >= 1_000 ? `（保留の ${grouped(Math.round(heldMs / 1_000))} 秒を除く）` : ''}`;
  let last = -1;
  const reached = DRAGON_MILESTONES.map((item, index) => {
    const predicate = parseDoneWhen(item.doneWhen);
    const yes = (item.holds ? item.holds(facts) : !!predicate && predicateHolds(predicate, facts)) || doneInPlan(tree, item);
    if (yes) last = index;
    return yes;
  });
  // run 26: a node of the plan names a milestone's own condition (「地下のベッドを取る」, have:bed>=1). The node she is on makes the meter point at it, though a later
  // milestone is reached; and a milestone passed over (the bed after the bucket) is still said while the plan's node for it is not done.
  const clausesOf = (node: PlanNode) => (node.doneWhen ?? '').replace(/\s+/gu, '').toLowerCase().split(/[|&]/u);
  const names = (node: PlanNode, item: Milestone) => item.node?.(node) === true || clausesOf(node).some(clause => clause === item.doneWhen || clause.startsWith(`${item.doneWhen}>=`));
  const current = tree.nodes.find(node => node.id === tree.current);
  const throughTheGate = reached[reached.length - 1];
  const named = throughTheGate ? -1 : DRAGON_MILESTONES.findIndex((item, index) => !reached[index] && !!current && names(current, item));
  const { index: prepIndex, over: prepOver, fact: prepFact } = prepEnd(tree, facts, reached);
  let nextIndex = named >= 0 ? named : last + 1;
  if (prepOver && nextIndex === prepIndex) nextIndex += 1;
  const next = DRAGON_MILESTONES[nextIndex];
  // The milestones kept in the pack (not the obsidian or the water that are used up), and not once she is through the gate.
  const skippedIndex = throughTheGate ? -1 : reached.findIndex((yes, index) => !yes && index !== nextIndex && index < (next ? nextIndex : reached.length)
    && !(prepOver && index === prepIndex) && isKept(DRAGON_MILESTONES[index]!)
    && tree.nodes.some(node => node.state !== 'done' && names(node, DRAGON_MILESTONES[index]!)));
  const passed = DRAGON_MILESTONES[skippedIndex];
  const detail = (item: Milestone): string => [item.now ? `今 ${item.now(facts)}` : '', item.cost ?? ''].filter(Boolean).join('。');
  const skipped = passed ? `・まだの節目: ${passed.name}（目安 ${grouped(passed.seconds)} 秒${detail(passed) ? `。${detail(passed)}` : ''}）` : '';
  if (!next) return { line: `目安: ${clock}（節目は全部済んだ）${skipped}${prepFact}`, next: null };
  const gap = next.seconds - now;
  const state = gap >= 0 ? `あと ${grouped(gap)} 秒` : `${grouped(-gap)} 秒遅れ`;
  return { line: `目安: ${clock}・次の節目 ${next.name} 目安 ${grouped(next.seconds)} 秒（${state}）${detail(next) ? `・${detail(next)}` : ''}${skipped}${prepFact}`, next: next.name };
}
