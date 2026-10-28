import { orderedPlan, type PlanKind, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation, BodyPlanView } from '../../contracts/bodyControlContract.js';
import { doneFacts, doneStatusWords, undergroundInOverworld } from './minecraftPlanDone.js';
import { kindOf, readWhere } from './minecraftPlanFacts.js';

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
  const facts = doneFacts(observation), status = doneStatusWords(node.doneWhen, facts);
  // A preparation node that is not met says so beside its condition (the work for another node does not move it);
  // below the surface it is one not to be met now.
  const word = facts && undergroundInOverworld(facts) ? PREP_NOT_NOW : PREP_NOTE;
  const held = node.state !== 'done' && holdsNow(node) && status !== '満たしている' ? { ...node, note: node.note ? `${word} ${node.note}` : word } : node;
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
 * acts to the iron at 265 s, and she went down with 17.6 of 40 food points, no gold and no food hunted): a node of the kind `prep_descent` or `food` (chapter 7:
 * the kind the model wrote; a title or a condition says nothing of it). The current node is not moved away from one that is open (`followNode`), and the live
 * says so (`prepNote`).
 */
const PREP_KINDS: ReadonlySet<PlanKind> = new Set<PlanKind>(['prep_descent', 'food']);
export const isPrepNode = (node: Pick<PlanNode, 'kind'>): boolean => PREP_KINDS.has(kindOf(node));
/**
 * A preparation node that is still to be met: the model has not written `prep: skipped` (left out) or `unmet_now` (not to be met now) on it. Only such a node
 * holds the current node and carries the note; the code writes neither word (chapter 7).
 */
const holdsNow = (node: Pick<PlanNode, 'kind' | 'prep'>): boolean => isPrepNode(node) && node.prep?.state !== 'skipped' && node.prep?.state !== 'unmet_now';
/** The words beside the current node's line while it is a preparation node that is not done: the work may go on elsewhere, the node stays. */
export const PREP_NOTE = '※下りる前の準備の節・未達';
/** The same node once she is below the surface (GPT's review 2026-10-28): not to be met now; the now does not stay on it (`followNode`). */
export const PREP_NOT_NOW = '※下りる前の準備の節・地下なので今は満たせない';
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
export function followNode(taskId: string, tree: PlanTree, underground = false): { to: string; from: string | null; acts: number; words: string } | null {
  const order = orderedPlan(tree.nodes), questions = treeQuestions(tree), { under, open } = questions;
  // Run 42 (Sonnet tagged p4.1 and p5.1 to p5.3, which the plan never had: every run of them was null and the now stayed on p1.2 for 700 s): a tag
  // for a node the plan does not have is for its nearest ancestor that it has (p4.1 → p4).
  const known = (started.get(taskId) ?? []).map(tag => ({ ...tag, node: existingNode(tag.node, questions.byId) }));
  // A parent's tag says nothing of the work under it: it is not counted, and it does not break a run.
  const counted = known.filter(tag => !(tag.current && tag.node !== tag.current && under(tag.current, tag.node)));
  const tags = counted.slice(-FOLLOW_AFTER), target = tags[0]?.node;
  if (tags.length < FOLLOW_AFTER || !target || tags.some(tag => tag.node !== target || tag.current !== tree.current) || !open(target)) return null;
  const leaf = order.find(node => open(node.id) && under(node.id, target) && !order.some(kid => kid.parentId === node.id && open(kid.id)));
  if (!leaf || leaf.id === tree.current || (tree.current !== null && under(tree.current, target))) return null;
  // Run 40: an open preparation node holds the current node (the work for another node may go on; the node that asks for the food stays the now).
  if (!underground && heldByPreparation(tree, leaf.id, questions)) return null;
  // Run 41 (the current node went p2.3 → p4.1 over p1.3 and p3, so no preparation node was ever the now and `heldByPreparation` never held): the work for a node that
  // is no preparation, with a preparation node open before it, puts the current node on that preparation node (the tags stay, no hand is held).
  const owed = underground ? undefined : openPreparation(order, leaf, questions);
  if (owed) {
    if (tree.current !== null && questions.under(tree.current, owed.id)) return null;
    const to = order.find(node => questions.open(node.id) && questions.under(node.id, owed.id) && !order.some(kid => kid.parentId === node.id && questions.open(kid.id))) ?? owed;
    return { to: to.id, from: tree.current, acts: tags.length, words: `今の節を [${to.id}] ${to.title.slice(0, 24)} に置いた（体が [${leaf.id}] の項目を続けて始めたが、先に済ませる準備の節 [${owed.id}] `
      + `${owed.title.slice(0, 24)} が開いているため。札は [${leaf.id}] のまま、手は止めていない）` };
  }
  const skipped = order.slice(tree.current === null ? 0 : order.findIndex(node => node.id === tree.current) + 1, order.indexOf(leaf))
    .filter(node => questions.open(node.id) && !order.some(kid => kid.parentId === node.id && questions.open(kid.id)) && !questions.under(leaf.id, node.id)).slice(0, 3);
  return { to: leaf.id, from: tree.current, acts: tags.length, words: `今の節を [${leaf.id}] に進めた（体が [${leaf.id}] の項目を始めたため）。`
    + `飛ばした節は順のまま残っている${skipped.length ? `: ${skipped.map(node => `[${node.id}] ${node.title.slice(0, 20)}`).join('・')}` : ''}` };
}

