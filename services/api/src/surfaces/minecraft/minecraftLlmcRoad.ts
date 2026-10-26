import { orderedPlan, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { doneFacts, parseDoneWhen, predicateHolds } from './minecraftPlanDone.js';

/**
 * mb-llmc v2 (mb-llmc-cand 11, chapter 4 A: the goal's yardstick and the stage road): for a task that goes for the dragon, two lines of the live
 * state that the code makes from facts, never the model: `road`, the plan's top-level nodes in their order with what is done and where she is
 * (「準備✓ 鉄✓ ダイヤ◀今 → 黒曜石 → ゲート → ネザー…」), and `meter`, the seconds since the task began against the owner's targets for the route's milestones
 * (「今 812 秒・次の節目 ダイヤのツルハシ 目安 1,000 秒（あと 188 秒）」). A milestone is reached when its done-condition holds in the frame (`doneWhen`, the plan's own
 * predicates: `minecraftPlanDone.ts`). Both are absent for a task that is not after the dragon. The targets are the owner's (2026-10-24); the
 * instructions say the same numbers (`milestoneWords`), from this one constant. They measure; they decide no hand.
 */
export interface Milestone { name: string; seconds: number; doneWhen: string }
export const DRAGON_MILESTONES: readonly Milestone[] = Object.freeze([
  { name: 'ベッド', seconds: 150, doneWhen: 'have:bed' },
  { name: '鉄のツルハシ', seconds: 250, doneWhen: 'have:iron_pickaxe' },
  { name: 'バケツ', seconds: 600, doneWhen: 'have:bucket' },
  { name: 'ダイヤのツルハシ', seconds: 1_000, doneWhen: 'have:diamond_pickaxe' },
  { name: '水バケツ', seconds: 1_000, doneWhen: 'have:water_bucket' },
  { name: '黒曜石 10 個', seconds: 1_500, doneWhen: 'have:obsidian>=10' },
  { name: 'ネザー', seconds: 1_800, doneWhen: 'dim:the_nether' },
]);
/** The milestones whose item stays in the pack (a bed, the pickaxes, the bucket): one passed over is still to do. */
const KEPT_MILESTONES: ReadonlySet<string> = new Set(['have:bed', 'have:iron_pickaxe', 'have:bucket', 'have:diamond_pickaxe']);
const grouped = (seconds: number): string => seconds.toLocaleString('en-US');
/** The targets as the instructions say them: 「ベッド 150・鉄のツルハシ 250・…・ネザー 1,800」. */
export const milestoneWords = (): string => DRAGON_MILESTONES.map(item => `${item.name} ${grouped(item.seconds)}`).join('・');

/** Whether the plan is the dragon's: a node of it names the dragon (the seeded plan's last node, 「エンドでドラゴン」). */
export const isDragonPlan = (tree: PlanTree | null | undefined): boolean => !!tree && tree.nodes.some(node => /ドラゴン|エンドラ/u.test(node.title));

const SHOWN_AFTER = 5, SHOWN_DONE = 3;
const MARKS: Readonly<Record<string, string>> = { blocked: '（止）', done: '✓' };
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
 * with 止. Null when the plan is not the dragon's.
 */
export function roadLine(tree: PlanTree | null | undefined): string | null {
  if (!tree || !isDragonPlan(tree)) return null;
  const top = orderedPlan(tree.nodes).filter(node => node.parentId === null), current = topOf(tree);
  const here = Math.max(0, top.findIndex(node => node.id === current));
  const done = top.slice(0, here).filter(node => node.state === 'done' || node.state === 'blocked'), open = top.slice(here);
  const early = done.length > SHOWN_DONE ? `済み ${done.length - SHOWN_DONE} 節 ` : '';
  const mark = (node: PlanNode, index: number): string => index === 0 && current ? '◀今' : MARKS[node.state] ?? '';
  const shown = open.slice(0, SHOWN_AFTER + 1).map((node, index) => `${label(node)}${mark(node, index)}`);
  const left = open.length - shown.length, before = done.slice(-SHOWN_DONE).map(node => `${label(node)}${MARKS[node.state]}`).join(' ');
  return `道のり: ${early}${before}${done.length ? ' → ' : ''}${shown.join(' → ')}${left > 0 ? ` → ほか ${left} 節` : ''}`;
}

/** Whether a node the plan holds done names the milestone's own condition: reached, whatever the frame shows now (the pack used up, the dimension left). */
const doneInPlan = (tree: PlanTree, clause: string): boolean => tree.nodes.some(node => {
  const text = (node.doneWhen ?? '').replace(/\s+/gu, '').toLowerCase();
  // A dimension in an alternative (「have:obsidian>=10|dim:the_nether」) is not what the node being done says: only a node that names it alone counts.
  return node.state === 'done' && text.split(/[|&]/u).includes(clause) && (!clause.startsWith('dim:') || !text.includes('|'));
});
/**
 * `body.meter`: the seconds since the task began, and the next milestone (the first after the last one reached) with its target and how far ahead or
 * behind. A milestone is reached when the frame shows it or when the plan holds a node done by that very condition, so it stays reached when the
 * obsidian is used up or she is back in the overworld: the plan carries it, nothing else is kept. After the last one only the seconds are said.
 * Null when the plan is not the dragon's or the time is not known.
 */
export function meterLine(tree: PlanTree | null | undefined, observation: BodyObservation | null, elapsedMinutes: number | null): string | null {
  const facts = doneFacts(observation);
  if (!tree || !isDragonPlan(tree) || elapsedMinutes === null || !facts) return null;
  const now = Math.round(elapsedMinutes * 60);
  let last = -1;
  const reached = DRAGON_MILESTONES.map((item, index) => {
    const predicate = parseDoneWhen(item.doneWhen);
    const yes = (!!predicate && predicateHolds(predicate, facts)) || doneInPlan(tree, item.doneWhen);
    if (yes) last = index;
    return yes;
  });
  // run 26: a node of the plan names a milestone's own condition (「地下のベッドを取る」, have:bed>=1). The node she is on makes the meter point at it, though a later
  // milestone is reached; and a milestone passed over (the bed after the bucket) is still said while the plan's node for it is not done.
  const clausesOf = (node: PlanNode) => (node.doneWhen ?? '').replace(/s+/gu, '').toLowerCase().split(/[|&]/u);
  const names = (node: PlanNode, item: Milestone) => clausesOf(node).some(clause => clause === item.doneWhen || clause.startsWith(`${item.doneWhen}>=`));
  const current = tree.nodes.find(node => node.id === tree.current);
  const throughTheGate = reached[reached.length - 1];
  const named = throughTheGate ? -1 : DRAGON_MILESTONES.findIndex((item, index) => !reached[index] && !!current && names(current, item));
  const nextIndex = named >= 0 ? named : last + 1;
  const next = DRAGON_MILESTONES[nextIndex];
  // The milestones kept in the pack (not the obsidian or the water that are used up), and not once she is through the gate.
  const skippedIndex = throughTheGate ? -1 : reached.findIndex((yes, index) => !yes && index !== nextIndex && index < (next ? nextIndex : reached.length)
    && KEPT_MILESTONES.has(DRAGON_MILESTONES[index]!.doneWhen)
    && tree.nodes.some(node => node.state !== 'done' && names(node, DRAGON_MILESTONES[index]!)));
  const passed = DRAGON_MILESTONES[skippedIndex];
  const skipped = passed ? `・まだの節目: ${passed.name}（目安 ${grouped(passed.seconds)} 秒。飛ばしたなら plan.update に書く）` : '';
  if (!next) return `目安: 今 ${grouped(now)} 秒（節目は全部済んだ）${skipped}`;
  const gap = next.seconds - now;
  const state = gap >= 0 ? `あと ${grouped(gap)} 秒` : `${grouped(-gap)} 秒遅れ`;
  return `目安: 今 ${grouped(now)} 秒・次の節目 ${next.name} 目安 ${grouped(next.seconds)} 秒（${state}）${skipped}`;
}
