import { orderedPlan, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation, BodyPlanView } from '../../contracts/bodyControlContract.js';
import { doneFacts, doneStatusWords } from './minecraftPlanDone.js';

/**
 * mb-llmc r6 (run 29: the plan's "now" was 「p1.1 作業台と板を作る」 from 36 s to the end, and Sonnet went for the blazes from the first act;
 * plan.update 0). A hypothesis, measured by comparing Sonnet and Opus from the same start: an act says which plan node it is for.
 *
 * - The model writes the node first in the act's `why` (`[p1.2] …`; another node than the current one with 「理由: …」; `[急ぎ]` for an
 *   urgent hand). A why without a tag gets the current node's put first by the head (`tagActWhy`), said in the result as a form fixed.
 * - Each act sent is counted per task (`noteActNode`): how many were for the current node (or one under it; r7: not a parent's tag, nor a
 *   why with 「理由:」), how many for a parent (`parent`), how many for another, how many of those said why, how many urgent, how many the
 *   head tagged. The log line carries the share on the plan.
 */
export const URGENT_TAG = '急ぎ';
const TAG = /^\s*\[([A-Za-z0-9][A-Za-z0-9_.-]{0,31}|急ぎ)\]\s*/u;
const REASON = /理由\s*[:：]/u;
const WHY_LIMIT = 120;

export interface ActNodeMark {
  /** The node the act is for (`急ぎ` for an urgent one). */
  node: string;
  current: string | null;
  by: 'model' | 'head';
  /**
   * For the current node or one under it, with no reason of another node's. r7 (runs 30, 31: 「[p1] ブレイズを打つ」 under the current p1.1,
   * and 「[p1.1] 理由: … ゲートへ戻り食料」, were both counted on): a parent's tag is not on (`parent`), nor a why with 「理由:」.
   */
  on: boolean;
  urgent: boolean;
  /** Another node's act with its reason written (r7: the current node's tag with 「理由:」 too). */
  reason: boolean;
  /** r7: the tag is a node above the current one (counted apart, not on). */
  parent?: boolean;
}

/** Where `id` stands against the current node: itself or under it (`leaf`), above it (`parent`), or elsewhere (`off`). */
export function nodeAgainstCurrent(plan: Pick<BodyPlanView, 'current' | 'nodes'>, id: string): 'leaf' | 'parent' | 'off' {
  const current = plan.current;
  if (!current) return 'off';
  const parent = new Map(plan.nodes.map(node => [node.id, node.parentId]));
  const up = (from: string | null, target: string): boolean => {
    for (let at = from, guard = 0; at && guard < 16; at = parent.get(at) ?? null, guard += 1) if (at === target) return true;
    return false;
  };
  if (id === current || up(id, current)) return 'leaf';
  return up(current, id) ? 'parent' : 'off';
}

/** The act with its why tagged by the node it is for: the model's own tag kept; none, the current node's put first. */
export function tagActWhy(input: unknown, plan: BodyPlanView | undefined): { input: unknown; fix: string | null; mark: ActNodeMark | null } {
  const act = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
  if (!act || !plan?.current) return { input, fix: null, mark: null };
  const why = typeof act.why === 'string' ? act.why : '';
  const tag = TAG.exec(why)?.[1];
  if (tag) {
    const urgent = tag === URGENT_TAG, where = urgent ? 'off' : nodeAgainstCurrent(plan, tag), reason = !urgent && REASON.test(why);
    const on = where === 'leaf' && !reason, parent = where === 'parent' && !reason;
    return { input, fix: null, mark: { node: tag, current: plan.current, by: 'model', on, urgent, reason, ...(parent ? { parent } : {}) } };
  }
  const tagged = `[${plan.current}] ${why.trim()}`.trim().slice(0, WHY_LIMIT);
  return { input: { ...act, why: tagged }, fix: `why に今の節 [${plan.current}] を付けた`,
    mark: { node: plan.current, current: plan.current, by: 'head', on: true, urgent: false, reason: false } };
}

