import { targetRequirements } from './minecraftPlanRequirements.js';
import type { BodyObservation, BodyPlanView } from '../../contracts/bodyControlContract.js';
import { MC_ACT_TOOL } from '../../contracts/minecraftActContract.js';
import { carriedFood } from './minecraftLlmcLive.js';
import { doneFacts, parseDoneWhen, prepUnmetFacts, undergroundInOverworld } from './minecraftPlanDone.js';
import { dayBedLine, nightChoiceLine } from './minecraftNightArms.js';
import { nowKinds, PLAN_FACTS_KEY, planFactsOf, type PlanFacts } from './minecraftPlanFacts.js';
import { isDragonPlan, reachedMilestoneNames } from './minecraftLlmcRoad.js';
import { offer, pending, withdraw, type OnceFact } from './minecraftLlmcOnceFacts.js';
import { wantsFood, type FactsContext } from './minecraftLlmcFacts.js';
import type { PlanTree } from '@shannon/mind';
import { meterLine, roadLine } from './minecraftLlmcRoad.js';
import {
  feetIn,
  foodFirstLine,
  foodLeads,
  fuelShortage,
  ironSearchLine, sheepAbsentLine, goldAbsentLine, foodAbsentLine,
  preparationShortage,
  readinessOf,
  recoveryLine,
} from './minecraftLlmcReadiness.js';
import { wornItems } from './minecraftItems.js';
import { missingNodeFact, planNowOf } from './minecraftLlmcNode.js';
import type { ActInput } from '../../contracts/minecraftActContract.js';
import { normalizeActInput } from './minecraftLlmcShape.js';
import { roofedInRock } from './minecraftOreRoute.js';
import type { Endgame } from './minecraftEndgame.js';

/**
 * What a Minecraft task's body lifecycle takes in the LLM-centric mode (`createMinecraftTaskBody`, `llmc`): the
 * task's plan (for the
 * context of every command and reflex session, `BodyTaskContext.plan`) and its path's size (the live state's
 * room), and the per-task
 * events and food trend kept across steps.
 */
export interface LlmcBodyParts {
  /** Original task's native dragon binding; absent keeps legacy helper inputs unchanged. */
  journeyReadiness?: boolean;
  plan(): BodyPlanView | undefined;
  /** The plan's path as the decision reads it (its tokens count against the live state's bound). */
  planView(): object | null;
  /** r6: the whole tree (the places of its nodes: the gate back, for where food is). Absent: none read. */
  planTree?(): PlanTree;
  returnRoute?(observation: BodyObservation | null): readonly string[];
  /** The way to the dragon after the Nether: the thrown eyes and the facts of the End (`minecraftEndgame.ts`). Absent: none. */
  endgame?: Endgame;
}

/** What the chapter 8 facts need beyond the frame: the blows line (`HitWatch.line`), the time of the previous
 * decision (ISO), the queue's inputs, the last results' stops. */
export interface JudgeParts {
  hits?: string | null;
  since?: string | undefined;
  ahead?: readonly ActInput[];
  stops?: readonly string[];
  failures?: readonly string[];
}

/** The facts' context from the plan's promises (the tree), and whether food is what she is short of (the near
 * words' own reading). */
/** A surface errand (o06 a hunt, o08 the village's beds): at dusk it is the morning's. Cooking and crafting are done in the hole. */
const SURFACE_ERRAND = /村|原木|動物|狩|豚|牛|羊|鶏|ニワトリ|羊毛|干し草|畑|箱|ベッド|歩く|探す|見に行く|寄る/u, INDOOR = /焼く|かまど|調理|作る|工作|鉄|石炭|ダイヤ|鉱/u;
export function factsContext(
  llmc: LlmcBodyParts,
  observation: BodyObservation | null,
  readiness: { shortage?: string; recovery?: string[] },
  planFacts: PlanFacts | undefined,
  judge: JudgeParts = {},
): FactsContext {
  const tree = planTreeOf(llmc),
    world = (observation?.state.world ?? {}) as Record<string, unknown>;
  const food = carriedFood(world, observation?.facts ?? {}),
    hunger = typeof world.food === 'number' && Number.isFinite(world.food) ? world.food : null;
  const endgame = llmc.endgame?.lines(observation, isDragonPlan(tree));
  return {
    ...(judge.hits ? { hits: judge.hits } : {}),
    ...(endgame?.lines.length ? { endgame } : {}),
    ...(tree?.promises.length ? { promises: tree.promises } : {}),
    ...(judge.since
      ? {
          since: judge.since,
        }
      : {}),
    ...(judge.ahead?.length ? { ahead: judge.ahead } : {}),
    ...(judge.stops?.length ? { stops: judge.stops } : {}),
    ...(judge.failures?.length ? { failures: judge.failures } : {}),
    wantsFood: wantsFood({
      fullness: hunger,
      points: food.points,
      shortage: readiness.shortage ?? null,
      recovery: readiness.recovery ?? null,
      planFacts: planFacts ?? null,
    }),
  };
}

