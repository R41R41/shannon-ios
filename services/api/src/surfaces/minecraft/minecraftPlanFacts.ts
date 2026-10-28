import { orderedPlan, PLAN_KINDS, type PlanKind, type PlanNode, type PlanTree, type PrepState } from '@shannon/mind';

/**
 * The continue contract, chapter 7 (2026-10-28): what the head's code knows of the plan as facts of the nodes, never as words of their titles. A node's
 * `kind` is written by the model (the first plan, `plan.update`); a node with none is `other`. The code that used to read a title or the `planNow` line
 * with a regular expression (the stage whose check holds, the gate back, the knowledge of a stage, the near creatures a plan needs…) reads the kinds here.
 *
 * `planFacts` is an internal field of the live state's `body` (`readinessParts`, `minecraftLlmcBody.ts`): the machine's reading of the current node, the
 * kinds above it and the next nodes. The functions that work from the live state alone (`stagesFor`, `rewriteLlmcLive`) read it; `rewriteLlmcLive` takes
 * it out, so the model does not see it. A live state without one (an old test input) gets no decision that depends on a kind: a kind is never inferred
 * from `planNow`.
 */
export const PLAN_FACTS_KEY = 'planFacts';

/** The kind of a node: the one written, or `other`. */
export const kindOf = (node: Pick<PlanNode, 'kind'> | null | undefined): PlanKind => node?.kind ?? 'other';

export interface PlanFactsNode {
  id: string; kind: PlanKind;
  /** The node's place and the condition that shows it done, as the plan holds them (read by `readWhere` and `doneRange`, never from a shown line). */
  where?: string; doneWhen?: string;
  /** The preparation state the model wrote (`plan.update` set `prep`), when it wrote one. */
  prep?: PrepState;
}
export interface PlanFacts {
  /** The current node. */
  now: PlanFactsNode | null;
  /** The kinds of the nodes above the current one, the nearest first. */
  above: PlanKind[];
  /** The nodes after the current one as the plan shows them (`planPath`'s pick: at most 3, the first is "the next node"). */
  next: Array<{ id: string; kind: PlanKind }>;
}
const NEXT_SHOWN = 3;

/**
 * The facts of a tree. The next nodes are chosen as `planPath` (mind) chooses them: after the current node in order, still to do (continue or wait), with
 * nothing open under them and no done node above them.
 */
export function planFactsOf(tree: PlanTree | null | undefined): PlanFacts | null {
  if (!tree) return null;
  const byId = new Map(tree.nodes.map(node => [node.id, node] as const));
  const now = tree.current ? byId.get(tree.current) ?? null : null;
  const above: PlanKind[] = [];
  for (let up = now?.parentId ? byId.get(now.parentId) : undefined, guard = 0; up && guard < 16; up = up.parentId ? byId.get(up.parentId) : undefined, guard += 1) {
    above.push(kindOf(up));
  }
  const order = orderedPlan(tree.nodes), from = now ? order.findIndex(node => node.id === now.id) + 1 : 0;
  const doneAbove = (node: PlanNode): boolean => {
    for (let up = node.parentId ? byId.get(node.parentId) : undefined, guard = 0; up && guard < 16; up = up.parentId ? byId.get(up.parentId) : undefined, guard += 1) {
      if (up.state === 'done') return true;
    }
    return false;
  };
  const next = order.slice(from).filter(node => node.state === 'continue' || node.state === 'wait')
    .filter(node => !order.some(other => other.parentId === node.id && other.state !== 'done') && !doneAbove(node)).slice(0, NEXT_SHOWN)
    .map(node => ({ id: node.id, kind: kindOf(node) }));
  return { now: now ? { id: now.id, kind: kindOf(now), ...(now.where ? { where: now.where } : {}), ...(now.doneWhen ? { doneWhen: now.doneWhen } : {}),
    ...(now.prep ? { prep: now.prep.state } : {}) } : null, above, next };
}

