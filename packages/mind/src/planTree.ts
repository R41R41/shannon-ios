/**
 * The plan tree of one task (design mb-llm-centric 2.7, 2026-10-21): the model's own plan, kept by the common runtime and changed only
 * by the model (`plan.update`, a core tool of the FCA). Pure data: no executor, no permission, no approval (stage 5's TaskTree, which is
 * Codex's and approved, is a different thing). A task keeps one; the checkpoint holds it (`fcaPlanTree`), `agent_tasks.plan_json` a flat
 * copy for the app's task screen, and a body's command its display (`BodyPlanView`).
 *
 * Bounds: 64 nodes, 4 deep. A node's `state` is the same four words as the task tree's: done, blocked, continue (to be done), wait.
 * Two rules keep the tree honest without asking the model: a parent whose children are all done is done, and when the current node
 * is done and no new current is named, the next node not done (in order, depth first) becomes current.
 */
export const PLAN_TREE_SCHEMA = 'shannon.plan-tree.v1' as const;
export const PLAN_LIMITS = Object.freeze({ nodes: 64, depth: 4, title: 60, text: 120, reason: 80, ops: 24, split: 8, next: 3 });
export type PlanNodeState = 'done' | 'blocked' | 'continue' | 'wait';
export const PLAN_NODE_STATES: readonly PlanNodeState[] = ['done', 'blocked', 'continue', 'wait'];

export interface PlanNode {
  id: string; parentId: string | null; order: number; title: string; state: PlanNodeState;
  /** Where it is done (a coordinate and a few words: `(196,69,237) 村の北`). */
  where?: string;
  /** What shows it done (an observation: `iron_ingot×24 を持つ`, a milestone). */
  doneWhen?: string;
  note?: string;
  /** Why it is blocked. */
  reason?: string;
}
export interface PlanTree { schema: typeof PLAN_TREE_SCHEMA; revision: number; current: string | null; nodes: readonly PlanNode[] }

/** A node's fields as an op gives them. */
export interface PlanNodeDraft { id?: string; title: string; where?: string; doneWhen?: string; note?: string; state?: PlanNodeState }
export type PlanOp =
  | ({ op: 'add'; parent?: string | null; after?: string | null } & PlanNodeDraft)
  | { op: 'split'; id: string; into: readonly PlanNodeDraft[] }
  | { op: 'set'; id: string; state?: PlanNodeState; title?: string; where?: string; doneWhen?: string; note?: string; reason?: string }
  | { op: 'move'; id: string; parent?: string | null; after?: string | null }
  | { op: 'drop'; id: string };
export interface PlanUpdate { ops?: readonly PlanOp[]; current?: string | null }
export interface PlanUpdateResult { tree: PlanTree; changed: boolean; problem: string | null }

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/u;
const isText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !value.includes('\0');
const optionalText = (value: unknown, limit: number) => value === undefined || isText(value, limit);

export function emptyPlanTree(): PlanTree { return { schema: PLAN_TREE_SCHEMA, revision: 0, current: null, nodes: [] }; }

/** What is wrong with a tree (its shape, its links, its bounds), or null. */
export function planTreeProblem(tree: PlanTree): string | null {
  if (!treeShaped(tree)) return 'PLAN_SHAPE';
  if (tree.nodes.length > PLAN_LIMITS.nodes) return 'PLAN_TOO_MANY';
  const byId = new Map<string, PlanNode>();
  for (const node of tree.nodes) {
    if (!nodeFits(node) || byId.has(node.id)) return 'PLAN_NODE';
    byId.set(node.id, node);
  }
  for (const node of tree.nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) return 'PLAN_LINK';
    if (depthOf(byId, node.id) > PLAN_LIMITS.depth) return 'PLAN_DEPTH';
  }
  if (tree.current !== null && !byId.has(tree.current)) return 'PLAN_CURRENT';
  return null;
}
function treeShaped(tree: PlanTree): boolean {
  return !!tree && tree.schema === PLAN_TREE_SCHEMA && Number.isSafeInteger(tree.revision) && tree.revision >= 0 && Array.isArray(tree.nodes);
}
/** One node's own fields: its id, title, state, order and texts within their bounds. */
function nodeFits(node: PlanNode): boolean {
  if (!node || !ID.test(String(node.id)) || !isText(node.title, PLAN_LIMITS.title)) return false;
  if (!PLAN_NODE_STATES.includes(node.state) || !Number.isSafeInteger(node.order) || node.order < 0) return false;
  return [node.where, node.doneWhen, node.note].every(value => optionalText(value, PLAN_LIMITS.text)) && optionalText(node.reason, PLAN_LIMITS.reason);
}
/** A node's depth (1 at the top), or Infinity in a cycle. */
function depthOf(byId: ReadonlyMap<string, PlanNode>, id: string): number {
  let depth = 0;
  for (let node = byId.get(id); node; node = node.parentId === null ? undefined : byId.get(node.parentId)) {
    depth += 1;
    if (depth > PLAN_LIMITS.nodes) return Infinity;
  }
  return depth;
}

