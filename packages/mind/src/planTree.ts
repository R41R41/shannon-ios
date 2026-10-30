import { depthOf,orderedPlan } from './planTreeView.js';
import { migratePlanTree } from './planTreeMigration.js';
import type { PlanTreeV1 } from './planTreeMigration.js';
import { PLAN_TREE_SCHEMA,PLAN_TREE_SCHEMA_V1,PLAN_LIMITS,PLAN_NODE_STATES,PLAN_KINDS,PREP_STATES } from './planTreeTypes.js';
import type {
PlanKind,PlanPrep,PlanPromise,PlanNode,PlanTree,PlanNodeDraft,
PromiseOp,PlanOp,PlanUpdate,PlanUpdateContext,PlanUpdateResult
} from './planTreeTypes.js';
export { orderedPlan, planRules, planPath, planText, flatPlan, planDisplay } from './planTreeView.js';
export type { PlanPathView } from './planTreeView.js';
export { migratePlanTree } from './planTreeMigration.js';
export type { PlanTreeV1 } from './planTreeMigration.js';
export { PLAN_TREE_SCHEMA, PLAN_TREE_SCHEMA_V1, PLAN_LIMITS, PLAN_NODE_STATES, PLAN_KINDS, PREP_STATES } from './planTreeTypes.js';
export type { PlanNodeState, PlanKind, PrepState, PlanPrep, PlanCondition, PromiseEvent, PlanPromise, PlanNode, PlanTree, PlanNodeDraft,
   PromiseOp, PlanOp, PlanUpdate, PlanUpdateContext, PlanUpdateResult } from './planTreeTypes.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/u;
const isText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !value.includes('\0');
const optionalText = (value: unknown, limit: number) => value === undefined || isText(value, limit);

export function emptyPlanTree(): PlanTree { return { schema: PLAN_TREE_SCHEMA, revision: 0, current: null, nodes: [], promises: [] }; }

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
  return promisesProblem(tree.promises) ? 'PLAN_PROMISES' : null;
}
const PROMISE_ITEM = /^[a-z][a-z0-9_]{0,63}$/u;
const kindFits = (value: unknown) => value === undefined || (PLAN_KINDS as readonly string[]).includes(String(value));
const prepFits = (value: unknown) => value === undefined || (!!value && typeof value === 'object' && (
  PREP_STATES as readonly string[]).includes(String((value as PlanPrep).state))
  && optionalText((value as PlanPrep).why, PLAN_LIMITS.text) && optionalText((value as PlanPrep).at, 40));
/** What is wrong with the promises of a tree (the shape and bounds of each; the ledger is the head's), or null. */
function promisesProblem(promises: unknown): string | null {
  if (!Array.isArray(promises) || promises.length > PLAN_LIMITS.promises) return 'promises';
  const ids = new Set<number>();
  for (const item of promises as PlanPromise[]) {
    if (invalidPromiseIdentity(item, ids)) return 'id';
    ids.add(item.id);
    if (!promiseItemFits(item.item) || !Number.isSafeInteger(item.count) || item.count < 1 || !isText(item.use, PLAN_LIMITS.promiseUse)) return 'fields';
    if (!['open', 'kept_by_instead', 'closed'].includes(item.state) || !Array.isArray(item.ledger)) return 'state';
    if (item.have !== undefined && !(typeof item.have === 'number' && Number.isFinite(item.have) && item.have >= 0)) return 'have';
  }
  return null;
}
/** A promise's item: `food` (food points) or a concrete item name (`oak_planks`; `planks` counts every kind, as
 * `have` reads it). */