/** The live body with the plan's facts as its internal field (none: as it is; a body that is not connected has no
 * plan to read). */
export function withPlanFacts(live: Record<string, unknown>, facts: PlanFacts | undefined): Record<string, unknown> {
  return facts && live.connected !== false ? { ...live, [PLAN_FACTS_KEY]: facts } : live;
}

/** The plan's tree, or null (none, or it could not be read). */
export function planTreeOf(llmc: LlmcBodyParts): PlanTree | null {
  try {
    return llmc.planTree?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * r6 (with the probe, as r4's parts): the current node before the map, what its stage lacks, and health that
 * does not come back with
 * where food is (`minecraftLlmcReadiness.ts`). Facts only: what to do with them is the decision's.
 * The continue contract (chapter 7): `planFacts`, the plan's kinds as the code reads them (the stage that is
 * checked, the knowledge of a stage, the near creatures a plan needs
 * all come from it, never from a title); `onceFacts`, the facts to say once (with a `taskId`: the preparation
 * node she went down without meeting, offered when it
 * holds and taken back when the model has written `prep` on it). The code writes no `skipped`.
 */
export function readinessParts(
  llmc: LlmcBodyParts,
  view: object | null,
  observation: BodyObservation | null,
  taskId?: string,
): { planNow?: string; shortage?: string; recovery?: string[]; planFacts?: PlanFacts; onceFacts?: OnceFact[] } {
  const facts = readinessOf(observation);
  const tree = planTreeOf(llmc),
    nodes = tree?.nodes ?? [],
    planNow = planNowOf(tree, view, observation);
  const planFacts = planFactsOf(tree) ?? undefined;
  const out = { ...(planNow ? { planNow } : {}), ...(planFacts ? { planFacts } : {}) };
  if (!facts) return out;
  const display = llmc.plan();
  // Run 43: the fuel for what she carries to smelt is a lack of its own, beside the stage's.
  const shortage =
    [
      preparationShortage({
        dimension: facts.dimension,
        counts: facts.counts,
        food: facts.food,
        nowKinds: nowKinds(planFacts),
        worn: wornItems(facts.world.worn),
        inventory: facts.world.inventory,
        world: facts.world,
        taskId,
        journeyReadiness: llmc.journeyReadiness,
      }),
      fuelShortage(facts.world, facts.counts),
      ironSearchLine(facts.world, facts.counts, facts.dimension, tree?.nodes.find(node => node.id === tree.current)),
      sheepAbsentLine(facts.world, facts.counts, facts.dimension, tree?.nodes ?? [], tree?.nodes.find(node => node.id === tree.current)),
      goldAbsentLine(facts.world, facts.counts, facts.dimension, tree?.nodes ?? [], tree?.nodes.find(node => node.id === tree.current)),
      foodAbsentLine(facts.world, facts.food, facts.dimension, tree?.nodes.find(node => node.id === tree.current), facts.counts),
      targetRequirements(tree?.nodes.find(node => node.id === tree.current), facts.counts, tree ?? undefined),
    ]
      .filter(Boolean)
      .join('。') || null;
  const recovery = recoveryLine(facts.hunger, facts.health, facts.food, facts.counts);
  const route = llmc.returnRoute?.(observation) ?? [];
  // r7 (runs 29, 30): no food and health that does not come back: the plan's food node is said before its now (the
  // plan is not changed).
  const foodRecoveryFirstStep = () =>
    recovery && facts.food <= 0 && planNow
      ? foodFirstLine(nodes, display?.current ?? tree?.current ?? null, feetIn(facts.world), facts.dimension)
      : null;
  const first = foodRecoveryFirstStep();
  // end1109o03: the night with no bed: the choices before the plan's now (`nightChoiceLine`); end1109o04: by day with a bed, the day is the plan's (`dayBedLine`).
  const done = doneFacts(observation);
  const choice = planNow ? nightChoiceLine(facts.world, facts.counts, facts.dimension, (!!done && undergroundInOverworld(done)) || roofedInRock(facts.world),
    facts.food) : null;
  const night = choice ?? (planNow ? dayBedLine(facts.world, facts.counts, facts.dimension) : null);
  // end1109o06 (meta 13:10, the fifth first night lost) and o08 (the village's beds, meta 14:58): at dusk with the now an errand on the surface, it waits for the morning and the night's
  // choice (the sealed shaft down to the iron) goes first; the plan is not changed, its now is said as the morning's.
  const current = nodes.find(node => node.id === (display?.current ?? tree?.current));
  const huntWaits = !!choice && !!current && SURFACE_ERRAND.test(current.title ?? '') && !INDOOR.test(current.title ?? '');
  // end1109o10: 「朝へ回す」 alone left the night with no now; the first open node of the ore (iron, then the diamonds) is said as the night's.
  const underNode = huntWaits ? nodes.find(node => node.state !== 'done' && node.state !== 'blocked' && node.id !== current?.id
    && !nodes.some(kid => kid.parentId === node.id && kid.state !== 'done') && /鉄(?!ゴーレム)|ダイヤ|iron|diamond/u.test(`${node.title ?? ''} ${node.doneWhen ?? ''}`)) : undefined;
  const onceFacts = taskId ? (preparationFacts(taskId, tree, observation), staleNodeFacts(taskId, tree, observation)) : undefined;
  return {
    ...(planNow ? { planNow: huntWaits ? `${night}。今の節 ${planNow} は地上の用事なので朝へ回す（夜の地上は骸骨・クリーパー・ゾンビが多い。朝になったら続ける）。${underNode ? `夜の間は地下の節 [${underNode.id}] ${underNode.title} を進める（地下の暗さは昼も夜も同じ）` : '夜の間は地下で鉱石を掘る'}`
      : [night, first].filter(Boolean).length ? `${[night, first].filter(Boolean).join('。')}。その後に今の節 ${planNow}` : planNow } : {}),
    ...(shortage ? { shortage } : {}),
    ...recoveryParts(recovery, () => foodLeads(facts.world, facts.dimension, nodes), route),
    ...(planFacts ? { planFacts } : {}),
    ...(onceFacts?.length ? { onceFacts } : {}),
  };
}

export const STALE_FACT_KEY = 'stale_node:';

function recoveryParts(health: string | null, leads: () => string, route: readonly string[]): { recovery?: string[] } {
  const lines = [...(health ? [health, leads()] : []), ...route];
  return lines.length ? { recovery: lines } : {};
}

/** For each task: the current node and the milestones that were reached when it became the current node. */
export const sinceCurrent = new Map<string, { node: string; reached: ReadonlySet<string> }>();

/**
 * Run 48 (the live state's `planNow` said 「[n1] 食料不足のまま鉄へ（地上に動物なし）」 from +190 s to the end; the iron pickaxe,
 * the diamond pickaxe and the obsidian came and went): a node the model
 * added with no condition the code can read (`doneWhen` empty or in free words) is moved by the model's
 * `plan.update` alone, and the model tags every act with the current node. When milestones
 * of the plan are reached while such a node is the current one, the fact is said once for each new one: the node
 * has no condition and is not done, and which milestones were reached since it became the
 * current node. The node's state is the model's; nothing is moved here.
 */
function withdrawFacts(taskId: string, predicate: (fact: OnceFact) => boolean): void {
  for (const fact of pending(taskId)) if (predicate(fact)) withdraw(taskId, fact.key);
}

export function staleNodeFacts(taskId: string, tree: PlanTree | null, observation: BodyObservation | null): OnceFact[] {
  const missing = tree ? missingNodeFact(taskId, tree) : null;
  if (missing) offer(taskId, 'missing_node', missing);
  else if (tree) withdraw(taskId, 'missing_node');
  const reached = reachedMilestoneNames(tree, observation);
  const node = tree?.current ? tree.nodes.find((item) => item.id === tree.current) : undefined;
  if (!tree || !reached || !node) return pending(taskId);
  const kept = sinceCurrent.get(taskId);
  if (!kept || kept.node !== node.id) {
    sinceCurrent.delete(taskId);
    sinceCurrent.set(taskId, { node: node.id, reached: new Set(reached) });
    if (sinceCurrent.size > 32) sinceCurrent.delete(sinceCurrent.keys().next().value as string);
    withdrawFacts(taskId, (old) => old.key.startsWith(STALE_FACT_KEY));
    return pending(taskId);
  }
  const unreadable = node.state !== 'done' && parseDoneWhen(node.doneWhen) === null;
  const since = reached.filter((name) => !kept.reached.has(name));
  withdrawFacts(
    taskId,
    (old) => old.key.startsWith(STALE_FACT_KEY) && (!unreadable || !old.key.startsWith(`${STALE_FACT_KEY}${node.id}:`)),
  );
  if (unreadable && since.length) {
    offer(
      taskId,
      `${STALE_FACT_KEY}${node.id}:${since.length}`,
      `今の節 ${node.id}「${node.title.slice(0, 30)}」には、済む条件が書かれておらず（コードが読める形でない）、done にもなっていない。この節が今の節になってから、計画の節目 ${since.join('・')} に着いた`,
    );
    withdrawFacts(
      taskId,
      (old) => old.key.startsWith(`${STALE_FACT_KEY}${node.id}:`) && old.key !== `${STALE_FACT_KEY}${node.id}:${since.length}`,
    );
  }
  return pending(taskId);
}

export const PREP_FACT_KEY = 'prep_unmet:';

/**
 * Chapter 7 / chapter 8: she is below the surface with a preparation node unmet (the old `descentClosed` closed
 * it and wrote that it was skipped). The head says the fact,
 * once (`minecraftLlmcOnceFacts.ts`); the node's `state` and `prep` are the model's. A fact still pending when
 * the node no longer fits (done, or the model wrote `prep` on it) is taken
 * back; with no frame nothing is taken back (no frame says nothing). Returns the facts now pending for the task.
 */
export function preparationFacts(taskId: string, tree: PlanTree | null, observation: BodyObservation | null): OnceFact[] {
  const frame = doneFacts(observation);
  if (!tree || !frame) return pending(taskId);
  const now = prepUnmetFacts(tree, frame);
  for (const fact of now) offer(taskId, fact.key, fact.text);
  withdrawFacts(taskId, (old) => old.key.startsWith(PREP_FACT_KEY) && !now.some((fact) => fact.key === old.key));
  return pending(taskId);
}

/** The current node (its id and title), from the tree; else from the display the body was given. */
export function currentNodeOf(llmc: LlmcBodyParts): { id: string; title: string } | null {
  const tree = planTreeOf(llmc),
    node = tree?.current ? tree.nodes.find((item) => item.id === tree.current) : undefined;
  if (node) return node;
  const display = llmc.plan();
  return display?.nodes.find((item) => item.id === display.current) ?? null;
}

/** r6: an act with a wait hand, stored with the fact that health does not come back now (the same words as the live state's). */
export function withRecoveryFact(name: string, input: unknown, stored: string, observation: BodyObservation | null): string {
  if (name !== MC_ACT_TOOL) return stored;
  let hands: readonly { do?: string }[] = [];
  try {
    hands = (normalizeActInput(input).input as ActInput | null)?.hands ?? [];
  } catch {
    hands = [];
  }
  const facts = hands.some((hand) => hand.do === 'wait') ? readinessOf(observation) : null;
  const recovery = facts ? recoveryLine(facts.hunger, facts.health, facts.food, facts.counts) : null;
  return recovery ? `${stored}\n頭: ${recovery}` : stored;
}

/** mb-llmc-cand 11: the road and meter lines of a dragon task (`minecraftLlmcRoad.ts`); none for another task. */
export function roadParts(
  llmc: LlmcBodyParts,
  observation: BodyObservation | null,
  minutes: number | null,
  heldMs = 0,
): { road?: string; meter?: string } {
  let tree: PlanTree | null = null;
  try {
    tree = llmc.planTree?.() ?? null;
  } catch {
    tree = null;
  }
  // Chapter 8: the meter's seconds are the seconds the task ran, without the time it was held (the time limit counts the same).
  const road = roadLine(tree),
    meter = meterLine(tree, observation, minutes, heldMs);
  return { ...(road ? { road } : {}), ...(meter ? { meter } : {}) };
}