/** The nodes in order: parents before children, siblings by `order`, depth first. */
export function orderedPlan(nodes: readonly PlanNode[]): PlanNode[] {
  const children = new Map<string | null, PlanNode[]>();
  for (const node of nodes) children.set(node.parentId, [...children.get(node.parentId) ?? [], node]);
  for (const list of children.values()) list.sort((left, right) => left.order - right.order);
  const out: PlanNode[] = [];
  const walk = (parent: string | null) => {
    for (const node of children.get(parent) ?? []) {
      out.push(node);
      walk(node.id);
    }
  };
  walk(null);
  return out;
}

/** A tree read back from a checkpoint, or null when it is not a valid one. */
export function readPlanTree(value: unknown): PlanTree | null {
  if (!value || typeof value !== 'object') return null;
  const tree = value as PlanTree;
  try { return planTreeProblem(tree) ? null : JSON.parse(JSON.stringify(tree)) as PlanTree; } catch { return null; }
}

/** What is wrong with a `set` op's values (an empty text clears that field), or null. */
function setProblem(op: Extract<PlanOp, { op: 'set' }>): string | null {
  if (op.state !== undefined && !PLAN_NODE_STATES.includes(op.state)) return `${op.id} の state が合わない`;
  if (op.title !== undefined && !isText(op.title, PLAN_LIMITS.title)) return `${op.id} の title が長すぎる`;
  const fits = (value: string | undefined, limit: number) => value === undefined || value === '' || optionalText(value, limit);
  if (![op.where, op.doneWhen, op.note].every(value => fits(value, PLAN_LIMITS.text))) return `${op.id} の文が長すぎる`;
  return fits(op.reason, PLAN_LIMITS.reason) ? null : `${op.id} の reason が長すぎる`;
}

class PlanEdit {
  readonly nodes = new Map<string, PlanNode>();
  current: string | null;
  constructor(tree: PlanTree) {
    for (const node of tree.nodes) this.nodes.set(node.id, { ...node });
    this.current = tree.current;
  }
  freshId(): string {
    let top = 0;
    for (const id of this.nodes.keys()) {
      const match = /^n(\d{1,6})$/u.exec(id);
      if (match) top = Math.max(top, Number(match[1]));
    }
    return `n${top + 1}`;
  }
  children(parent: string | null): PlanNode[] {
    return [...this.nodes.values()].filter(node => node.parentId === parent).sort((left, right) => left.order - right.order);
  }
  /** Puts `node` among `parent`'s children right after `after` (null or absent: last), renumbering the siblings. */
  place(node: PlanNode, parent: string | null, after: string | null | undefined): string | null {
    if (parent !== null && !this.nodes.has(parent)) return `親 ${parent} が無い`;
    for (let up = parent; up !== null; up = this.nodes.get(up)?.parentId ?? null) if (up === node.id) return `${node.id} を自分の下へは動かせない`;
    const siblings = this.children(parent).filter(item => item.id !== node.id);
    const index = after === undefined || after === null ? siblings.length : siblings.findIndex(item => item.id === after) + 1;
    if (index === 0 && after) return `${after} は ${parent ?? '一番上'} の子ではない`;
    siblings.splice(index, 0, node);
    node.parentId = parent;
    siblings.forEach((item, order) => { item.order = order; });
    this.nodes.set(node.id, node);
    return null;
  }
  draft(draft: PlanNodeDraft, parent: string | null, after?: string | null): string | null {
    const id = draft.id ?? this.freshId();
    if (!ID.test(id)) return `id ${id} の形が合わない`;
    if (this.nodes.has(id)) return `id ${id} はもうある`;
    if (!isText(draft.title, PLAN_LIMITS.title)) return `${id} の title が無いか長すぎる（${PLAN_LIMITS.title}字まで）`;
    if (![draft.where, draft.doneWhen, draft.note].every(value => optionalText(value, PLAN_LIMITS.text))) return `${id} の文が長すぎる`;
    if (draft.state !== undefined && !PLAN_NODE_STATES.includes(draft.state)) return `${id} の state が合わない`;
    const node: PlanNode = { id, parentId: parent, order: 0, title: draft.title.trim(), state: draft.state ?? 'continue',
      ...(draft.where ? { where: draft.where } : {}), ...(draft.doneWhen ? { doneWhen: draft.doneWhen } : {}), ...(draft.note ? { note: draft.note } : {}) };
    return this.place(node, parent, after);
  }
  drop(id: string): void {
    for (const child of this.children(id)) this.drop(child.id);
    this.nodes.delete(id);
    if (this.current === id) this.current = null;
  }
  set(op: Extract<PlanOp, { op: 'set' }>): string | null {
    const node = this.nodes.get(op.id);
    if (!node) return `${op.id} が無い`;
    const problem = setProblem(op);
    if (problem) return problem;
    if (op.state) node.state = op.state;
    if (op.title) node.title = op.title.trim();
    for (const key of ['where', 'doneWhen', 'note', 'reason'] as const) {
      if (op[key] === '') delete node[key];
      else if (op[key] !== undefined) node[key] = op[key];
    }
    if (node.state !== 'blocked') delete node.reason;
    return null;
  }
  split(op: Extract<PlanOp, { op: 'split' }>): string | null {
    if (!this.nodes.has(op.id)) return `${op.id} が無い`;
    if (!Array.isArray(op.into) || !op.into.length || op.into.length > PLAN_LIMITS.split) return `split は 1〜${PLAN_LIMITS.split} 個`;
    for (const draft of op.into) {
      const problem = this.draft(draft, op.id);
      if (problem) return problem;
    }
    return null;
  }
  move(op: Extract<PlanOp, { op: 'move' }>): string | null {
    const node = this.nodes.get(op.id);
    if (!node) return `${op.id} が無い`;
    return this.place(node, op.parent === undefined ? node.parentId : op.parent, op.after);
  }
  dropOne(op: Extract<PlanOp, { op: 'drop' }>): string | null {
    if (!this.nodes.has(op.id)) return `${op.id} が無い`;
    this.drop(op.id);
    return null;
  }
  apply(op: PlanOp): string | null {
    switch (op?.op) {
      case 'add': return this.draft(op, op.parent ?? null, op.after);
      case 'split': return this.split(op);
      case 'set': return this.set(op);
      case 'move': return this.move(op);
      case 'drop': return this.dropOne(op);
      default: return 'op は add・split・set・move・drop';
    }
  }
  /** A parent whose children are all done is done (deepest first). */
  settleParents(): void {
    for (const node of orderedPlan([...this.nodes.values()]).reverse()) {
      const kids = this.children(node.id);
      if (kids.length && kids.every(kid => kid.state === 'done') && node.state !== 'blocked') node.state = 'done';
    }
  }
  /** The first node not done after `from` in order (or from the start): a leaf before its parent's turn comes. */
  nextOpen(from: string | null): string | null {
    const order = orderedPlan([...this.nodes.values()]);
    const start = from === null ? 0 : order.findIndex(node => node.id === from) + 1;
    const open = (node: PlanNode) => node.state !== 'done' && node.state !== 'blocked' && !this.children(node.id).some(kid => kid.state !== 'done');
    return [...order.slice(start), ...order.slice(0, start)].find(open)?.id ?? null;
  }
}