export const promiseItemFits = (value: unknown): boolean => typeof value === 'string' && PROMISE_ITEM.test(value);
function treeShaped(tree: PlanTree): boolean {
  return !!tree && tree.schema === PLAN_TREE_SCHEMA && Number.isSafeInteger(tree.revision) && tree.revision >= 0 && Array.isArray(tree.nodes);
}
/** One node's own fields: its id, title, state, order and texts within their bounds. */
function nodeFits(node: PlanNode): boolean {
  if (!node || !ID.test(String(node.id)) || !isText(node.title, PLAN_LIMITS.title)) return false;
  if (!PLAN_NODE_STATES.includes(node.state) || !Number.isSafeInteger(node.order) || node.order < 0) return false;
  return [node.where, node.doneWhen, node.note].every(value => optionalText(value, PLAN_LIMITS.text)) && optionalText(node.reason, PLAN_LIMITS.reason)
    && rulesFit(node.forbid) && rulesFit(node.caution) && kindFits(node.kind) && optionalText(node.kindRaw, 64) && prepFits(node.prep);
}
/** A node's forbid or caution: absent, or at most `PLAN_LIMITS.rules` lines, each a text within `PLAN_LIMITS.rule`. */
function rulesFit(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= PLAN_LIMITS.rules && value.every(item => isText(item, PLAN_LIMITS.rule)));
}
/** What is wrong with a draft's own fields (its id's form, title, texts, state), or null. */
function draftProblem(draft: PlanNodeDraft, id: string): string | null {
  if (!ID.test(id)) return `id ${id} の形が合わない`;
  if (!isText(draft.title, PLAN_LIMITS.title)) return `${id} の title が無いか長すぎる（${PLAN_LIMITS.title}字まで）`;
  if (![draft.where, draft.doneWhen, draft.note].every(value => optionalText(value, PLAN_LIMITS.text))) return `${id} の文が長すぎる`;
  if (draft.state !== undefined && !PLAN_NODE_STATES.includes(draft.state)) return `${id} の state が合わない`;
  if (draft.kind !== undefined && !isText(draft.kind, 64)) return `${id} の kind は 64 字までの語`;
  return prepFits(draft.prep) ? null : `${id} の prep は state（met・skipped・unmet_now）と why`;
}
/** A kind as the model wrote it: one of the list as it is, anything else `other` with the value kept. */
function kindOf(value: string | undefined): { kind: PlanKind; kindRaw?: string } {
  if (value === undefined) return { kind: 'other' };
  const word = value.trim();
  return (PLAN_KINDS as readonly string[]).includes(word) ? { kind: word as PlanKind } : { kind: 'other', kindRaw: word.slice(0, 64) };
}
/** A node from a draft whose fields fit (`draftProblem`), with its forbid and caution as kept (`draftRules`). */
function draftNode(draft: PlanNodeDraft, id: string, parent: string | null, forbid?: string[], caution?: string[]): PlanNode {
  return { id, parentId: parent, order: 0, title: draft.title.trim(), state: draft.state ?? 'continue', ...kindOf(draft.kind),
    ...(draft.prep ? { prep: { ...draft.prep } } : {}),
    ...(draft.where ? { where: draft.where } : {}), ...(draft.doneWhen ? { doneWhen: draft.doneWhen } : {}), ...(draft.note ? { note: draft.note } : {}),
    ...(forbid ? { forbid } : {}), ...(caution ? { caution } : {}) };
}
/** r4: takes `text` off a node's forbid and caution (the same line, or else the one line that contains it), or says why not. */
function liftRule(node: PlanNode, id: string, text: string): string | null {
  const all = [...(node.forbid ?? []), ...(node.caution ?? [])];
  const exact = all.filter(line => line === text), within = all.filter(line => line.includes(text));
  const gone = exact.length ? exact : within.length === 1 ? within : [];
  if (!gone.length) return within.length > 1 ? `${id} に「${text}」を含む行が ${within.length} つある（全文で書く）` : `${id} に「${text}」の禁止・注意は無い`;
  for (const key of ['forbid', 'caution'] as const) {
    const kept = (node[key] ?? []).filter(line => !gone.includes(line));
    if (kept.length) node[key] = kept;
    else delete node[key];
  }
  return null;
}
/** A draft's forbid or caution as the node keeps it (trimmed, no repeats), or a problem. */
function draftRules(value: unknown, id: string, label: string): { rules?: string[]; problem?: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) return { problem: `${id} の ${label} は文の配列` };
  const rules = [...new Set(value.map(item => typeof item === 'string' ? item.trim() : item))];
  if (!rulesFit(rules)) return { problem: `${id} の ${label} は ${PLAN_LIMITS.rules} 行まで・1 行 ${PLAN_LIMITS.rule}字まで` };
  return rules.length ? { rules: rules as string[] } : {};
}

