import { orderedPlan, type PlanTree } from '@shannon/mind';
import { blazeLack } from './minecraftLlmcDeadlyGates.js';
import { kindOf } from './minecraftPlanFacts.js';
import { predicateHolds, predicatesOf, type DoneFacts } from './minecraftPlanDone.js';
import { DIMENSION_KINDS, followDimension, treeQuestions } from './minecraftLlmcNode.js';

/**
 * A gate that stops the same node over and over (the owner's d50, run59: the blaze gate stopped the rods three times; words alone moved the plan to
 * the pearls 0 to 1 of 5): the unattended rebuild's part. The head notes each act the gates held and each that went through; when the same gate
 * (its `kind`) has held `HELD_LIMIT` of the last `HELD_WINDOW` acts, the current node is put on the next open leaf of another kind, as a fact
 * (the node followed from, the node put on, what lifts the gate and where the stopped node waits, in its order). Any gate: the stop is the fact,
 * the node moved to is the first open one of another kind.
 */
export const HELD_LIMIT = 2;
export const HELD_WINDOW = 6;
interface Window { outcomes: Array<string | null>; moved: { from: string; kind: string } | null }
const windows = new Map<string, Window>();
const windowOf = (taskId: string): Window => {
  const found = windows.get(taskId) ?? { outcomes: [], moved: null };
  windows.set(taskId, found);
  return found;
};

/** An act the gates held (`kind` of the held hand; a gate's `gate_required` only) or let go (`null`). */
export function noteHeldAct(taskId: string, held: { code: string; kind: string } | null): void {
  const window = windowOf(taskId);
  window.outcomes.push(held && held.code === 'gate_required' ? held.kind : null);
  if (window.outcomes.length > HELD_WINDOW) window.outcomes.shift();
}

/** For tests: no task has a window. */
export function forgetHeldStreaks(): void { windows.clear(); }

/** What lifts the gate of a kind, in words (the facts the gate itself says), for the line that moves the node. */
function liftWords(kind: string, facts: DoneFacts): string {
  if (kind === 'fight' && facts.dimension === 'the_nether') {
    return 'ブレイズの関所の必須（体力 20・満腹度 18・食料 150 点・盾 1）がそろえば元の節に戻れる';
  }
  return '関所の足りない物がそろえば元の節に戻れる';
}

/**
 * The move after a gate has held the same node `HELD_LIMIT` times of the last `HELD_WINDOW` acts, or null. The current node goes to the first open leaf
 * after it (the plan's order, round the end) that is of another kind and whose own condition does not hold; the stopped node stays open in its order.
 */
export function followHeld(taskId: string, tree: PlanTree, facts: DoneFacts | null): { to: string; from: string | null; acts: number; words: string } | null {
  const window = windows.get(taskId);
  if (!window || !facts || !tree.current) return null;
  const counts = new Map<string, number>();
  for (const kind of window.outcomes) if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const [gate] = [...counts].filter(([, count]) => count >= HELD_LIMIT).sort((a, b) => b[1] - a[1]).map(([kind]) => kind);
  if (!gate) return null;
  const order = orderedPlan(tree.nodes), current = order.find(node => node.id === tree.current);
  if (!current) return null;
  const predicates = predicatesOf(tree), questions = treeQuestions(tree);
  const open = (node: (typeof order)[number]) => questions.open(node.id) && !order.some(kid => kid.parentId === node.id && questions.open(kid.id))
    && !(predicates.get(node.id) && predicateHolds(predicates.get(node.id)!, facts));
  const at = order.indexOf(current), before = order.slice(0, at).reverse(), after = order.slice(at + 1);
  // The entry gates (the portal, the golden piece) are stopped by something earlier in the plan: look back first. The others (the blaze) look on.
  const around = gate === 'portal' || gate === 'gold' ? [...before, ...after] : [...after, ...[...before].reverse()];
  const elsewhere = (node: (typeof order)[number]) =>
    Object.entries(DIMENSION_KINDS).some(([dimension, kinds]) => dimension !== facts.dimension && kinds.has(kindOf(node)));
  const blazeShut = blazeLack({ health: facts.hp ?? null, hunger: facts.hunger ?? null, food: facts.food, counts: facts.counts }) !== null;
  // A node the next read would move away from again (a food node in the Nether, `followDimension`) is no place to put the current node: pearl, food, pearl.
  const stays = (node: (typeof order)[number]) => followDimension({ ...tree, current: node.id }, facts) === null;
  const leaf = around.find(node => open(node) && kindOf(node) !== kindOf(current) && !elsewhere(node) && !(kindOf(node) === 'blaze' && blazeShut) && stays(node));
  if (!leaf) return null;
  window.outcomes = [];
  window.moved = { from: current.id, kind: gate };
  const NAMES: Record<string, string> = { fight: 'ブレイズの関所', portal: 'ネザーへ入る関所', gold: '金の防具の関所' };
  const gateWords = NAMES[gate] ?? `関所（${gate}）`;
  const put = `今の節を [${leaf.id}] ${leaf.title.slice(0, 24)} に置いた。`;
  const kept = `元の節 [${current.id}] ${current.title.slice(0, 24)} は順のまま残る（${liftWords(gate, facts)}）`;
  return { to: leaf.id, from: tree.current, acts: 0, words: `${gateWords}が ${HELD_LIMIT} 回止めた: ${put}${kept}` };
}