/**
 * The tree after `update`, all or nothing: one op that does not fit leaves the tree as it was and says why (Japanese, closed words).
 * `current`: the node now (null clears it); absent, a done current moves on by itself.
 */
export function applyPlanUpdate(tree: PlanTree, update: PlanUpdate): PlanUpdateResult {
  const ops = update.ops ?? [];
  if (!Array.isArray(ops) || ops.length > PLAN_LIMITS.ops) return { tree, changed: false, problem: `ops は ${PLAN_LIMITS.ops} 個まで` };
  const edit = new PlanEdit(tree);
  for (const [index, op] of ops.entries()) {
    const problem = edit.apply(op);
    if (problem) return { tree, changed: false, problem: `ops[${index}]: ${problem}` };
  }
  const current = settleCurrent(edit, update.current);
  if (current) return { tree, changed: false, problem: current };
  const nodes = orderedPlan([...edit.nodes.values()]);
  const next: PlanTree = { schema: PLAN_TREE_SCHEMA, revision: tree.revision + 1, current: edit.current, nodes };
  const problem = planTreeProblem(next);
  if (problem) return { tree, changed: false, problem: PROBLEM_WORDS[problem] ?? problem };
  const changed = JSON.stringify({ c: tree.current, n: tree.nodes }) !== JSON.stringify({ c: next.current, n: next.nodes });
  return { tree: changed ? next : tree, changed, problem: null };
}
const PROBLEM_WORDS: Readonly<Record<string, string>> = { PLAN_TOO_MANY: `節は ${PLAN_LIMITS.nodes} 個まで`, PLAN_DEPTH: `深さは ${PLAN_LIMITS.depth} まで` };
/** The current node after the ops: the one named, or (none named) the next open one when the current is done or gone. A problem, or null. */
function settleCurrent(edit: PlanEdit, named: string | null | undefined): string | null {
  if (named !== undefined) {
    if (named !== null && !edit.nodes.has(named)) return `current の ${named} が無い`;
    edit.current = named;
  }
  edit.settleParents();
  const now = edit.current === null ? undefined : edit.nodes.get(edit.current);
  if (named === undefined && (!now || now.state === 'done')) edit.current = edit.nextOpen(now ? now.id : null);
  return null;
}