/** A tree read back from a checkpoint, or null when it is not a valid one. A v1 tree is moved to v2 once (`migratePlanTree`). */
export function readPlanTree(value: unknown): PlanTree | null { return readPlanTreeWith(value)?.tree ?? null; }
/** The same, saying whether the tree was moved from v1 (the caller writes the one line of it in the plan's log). */
export function readPlanTreeWith(value: unknown): { tree: PlanTree; migrated: boolean } | null {
  if (!value || typeof value !== 'object') return null;
  try {
    const copy = JSON.parse(JSON.stringify(value)) as PlanTree | PlanTreeV1;
    const migrated = (copy as PlanTreeV1).schema === PLAN_TREE_SCHEMA_V1;
    const tree = migrated ? migratePlanTree(copy as PlanTreeV1) : copy as PlanTree;
    return planTreeProblem(tree) ? null : { tree, migrated };
  } catch { return null; }
}

/** What is wrong with a `set` op's values (an empty text clears that field), or null. */
function setProblem(op: Extract<PlanOp, { op: 'set' }>): string | null {
  if (op.state !== undefined && !PLAN_NODE_STATES.includes(op.state)) return `${op.id} の state が合わない`;
  if (op.title !== undefined && !isText(op.title, PLAN_LIMITS.title)) return `${op.id} の title が長すぎる`;
  const fits = (value: string | undefined, limit: number) => value === undefined || value === '' || optionalText(value, limit);
  if (![op.where, op.doneWhen, op.note].every(value => fits(value, PLAN_LIMITS.text))) return `${op.id} の文が長すぎる`;
  if (op.kind !== undefined && !isText(op.kind, 64)) return `${op.id} の kind は 64 字までの語`;
  if (!prepFits(op.prep)) return `${op.id} の prep は state（met・skipped・unmet_now）と why`;
  return fits(op.reason, PLAN_LIMITS.reason) ? null : `${op.id} の reason が長すぎる`;
}