const KIND_SET: ReadonlySet<string> = new Set(PLAN_KINDS);
const kindName = (value: unknown): PlanKind | null => typeof value === 'string' && KIND_SET.has(value) ? value as PlanKind : null;
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
/** The facts a live state's body carries (`planFacts`), or null (none, or not in the form). Never reads `planNow`. */
export function factsIn(body: Record<string, unknown> | null | undefined): PlanFacts | null {
  const raw = body?.[PLAN_FACTS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const nowRaw = record.now && typeof record.now === 'object' && !Array.isArray(record.now) ? record.now as Record<string, unknown> : null;
  const nowKind = kindName(nowRaw?.kind), id = text(nowRaw?.id);
  const now: PlanFactsNode | null = nowRaw && nowKind && id ? { id, kind: nowKind, ...(text(nowRaw.where) ? { where: text(nowRaw.where)! } : {}),
    ...(text(nowRaw.doneWhen) ? { doneWhen: text(nowRaw.doneWhen)! } : {}),
    ...(nowRaw.prep === 'met' || nowRaw.prep === 'skipped' || nowRaw.prep === 'unmet_now' ? { prep: nowRaw.prep } : {}) } : null;
  const above = (Array.isArray(record.above) ? record.above : []).flatMap(item => { const kind = kindName(item); return kind ? [kind] : []; });
  const next = (Array.isArray(record.next) ? record.next : []).flatMap(item => {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null, kind = kindName(entry?.kind), nextId = text(entry?.id);
    return kind && nextId ? [{ id: nextId, kind }] : [];
  }).slice(0, NEXT_SHOWN);
  return { now, above, next };
}

/** The kinds of the current node and the nodes above it, the nearest first (empty with no current node). */
export const nowKinds = (facts: PlanFacts | null | undefined): PlanKind[] => facts?.now ? [facts.now.kind, ...facts.above] : [];
/** The kinds of the current node and of the next nodes shown. */
export const nearKinds = (facts: PlanFacts | null | undefined): PlanKind[] => facts ? [...facts.now ? [facts.now.kind] : [], ...facts.next.map(item => item.kind)] : [];
/** The kinds of the current node and of the one next node (the first of the next nodes). */
export const nowAndNextKinds = (facts: PlanFacts | null | undefined): PlanKind[] => facts ? [...facts.now ? [facts.now.kind] : [], ...facts.next.slice(0, 1).map(item => item.kind)] : [];
export const hasKind = (kinds: readonly PlanKind[], wanted: ReadonlySet<PlanKind>): boolean => kinds.some(kind => wanted.has(kind));

export interface WherePos { x: number; y: number; z: number }
const NUMBER = '(-?\\d+)';
/** A place written first in a node's `where`: `195,66,60`, `(196,69,237) 村の北`, `@ (150,64,210)`. */
const LEADING = new RegExp(`^\\s*[@＠]?\\s*\\(?\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*\\)?`, 'u');
const BRACKETED = /\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/u;
const BARE = /(?<![\d.])(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)(?![\d.])/u;
/**
 * The one reader of a node's `where` (a text: a place and a few words; no structure of its own, chapter 7). `goal` (the default): the place the text begins
 * with, which is the node's place (a bed named in a later sentence is not: the replay took one once). `any`: the first place anywhere in it, bracketed or
 * bare (the gate back and the food node's distance: `(5,35,12)` after words).
 */
export function readWhere(where: string | null | undefined, mode: 'goal' | 'any' = 'goal'): WherePos | null {
  if (!where) return null;
  const found = mode === 'goal' ? LEADING.exec(where) : BRACKETED.exec(where) ?? BARE.exec(where);
  return found ? { x: Number(found[1]), y: Number(found[2]), z: Number(found[3]) } : null;
}
const DONE_RANGE = /at:\(?-?\d+,-?\d+,-?\d+\)?~(\d+)/u;
/** The radius of a done-condition `at:x,y,z~N` of the node (the range of its goal), or null. */
export function doneRange(doneWhen: string | null | undefined): number | null {
  const found = doneWhen ? DONE_RANGE.exec(doneWhen) : null;
  return found ? Number(found[1]) : null;
}
