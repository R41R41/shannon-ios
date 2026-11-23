import { orderedPlan, type PlanTree } from '@shannon/mind';

const openNode = (node: { state: string }) => node.state !== 'done' && node.state !== 'blocked';

/**
 * Play 1124 (the cake, 00:54): `fca_complete` was turned away because nodes of the plan were open, and the next decision dropped them with
 * plan.update (the part of the owner's request that was still undone: growing the wheat with bone meal) and completed on the second try. A drop that
 * leaves no open node, while open nodes went, makes the plan read as all done and the completion pass with the work not done. So such an update
 * must say what is asked now (`goal`), and the part dropped is told to the parent in the completion's summary. Dropping open nodes while
 * others stay open (a plan changed on the way) is not touched.
 */
export function droppedOpenProblem(before: PlanTree, after: PlanTree): string | null {
  if (after.goal !== before.goal && after.goal) return null;
  const kept = new Set(after.nodes.map(node => node.id));
  const dropped = orderedPlan(before.nodes).filter(node => openNode(node) && !kept.has(node.id));
  if (!dropped.length || after.nodes.some(openNode)) return null;
  const names = dropped.slice(0, 4).map(node => `${node.id} ${node.title}`).join('・');
  return `未済の節（${names}）をすべて落とすと、計画が全部済みに見えて完了にできてしまう。落とすなら、同じ plan.update の goal に、落とした分を除いた今の依頼を 1 文で書く`
    + '（書かないと依頼の元の文が残り、やっていない事が済みの扱いになる）。落とした分は、完了の報告（summary）に「やらなかった分」として書く。親の依頼へはその報告が渡り、続きは親が持つ';
}
