import { applyPlanUpdate, orderedPlan, type PlanNode, type PlanTree, type PlanUpdate } from '@shannon/mind';
import type { FcaPlanInbox } from '../../mind/action/fca/fcaPlanTools.js';

/**
 * The owner's hand on one node of a request's plan (「小麦集めは飛ばして」, the mod's button on a node): skip it, hold it, put it back.
 * The request goes on; only the node is set aside, with the plan's own state for that (`blocked`, with a reason that begins with `owner_`), so the
 * way to the next node, the parent's and the screen's colour are the ones a blocked node already has. No new state.
 *
 * The change is made to the plan the task holds, not to the plan as the door saw it: it is put by `putOwnerNodeOp` and taken at the task's next read
 * of the plan (`withOwnerNodeInbox`, the form of the first plan's and the new plan's inboxes), once. The acts the node's hands made are cut at once
 * (`OwnerPlan.cut`, the queue of the step that runs).
 */
export const OWNER_NODE_OPS = ['skip', 'hold', 'resume'] as const;
export type OwnerNodeOp = typeof OWNER_NODE_OPS[number];

export const OWNER_SKIP_REASON = 'owner_skip: 持ち主が飛ばした';
export const OWNER_HOLD_REASON = 'owner_hold: 持ち主が止めた';
const SKIP_CAUTION = '持ち主が飛ばした節。持ち主が戻せと言うまで continue に戻さない（要る物は別の節で取る）';
const HOLD_CAUTION = '持ち主が止めた節。持ち主が再開と言うまで continue に戻さない';

/** Why a node was not changed. */
export type OwnerNodeProblem = 'no_such_node' | 'ambiguous' | 'node_done' | 'not_blocked' | 'unchanged';

export type OwnerNodeResult =
  | { ok: true; node: { id: string; title: string }; update: PlanUpdate; lift?: PlanUpdate; note: string; cut: ReadonlySet<string> }
  | { ok: false; problem: OwnerNodeProblem; detail?: string };

const flat = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/** Ids of `id` and everything under it. */
function under(tree: PlanTree, id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const node of tree.nodes) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) { ids.add(node.id); grew = true; }
  }
  return ids;
}

/**
 * The node the owner means: by id (`p2.1`), else by its title as he said it (a part of it, either way round, ignoring spaces and marks). Of several that
 * fit, the ones that can be changed by `op` are looked at first (a done node cannot be skipped; only a blocked one can be put back). More than one is
 * `ambiguous`, never guessed.
 */
