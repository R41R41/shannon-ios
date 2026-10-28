import { migratePlanTree, type PlanKind, type PlanNode, type PlanTree, type PlanTreeV1 } from '@shannon/mind';
import type { PlanFacts, PlanFactsNode } from '../../src/surfaces/minecraft/minecraftPlanFacts.js';

/**
 * The continue contract (chapter 7): the plan tree is v2, and a node's `kind` is what the head's code reads (never a title). The tests of the runs before it
 * wrote their trees by titles. This builds a v2 tree from nodes written in that way: each node gets the kind `migratePlanTree` gives a v1 node (the one move
 * that reads titles), unless it already has one; a done node whose note begins 「準備を省いた」 gets `prep: skipped`, as the migration does. The `revision` is the one
 * given (the migration adds one), and the promises are empty.
 */
export function v2tree(input: { revision: number; current: string | null; nodes: readonly PlanNode[] }): PlanTree {
  const v1: PlanTreeV1 = { schema: 'shannon.plan-tree.v1', revision: input.revision, current: input.current, nodes: input.nodes.map(({ kind: _kind, ...node }) => node) };
  const moved = migratePlanTree(v1);
  const nodes = moved.nodes.map((node, index) => {
    const own = input.nodes[index]!;
    return { ...node, ...(own.kind ? { kind: own.kind } : {}), ...(own.prep ? { prep: own.prep } : {}), ...(own.kindRaw ? { kindRaw: own.kindRaw } : {}) } as PlanNode;
  });
  return { ...moved, revision: input.revision, nodes };
}

/** A node as the old tests wrote it (no order needed): `order` is its index among the nodes of the same parent. */
export function nodesOf(list: ReadonlyArray<Omit<PlanNode, 'order'> & { order?: number }>): PlanNode[] {
  const seen = new Map<string | null, number>();
  return list.map(node => {
    const order = node.order ?? seen.get(node.parentId) ?? 0;
    seen.set(node.parentId, order + 1);
    return { ...node, order } as PlanNode;
  });
}

/**
 * The `planFacts` a live state's body carries (`minecraftPlanFacts.ts`), for the tests that give a live state by hand: the kind of the current node (or none),
 * and the kinds above it and of the next nodes. `id` is the current node's (`p1`).
 */
export function planFacts(now: PlanKind | null, options: { id?: string; where?: string; doneWhen?: string; prep?: PlanFactsNode['prep']; above?: PlanKind[];
  next?: PlanKind[] } = {}): PlanFacts {
  return { now: now ? { id: options.id ?? 'p1', kind: now, ...(options.where ? { where: options.where } : {}), ...(options.doneWhen ? { doneWhen: options.doneWhen } : {}),
    ...(options.prep ? { prep: options.prep } : {}) } : null, above: options.above ?? [], next: (options.next ?? []).map((kind, index) => ({ id: `n${index + 1}`, kind })) };
}
