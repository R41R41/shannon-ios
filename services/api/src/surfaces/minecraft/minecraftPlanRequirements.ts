import type { PlanNode, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { acquired, carried, doneFacts } from './minecraftConditions.js';
import { parseDoneWhen } from './minecraftPlanDone.js';
import { materialsOf, smeltingInputOf } from './minecraftLlmcRecipes.js';
import { FRAME_EYES, MIN_SPARE } from './minecraftEyeSpare.js';

/** The fact for a node whose title was changed and whose done condition and place were not (`PlanNode.staleCondition`, set by `plan.update`): said in its result and in the live's now; nothing is removed. */
export const STALE_CONDITION_WORDS = 'この済む条件は題を変える前のものです（doneWhen・where を新しい題に合わせるなら set で作り直す）';

export const PLAN_TARGET_SCHEMA = { type: 'object', additionalProperties: false, required: ['item', 'count'], properties: {
  item: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' }, count: { type: 'integer', minimum: 1, maximum: 99999 } },
  description: 'この節で取得する物と数。材料や道具の節とは分ける。doneWhen のどの代替条件でもこの取得が必要' };

/**
 * The item a clause names is the target's when it is the same id, or the generic name the head's own conditions read it by (`carried`: `bed` is any
 * `*_bed`): run59 task 1's first plan was thrown away whole for a node of target white_bed with doneWhen have:bed>=1.
 */
const sameItem = (target: string, clause: string): boolean => target === clause || target.endsWith(`_${clause}`);

/** Every alternative must establish the explicit target. A title is never parsed into one. */
export function targetConditionProblem(node: PlanNode): string | null {
  const target = node.target;
  if (!target) return null;
  const predicate = parseDoneWhen(node.doneWhen);
  if (!predicate || predicate.some(clauses => !clauses.some(c => c.kind === 'have' && sameItem(target.item, c.item) && c.count >= target.count))) {
    return `${node.id}: target ${target.item}×${target.count} と doneWhen が不一致。各 | の枝に have:${target.item}>=${target.count} が必要（材料を持つだけでは完成品の取得ではない）。`
      + `直し方: doneWhen を have:${target.item}>=${target.count} に合わせる。取る物や数が変わったなら、set で target も新しい物・数に直す（doneWhen だけを書き直さない）。取得目標をやめるなら set で target=null`;
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
    if (node.target && node.state === 'done' && (old?.state !== 'done' || changedGoal)) {
      if (!facts) return `${node.id}: 取得目標は現在の観測で未確認。${DONE_REPAIR}`;
      const short = shortOfTarget(node.id, node.target, facts.counts);
      if (short) return short;
    }
  }
  return null;
}

/**
 * Why a target node cannot be closed now: the count and what is counted toward it, and that the count may be lowered (11/15b c1: with 13 eyes made
 * and no pearl, 「パール 14」 was refused five times as 「未達か未確認」; the head took the pearls for spent, not knowing an eye counts as one).
 */
/** The portal frame takes 12 eyes; a pearl or eye target above it holds the spare for eyes that break when thrown (at least 1 more, `MIN_SPARE`). */
const FRAME_EYES_WITH_SPARE = FRAME_EYES + MIN_SPARE;

const DONE_REPAIR ='done にできるのは現物を持っている節だけ。'
  + '直し方: しなくていい節は set state=done ではなく drop（id とその下を消す）で外す。待たせる節は state=blocked か wait';

function shortOfTarget(id: string, target: NonNullable<PlanNode['target']>, counts: ReadonlyMap<string, number>): string | null {
  const have = acquired(counts, target.item);
  if (have >= target.count) return null;
  const parts = target.item === 'ender_pearl' ? `（ender_pearl ${carried(counts, 'ender_pearl')}＋ender_eye ${carried(counts, 'ender_eye')}。アイもパールとして数える）`
    : target.item === 'blaze_rod' ? `（blaze_rod ${carried(counts, 'blaze_rod')}＋粉・アイから戻した分）` : '';
  const spare = target.item === 'ender_pearl' || target.item === 'ender_eye';
  const lower = !spare ? '' : have >= FRAME_EYES_WITH_SPARE
    ? `予備を減らすなら同じ set で target の count と doneWhen の数を ${have > FRAME_EYES_WITH_SPARE ? `${FRAME_EYES_WITH_SPARE}〜${have}` : have} に下げてよい（枠の ${FRAME_EYES} と予備の最低 ${MIN_SPARE} は下回らない）`
    : `枠に ${FRAME_EYES} と割れる分の予備 ${MIN_SPARE} 以上で ${FRAME_EYES_WITH_SPARE} 要るので数は下げない`;
  return `${id}: 取得目標 ${target.item}×${target.count} に今 ${have}${parts}、あと ${target.count - have}。${DONE_REPAIR}。${lower}`;
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
