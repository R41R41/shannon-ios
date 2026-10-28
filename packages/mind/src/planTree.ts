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
export const PLAN_TREE_SCHEMA = 'shannon.plan-tree.v2' as const;
/** The schema before the `continue` contract (v3.1, 2026-10-28): read once and moved to v2 by `migratePlanTree`. */
export const PLAN_TREE_SCHEMA_V1 = 'shannon.plan-tree.v1' as const;
/**
 * `rules`: a node's forbid and caution lines each (mb-llmc r4: `forbid`, `caution`), `rule` their length, `shownRules` how many of them the
 * path shows (the current node's and its parents', `planPath`).
 */
export const PLAN_LIMITS = Object.freeze({ nodes: 64, depth: 4, title: 60, text: 120, reason: 80, ops: 24, split: 8, next: 3, rules: 4, rule: 80,
  shownRules: 8, promises: 32, promiseUse: 40, ledger: 32, promiseCount: 2304 });
export type PlanNodeState = 'done' | 'blocked' | 'continue' | 'wait';
export const PLAN_NODE_STATES: readonly PlanNodeState[] = ['done', 'blocked', 'continue', 'wait'];

/**
 * The kind of a node (the `continue` contract, chapter 7): chosen by the model, never inferred from the title by the code (only the one move from
 * v1, `migratePlanTree`, reads titles). A value outside the list is taken as `other` with the written value kept in `kindRaw`.
 */
export const PLAN_KINDS = ['wood', 'stone_tools', 'food', 'bed', 'village', 'prep_descent', 'iron', 'iron_armor', 'diamond', 'water', 'lava', 'obsidian',
  'portal', 'nether', 'fortress', 'blaze', 'pearl', 'stronghold', 'end', 'dragon', 'chest', 'other'] as const;
export type PlanKind = typeof PLAN_KINDS[number];
/** The state of a preparation node (apart from the work's `state`); only the model writes it. */
export const PREP_STATES = ['met', 'skipped', 'unmet_now'] as const;
export type PrepState = typeof PREP_STATES[number];
export interface PlanPrep { state: PrepState; why?: string; at?: string }

/** A condition as the plan keeps it: alternatives of conjunctions of clauses (the head's `ActCondition`; this package reads none of it). */
export type PlanCondition = ReadonlyArray<ReadonlyArray<Readonly<Record<string, unknown>>>>;
export interface PromiseEvent {
  id: string; at: string; kind: 'made' | 'revised' | 'consumed' | 'gained' | 'lost_death' | 'unexplained' | 'released' | 'closed';
  count: number; have: number; declared?: boolean; reason?: string; promiseRev?: number;
  by?: { command?: string; item?: string; pass?: number; hand?: number };
}
/** A promise (chapter 3): what to keep, for what, until when, and the ledger of what happened to it. Written by the model; the ledger by the head. */
export interface PlanPromise {
  id: number; rev: number; item: string; count: number; use: string;
  until?: { node?: string; condition?: PlanCondition }; instead?: PlanCondition;
  state: 'open' | 'kept_by_instead' | 'closed'; closedBy?: 'until' | 'released';
  ledger: PromiseEvent[]; dropped?: number;
}

export interface PlanNode {
  id: string; parentId: string | null; order: number; title: string; state: PlanNodeState;
  kind?: PlanKind;
  /** The kind the model wrote when it is not in `PLAN_KINDS` (the node is `other`). */
  kindRaw?: string;
  prep?: PlanPrep;
  /** Where it is done (a coordinate and a few words: `(196,69,237) 村の北`). */
  where?: string;
  /** What shows it done (an observation: `iron_ingot×24 を持つ`, a milestone). */
  doneWhen?: string;
  note?: string;
  /** Why it is blocked. */
  reason?: string;
  /**
   * mb-llmc r4 (owner 2026-10-22; arch-check 23: of what a supervisor wrote, the forbids and cautions held longest and worked): what not to
   * do (`forbid`) and what to mind (`caution`) while this node or one under it is the current one; at most `PLAN_LIMITS.rules` each.
   */
  forbid?: readonly string[];
  caution?: readonly string[];
}
export interface PlanTree {
  schema: typeof PLAN_TREE_SCHEMA; revision: number; current: string | null; nodes: readonly PlanNode[];
  promises: readonly PlanPromise[];
}

/** A node's fields as an op gives them. */
export interface PlanNodeDraft { id?: string; title: string; where?: string; doneWhen?: string; note?: string; state?: PlanNodeState;
  forbid?: readonly string[]; caution?: readonly string[]; kind?: string; prep?: PlanPrep }