export function findOwnerNode(tree: PlanTree, ref: string, op: OwnerNodeOp): { node: PlanNode } | { problem: 'no_such_node' | 'ambiguous'; detail?: string } {
  const wanted = ref.trim();
  const byId = tree.nodes.find(node => node.id.toLowerCase() === wanted.replace(/^#/u, '').toLowerCase());
  if (byId) return { node: byId };
  const key = flat(wanted);
  if (key.length < 2) return { problem: 'no_such_node' };
  const usable = (node: PlanNode) => (op === 'resume' ? node.state === 'blocked' : node.state !== 'done');
  const matches = (test: (title: string) => boolean) => orderedPlan(tree.nodes).filter(node => test(flat(node.title)));
  for (const found of [matches(title => title === key), matches(title => title.includes(key)),
    matches(title => title.length >= 2 && key.includes(title))]) {
    if (!found.length) continue;
    const ready = found.filter(usable);
    const pool = ready.length ? ready : found;
    if (pool.length === 1) return { node: pool[0]! };
    return { problem: 'ambiguous', detail: pool.slice(0, 4).map(node => `${node.id} ${node.title}`).join(' / ') };
  }
  return { problem: 'no_such_node' };
}

/** The plan update an op makes to the node (the pure part: nothing is applied). */
export function ownerNodeChange(tree: PlanTree, ref: string, op: OwnerNodeOp): OwnerNodeResult {
  const found = findOwnerNode(tree, ref, op);
  if ('problem' in found) return { ok: false, problem: found.problem, ...(found.detail ? { detail: found.detail } : {}) };
  const node = found.node;
  const label = `[${node.id} ${node.title}]`;
  const cut = under(tree, node.id);
  if (op !== 'resume' && node.state === 'done') return { ok: false, problem: 'node_done', detail: node.title };
  if (op === 'resume') {
    if (node.state !== 'blocked') return { ok: false, problem: 'not_blocked', detail: node.title };
    const open = orderedPlan(tree.nodes).find(item => cut.has(item.id) && item.state !== 'done'
      && !tree.nodes.some(kid => kid.parentId === item.id && kid.state !== 'done'));
    const lines = [...(node.caution ?? []).filter(line => line === SKIP_CAUTION || line === HOLD_CAUTION)];
    const outer = tree.nodes.find(item => item.id !== node.id && item.state === 'blocked' && under(tree, item.id).has(node.id));
    return { ok: true, node: { id: node.id, title: node.title }, cut: new Set(),
      update: { ops: [{ op: 'set', id: node.id, state: 'continue' }], ...(open ? { current: open.id } : {}) },
      ...(lines.length ? { lift: { ops: lines.map(text => ({ op: 'lift' as const, id: node.id, text })) } } : {}),
      note: `持ち主が ${label} を再開させた。この節を進めてよい（順は計画のまま）。${outer ? `ただし上の [${outer.id} ${outer.title}] が止まったままなので、まだ進めない。` : ''}` };
  }
  const skip = op === 'skip';
  if (node.state === 'blocked' && node.reason === (skip ? OWNER_SKIP_REASON : OWNER_HOLD_REASON)) return { ok: false, problem: 'unchanged', detail: node.title };
  const stale = (node.caution ?? []).filter(line => line === (skip ? HOLD_CAUTION : SKIP_CAUTION));
  const promises = tree.promises.filter(item => item.state !== 'closed' && item.until?.node && cut.has(item.until.node));
  const words = skip
    ? `持ち主が ${label} を飛ばした（その節の手は切った）。この節で取る物が他の節に要るなら、代わりの道を plan.update で足す。持ち主が戻せと言うまでこの節を continue に戻さない。`
    : `持ち主が ${label} を止めた（その節の手は切った）。持ち主が再開と言うまでこの節を continue に戻さない。他の節は進めてよい。`;
  return { ok: true, node: { id: node.id, title: node.title }, cut,
    update: { ops: [{ op: 'set', id: node.id, state: 'blocked', reason: skip ? OWNER_SKIP_REASON : OWNER_HOLD_REASON },
      { op: 'caution', id: node.id, text: skip ? SKIP_CAUTION : HOLD_CAUTION }] },
    ...(stale.length ? { lift: { ops: stale.map(text => ({ op: 'lift' as const, id: node.id, text })) } } : {}),
    note: words + (promises.length ? `この節を期限にした約束 ${promises.map(item => `#${item.id}`).join('・')} が開いたまま（要らなければ release）。` : '') };
}

/** The tree after the change, or null when the plan does not take it. The lift of an old line is best effort (a line that is gone is no reason to refuse). */
export function applyOwnerNodeChange(tree: PlanTree, change: Extract<OwnerNodeResult, { ok: true }>, at: string): PlanTree | null {
  const made = applyPlanUpdate(tree, change.update, { at });
  const settled = made.problem || !made.changed ? applyPlanUpdate(tree, { ops: change.update.ops }, { at }) : made;
  if (settled.problem || !settled.changed) return null;
  if (!change.lift) return settled.tree;
  const lifted = applyPlanUpdate(settled.tree, change.lift, { at, partial: true });
  return lifted.problem || !lifted.changed ? settled.tree : lifted.tree;
}

interface WaitingOp { node: string; title: string; op: OwnerNodeOp }
const waiting = new Map<string, WaitingOp[]>();

/** An owner's change of a node, taken at the task's next read of its plan. */
export function putOwnerNodeOp(taskId: string, entry: WaitingOp): void {
  const held = (waiting.get(taskId) ?? []).filter(item => item.node !== entry.node);
  waiting.delete(taskId);
  waiting.set(taskId, [...held, entry].slice(-8));
  if (waiting.size > 32) waiting.delete(waiting.keys().next().value as string);
}

/** The plan inbox of a task with the owner's node changes after the ones of `inner` (the first plan, a new plan). */
export function withOwnerNodeInbox(inner: FcaPlanInbox, log: (line: string) => void = () => undefined): FcaPlanInbox {
  return {
    take(taskId, held) {
      const first = inner.take(taskId, held);
      const entries = waiting.get(taskId);
      if (!entries?.length) return first;
      waiting.delete(taskId);
      let tree = first?.tree ?? held;
      const notes: string[] = first ? [first.note] : [];
      for (const entry of entries) {
        const node = tree.nodes.find(item => item.id === entry.node);
        if (!node || node.title !== entry.title) {
          log(`Shannon Minecraft owner node op not taken task=${taskId} node=${entry.node} op=${entry.op} (not the node it was)`);
          continue;
        }
        const change = ownerNodeChange(tree, entry.node, entry.op);
        const next = change.ok ? applyOwnerNodeChange(tree, change, new Date().toISOString()) : null;
        if (!change.ok || !next) {
          log(`Shannon Minecraft owner node op not taken task=${taskId} node=${entry.node} op=${entry.op} ${change.ok ? 'plan refused' : change.problem}`);
          continue;
        }
        tree = next;
        notes.push(change.note);
        log(`Shannon Minecraft owner node op taken task=${taskId} node=${entry.node} op=${entry.op}`);
      }
      return tree === (first?.tree ?? held) ? first : { tree, note: notes.join(' ') };
    },
  };
}

/** What a task's step lets the owner's door reach: the plan as it is, and the cut of the acts that serve a node. */
export interface OwnerPlan {
  tree(): PlanTree;
  /** Takes the acts tagged with these nodes off the queue (the ones behind them that rely on them go too); the words of what went. */
  cut(nodes: ReadonlySet<string>): Promise<string>;
}
const plans = new Map<string, OwnerPlan>();

/** The newest step of a task replaces the older one. */
export function registerOwnerPlan(taskId: string, plan: OwnerPlan): void {
  plans.delete(taskId);
  plans.set(taskId, plan);
  if (plans.size > 32) plans.delete(plans.keys().next().value as string);
}
export const ownerPlanOf = (taskId: string): OwnerPlan | null => plans.get(taskId) ?? null;

const NODE_LINES_MAX = 6;
const nodeLine = (node: PlanNode, tag: string, extra = ''): string => `${tag} ${node.id} ${node.title.slice(0, 30)}${extra}`;

/**
 * The plan of the request that runs, as lines of the guide for her turn (`[計画の段]`): the current node, the ones that come next, the ones that stand
 * blocked, each with its id and title, so that the model can name the node the owner means by the node's own words (「骨集め」 for 「骨粉を作る」), not by
 * a part of the title he happened to say. Only leaves are listed (a parent's work is its children's). Empty when the task has no plan the head can reach.
 */
export function ownerPlanPromptLines(taskId: string | null | undefined, seq?: number): string[] {
  const plan = taskId ? ownerPlanOf(taskId) : null;
  if (!plan) return [];
  let tree: PlanTree;
  try { tree = plan.tree(); } catch { return []; }
  const order = orderedPlan(tree.nodes);
  const leaf = (node: PlanNode) => !tree.nodes.some(kid => kid.parentId === node.id);
  const open = order.filter(node => leaf(node) && node.state !== 'done' && node.state !== 'blocked');
  const now = (tree.current ? open.find(node => node.id === tree.current) : null) ?? open[0];
  const after = now ? open.filter(node => node !== now && order.indexOf(node) > order.indexOf(now)).slice(0, 2) : [];
  const stopped = order.filter(node => node.state === 'blocked').slice(0, 3);
  const lines = [
    ...(now ? [nodeLine(now, '今')] : []),
    ...after.map(node => nodeLine(node, '次')),
    ...stopped.map(node => nodeLine(node, '止まった', node.reason ? `（${node.reason.slice(0, 24)}）` : '')),
  ].slice(0, NODE_LINES_MAX);
  return lines.length ? [`[走っている依頼${seq ? ` #${seq}` : ''}の計画の段]（kind=skip・hold・resume の node は、ここの段の id を入れる）`, ...lines] : [];
}

/** For tests. */
export function forgetOwnerNodeOps(): void {
  waiting.clear();
  plans.clear();
}