interface Tally { acts: number; on: number; off: number; offReason: number; urgent: number; head: number; parent: number }
const tallies = new Map<string, Tally>();
/** Counts one act sent for the task and says it in the log (its node, the current one, and the task's share on the plan so far). */
export function noteActNode(taskId: string, mark: ActNodeMark | null, log: (line: string) => void): Tally | null {
  if (!mark) return null;
  let tally = tallies.get(taskId);
  if (!tally) {
    tally = { acts: 0, on: 0, off: 0, offReason: 0, urgent: 0, head: 0, parent: 0 };
    tallies.set(taskId, tally);
    if (tallies.size > 32) tallies.delete(tallies.keys().next().value as string);
  }
  tally.acts += 1;
  if (mark.by === 'head') tally.head += 1;
  else if (mark.urgent) tally.urgent += 1;
  else if (mark.on) tally.on += 1;
  else if (mark.parent) tally.parent += 1;
  else {
    tally.off += 1;
    if (mark.reason) tally.offReason += 1;
  }
  const share = (tally.on / tally.acts).toFixed(2);
  try {
    log(`Shannon Minecraft act node task=${taskId} node=${mark.node} current=${mark.current ?? '-'} by=${mark.by} on=${mark.on ? 1 : 0}`
      + ` reason=${mark.reason ? 1 : 0} acts=${tally.acts} onPlan=${tally.on} off=${tally.off} offReason=${tally.offReason} urgent=${tally.urgent}`
      + ` head=${tally.head} parent=${tally.parent} share=${share}`);
  } catch { /* a log never fails a step */ }
  return { ...tally };
}

/** The current node as the live state shows it before the map: `[p1.1] 作業台と板を作る＠…（済み: …）` and the path above it. */
export function planNowLine(view: { now?: unknown; path?: unknown } | null): string | null {
  const now = typeof view?.now === 'string' ? view.now : '';
  const match = /^(\S+) (.+)$/u.exec(now);
  if (!match) return null;
  const path = Array.isArray(view?.path) ? (view!.path as unknown[]).filter(item => typeof item === 'string').slice(-2) : [];
  return `[${match[1]}] ${match[2]}${path.length ? `（道: ${path.join(' › ')}）` : ''}`.slice(0, 200);
}

const NOW_LIMIT = 200;
/**
 * Notion 09-1c 2-5 (the current node was one string cut at 200 characters from its end, so a long where or path could cut its done-condition; and the
 * condition was not read beside it): the current node from its own fields, with how far the frame meets its condition (`doneStatusWords`), in the order
 * the decision needs them: id and title, the condition and its status, the place, the note, the path. Past the bound the path goes first, then the note,
 * then the place is shortened; the condition is kept. 「[p4.3] 鉄の兜・胸当て・脚を着る（済む条件: have:iron_helmet&…／今: 未: iron_leggings 0/1）＠… （道: 鉄 › …）」.
 */
export function currentNodeLine(node: { id: string; title: string; where?: string | undefined; doneWhen?: string | undefined; note?: string | undefined },
  pathOf: unknown, status: string | null): string {
  const path = Array.isArray(pathOf) ? pathOf.filter((item): item is string => typeof item === 'string') : [];
  const head = `[${node.id}] ${node.title}`;
  const condition = node.doneWhen ? `（済む条件: ${node.doneWhen}${status ? `／今: ${status}` : ''}）` : status ? `（今: ${status}）` : '';
  const way = path.length ? `（道: ${path.slice(-2).join(' › ')}）` : '';
  const note = node.note ? ` ${node.note}` : '';
  const place = (where: string | undefined) => where ? `＠${where}` : '';
  const shorter = node.where?.slice(0, 40);
  for (const line of [`${head}${condition}${place(node.where)}${note}${way}`, `${head}${condition}${place(node.where)}${note}`,
    `${head}${condition}${place(node.where)}`, `${head}${condition}${place(shorter)}`]) {
    if (line.length <= NOW_LIMIT) return line;
  }
  return `${head}${condition}`.slice(0, NOW_LIMIT);
}

/**
 * `body.planNow`: the current node from its fields with its condition read against the frame (`currentNodeLine`); with no current node in
 * the tree, the plan view's line (`planNowLine`).
 */
