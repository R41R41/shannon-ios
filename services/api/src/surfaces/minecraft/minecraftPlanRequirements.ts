import type { PlanNode, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { acquired, carried, doneFacts } from './minecraftConditions.js';
import { parseDoneWhen } from './minecraftPlanDone.js';
import { materialsOf, smeltingInputOf } from './minecraftLlmcRecipes.js';

export const PLAN_TARGET_SCHEMA = { type: 'object', additionalProperties: false, required: ['item', 'count'], properties: {
  item: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' }, count: { type: 'integer', minimum: 1, maximum: 99999 } },
  description: 'この節で取得する物と数。材料や道具の節とは分ける。doneWhen のどの代替条件でもこの取得が必要' };

/** Every alternative must establish the explicit target. A title is never parsed into one. */
export function targetConditionProblem(node: PlanNode): string | null {
  const target = node.target;
  if (!target) return null;
  const predicate = parseDoneWhen(node.doneWhen);
  if (!predicate || predicate.some(clauses => !clauses.some(c => c.kind === 'have' && c.item === target.item && c.count >= target.count))) {
    return `${node.id}: target ${target.item}×${target.count} と doneWhen が不一致。各 | の枝に have:${target.item}>=${target.count} が必要（材料を持つだけでは完成品の取得ではない）`;
  }
  return null;
}

export function targetUpdateProblem(before: PlanTree, after: PlanTree, observation: BodyObservation | null): string | null {
  const facts = doneFacts(observation);
  for (const node of after.nodes) {
    const old = before.nodes.find(n => n.id === node.id);
    // Do not rewrite or rejudge unchanged historical acquisitions.
    if (JSON.stringify(old?.target) === JSON.stringify(node.target) && old?.doneWhen === node.doneWhen && old?.state === node.state) continue;
    const problem = targetConditionProblem(node);
    if (problem) return problem;
    const changedGoal = JSON.stringify(old?.target) !== JSON.stringify(node.target) || old?.doneWhen !== node.doneWhen;
    if (node.target && node.state === 'done' && (old?.state !== 'done' || changedGoal)
      && (!facts || acquired(facts.counts, node.target.item) < node.target.count)) return `${node.id}: 取得目標は現在の観測で未達か未確認。達成履歴にする前に現物を確認する`;
  }
  return null;
}

function unreservedStock(node: PlanNode, counts: ReadonlyMap<string, number>, tree?: PlanTree) {
  // Open promises for another purpose remain reserved; promises ending at this target may be spent here.
  const free = new Map(counts);
  const reserved: string[] = [];
  for (const p of tree?.promises ?? []) {
    if (p.state !== 'open' || p.until?.node === node.id || p.item === 'food') continue;
    let left = p.count;
    for (const [name, n] of free) {
      if (!left || !carried(new Map([[name, n]]), p.item)) continue;
      const take = Math.min(n, left);
      free.set(name, n - take);
      left -= take;
    }
    reserved.push(`${p.item}×${p.count}`);
  }
  return { free, reserved };
}

/** Current deficit, independent of past done nodes. Existing recipes and the body's smelting export supply conversions. */
export function targetRequirements(node: PlanNode | undefined, counts: ReadonlyMap<string, number>, tree?: PlanTree): string | null {
  if (!node?.target) return null;
  const target = node.target, missing = Math.max(0, target.count - acquired(counts, target.item));
  if (!missing) return `取得目標 ${target.item}×${target.count}: 現在充足`;
  const { free, reserved } = unreservedStock(node, counts, tree);
  const recipe = materialsOf(target.item, missing, { chain: true, pack: free });
  if (recipe.uncounted) return `取得目標 ${target.item} あと${missing}。材料換算は未対応（実物のレシピを確認）`;
  const needs: string[] = [];
  for (const part of recipe.spends) {
    const shortage = Math.max(0, part.count - carried(free, part.item));
    if (!shortage) continue;
    const input = smeltingInputOf(part.item);
    const smelt = input ? Math.min(shortage, carried(free, input)) : 0;
    if (smelt) needs.push(`${input}×${smelt}を精錬→${part.item}（炉と燃料の確認が必要）`);
    if (shortage > smelt) needs.push(`${part.item} あと${shortage - smelt}`);
  }
  return `取得目標 ${target.item} あと${missing}: ${needs.join('・') || '所持材料で製作可能（作業台などの設備を確認）'}${reserved.length ? `。別用途の予約: ${reserved.join('・')}` : ''}`;
}