class PlanEdit {
  readonly nodes = new Map<string, PlanNode>();
  promises: PlanPromise[];
  current: string | null;
  constructor(tree: PlanTree, private readonly context: PlanUpdateContext = {}) {
    for (const node of tree.nodes) this.nodes.set(node.id, { ...node });
    this.promises = tree.promises.map(item => ({ ...item, ledger: [...item.ledger] }));
    this.current = tree.current;
  }
  /** A promise made or revised (the model writes it; the ledger gets `made` or `revised`). */
  promise(op: PromiseOp): string | null {
    const problem = promiseOpProblem(op);
    if (problem) return problem;
    const at = this.context.at ?? new Date(0).toISOString();
    const base = { item: op.item, count: op.count, use: op.use.trim(), ...(op.until && (op.until.node || op.until.condition) ? { until: {
       ...op.until } } : {}),
      ...(op.instead ? { instead: op.instead } : {}) };
    if (op.id === undefined) {
      if (this.promises.length >= PLAN_LIMITS.promises) {
        const closed = this.promises.findIndex(item => item.state === 'closed');
        if (closed < 0) return `約束は ${PLAN_LIMITS.promises} つまで（release で閉じてから）`;
        this.promises.splice(closed, 1);
      }
      const id = this.promises.reduce((top, item) => Math.max(top, item.id), 0) + 1;
      this.promises.push({ id, rev: 1, ...base, state: 'open', ledger: [{ id: 'plan:1', at, kind: 'made', count: op.count, have: 0 }] });
      return null;
    }
    const index = this.promises.findIndex(item => item.id === op.id);
    if (index < 0) return `約束 #${op.id} が無い`;
    const old = this.promises[index]!, rev = old.rev + 1;
    // The count the ledger took is of the old item: a revision to another item starts it again.
    const { until: _u, instead: _i, closedBy: _c, ...keptAll } = old;
    const { have: _h, ...kept } = keptAll;
    const carry = old.item === op.item && old.have !== undefined ? { have: old.have } : {};
    this.promises[index] = { ...kept, ...carry, ...base, rev, state: 'open', ledger: [...old.ledger, { id: `plan:${rev}`, at, kind:
       'revised', count: op.count, have: 0 }] };
    return null;
  }
  /** A promise let go: closed by the release. */
  release(op: { id: number; why?: string }): string | null {
    const index = this.promises.findIndex(item => item.id === op.id);
    if (index < 0) return `約束 #${op.id} が無い`;
    const old = this.promises[index]!;
    if (old.state === 'closed') return null;
    this.promises[index] = { ...old, state: 'closed', closedBy: 'released',
      ledger: [...old.ledger, { id: `plan:release:${old.rev}`, at: this.context.at ?? new Date(0).toISOString(), kind: 'released', count: 0, have: 0,
        ...(op.why ? { reason: String(op.why).slice(0, PLAN_LIMITS.reason) } : {}) }] };
    return null;
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
    const problem = this.nodes.has(id) && ID.test(id) ? `id ${id} はもうある` : draftProblem(draft, id);
    if (problem) return problem;
    const forbid = draftRules(draft.forbid, id, 'forbid'), caution = draftRules(draft.caution, id, 'caution');
    if (forbid.problem || caution.problem) return forbid.problem ?? caution.problem!;
    return this.place(draftNode(draft, id, parent, forbid.rules, caution.rules), parent, after);
  }
  /** r4: the node an op names for its forbid or caution (absent id: the current one), or why there is none. */
  ruleNode(id: string | undefined, op: string): { node: PlanNode; id: string } | { problem: string } {
    const named = id ?? this.current;
    const node = named === null ? undefined : this.nodes.get(named);
    return node ? { node, id: node.id } : { problem: named === null ? `${op} の id が無く、今の節も無い` : `${named} が無い` };
  }
  /** r4: one forbid or caution line added to a node (absent id: the current one), the oldest dropped past the bound. */
  rule(op: { op: 'forbid' | 'caution'; id?: string; text: string }): string | null {
    const target = this.ruleNode(op.id, op.op);
    if ('problem' in target) return target.problem;
    const text = typeof op.text === 'string' ? op.text.trim() : '';
    if (!isText(text, PLAN_LIMITS.rule)) return `${op.op} の text が無いか長すぎる（${PLAN_LIMITS.rule}字まで）`;
    const lines = [...target.node[op.op] ?? []].filter(line => line !== text);
    lines.push(text);
    target.node[op.op] = lines.slice(-PLAN_LIMITS.rules);
    return null;
  }
  /** r4: a forbid or caution line taken off a node: the same text, or else the one line that contains it. */
  lift(op: { id?: string; text: string }): string | null {
    const target = this.ruleNode(op.id, 'lift');
    if ('problem' in target) return target.problem;
    const text = typeof op.text === 'string' ? op.text.trim() : '';
    return text ? liftRule(target.node, target.id, text) : 'lift の text が無い';
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
    if (op.kind !== undefined) {
      const kind = kindOf(op.kind);
      node.kind = kind.kind;
      if (kind.kindRaw) node.kindRaw = kind.kindRaw;
      else delete node.kindRaw;
    }
    if (op.prep !== undefined) {
      const at = op.prep.at ?? this.context.at;
      node.prep = { state: op.prep.state, ...(op.prep.why ? { why: op.prep.why } : {}), ...(at ? { at } : {}) };
    }
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
      case 'forbid': case 'caution': return this.rule(op as { op: 'forbid' | 'caution'; id?: string; text: string });
      case 'lift': return this.lift(op);
      case 'promise': return this.promise(op);
      case 'release': return this.release(op);
      default: return 'op は add・split・set・move・drop・forbid・caution・lift・promise・release';
    }
  }
  /** A parent whose children are all done is done (deepest first). */
  settleParents(): void {
    for (const node of orderedPlan([...this.nodes.values()]).reverse()) {
      const kids = this.children(node.id);
      if (kids.length && kids.every(kid => kid.state === 'done') && node.state !== 'blocked') node.state = 'done';
    }
  }
  /** r9: whether a node above `node` is done (a done node leaves nothing under it to do, so none of its open
 * children is the next). */
  doneAbove(node: PlanNode): boolean {
    for (let up = node.parentId, guard = 0; up !== null && guard < PLAN_LIMITS.nodes; up = this.nodes.get(up)?.parentId ?? null, guard += 1) {
      if (this.nodes.get(up)?.state === 'done') return true;
    }
    return false;
  }
  /** The first node not done after `from` in order (or from the start): a leaf before its parent's turn comes. */
  nextOpen(from: string | null): string | null {
    const order = orderedPlan([...this.nodes.values()]);
    const start = from === null ? 0 : order.findIndex(node => node.id === from) + 1;
    const open = (node: PlanNode) => node.state !== 'done' && node.state !== 'blocked' && !this.children(node.id).some(kid => kid.state !== 'done')
      && !this.doneAbove(node);
    return [...order.slice(start), ...order.slice(0, start)].find(open)?.id ?? null;
  }
}

