import { PLAN_LIMITS } from './planTreeTypes.js';
import type { PlanNodeState, PlanKind, PlanNode, PlanTree } from './planTreeTypes.js';

/** A node's depth (1 at the top), or Infinity in a cycle. */
export function depthOf(byId: ReadonlyMap<string, PlanNode>, id: string): number {
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
  for (const node of nodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
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

/**
 * The part of the plan a decision reads every turn: the way down to the current node, it, the next few, and what is blocked; r4: `rules`,
 * the forbid and caution lines of the current node and of every node above it (the nearest node first, each node's forbids before its cautions, at most
 * `PLAN_LIMITS.shownRules`), present only when there is one.
 */
export interface PlanPathView {
  done: string;
  path: readonly string[];
  now: string | null;
  next: readonly string[];
  blocked: readonly string[];
  rules?: readonly string[];
}

/** The forbid and caution lines that hold at `now`: its own, then its parents' up to the top. */
export function planRules(
  tree: PlanTree,
  now: PlanNode | null = tree.current ? (tree.nodes.find((node) => node.id === tree.current) ?? null) : null,
): string[] {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const lines: string[] = [];
  for (let node: PlanNode | undefined = now ?? undefined; node; node = node.parentId ? byId.get(node.parentId) : undefined) {
    const own = node.id === now?.id ? '' : `（${node.id}）`;
    for (const line of node.forbid ?? []) lines.push(`禁止${own}: ${line}`);
    for (const line of node.caution ?? []) lines.push(`注意${own}: ${line}`);
  }
  return lines.slice(0, PLAN_LIMITS.shownRules);
}

export const nodeLine = (node: PlanNode) =>
  [
    `${node.id} ${node.title}`,
    node.where ? `＠${node.where}` : '',
    node.doneWhen ? `（済み: ${node.doneWhen}）` : '',
    node.note ? ` ${node.note}` : '',
  ].join('');

export function planPath(tree: PlanTree): PlanPathView {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const path: string[] = [];
  const now = tree.current ? (byId.get(tree.current) ?? null) : null;
  for (let up = now?.parentId ? byId.get(now.parentId) : undefined; up; up = up.parentId ? byId.get(up.parentId) : undefined)
    path.unshift(up.title);
  const order = orderedPlan(tree.nodes),
    from = now ? order.findIndex((node) => node.id === now.id) + 1 : 0;
  // r9: a node under a done one is not next (the done node leaves nothing under it to do).
  const doneAbove = (node: PlanNode) => {
    for (let up = node.parentId ? byId.get(node.parentId) : undefined; up; up = up.parentId ? byId.get(up.parentId) : undefined) {
      if (up.state === 'done') return true;
    }
    return false;
  };
  const next = order
    .slice(from)
    .filter((node) => node.state === 'continue' || node.state === 'wait')
    .filter((node) => !order.some((other) => other.parentId === node.id && other.state !== 'done') && !doneAbove(node))
    .slice(0, PLAN_LIMITS.next);
  const rules = planRules(tree, now);
  return {
    done: `${tree.nodes.filter((node) => node.state === 'done').length}/${tree.nodes.length}`,
    path,
    now: now ? nodeLine(now) : null,
    next: next.map(nodeLine),
    blocked: tree.nodes
      .filter((node) => node.state === 'blocked')
      .slice(0, 3)
      .map((node) => `${node.id} ${node.title}${node.reason ? ` — ${node.reason}` : ''}`),
    ...(rules.length ? { rules } : {}),
  };
}

export const MARK: Readonly<Record<PlanNodeState, string>> = { done: '済', blocked: '止', continue: '・', wait: '待' };

/** The whole tree as text, one node a line, indented by depth; the current node marked ▶. */
export function planText(tree: PlanTree): string {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const lines = orderedPlan(tree.nodes).flatMap((node) => {
    const depth = depthOf(byId, node.id) - 1,
      mark = node.id === tree.current ? '▶' : MARK[node.state];
    const indent = '  '.repeat(depth + 1);
    return [
      `${'  '.repeat(depth)}${mark} ${nodeLine(node)}${node.state === 'blocked' && node.reason ? ` — ${node.reason}` : ''}`,
      ...(node.forbid ?? []).map((line) => `${indent}禁止: ${line}`),
      ...(node.caution ?? []).map((line) => `${indent}注意: ${line}`),
    ];
  });
  return [
    `計画 rev${tree.revision}（済み ${tree.nodes.filter((node) => node.state === 'done').length}/${tree.nodes.length}）`,
    ...lines,
  ].join('\n');
}

/** The flat copy for `agent_tasks.plan_json` (the app's task list): indented titles, completed / running (the
 * current) / pending. */
export function flatPlan(tree: PlanTree): Array<{ id: string; title: string; status: 'pending' | 'running' | 'completed' }> {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  return orderedPlan(tree.nodes).map((node) => ({
    id: node.id,
    title: `${'　'.repeat(depthOf(byId, node.id) - 1)}${node.title}`,
    status: node.id === tree.current ? 'running' : node.state === 'done' ? 'completed' : 'pending',
  }));
}

/**
 * What a body shows (`BodyPlanView`): ids, parents, titles, states and the current node; the reason of a blocked one, and the node's
 * `where`, `doneWhen`, `note`, `forbid`, `caution` and `kind` when it has them (for the ShannonUI mod's tooltips; no model reads this, and the body moves
 * nothing by `kind`: chapter 7). A node of the kind `other` has no `kind` in the view: absent says it.
 */
export function planDisplay(tree: PlanTree): {
  revision: number;
  current: string | null;
  nodes: Array<{
    id: string;
    parentId: string | null;
    title: string;
    state: PlanNodeState;
    reason?: string;
    where?: string;
    doneWhen?: string;
    note?: string;
    forbid?: string[];
    caution?: string[];
    kind?: PlanKind;
  }>;
} {
  return {
    revision: tree.revision,
    current: tree.current,
    nodes: orderedPlan(tree.nodes).map((node) => ({
      id: node.id,
      parentId: node.parentId,
      title: node.title,
      state: node.state,
      ...(node.state === 'blocked' && node.reason ? { reason: node.reason } : {}),
      ...(node.where ? { where: node.where } : {}),
      ...(node.doneWhen ? { doneWhen: node.doneWhen } : {}),
      ...(node.note ? { note: node.note } : {}),
      ...(node.forbid?.length ? { forbid: [...node.forbid] } : {}),
      ...(node.caution?.length ? { caution: [...node.caution] } : {}),
      ...(node.kind && node.kind !== 'other' ? { kind: node.kind } : {}),
    })),
  };
}