export function planNowOf(tree: PlanTree | null, view: unknown, observation: BodyObservation | null): string | null {
  const node = tree?.current ? tree.nodes.find(item => item.id === tree.current) : undefined;
  const shown = view as { now?: unknown; path?: unknown } | null;
  if (!node) return planNowLine(shown);
  const status = doneStatusWords(node.doneWhen, doneFacts(observation));
  // A preparation node that is not met says so beside its condition (the work for another node does not move it).
  const held = node.state !== 'done' && isPrepNode(node) && status !== '満たしている' ? { ...node, note: node.note ? `${PREP_NOTE} ${node.note}` : PREP_NOTE } : node;
  return currentNodeLine(held, shown?.path, status);
}

/** The items in a row, started for the one same node that is not the current one, after which the head moves the current node to it. */
export const FOLLOW_AFTER = 2;
const FOLLOW_KEPT = 8;
interface Started { node: string; current: string | null }
/** The nodes of the items the body started, newest last, each with the current node the plan had when the model sent the item. */
const started = new Map<string, Started[]>();
export function noteItemStart(taskId: string, node: string | null, current: string | null = null): void {
  if (!node) return;
  const list = [...(started.get(taskId) ?? []), { node, current }].slice(-FOLLOW_KEPT);
  started.delete(taskId);
  started.set(taskId, list);
  if (started.size > 32) started.delete(started.keys().next().value as string);
}
/**
 * The nodes of the preparation before the descent (run 40: p3 「食料を集める（狩り）」 and p4 「地下の準備」 were never the current node, the plan's now followed the
 * acts to the iron at 265 s, and she went down with 17.6 of 40 food points, no gold and no food hunted): a node that asks for food (its doneWhen has
 * `food>=`) or
 * whose title says food, hunting or preparing. The current node is not moved away from one that is open (`followNode`), and the live says so (`prepNote`).
 */
const PREP_TITLE = /食料|食べ物|狩|動物|準備/u;
export const isPrepNode = (node: { title: string; doneWhen?: string | undefined }): boolean =>
  /food>=/u.test(node.doneWhen ?? '') || PREP_TITLE.test(node.title);
/** The words beside the current node's line while it is a preparation node that is not done: the work may go on elsewhere, the node stays. */
export const PREP_NOTE = '※準備の節（済むまで今の節は移らない。済ませてから下りる）';
/**
 * run 26 (2026-10-26, 「エンドラを討伐して」, Sonnet: plan.update 0 and no 「理由:」 in 125 decisions, 85 of 104 acts tagged for another node than the current
 * one; the plan's now said 原木を集める for 471 s while she smelted iron, and 動物を狩り焼く / 地下のベッドを取る while she did the iron again): the node the
 * body works on is the plan's current node. Run 39 (2026-10-26: the queue's first version moved the node at each item that started, 7 moves in 34 minutes, and
 * the nodes for food, legs, the shield and gold boots never became the current one): back to rel52's rule. When the last `FOLLOW_AFTER` items to start were
 * for the same node (not the current one, not an urgent hand, not a node above the current one) and were sent under the current node the plan has now, the
 * head moves the current node to that node's first open leaf: the plan, its display (the mod's task tab) and the live's now say what she does. An item for
 * the current node (or one the head tagged) breaks a run.
 * The nodes it passes stay open in their order (the plan's own next-open comes back to them when this one is done). Null when the tags do not agree.
 */