export interface PromiseOp { op: 'promise'; id?: number; item: string; count: number; use: string; until?: { node?: string; condition?: PlanCondition };
  instead?: PlanCondition }
export type PlanOp =
  | ({ op: 'add'; parent?: string | null; after?: string | null } & PlanNodeDraft)
  | { op: 'split'; id: string; into: readonly PlanNodeDraft[] }
  | { op: 'set'; id: string; state?: PlanNodeState; title?: string; where?: string; doneWhen?: string; note?: string; reason?: string;
      kind?: string; prep?: PlanPrep }
  | PromiseOp
  | { op: 'release'; id: number; why?: string }
  | { op: 'move'; id: string; parent?: string | null; after?: string | null }
  | { op: 'drop'; id: string }
  /**
   * mb-llmc r4: `forbid` / `caution` add one line to node `id` (absent: the current node; the oldest goes past `PLAN_LIMITS.rules`, the same
   * line is not added twice); `lift` takes a line off node `id`'s forbid and caution (the same text, or the one line that contains it).
   */
  | { op: 'forbid' | 'caution' | 'lift'; id?: string; text: string };
export interface PlanUpdate { ops?: readonly PlanOp[]; current?: string | null }
/** When the update is applied (ISO), for the times a promise and a preparation state keep. */
export interface PlanUpdateContext { at?: string }
export interface PlanUpdateResult { tree: PlanTree; changed: boolean; problem: string | null }

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
const prepFits = (value: unknown) => value === undefined || (!!value && typeof value === 'object' && (PREP_STATES as readonly string[]).includes(String((value as PlanPrep).state))
  && optionalText((value as PlanPrep).why, PLAN_LIMITS.text) && optionalText((value as PlanPrep).at, 40));
/** What is wrong with the promises of a tree (the shape and bounds of each; the ledger is the head's), or null. */
function promisesProblem(promises: unknown): string | null {
  if (!Array.isArray(promises) || promises.length > PLAN_LIMITS.promises) return 'promises';
  const ids = new Set<number>();
  for (const item of promises as PlanPromise[]) {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id) || !Number.isSafeInteger(item.rev) || item.rev < 1) return 'id';
    ids.add(item.id);
    if (!promiseItemFits(item.item) || !Number.isSafeInteger(item.count) || item.count < 1 || !isText(item.use, PLAN_LIMITS.promiseUse)) return 'fields';
    if (!['open', 'kept_by_instead', 'closed'].includes(item.state) || !Array.isArray(item.ledger)) return 'state';
  }
  return null;
}
/** A promise's item: `food` (food points) or a concrete item name (`oak_planks`; `planks` counts every kind, as `have` reads it). */
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

/** The v1 tree: no kinds, no preparation states, no promises. */
export interface PlanTreeV1 { schema: typeof PLAN_TREE_SCHEMA_V1; revision: number; current: string | null; nodes: readonly PlanNode[] }
const OLD_SKIPPED = '準備を省いた';
/**
 * The one place where a title is read for its kind: a v1 tree held no kind, so each node gets the kind its title (and `doneWhen`) said to the code that
 * used to read them (chapter 7, table 1-15). The note `準備を省いた…` that the v1 head wrote becomes `prep.state: skipped`; a done preparation node
 * becomes `met`. The revision goes up by one. A tree that is already v2 is returned as it is.
 */
