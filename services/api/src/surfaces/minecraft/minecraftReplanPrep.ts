import { orderedPlan, type PlanNode, type PlanOp, type PlanTree, type PlanUpdate } from '@shannon/mind';
import { belowTheSurface, doneStatusWords, parseDoneWhen, UNDERGROUND_KINDS, type DoneFacts } from './minecraftPlanDone.js';
import { kindOf } from './minecraftPlanFacts.js';

/**
 * e1111h2 (00:19): the body stood in a water hole and the stall was the road's, yet the new plan set the village node p2.1 (beds, none in the
 * pack) blocked and moved the current to p3 (iron), and the descent went on without the beds. A stall of the same spot is the road's, the
 * terrain's or the water's: no preparation node still owed is set aside by it, and the current does not jump past it. This reads kinds and
 * done-conditions only (never a title or a place). A node the model wrote `prep: skipped|unmet_now` on (or under) is the model's own choice
 * and is left alone.
 */
export interface KeptPreparation {
  update: PlanUpdate;
  /** The ids the update would have set aside (a node an op took out, the current it would have moved to). */
  dropped: string[];
  /** The owed nodes, with how far each is (「p2.1（have:bed>=8 未: bed 0/8）」), for the record. */
  owed: string[];
}

/** The nodes before the work down there that are still open and unmet by the frame now. Empty below the surface, without a frame, or with no work down there. */
export function owedPreparation(tree: PlanTree, facts: DoneFacts | null): PlanNode[] {
  if (!facts || (facts.dimension ?? 'overworld') !== 'overworld' || belowTheSurface(facts)) return [];
  const order = orderedPlan(tree.nodes), down = order.findIndex(node => UNDERGROUND_KINDS.has(kindOf(node)));
  if (down < 0) return [];
  const byId = new Map(tree.nodes.map(node => [node.id, node] as const));
  const chosen = (node: PlanNode): boolean => {
    for (let at: PlanNode | undefined = node; at; at = at.parentId ? byId.get(at.parentId) : undefined) {
      if (at.prep?.state === 'skipped' || at.prep?.state === 'unmet_now') return true;
    }
    return false;
  };
  return order.slice(0, down).filter(node => {
    if (node.state === 'done' || node.state === 'blocked' || !node.doneWhen || !parseDoneWhen(node.doneWhen) || chosen(node)) return false;
    return (doneStatusWords(node.doneWhen, facts, node.target) ?? '').startsWith('未: ');
  });
}

const FIELDS = ['state', 'prep', 'doneWhen', 'target'] as const;

/** The update without what would set aside a preparation still owed (`owedPreparation`). */
export function keepPreparation(tree: PlanTree, facts: DoneFacts | null, update: PlanUpdate): KeptPreparation {
  const owed = owedPreparation(tree, facts);
  if (!owed.length) return { update, dropped: [], owed: [] };
  const owedIds = new Set(owed.map(node => node.id));
  const byId = new Map(tree.nodes.map(node => [node.id, node] as const));
  const within = (id: string): boolean => {
    for (let at = byId.get(id); at; at = at.parentId ? byId.get(at.parentId) : undefined) if (owedIds.has(at.id)) return true;
    return false;
  };
  const dropped: string[] = [];
  const note = (id: string): void => { if (!dropped.includes(id)) dropped.push(id); };
  const ops: PlanOp[] = [];
  for (const op of update.ops ?? []) {
    if ((op.op === 'drop' || op.op === 'move') && within(op.id)) { note(op.id); continue; }
    if (op.op !== 'set' || !within(op.id)) { ops.push(op); continue; }
    const set = op as Extract<PlanOp, { op: 'set' }>;
    const blocksOrCloses = set.state === 'blocked' || set.state === 'done';
    const cut = FIELDS.filter(field => field === 'state' ? blocksOrCloses : set[field] !== undefined);
    if (!cut.length) { ops.push(op); continue; }
    note(set.id);
    const rest: Record<string, unknown> = { ...set };
    for (const field of cut) delete rest[field];
    if (cut.includes('state')) delete rest.reason;  // the reason belongs to the state that was cut
    if (Object.keys(rest).some(key => key !== 'op' && key !== 'id')) ops.push(rest as PlanOp);
  }
  const order = orderedPlan(tree.nodes), first = order.findIndex(node => owedIds.has(node.id));
  let current = update.current;
  if (typeof current === 'string' && !within(current)) {
    const at = order.findIndex(node => node.id === current);
    if (at > first) { note(current); current = undefined; }
  }
  const kept: PlanUpdate = { ...(ops.length ? { ops } : {}), ...(current !== undefined ? { current } : {}) };
  // The ones the update reached first, so that the record names the node it was about.
  const named = [...owed].sort((a, b) => Number(dropped.includes(b.id)) - Number(dropped.includes(a.id)));
  const words = named.map(node => `${node.id}（${node.doneWhen} ${doneStatusWords(node.doneWhen, facts, node.target)}）`);
  return { update: dropped.length ? kept : update, dropped, owed: words };
}
