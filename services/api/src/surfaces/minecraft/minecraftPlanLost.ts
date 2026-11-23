import { orderedPlan, PLAN_LIMITS, type PlanNode, type PlanTree, type PlanUpdate } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { doneFacts, predicateHolds, predicatesOf, type DonePredicate } from './minecraftPlanDone.js';
import { lifeViewOf } from './minecraftMadeIn.js';

/**
 * A node the head marked done because the pack held what it names (`have:wheat_seeds>=4`) stays done after a death took the pack (play 1124: the
 * cake's p1.2 and p1.5 stayed 「済み」 with 0 wheat, so the plan showed only the node before them and the work to grow the wheat again was
 * never put in the next three). So when the life changed since the plan was last read (a death, in this step or while another task ran), the
 * nodes whose condition is made only of `have:` clauses are judged again against the pack, and the ones that no longer hold go back to open.
 * Only a death makes it: a pack that is smaller because the work used the material (planks into a table) is no reason to open a node.
 */
const judgedLife = new Map<string, number>();
export const forgetJudgedLife = (): void => { judgedLife.clear(); };

const packOnly = (predicate: DonePredicate | undefined): predicate is DonePredicate =>
  !!predicate && predicate.length > 0 && predicate.every(clauses => clauses.length > 0 && clauses.every(clause => clause.kind === 'have'));

export interface LostDone { update: PlanUpdate; ids: string[]; words: string }

/**
 * The update that puts back to open the done nodes the pack no longer shows, or null (the same life as the last reading, no life in the frame,
 * nothing lost). A done parent with no condition of its own is opened with its lost child (it was done only because its children were).
 */
export function lostDoneUpdate(taskId: string, tree: PlanTree, observation: BodyObservation | null): LostDone | null {
  const facts = doneFacts(observation), life = lifeViewOf(observation)?.life;
  if (!facts || life === undefined) return null;
  const known = judgedLife.get(taskId);
  judgedLife.delete(taskId);
  judgedLife.set(taskId, life);
  if (judgedLife.size > 32) judgedLife.delete(judgedLife.keys().next().value as string);
  // The first reading of a task (a new head, a new plan) has nothing to compare with: it only takes the life as the base.
  if (known === undefined || life <= known) return null;
  const predicates = predicatesOf(tree), byId = new Map(tree.nodes.map(node => [node.id, node] as const));
  const lost = orderedPlan(tree.nodes).filter(node => node.state === 'done' && packOnly(predicates.get(node.id))
    && !predicateHolds(predicates.get(node.id)!, facts));
  if (!lost.length) return null;
  const ids = new Set(lost.map(node => node.id));
  for (const node of lost) {
    for (let up = byId.get(node.parentId ?? ''), guard = 0; up && guard < PLAN_LIMITS.depth + 1; up = byId.get(up.parentId ?? ''), guard += 1) {
      if (up.state === 'done' && !predicates.has(up.id)) ids.add(up.id);
    }
  }
  const order = orderedPlan(tree.nodes).filter(node => ids.has(node.id)).slice(0, PLAN_LIMITS.ops);
  const named = (node: PlanNode) => `${node.id} ${node.title}${node.doneWhen ? `（${node.doneWhen}）` : ''}`;
  return { update: { ops: order.map(node => ({ op: 'set' as const, id: node.id, state: 'continue' as const })) }, ids: order.map(node => node.id),
    words: `死んで持ち物が変わったので、済みにしていた節を未済へ戻した（今の持ち物に無い）: ${order.slice(0, 4).map(named).join('・')}。`
      + '戻した節の物は、今の持ち物から数え直して集め直す' };
}