/** The part of the plan a decision reads every turn: the way down to the current node, it, the next few, and what is blocked. */
export interface PlanPathView { done: string; path: readonly string[]; now: string | null; next: readonly string[]; blocked: readonly string[] }
const nodeLine = (node: PlanNode) => [`${node.id} ${node.title}`, node.where ? `＠${node.where}` : '', node.doneWhen ? `（済み: ${node.doneWhen}）` : '',
  node.note ? ` ${node.note}` : ''].join('');
export function planPath(tree: PlanTree): PlanPathView {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const path: string[] = [];
  const now = tree.current ? byId.get(tree.current) ?? null : null;
  for (let up = now?.parentId ? byId.get(now.parentId) : undefined; up; up = up.parentId ? byId.get(up.parentId) : undefined) path.unshift(up.title);
  const order = orderedPlan(tree.nodes), from = now ? order.findIndex(node => node.id === now.id) + 1 : 0;
  const next = order.slice(from).filter(node => node.state === 'continue' || node.state === 'wait')
    .filter(node => !order.some(other => other.parentId === node.id && other.state !== 'done')).slice(0, PLAN_LIMITS.next);
  return { done: `${tree.nodes.filter(node => node.state === 'done').length}/${tree.nodes.length}`, path,
    now: now ? nodeLine(now) : null, next: next.map(nodeLine),
    blocked: tree.nodes.filter(node => node.state === 'blocked').slice(0, 3).map(node => `${node.id} ${node.title}${node.reason ? ` — ${node.reason}` : ''}`) };
}

const MARK: Readonly<Record<PlanNodeState, string>> = { done: '済', blocked: '止', continue: '・', wait: '待' };
/** The whole tree as text, one node a line, indented by depth; the current node marked ▶. */
export function planText(tree: PlanTree): string {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const lines = orderedPlan(tree.nodes).map(node => {
    const depth = depthOf(byId, node.id) - 1, mark = node.id === tree.current ? '▶' : MARK[node.state];
    return `${'  '.repeat(depth)}${mark} ${nodeLine(node)}${node.state === 'blocked' && node.reason ? ` — ${node.reason}` : ''}`;
  });
  return [`計画 rev${tree.revision}（済み ${tree.nodes.filter(node => node.state === 'done').length}/${tree.nodes.length}）`, ...lines].join('\n');
}

/** The flat copy for `agent_tasks.plan_json` (the app's task list): indented titles, completed / running (the current) / pending. */
export function flatPlan(tree: PlanTree): Array<{ id: string; title: string; status: 'pending' | 'running' | 'completed' }> {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  return orderedPlan(tree.nodes).map(node => ({ id: node.id, title: `${'　'.repeat(depthOf(byId, node.id) - 1)}${node.title}`,
    status: node.id === tree.current ? 'running' : node.state === 'done' ? 'completed' : 'pending' }));
}

/** What a body shows (`BodyPlanView`): ids, parents, titles, states and the current node; the reason of a blocked one. */
export function planDisplay(tree: PlanTree): { revision: number; current: string | null;
  nodes: Array<{ id: string; parentId: string | null; title: string; state: PlanNodeState; reason?: string }> } {
  return { revision: tree.revision, current: tree.current, nodes: orderedPlan(tree.nodes).map(node => ({ id: node.id, parentId: node.parentId,
    title: node.title, state: node.state, ...(node.state === 'blocked' && node.reason ? { reason: node.reason } : {}) })) };
}

/** A tree made whole from drafts (the first plan): each with its children, in order. Null when it does not fit the bounds. */
export interface PlanSeed extends PlanNodeDraft { children?: readonly PlanSeed[] }
export function planFromSeeds(seeds: readonly PlanSeed[]): PlanTree | null {
  const ops: PlanOp[] = [];
  const walk = (list: readonly PlanSeed[], parent: string | null, prefix: string) => list.forEach((seed, index) => {
    const { children, ...draft } = seed, id = seed.id ?? `${prefix}${index + 1}`;
    ops.push({ op: 'add', parent, ...draft, id });
    walk(children ?? [], id, `${id}.`);
  });
  walk(seeds, null, 'p');
  if (!ops.length || ops.length > PLAN_LIMITS.nodes) return null;
  const edit = new PlanEdit(emptyPlanTree());
  for (const op of ops) if (edit.apply(op)) return null;
  edit.current = edit.nextOpen(null);
  const tree: PlanTree = { schema: PLAN_TREE_SCHEMA, revision: 1, current: edit.current, nodes: orderedPlan([...edit.nodes.values()]) };
  return planTreeProblem(tree) ? null : tree;
}