export function migratePlanTree(tree: PlanTreeV1 | PlanTree): PlanTree {
  if (tree.schema === PLAN_TREE_SCHEMA) return tree;
  const nodes = tree.nodes.map(node => {
    const kind = kindFromV1(node);
    const skipped = node.state === 'done' && (node.note ?? '').startsWith(OLD_SKIPPED);
    const prep: PlanPrep | undefined = skipped ? { state: 'skipped' } : kind === 'prep_descent' && node.state === 'done' ? { state: 'met' } : undefined;
    return { ...node, kind, ...(prep ? { prep } : {}) } as PlanNode;
  });
  return { schema: PLAN_TREE_SCHEMA, revision: tree.revision + 1, current: tree.current, nodes, promises: [] };
}
function kindFromV1(node: PlanNode): PlanKind {
  const title = node.title, done = node.doneWhen ?? '';
  const food = /food>=(\d{1,4})/u.exec(done.replace(/\s+/gu, '').toLowerCase())?.[1];
  if (/ドラゴン|エンドラ/u.test(title)) return 'dragon';
  if (/ストロングホールド/u.test(title)) return 'stronghold';
  if (/パール|アイ/u.test(title)) return 'pearl';
  if (/エンド(?!ウ)|三角|ポータルの部屋/u.test(title)) return 'end';
  if (/地下の準備|下る準備|下りる準備/u.test(title) || (food !== undefined && Number(food) >= 40 && Number(food) < 100)) return 'prep_descent';
  if (/ゲート|ポータル|ネザーに入|金のブーツ/u.test(title)) return 'portal';
  if (/黒曜石|火打/u.test(title)) return 'obsidian';
  if (/要塞/u.test(title)) return 'fortress';
  if (/ブレイズ/u.test(title)) return 'blaze';
  if (/ネザー/u.test(title)) return 'nether';
  if (/ダイヤ/u.test(title)) return 'diamond';
  if (/鉄の防具|鉄装備/u.test(title)) return 'iron_armor';
  if (/鉄/u.test(title) || /iron_ingot|raw_iron/u.test(done)) return 'iron';
  if (/食料|食べ物|狩|肉|ホグリン|パン/u.test(title) || food !== undefined) return 'food';
  if (/箱|樽|チェスト|chest|barrel/iu.test(title)) return 'chest';
  if (/ベッド/u.test(title)) return 'bed';
  if (/村/u.test(title)) return 'village';
  if (/石のツルハシ|石の道具|石器/u.test(title)) return 'stone_tools';
  if (/溶岩/u.test(title)) return 'lava';
  if (/水/u.test(title)) return 'water';
  if (/原木|木/u.test(title)) return 'wood';
  return 'other';
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
    if (!promiseItemFits(op.item)) return 'promise の item は物の名前（oak_planks・cobblestone）か food';
    if (!Number.isSafeInteger(op.count) || op.count < 1 || op.count > PLAN_LIMITS.promiseCount) return `promise の count は 1〜${PLAN_LIMITS.promiseCount} の整数`;
    if (!isText(op.use, PLAN_LIMITS.promiseUse)) return `promise の use は ${PLAN_LIMITS.promiseUse} 字までの言葉`;
    if (op.until?.node !== undefined && !ID.test(op.until.node)) return 'promise の until.node は節の id';
    const at = this.context.at ?? new Date(0).toISOString();
    const base = { item: op.item, count: op.count, use: op.use.trim(), ...(op.until && (op.until.node || op.until.condition) ? { until: { ...op.until } } : {}),
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
    const { until: _u, instead: _i, closedBy: _c, ...kept } = old;
    this.promises[index] = { ...kept, ...base, rev, state: 'open', ledger: [...old.ledger, { id: `plan:${rev}`, at, kind: 'revised', count: op.count, have: 0 }] };
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
  /** r9: whether a node above `node` is done (a done node leaves nothing under it to do, so none of its open children is the next). */
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
  const changed = JSON.stringify({ c: tree.current, n: tree.nodes, p: tree.promises }) !== JSON.stringify({ c: next.current, n: next.nodes, p: next.promises });
  return { tree: changed ? next : tree, changed, problem: null };
}
const PROBLEM_WORDS: Readonly<Record<string, string>> = { PLAN_TOO_MANY: `節は ${PLAN_LIMITS.nodes} 個まで`, PLAN_DEPTH: `深さは ${PLAN_LIMITS.depth} まで`,
  PLAN_PROMISES: '約束の形が合わない' };
/** The current node after the ops: the one named, or (none named) the next open one when the current is done or gone. A problem, or null. */
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

/**
 * The part of the plan a decision reads every turn: the way down to the current node, it, the next few, and what is blocked; r4: `rules`,
 * the forbid and caution lines of the current node and of every node above it (the nearest node first, each node's forbids before its cautions, at most
 * `PLAN_LIMITS.shownRules`), present only when there is one.
 */
export interface PlanPathView { done: string; path: readonly string[]; now: string | null; next: readonly string[]; blocked: readonly string[];
  rules?: readonly string[] }
/** The forbid and caution lines that hold at `now`: its own, then its parents' up to the top. */
export function planRules(tree: PlanTree, now: PlanNode | null = tree.current ? tree.nodes.find(node => node.id === tree.current) ?? null : null): string[] {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const lines: string[] = [];
  for (let node: PlanNode | undefined = now ?? undefined; node; node = node.parentId ? byId.get(node.parentId) : undefined) {
    const own = node.id === now?.id ? '' : `（${node.id}）`;
    for (const line of node.forbid ?? []) lines.push(`禁止${own}: ${line}`);
    for (const line of node.caution ?? []) lines.push(`注意${own}: ${line}`);
  }
  return lines.slice(0, PLAN_LIMITS.shownRules);
}
const nodeLine = (node: PlanNode) => [`${node.id} ${node.title}`, node.where ? `＠${node.where}` : '', node.doneWhen ? `（済み: ${node.doneWhen}）` : '',
  node.note ? ` ${node.note}` : ''].join('');
export function planPath(tree: PlanTree): PlanPathView {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const path: string[] = [];
  const now = tree.current ? byId.get(tree.current) ?? null : null;
  for (let up = now?.parentId ? byId.get(now.parentId) : undefined; up; up = up.parentId ? byId.get(up.parentId) : undefined) path.unshift(up.title);
  const order = orderedPlan(tree.nodes), from = now ? order.findIndex(node => node.id === now.id) + 1 : 0;
  // r9: a node under a done one is not next (the done node leaves nothing under it to do).
  const doneAbove = (node: PlanNode) => {
    for (let up = node.parentId ? byId.get(node.parentId) : undefined; up; up = up.parentId ? byId.get(up.parentId) : undefined) {
      if (up.state === 'done') return true;
    }
    return false;
  };
  const next = order.slice(from).filter(node => node.state === 'continue' || node.state === 'wait')
    .filter(node => !order.some(other => other.parentId === node.id && other.state !== 'done') && !doneAbove(node)).slice(0, PLAN_LIMITS.next);
  const rules = planRules(tree, now);
  return { done: `${tree.nodes.filter(node => node.state === 'done').length}/${tree.nodes.length}`, path,
    now: now ? nodeLine(now) : null, next: next.map(nodeLine),
    blocked: tree.nodes.filter(node => node.state === 'blocked').slice(0, 3).map(node => `${node.id} ${node.title}${node.reason ? ` — ${node.reason}` : ''}`),
    ...(rules.length ? { rules } : {}) };
}

const MARK: Readonly<Record<PlanNodeState, string>> = { done: '済', blocked: '止', continue: '・', wait: '待' };
/** The whole tree as text, one node a line, indented by depth; the current node marked ▶. */
export function planText(tree: PlanTree): string {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const lines = orderedPlan(tree.nodes).flatMap(node => {
    const depth = depthOf(byId, node.id) - 1, mark = node.id === tree.current ? '▶' : MARK[node.state];
    const indent = '  '.repeat(depth + 1);
    return [`${'  '.repeat(depth)}${mark} ${nodeLine(node)}${node.state === 'blocked' && node.reason ? ` — ${node.reason}` : ''}`,
      ...(node.forbid ?? []).map(line => `${indent}禁止: ${line}`), ...(node.caution ?? []).map(line => `${indent}注意: ${line}`)];
  });
  return [`計画 rev${tree.revision}（済み ${tree.nodes.filter(node => node.state === 'done').length}/${tree.nodes.length}）`, ...lines].join('\n');
}

/** The flat copy for `agent_tasks.plan_json` (the app's task list): indented titles, completed / running (the current) / pending. */
export function flatPlan(tree: PlanTree): Array<{ id: string; title: string; status: 'pending' | 'running' | 'completed' }> {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  return orderedPlan(tree.nodes).map(node => ({ id: node.id, title: `${'　'.repeat(depthOf(byId, node.id) - 1)}${node.title}`,
    status: node.id === tree.current ? 'running' : node.state === 'done' ? 'completed' : 'pending' }));
}

/**
 * What a body shows (`BodyPlanView`): ids, parents, titles, states and the current node; the reason of a blocked one, and the node's
 * `where`, `doneWhen`, `note`, `forbid`, `caution` and `kind` when it has them (for the ShannonUI mod's tooltips; no model reads this, and the body moves
 * nothing by `kind`: chapter 7). A node of the kind `other` has no `kind` in the view: absent says it.
 */
export function planDisplay(tree: PlanTree): { revision: number; current: string | null;
  nodes: Array<{ id: string; parentId: string | null; title: string; state: PlanNodeState; reason?: string; where?: string; doneWhen?: string;
    note?: string; forbid?: string[]; caution?: string[]; kind?: PlanKind }> } {
  return { revision: tree.revision, current: tree.current, nodes: orderedPlan(tree.nodes).map(node => ({ id: node.id, parentId: node.parentId,
    title: node.title, state: node.state, ...(node.state === 'blocked' && node.reason ? { reason: node.reason } : {}),
    ...(node.where ? { where: node.where } : {}), ...(node.doneWhen ? { doneWhen: node.doneWhen } : {}), ...(node.note ? { note: node.note } : {}),
    ...(node.forbid?.length ? { forbid: [...node.forbid] } : {}), ...(node.caution?.length ? { caution: [...node.caution] } : {}),
    ...(node.kind && node.kind !== 'other' ? { kind: node.kind } : {}) })) };
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
