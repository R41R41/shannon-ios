import { orderedPlan, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { FcaGoalVerification, FcaProgress } from '../../mind/action/fca/fcaProgressPorts.js';
import { planGoal } from './minecraftFirstPlan.js';
import { closedUnder, doneFacts, doneStatusWords, nodesSeenDone, predicatesOf, predicateHolds } from './minecraftPlanDone.js';

/**
 * Production 2026-10-26 04:43 and 04:49 (Sonnet 5.5, 「木を3本集めて」 and 「原木を10本集めて、作業台と木のツルハシを作って」): both tasks had their
 * plan done by the head's own code (every node a predicate of the pack, `minecraftPlanDone.ts`) and the goods in hand, and both were stopped
 * by five completions turned back. A body task bound to no goal (every request but the dragon's, `minecraftGoalBinding`) needs conditions of its own
 * (`requireConditions`), set with `goal.set_conditions`, which is not a tool of the mode's six (`llmcTools`): no completion could ever pass.
 *
 * In the mode a completion of such a task is checked by the plan and the body's new frame, with nothing for the model to set:
 * - every node of the plan is done (by the model, or shown done by the frame now, or no longer needed under a node that is done);
 * - at least one node that is done has a `doneWhen` an observation can show (`have:`, `dim:`, `at:`, `food>=`), and the frame holds it now.
 *   Not every such node: what a later node consumed (a table placed, planks made into the pickaxe, the logs of the 10 that made it) is no longer
 *   in the pack, and it was seen done when it was.
 * The nether asks for the Nether as well. The dragon's proof is the body's own record of its death (the binding) and nothing here.
 */
export interface PlanCompletion { ok: boolean; reason: string }

/** What a refusal says about the way to a completion (the mistake's line carries it after the reason). */
export const COMPLETION_WAY = '完了にするには、計画の全ての節が済み、観測の形の済む条件（have:・dim:・at:・food>=）を持つ節の 1 つが今の観測で満たされていること。'
  + '足りない節は plan_update で足せる。';

const OPEN_LISTED = 3;
const words = (nodes: readonly PlanNode[]) => nodes.slice(0, OPEN_LISTED).map(node => `${node.id} ${node.title}`).join('・')
  + (nodes.length > OPEN_LISTED ? ' ほか' : '');

/** The nodes that are not done yet, once the frame's own sight of them is counted (`nodesSeenDone`, `closedUnder`). */
function openNodes(tree: PlanTree, seen: ReadonlySet<string>): PlanNode[] {
  const under = new Set(closedUnder(tree, [...seen]).map(item => item.id));
  return orderedPlan(tree.nodes).filter(node => node.state !== 'done' && !seen.has(node.id) && !under.has(node.id));
}

/**
 * Whether a completion of an unbound request stands, from the plan and the new frame. `goal`: the kind the request's words name
 * (`planGoal`). A dragon request that is bound to nothing is never complete here (its proof is the binding's).
 */
export function planCompletion(tree: PlanTree, observation: BodyObservation | null, goal: 'dragon' | 'nether' | null): PlanCompletion {
  if (goal === 'dragon') return { ok: false, reason: '' };
  const facts = doneFacts(observation);
  if (!facts) return { ok: false, reason: '今の観測がまだ取れていない（体の状態を待ってから、もう一度）' };
  if (!tree.nodes.length) return { ok: false, reason: '計画に節が無く、何が済んだのか観測で確かめられない' };
  const seen = new Set(nodesSeenDone(tree, facts, true));
  const open = openNodes(tree, seen);
  if (open.length) return { ok: false, reason: `計画にまだ済んでいない節がある（${words(open)}）` };
  if (goal === 'nether' && facts.dimension !== 'the_nether') return { ok: false, reason: `ネザーにいる観測が無い（今の次元: ${facts.dimension ?? '不明'}）` };
  const predicates = predicatesOf(tree);
  const shown = orderedPlan(tree.nodes).filter(node => predicates.has(node.id));
  if (!shown.length) return { ok: false, reason: '計画に、観測で確かめられる済む条件（have:・dim:・at:・food>=）を持つ節が無い' };
  const holding = shown.find(node => predicateHolds(predicates.get(node.id)!, facts));
  if (!holding) {
    const last = shown.at(-1)!;
    return { ok: false, reason: `観測の済む条件が今は 1 つも満たされていない（${last.id} ${last.doneWhen}: ${doneStatusWords(last.doneWhen, facts) ?? '不明'}）` };
  }
  return { ok: true, reason: `計画の全ての節が済み、${holding.id}（${holding.doneWhen}）が今の観測で満たされている` };
}

/**
 * What the mode's completion check reads for a body task bound to no goal: the task's plan, the body's newest frame, and the request's
 * words (the kind of goal they name).
 */
export interface LlmcCompletion { tree(): PlanTree; observe(): BodyObservation | null; goal: string }

/** A completion of a task bound to no goal, from its plan and the new frame; a refusal says what is missing (`FcaGoalVerification.reason`). */
export function observedCompletion(turnedBack: FcaGoalVerification, completion: LlmcCompletion): FcaGoalVerification {
  const checked = planCompletion(completion.tree(), completion.observe(), planGoal(completion.goal));
  if (!checked.ok) return { ...turnedBack, ...(checked.reason ? { reason: checked.reason } : {}) };
  const check = { conditionId: 'plan-observed', operationId: 'llmc:plan-observed', tool: 'mc.plan', passed: true, resultDigest: '' };
  return { status: 'verified', bindingId: null, checks: [check], suggestedChecks: [], reason: checked.reason };
}

const DRAGON_UNBOUND = 'この依頼は、体がエンドラの死を見届けた記録に結び付いていない。完了にはならない（体を進める）。';
/**
 * The rule of completion in the progress the model reads, for a task bound to no goal: the machine's words name `goal.set_conditions`, which
 * is not a tool of the mode. A dragon request that is bound to nothing is told so, plainly.
 */
export function withCompletionRule(progress: FcaProgress, completion: LlmcCompletion | undefined): FcaProgress {
  if (!completion || progress.binding || progress.completionRule === undefined) return progress;
  return { ...progress, completionRule: planGoal(completion.goal) === 'dragon' ? DRAGON_UNBOUND : COMPLETION_WAY };
}