/**
 * The tree after `update`, all or nothing: one op that does not fit leaves the tree as it was and says why (Japanese, closed words).
 * `current`: the node now (null clears it); absent, a done current moves on by itself.
 */
export function applyPlanUpdate(tree: PlanTree, update: PlanUpdate, context: PlanUpdateContext = {}): PlanUpdateResult {
  const ops = update.ops ?? [];
  if (!Array.isArray(ops) || ops.length > PLAN_LIMITS.ops) return { tree, changed: false, problem: `ops は ${PLAN_LIMITS.ops} 個まで` };
  const edit = new PlanEdit(tree, context);
  for (const [index, op] of ops.entries()) {
    const problem = edit.apply(op);
    if (problem) return { tree, changed: false, problem: `ops[${index}]: ${problem}` };
  }
  const current = settleCurrent(edit, update.current);
  if (current) return { tree, changed: false, problem: current };
  const nodes = orderedPlan([...edit.nodes.values()]);
  const next: PlanTree = { schema: PLAN_TREE_SCHEMA, revision: tree.revision + 1, current: edit.current, nodes, promises: edit.promises };
  const problem = planTreeProblem(next);
  if (problem) return { tree, changed: false, problem: PROBLEM_WORDS[problem] ?? problem };
  const changed = JSON.stringify({ c: tree.current, n: tree.nodes, p: tree.promises }) !== JSON.stringify({ c: next.current, n: next.nodes,
     p: next.promises });
  return { tree: changed ? next : tree, changed, problem: null };
}
const PROBLEM_WORDS: Readonly<Record<string, string>> = { PLAN_TOO_MANY: `節は ${PLAN_LIMITS.nodes} 個まで`, PLAN_DEPTH: `深さは ${PLAN_LIMITS.depth} まで`,
  PLAN_PROMISES: '約束の形が合わない' };
/** The current node after the ops: the one named, or (none named) the next open one when the current is done or
 * gone. A problem, or null. */
function settleCurrent(edit: PlanEdit, named: string | null | undefined): string | null {
  if (named !== undefined) {
    if (named !== null && !edit.nodes.has(named)) return `current の ${named} が無い`;
    edit.current = named;
  }
  edit.settleParents();
  const now = edit.current === null ? undefined : edit.nodes.get(edit.current);
  if (named === undefined && (!now || now.state === 'done' || edit.doneAbove(now))) edit.current = edit.nextOpen(now ? now.id : null);
  return null;
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
  const tree: PlanTree = { schema: PLAN_TREE_SCHEMA, revision: 1, current: edit.current, nodes: orderedPlan([...edit.nodes.values()]), promises: [] };
  return planTreeProblem(tree) ? null : tree;
}

/** 約束の識別子・改訂番号・重複の確認。 */
function invalidPromiseIdentity(item: PlanPromise, ids: Set<number>): boolean {
  return !item || !Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id) || !Number.isSafeInteger(item.rev) || item.rev < 1;
}

/** 約束を書き換える前に入力を確認する。 */
function promiseOpProblem(op: PromiseOp): string | null {
    if (!promiseItemFits(op.item)) return 'promise の item は物の名前（oak_planks・cobblestone）か food';
    if (!Number.isSafeInteger(op.count) || op.count < 1 || op.count > PLAN_LIMITS.promiseCount) return `promise の count は 1〜${PLAN_LIMITS.promiseCount} の整数`;
    if (!isText(op.use, PLAN_LIMITS.promiseUse)) return `promise の use は ${PLAN_LIMITS.promiseUse} 字までの言葉`;
    if (op.until?.node !== undefined && !ID.test(op.until.node)) return 'promise の until.node は節の id';
  return null;
}