/** The node itself when the plan has it, else its nearest ancestor by the id's dots that it has (`p4.1` → `p4`), else the id as it was. */
function existingNode(id: string, byId: ReadonlyMap<string, PlanNode>): string {
  for (let at = id; at; at = at.includes('.') ? at.slice(0, at.lastIndexOf('.')) : '') if (byId.has(at)) return at;
  return id;
}

/**
 * Run 42 (p1.2 「村の箱を開ける」 where 157,67,200: the chest there was emptied at +62, the node had no doneWhen and Sonnet never set it done; it
 * stayed the current node for 700 s, and under its preparation parent p1 the now never moved to p3 「食料を集める」): a node for opening a chest or
 * barrel (the kind `chest`) is done when an act opened one at its place. The chests opened, per task, from the act's result (`chest (x,y,z): …` and the hand's line).
 */
const CHEST_SEEN = /^(?:chest|trapped_chest|barrel) \((-?\d+),(-?\d+),(-?\d+)\): |\((-?\d+),(-?\d+),(-?\d+)\) の (?:chest|trapped_chest|barrel) の中身/gmu;
const CHEST_KEPT = 16;
interface Opened { x: number; y: number; z: number; node: string | null }
const opened = new Map<string, Opened[]>();
/** The chests an act's result says it opened (a hand `chest … 済` and the container's line), with the node its why was tagged for. */
export function noteChestsOpened(taskId: string, text: string, why: string): void {
  if (!/^\d+ chest 済/mu.test(text)) return;
  const node = TAG.exec(why)?.[1] ?? null;
  const found: Opened[] = [];
  for (const match of text.matchAll(CHEST_SEEN)) {
    const [x, y, z] = (match[1] !== undefined ? match.slice(1, 4) : match.slice(4, 7)).map(Number) as [number, number, number];
    if (!found.some(item => item.x === x && item.y === y && item.z === z)) found.push({ x, y, z, node: node === URGENT_TAG ? null : node });
  }
  if (!found.length) return;
  const list = [...(opened.get(taskId) ?? []), ...found].slice(-CHEST_KEPT);
  opened.delete(taskId);
  opened.set(taskId, list);
  if (opened.size > 32) opened.delete(opened.keys().next().value as string);
}
/**
 * The open chest nodes an opened chest closes: a node that says a chest or barrel, with no doneWhen of its own (one that has it is the frame's to
 * close) and no open child, whose where is within 2 blocks of a chest opened, or with no where and the act tagged for it. Null when none.
 */
export function chestNodesDone(taskId: string, tree: PlanTree): { update: { ops: { op: 'set'; id: string; state: 'done'; reason: string }[] }; ids: string[] } | null {
  const list = opened.get(taskId);
  if (!list?.length || !tree.nodes.length) return null;
  const { open } = treeQuestions(tree);
  const ops: { op: 'set'; id: string; state: 'done'; reason: string }[] = [];
  for (const node of tree.nodes) {
    if (!open(node.id) || kindOf(node) !== 'chest' || node.doneWhen?.trim() || tree.nodes.some(kid => kid.parentId === node.id && open(kid.id))) continue;
    const at = node.where ? firstPoint(node.where) : null;
    const chest = list.find(item => at ? Math.max(Math.abs(item.x - at.x), Math.abs(item.y - at.y), Math.abs(item.z - at.z)) <= 2 : item.node === node.id);
    if (chest) ops.push({ op: 'set', id: node.id, state: 'done', reason: `箱 (${chest.x},${chest.y},${chest.z}) を開けた（頭が閉じた）` });
  }
  return ops.length ? { update: { ops: ops.slice(0, 8) }, ids: ops.slice(0, 8).map(op => op.id) } : null;
}
const firstPoint = (text: string): { x: number; y: number; z: number } | null => readWhere(text, 'any');

/**
 * The first node before `leaf` in the plan's order that is open and a preparation node, and that the work for `leaf` is not under (a preparation of its own).
 * A node whose children are all done or blocked has nothing left to do under it: it is not one (its own condition may be one only the model can mark).
 */
function openPreparation(order: readonly PlanNode[], leaf: PlanNode, questions: ReturnType<typeof treeQuestions>): PlanNode | undefined {
  if (isPrepNode(leaf)) return undefined;
  const before = order.indexOf(leaf);
  const pending = (node: PlanNode) => !order.some(kid => kid.parentId === node.id) || order.some(kid => kid.parentId === node.id && questions.open(kid.id));
  return order.find((node, index) => index < before && questions.open(node.id) && holdsNow(node) && pending(node) && !questions.under(leaf.id, node.id));
}

/** Whether the current node is an open preparation node that the work for `leaf` would move the now away from (not for the node itself or one under it). */
function heldByPreparation(tree: PlanTree, leaf: string, questions: ReturnType<typeof treeQuestions>): boolean {
  const now = tree.current ? questions.byId.get(tree.current) : undefined;
  if (!now || !questions.open(now.id) || !holdsNow(now)) return false;
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
  opened.clear();
}