export function followNode(taskId: string, tree: PlanTree): { to: string; from: string | null; acts: number; words: string } | null {
  const order = orderedPlan(tree.nodes), questions = treeQuestions(tree), { under, open } = questions;
  // A parent's tag says nothing of the work under it: it is not counted, and it does not break a run.
  const counted = (started.get(taskId) ?? []).filter(tag => !(tag.current && tag.node !== tag.current && under(tag.current, tag.node)));
  const tags = counted.slice(-FOLLOW_AFTER), target = tags[0]?.node;
  if (tags.length < FOLLOW_AFTER || !target || tags.some(tag => tag.node !== target || tag.current !== tree.current) || !open(target)) return null;
  const leaf = order.find(node => open(node.id) && under(node.id, target) && !order.some(kid => kid.parentId === node.id && open(kid.id)));
  if (!leaf || leaf.id === tree.current || (tree.current !== null && under(tree.current, target))) return null;
  // Run 40: an open preparation node holds the current node (the work for another node may go on; the node that asks for the food stays the now).
  if (heldByPreparation(tree, leaf.id, questions)) return null;
  // Run 41 (the current node went p2.3 → p4.1 over p1.3 and p3, so no preparation node was ever the now and `heldByPreparation` never held): the work for a node that
  // is no preparation, with a preparation node open before it, puts the current node on that preparation node (the tags stay, no hand is held).
  const owed = openPreparation(order, leaf, questions);
  if (owed) {
    if (tree.current !== null && questions.under(tree.current, owed.id)) return null;
    const to = order.find(node => questions.open(node.id) && questions.under(node.id, owed.id) && !order.some(kid => kid.parentId === node.id && questions.open(kid.id))) ?? owed;
    return { to: to.id, from: tree.current, acts: tags.length, words: `今の節を [${to.id}] ${to.title.slice(0, 24)} に置いた（体が [${leaf.id}] の項目を続けて始めたが、先に済ませる準備の節 [${owed.id}] `
      + `${owed.title.slice(0, 24)} が開いているため。札は [${leaf.id}] のまま、手は止めていない。準備は速さのために省かない。飛ばすなら plan.update で `
      + 'その節を set state=done か blocked にして reason を書く）' };
  }
  const skipped = order.slice(tree.current === null ? 0 : order.findIndex(node => node.id === tree.current) + 1, order.indexOf(leaf))
    .filter(node => questions.open(node.id) && !order.some(kid => kid.parentId === node.id && questions.open(kid.id)) && !questions.under(leaf.id, node.id)).slice(0, 3);
  return { to: leaf.id, from: tree.current, acts: tags.length, words: `今の節を [${leaf.id}] に進めた（体が [${leaf.id}] の項目を始めたため。順を変えるなら plan.update の current で戻す。`
    + `飛ばした節は順のまま残っている${skipped.length ? `: ${skipped.map(node => `[${node.id}] ${node.title.slice(0, 20)}`).join('・')}` : ''}）` };
}

/**
 * The first node before `leaf` in the plan's order that is open and a preparation node, and that the work for `leaf` is not under (a preparation of its own).
 * A node whose children are all done or blocked has nothing left to do under it: it is not one (its own condition may be one only the model can mark).
 */
function openPreparation(order: readonly PlanNode[], leaf: PlanNode, questions: ReturnType<typeof treeQuestions>): PlanNode | undefined {
  if (isPrepNode(leaf)) return undefined;
  const before = order.indexOf(leaf);
  const pending = (node: PlanNode) => !order.some(kid => kid.parentId === node.id) || order.some(kid => kid.parentId === node.id && questions.open(kid.id));
  return order.find((node, index) => index < before && questions.open(node.id) && isPrepNode(node) && pending(node) && !questions.under(leaf.id, node.id));
}

/** Whether the current node is an open preparation node that the work for `leaf` would move the now away from (not for the node itself or one under it). */
function heldByPreparation(tree: PlanTree, leaf: string, questions: ReturnType<typeof treeQuestions>): boolean {
  const now = tree.current ? questions.byId.get(tree.current) : undefined;
  if (!now || !questions.open(now.id) || !isPrepNode(now)) return false;
  const next = questions.byId.get(leaf);
  return !!next && !isPrepNode(next) && !questions.under(leaf, now.id);
}

/** The tree's own questions: a node is open (not done, not blocked), and one is itself or under another. */
function treeQuestions(tree: PlanTree) {
  const byId = new Map(tree.nodes.map(node => [node.id, node] as const));
  const under = (id: string, top: string): boolean => {
    for (let at: string | null = id, guard = 0; at && guard < 16; at = byId.get(at)?.parentId ?? null, guard += 1) if (at === top) return true;
    return false;
  };
  const open = (id: string) => byId.get(id)?.state !== 'done' && byId.get(id)?.state !== 'blocked' && byId.has(id);
  return { byId, under, open };
}

/** For tests: no task holds a tally. */
export function forgetActNodes(): void {
  tallies.clear();
  started.clear();
}
