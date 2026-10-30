/**
 * The plan tree of one task (design mb-llm-centric 2.7, 2026-10-21): the model's own plan, kept by the common
 * runtime and changed only
 * by the model (`plan.update`, a core tool of the FCA). Pure data: no executor, no permission, no approval
 * (stage 5's TaskTree, which is
 * Codex's and approved, is a different thing). A task keeps one; the checkpoint holds it (`fcaPlanTree`),
 * `agent_tasks.plan_json` a flat
 * copy for the app's task screen, and a body's command its display (`BodyPlanView`).
 *
 * Bounds: 64 nodes, 4 deep. A node's `state` is the same four words as the task tree's: done, blocked, continue
 * (to be done), wait.
 * Two rules keep the tree honest without asking the model: a parent whose children are all done is done, and
 * when the current node
 * is done and no new current is named, the next node not done (in order, depth first) becomes current.
 */
export const PLAN_TREE_SCHEMA = 'shannon.plan-tree.v2' as const;

/** The schema before the `continue` contract (v3.1, 2026-10-28): read once and moved to v2 by `migratePlanTree`. */
export const PLAN_TREE_SCHEMA_V1 = 'shannon.plan-tree.v1' as const;

/**
 * `rules`: a node's forbid and caution lines each (mb-llmc r4: `forbid`, `caution`), `rule` their length,
 * `shownRules` how many of them the
 * path shows (the current node's and its parents', `planPath`).
 */
export const PLAN_LIMITS = Object.freeze({
  nodes: 64,
  depth: 4,
  title: 60,
  text: 120,
  reason: 80,
  ops: 24,
  split: 8,
  next: 3,
  rules: 4,
  rule: 80,
  shownRules: 8,
  promises: 32,
  promiseUse: 40,
  ledger: 32,
  promiseCount: 2304,
});

export type PlanNodeState = 'done' | 'blocked' | 'continue' | 'wait';

export const PLAN_NODE_STATES: readonly PlanNodeState[] = ['done', 'blocked', 'continue', 'wait'];

/**
 * The kind of a node (the `continue` contract, chapter 7): chosen by the model, never inferred from the title by
 * the code (only the one move from
 * v1, `migratePlanTree`, reads titles). A value outside the list is taken as `other` with the written value kept in `kindRaw`.
 */
export const PLAN_KINDS = [
  'wood',
  'stone_tools',
  'food',
  'bed',
  'village',
  'prep_descent',
  'iron',
  'iron_armor',
  'diamond',
  'water',
  'lava',
  'obsidian',
  'portal',
  'nether',
  'fortress',
  'blaze',
  'pearl',
  'stronghold',
  'end',
  'dragon',
  'chest',
  'other',
] as const;

export type PlanKind = (typeof PLAN_KINDS)[number];

/** The state of a preparation node (apart from the work's `state`); only the model writes it. */
export const PREP_STATES = ['met', 'skipped', 'unmet_now'] as const;

export type PrepState = (typeof PREP_STATES)[number];

export interface PlanPrep {
  state: PrepState;
  why?: string;
  at?: string;
}

/** A condition as the plan keeps it: alternatives of conjunctions of clauses (the head's `ActCondition`; this
 * package reads none of it). */
export type PlanCondition = ReadonlyArray<ReadonlyArray<Readonly<Record<string, unknown>>>>;

export interface PromiseEvent {
  /**
   * `moved` (amendment A-1 4, 2026-10-28): the item changed place, not owner (put in a chest, taken out: `reason` `stored` /
   * `retrieved`); not a consumption.
   * `count` is what moved (always positive; `unexplained` alone is signed: negative is less than the events explain).
   */
  id: string;
  at: string;
  kind: 'made' | 'revised' | 'consumed' | 'gained' | 'moved' | 'lost_death' | 'unexplained' | 'released' | 'closed';
  count: number;
  have: number;
  declared?: boolean;
  reason?: string;
  promiseRev?: number;
  /** The item of the definition the event was put to (the definition the command was sent with: `planks` for an
   * `oak_planks` taken). */
  item?: string;
  by?: { command?: string; item?: string; pass?: number; hand?: number };
}

/** A promise (chapter 3): what to keep, for what, until when, and the ledger of what happened to it. Written by
 * the model; the ledger by the head. */
export interface PlanPromise {
  id: number;
  rev: number;
  item: string;
  count: number;
  use: string;
  until?: { node?: string; condition?: PlanCondition };
  instead?: PlanCondition;
  state: 'open' | 'kept_by_instead' | 'closed';
  closedBy?: 'until' | 'released' | 'used';
  ledger: PromiseEvent[];
  dropped?: number;
  /** What she carried of `item` at the last observation the ledger took (the head's; the model never writes it).
   * Absent until the first one. */
  have?: number;
}

export interface PlanNode {
  id: string;
  parentId: string | null;
  order: number;
  title: string;
  state: PlanNodeState;
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
   * mb-llmc r4 (owner 2026-10-22; arch-check 23: of what a supervisor wrote, the forbids and cautions held longest
   * and worked): what not to
   * do (`forbid`) and what to mind (`caution`) while this node or one under it is the current one; at most
   * `PLAN_LIMITS.rules` each.
   */
  forbid?: readonly string[];
  caution?: readonly string[];
}

export interface PlanTree {
  schema: typeof PLAN_TREE_SCHEMA;
  revision: number;
  current: string | null;
  nodes: readonly PlanNode[];
  promises: readonly PlanPromise[];
}

/** A node's fields as an op gives them. */
export interface PlanNodeDraft {
  id?: string;
  title: string;
  where?: string;
  doneWhen?: string;
  note?: string;
  state?: PlanNodeState;
  forbid?: readonly string[];
  caution?: readonly string[];
  kind?: string;
  prep?: PlanPrep;
}

export interface PromiseOp {
  op: 'promise';
  id?: number;
  item: string;
  count: number;
  use: string;
  until?: { node?: string; condition?: PlanCondition };
  instead?: PlanCondition;
}

export type PlanOp =
  | ({ op: 'add'; parent?: string | null; after?: string | null } & PlanNodeDraft)
  | { op: 'split'; id: string; into: readonly PlanNodeDraft[] }
  | {
      op: 'set';
      id: string;
      state?: PlanNodeState;
      title?: string;
      where?: string;
      doneWhen?: string;
      note?: string;
      reason?: string;
      kind?: string;
      prep?: PlanPrep;
    }
  | PromiseOp
  | { op: 'release'; id: number; why?: string }
  | { op: 'move'; id: string; parent?: string | null; after?: string | null }
  | { op: 'drop'; id: string }
  /**
   * mb-llmc r4: `forbid` / `caution` add one line to node `id` (absent: the current node; the oldest goes past `PLAN_LIMITS.rules`, the same
   * line is not added twice); `lift` takes a line off node `id`'s forbid and caution (the same text, or the one line that contains it).
   */
  | { op: 'forbid' | 'caution' | 'lift'; id?: string; text: string };

export interface PlanUpdate {
  ops?: readonly PlanOp[];
  current?: string | null;
}

/** When the update is applied (ISO), for the times a promise and a preparation state keep. */
export interface PlanUpdateContext {
  at?: string;
}

export interface PlanUpdateResult {
  tree: PlanTree;
  changed: boolean;
  problem: string | null;
}
