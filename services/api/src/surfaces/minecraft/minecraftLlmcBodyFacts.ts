import { targetRequirements } from './minecraftPlanRequirements.js';
import type { BodyObservation, BodyPlanView } from '../../contracts/bodyControlContract.js';
import { MC_ACT_TOOL } from '../../contracts/minecraftActContract.js';
import { carriedFood } from './minecraftLlmcLive.js';
import { requestFlag } from './minecraftLlmcFightFacts.js';
import { doneFacts, parseDoneWhen, prepUnmetFacts, undergroundInOverworld } from './minecraftPlanDone.js';
import { dayBedLine, dayNoBedLine, nightChoiceLine } from './minecraftNightArms.js';
import { animalsLine, enderSeenWords, nightMeanwhileLine, notePearlWatch, pearlDayLine, pearlNowOf } from './minecraftNightPearl.js';
import { firstPlanWaiting } from './minecraftFirstPlan.js';
import { frameDigLine } from './minecraftEndFrameDig.js';
import { noPickObsidianLine, spareDigWords } from './minecraftLlmcFightFacts.js';
import { sleepStateLine } from './minecraftLlmcSleepHold.js';
import { furnaceMeanwhileLine } from './minecraftFurnaceMeanwhile.js';
import { nowKinds, PLAN_FACTS_KEY, planFactsOf, type PlanFacts } from './minecraftPlanFacts.js';
import { isDragonPlan, reachedMilestoneNames } from './minecraftLlmcRoad.js';
import { offer, pending, withdraw, type OnceFact } from './minecraftLlmcOnceFacts.js';
import { wantsFood, type FactsContext } from './minecraftLlmcFacts.js';
import type { PlanKind, PlanTree } from '@shannon/mind';
import { meterLine, roadLine } from './minecraftLlmcRoad.js';
import {
  beforeStronghold,
  feetIn,
  foodFirstLine,
  foodLeads,
  fuelShortage,
  parallelFurnaceLine,
  furnaceReachLine, ironSearchLine, sheepAbsentLine, goldAbsentLine, foodAbsentLine,
  preparationShortage,
  preparationStage,
  readinessOf,
  recoveryLine,
} from './minecraftLlmcReadiness.js';
import { BED_ITEM, wornItems } from './minecraftItems.js';
import { carried } from './minecraftConditions.js';
import { eyeBasisOf } from './minecraftEyeSpare.js';
import { END_BEDS, END_OBSIDIAN } from './minecraftLlmcPrepRules.js';
import { ARROWS_TO_CARRY } from './minecraftEndPrepWords.js';
import { waterNodeFacts } from './minecraftLlmcWaterNode.js';
import { shiftFacts } from './minecraftLlmcShiftFacts.js';
import { missingNodeFact, planNowOf } from './minecraftLlmcNode.js';
import type { Goal } from './minecraftLlmcHazardFacts.js';
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
  /** The task's goal is a request of one thing (`planGoal` is null): said in `planFacts`, so that the decision's stage knowledge carries the request's steps. */
  singleRequest?: boolean;
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
  /** The node's go detour line (`detourLines`). */
  detour?: readonly string[];
  failures?: readonly string[];
  /** A blow of fire within the window (`burnedRecently`), and where the hands go (`queueGoal`, else the plan's place). */
  burning?: boolean;
  goal?: Goal | null;
}

/** The facts' context from the plan's promises (the tree), and whether food is what she is short of (the near
 * words' own reading). */
/**
 * Whether the pearls are the plan's now: the node's kind is `pearl`, or the pearls are short for the portal room's frames in the End's stage (`pearlNowOf`: the renamed pearl node
 * of the run of 11/27 kept the kind `stronghold`, and the night's "not asleep" fact never came). A request of one thing has no pearls to hunt.
 */
export function pearlNowFor(llmc: Pick<LlmcBodyParts, 'singleRequest' | 'journeyReadiness'>, planFacts: PlanFacts | undefined, observation: BodyObservation | null): boolean {
  const kinds = nowKinds(planFacts), kindPearl = kinds.includes('pearl');
  const facts = readinessOf(observation);
  if (!facts) return kindPearl;
  return pearlNowOf({ kindPearl, world: facts.world, counts: facts.counts, dimension: facts.dimension, journey: llmc.singleRequest !== true && llmc.journeyReadiness !== false,
    endStage: preparationStage(facts.dimension, facts.counts, kinds) === 'end' });
}

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
  const endgame = llmc.endgame?.lines(observation, isDragonPlan(tree), pearlNowFor(llmc, planFacts, observation));
  return {
    ...(judge.hits ? { hits: judge.hits } : {}),
    ...(judge.burning ? { burning: true } : {}),
    ...(judge.goal ? { goal: judge.goal } : {}),
    nowKinds: nowKinds(planFacts),
    ...requestFlag(planFacts),
    ...(endgame?.lines.length ? { endgame } : {}),
    ...(tree?.promises.length ? { promises: tree.promises } : {}),
    ...(judge.since
      ? {
          since: judge.since,
        }
      : {}),
    ...(judge.ahead?.length ? { ahead: judge.ahead } : {}),
    ...(judge.stops?.length ? { stops: withStopReadings(judge.stops) } : {}),
    ...(judge.detour?.length ? { detour: judge.detour } : {}),
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
): { planNow?: string; shortage?: string; recovery?: string[]; planFacts?: PlanFacts; onceFacts?: OnceFact[]; animals?: string } {
  const facts = readinessOf(observation);
  const tree = planTreeOf(llmc),
    nodes = tree?.nodes ?? [],
    planNow = planNowOf(tree, view, observation);
  const planFacts = planFactsOf(tree, llmc.singleRequest === true) ?? undefined;
  const out = { ...(planNow ? { planNow } : {}), ...(planFacts ? { planFacts } : {}) };
  if (!facts) return out;
  notePearlWatch(taskId, facts.world, facts.dimension);
  const pearlNow = pearlNowFor(llmc, planFacts, observation);
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
      fuelShortage(facts.world, facts.counts, nowKinds(planFacts)),
      parallelFurnaceLine(facts.world, facts.counts),
      furnaceReachLine(facts.world, facts.counts),
      ironSearchLine(facts.world, facts.counts, facts.dimension, tree?.nodes.find(node => node.id === tree.current), facts.at ?? null),
      sheepAbsentLine(facts.world, facts.counts, facts.dimension, tree?.nodes ?? [], tree?.nodes.find(node => node.id === tree.current)),
      goldAbsentLine(facts.world, facts.counts, facts.dimension, tree?.nodes ?? [], tree?.nodes.find(node => node.id === tree.current)),
      foodAbsentLine(facts.world, facts.food, facts.dimension, tree?.nodes.find(node => node.id === tree.current), facts.counts, tree?.nodes, facts.at ?? null),
      targetRequirements(tree?.nodes.find(node => node.id === tree.current), facts.counts, tree ?? undefined),
      endLackLine(facts, nowKinds(planFacts), llmc.journeyReadiness),
      frameDigLine(facts.world, facts.counts, feetIn(facts.world)),
      llmc.journeyReadiness !== false ? noPickObsidianLine(facts.counts, facts.dimension, preparationStage(facts.dimension, facts.counts, nowKinds(planFacts)) === 'end') : null,
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
    facts.food, llmc.singleRequest !== true && carried(facts.counts, 'ender_eye') <= 0, llmc.singleRequest === true) : null;
  // No bed by day is said too (a night with no bed cost two deaths and the materials in a run), unless a plan node already makes it; and the night's sleep in one line
  // beside the plan's now (a skip on, a booking the body may keep, what a sleep costs), so the sleep is weighed against what the node is for.
  const bedNode = nodes.some(node => node.state !== 'done' && node.state !== 'blocked' && (node.kind === 'bed' || node.kind === 'village' || /ベッド|have:bed|\bbed\b/u.test(`${node.title ?? ''} ${node.doneWhen ?? ''}`)));
  const bedLine = choice ?? (planNow ? dayBedLine(facts.world, facts.counts, facts.dimension, pearlNow, llmc.singleRequest !== true && carried(facts.counts, 'ender_eye') <= 0, () => dayBedAdviceTold(taskId))
    ?? dayNoBedLine(facts.world, facts.counts, facts.dimension, bedNode) : null);
  const nodeNow = nodes.find(node => node.id === (display?.current ?? tree?.current));
  const sleepLine = planNow && taskId ? sleepStateLine(observation, taskId, nodeNow?.title ?? null, undefined, pearlNow) : null;
  // 11/27: while the pearls are short the day's fact (where they mainly come from, what the day has shown of endermen) and, as the dusk comes, what can be moved besides waiting.
  const pearlLines = planNow ? [pearlDayLine(facts.world, facts.counts, facts.dimension, pearlNow, enderSeenWords(taskId)), nightMeanwhileLine(facts.world, facts.counts, facts.dimension, pearlNow)] : [];
  const night = [sleepLine, bedLine, ...pearlLines].filter(Boolean).join('。') || null;
  const animals = animalsLine(taskId, facts.world);
  // Run 6 (2026-11-11): while a furnace works, the hands to take instead of standing (the iron and coal in reach, the plan's next section that does not need the furnace's output),
  // said first like the night's choices (the replay of the night's line moved 3/6 to 6/6); the same choices are in the hold of a long wait (`furnaceStandHold`).
  const meanwhile = planNow ? furnaceMeanwhileLine(facts.world, facts.counts, nodes, display?.current ?? tree?.current ?? null, taskId) : null;
  // end1109o06 (meta 13:10, the fifth first night lost) and o08 (the village's beds, meta 14:58): at dusk with the now an errand on the surface, it waits for the morning and the night's
  // choice (the sealed shaft down to the iron) goes first; the plan is not changed, its now is said as the morning's.
  const current = nodes.find(node => node.id === (display?.current ?? tree?.current));
  const huntWaits = !!choice && llmc.singleRequest !== true && !!current && SURFACE_ERRAND.test(current.title ?? '') && !INDOOR.test(current.title ?? '');
  // end1109o10: 「朝へ回す」 alone left the night with no now; the first open node of the ore (iron, then the diamonds) is said as the night's.
  const underNode = huntWaits ? nodes.find(node => node.state !== 'done' && node.state !== 'blocked' && node.id !== current?.id
    && !nodes.some(kid => kid.parentId === node.id && kid.state !== 'done') && /鉄(?!ゴーレム)|ダイヤ|iron|diamond/u.test(`${node.title ?? ''} ${node.doneWhen ?? ''}`)) : undefined;
  const waiting = !!taskId && !!firstPlanWaiting(taskId);
  const spare = spareDigWords(facts.counts, facts.dimension);
  const onceFacts = taskId ? (preparationFacts(taskId, tree, observation), waterNodeFacts(taskId, tree, observation), shiftFacts(taskId, observation), staleNodeFacts(taskId, tree, observation))
    : undefined;
  return {
    ...(planNow ? { planNow: huntWaits ? `${[meanwhile, night].filter(Boolean).join('。')}。今の節 ${planNow} は地上の用事なので朝へ回す（夜の地上は骸骨・クリーパー・ゾンビが多い。朝になったら続ける）。${underNode ? `夜の間は地下の節 [${underNode.id}] ${underNode.title} を進める（地下の暗さは昼も夜も同じ）` : '夜の間は地下で鉱石を掘る'}`
      : waiting ? planNowWhileFirstPlan(current ? `[${current.id}] ${current.title ?? ''}` : planNow, meanwhile, choice ? night : null, first)
      : planNowOrdered(spare && llmc.journeyReadiness !== false ? `${planNow}。${spare}` : planNow, meanwhile, night, first, !!choice) } : {}),
    ...(shortage ? { shortage } : {}),
    ...(animals ? { animals } : {}),
    ...recoveryParts(recovery, () => foodLeads(facts.world, facts.dimension, nodes, facts.at ?? null), route),
    ...(planFacts ? { planFacts } : {}),
    ...(onceFacts?.length ? { onceFacts } : {}),
  };
}

/**
 * Run 9 (11/27): the sleep and clock paragraph (700 to 1,200 characters) stood before the current node in every decision, and the node's line was read after a long
 * explanation of when to sleep; the head's 70 hands never served the first node. The furnace's hands and the food's first step still go before the node (they are about
 * the node's own hands); the sleep and bed paragraph goes after it, unless it is the night's choice (a night with no bed, a few minutes before dark: said first, as it was).
 */
export function planNowOrdered(planNow: string, meanwhile: string | null, night: string | null, first: string | null, nightIsChoice: boolean): string {
  const before = [meanwhile, nightIsChoice ? night : null, first].filter(Boolean);
  const head = before.length ? `${before.join('。')}。その後に今の節 ${planNow}` : planNow;
  return night && !nightIsChoice ? `${head}。${night}` : head;
}

/**
 * Seen in a real run: the first plan took 36 s to come, and the decision in between read the default plan's node (`原木 12`) with 「今の節を進める」 and 「待てば 9 分 なにも進まない」 beside it, and sent a
 * long go 100 m north, 113 m back (about 2 minutes); the plan's own note beside it said to wait with a probe, and the two did not agree. While the first plan is being written (`firstPlanWaiting`,
 * and not past its bound) the now is said as a stand-in: the node's title only, the wait, what is allowed (what is within 24 m), what is not (a long go) and why. The day's bed paragraph (the
 * 「進める」 and the cost of waiting) is left out for these seconds; the furnace's hands, the food's first step and the night's own choice (dusk) are kept.
 */
export function planNowWhileFirstPlan(node: string, meanwhile: string | null, nightChoice: string | null, first: string | null): string {
  const words = `最初の計画を書いている最中（この世界に合わせた計画が数十秒で届く）。計画の節は、今の節 ${node.slice(0, 60)} も次の節（村・ベッドなど）も、旧の準備順の既定計画の物なので、計画が届くまで始めない。`
    + '数十秒の間に出してよい手は、probe・view・wait 5 のような短い手と、24m 内で取れる物の短い手だけ。長い go（歩きが 30 秒を超える物）と、木・村・ベッドへの遠出は出さない。理由: 既定計画は旧の準備順で、'
    + '北の木や村へ出ると要塞と逆の向きに歩いて戻る往復になり、約 2 分を失った。計画が届けばこの文は消えて今の節が替わる';
  return [meanwhile, nightChoice, first, words].filter(Boolean).join('。');
}

/** What the missing pieces take in iron ingots (a helmet 5, a chestplate 8, leggings 7, boots 4: `IRON_USES`' 兜 and 胸 and the plan's own numbers), summed, beside what the pack holds (ingots; raw iron is smelted to one each). */
const ARMOUR_IRON: Readonly<Record<string, number>> = { 頭: 5, 胴: 8, 脚: 7, 足: 4 };
export function armourIronWords(missing: readonly string[], counts: ReadonlyMap<string, number>): string {
  const parts = missing.filter(label => ARMOUR_IRON[label]);
  if (!parts.length) return '';
  const total = parts.reduce((sum, label) => sum + ARMOUR_IRON[label]!, 0);
  const ingots = carried(counts, 'iron_ingot'), raw = carried(counts, 'raw_iron');
  return `。欠けた部位ぜんぶの鉄 ${parts.map(label => `${label} ${ARMOUR_IRON[label]}`).join('＋')}＝${total}（手元 インゴット ${ingots}・生の鉄 ${raw}）。足は鉄のブーツでよい（金のブーツはネザーに入る時だけ）`;
}

const ARMOUR_SLOTS: ReadonlyArray<readonly [string, string]> = [['helmet', '頭'], ['chestplate', '胴'], ['leggings', '脚'], ['boots', '足']];
/**
 * Run 7 of 11/26 (past the fortress the shortage listed the beds, obsidian and the bow, and said nothing of the pickaxe at 73 of 1561, the armour at 2 of 4 or the
 * pearls and rods that make up for a broken eye): the End's check as one line of numbers, each only while it falls short, from the pack, the worn line and the durability
 * the frame carries. Facts only; where to get an item is not said (the pack's own counts are all it knows).
 */
export function endLackLine(facts: NonNullable<ReturnType<typeof readinessOf>>, kinds: readonly PlanKind[] | null, journeyReadiness?: boolean): string | null {
  if (journeyReadiness === false || facts.dimension !== 'overworld' || preparationStage(facts.dimension, facts.counts, kinds) !== 'end') return null;
  const { counts, world } = facts, count = (item: string) => carried(counts, item);
  const lacks: string[] = [];
  const beds = [...counts].reduce((sum, [name, n]) => sum + (BED_ITEM.test(name) ? n : 0), 0);
  if (beds < END_BEDS) lacks.push(`ベッド ${beds}/${END_BEDS}（あと ${END_BEDS - beds}）`);
  if (count('obsidian') < END_OBSIDIAN) lacks.push(`黒曜石 ${count('obsidian')}/${END_OBSIDIAN}（あと ${END_OBSIDIAN - count('obsidian')}）${count('diamond_pickaxe') + count('netherite_pickaxe') > 0 ? '' : '。掘る手段が無い（ダイヤのつるはしが荷に無い）'}`);
  if (!count('bow')) lacks.push(`弓なし（作るなら糸 ${count('string')}/3・棒 ${count('stick')}/3。弓矢は道中の短い節で作る物で、遠い所へは往復しない）`);
  if (count('arrow') < ARROWS_TO_CARRY) lacks.push(`矢 ${count('arrow')}/${ARROWS_TO_CARRY}（羽根 ${count('feather')}・火打石 ${count('flint')}・棒 ${count('stick')}）`);
  const picks = (Array.isArray(world.inventory) ? world.inventory : []).flatMap(raw => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null, durability = item?.durability as Record<string, unknown> | undefined;
    const left = durability?.left, max = durability?.max;
    return item && /(?:^|:)(?:wooden|stone|golden|iron|diamond|netherite)_pickaxe$/u.test(String(item.name)) && typeof left === 'number' && typeof max === 'number' && max > 0
      ? [{ name: String(item.name), left, max }] : [];
  }).sort((a, b) => b.left - a.left)[0];
  if (picks && picks.left < picks.max / 2) lacks.push(`${picks.name} 耐久 ${picks.left}/${picks.max}`);
  const worn = wornItems(world.worn), missing = ARMOUR_SLOTS.filter(([slot]) => !worn.some(name => name.endsWith(`_${slot}`))).map(([, label]) => label);
  if (missing.length) lacks.push(`防具 ${4 - missing.length}/4（${missing.join('・')}が無い）${armourIronWords(missing, counts)}`);
  // One measure with the eye fact beside the shortage (`eyeBasisOf`): 12 plus the spare for the throws to come while the frames are still to be found. Once they are found (in view or in the
  // body's record) the empty frames' number is said by the shortage's own two lines, so it is not said a third time here (it was 10/12 here beside 10/11 there).
  const eyes = count('ender_eye'), basis = eyeBasisOf(world);
  if (basis.kind === 'search' && eyes < basis.need) lacks.push(`アイ ${eyes}/${basis.need}（枠 12＋予備 ${basis.spare}。足せる材料: パール ${count('ender_pearl')}・粉 ${count('blaze_powder')}・ロッド ${count('blaze_rod')}）`);
  // The same sentence is in the heading just before (`END_PREP_AFTER_STRONGHOLD`); here it is said short, for the line read alone.
  const behind = beforeStronghold(world, counts, kinds) ? '。点検物（ベッド・黒曜石・足場）は要塞の後ろでよい。取りに出る節は要らない。弓矢は別で、要塞の前の道中の短い節で作る（遠い所へは往復しない）。身を守る物（防具の欠け・食料・掘る道具）は、近くの材料で作れる分だけ発つ前に作ってよい' : '';
  return lacks.length ? `エンドへ入る前に要る物のうち足りない分（数${behind}）: ${lacks.join('・')}` : null;
}

/**
 * run 8 (11/27): the same iron stopped four times on `limit_dig` and `inventory_full` and the head read it as "surrounded by water" (it was not water). The kinds of stop that
 * came, said once after the body's stop lines, with the number the limit is set against. Only for the codes present; a line the stops' readers do not match is skipped by them.
 */
const STOP_READINGS: ReadonlyArray<readonly [string, string]> = [
  ['limit_dig', 'limit_dig＝掘る数の上限 maxDig に着いた（水のせいではない）。掘る合計が n マスなら maxDig は n+5 以上にして同じ先へもう一度'],
  ['inventory_full', 'inventory_full＝持ち物が満杯で掘った物が入らない（水のせいではない）。空きを作ってから掘る'],
];
export function withStopReadings(stops: readonly string[]): string[] {
  const said = STOP_READINGS.filter(([code]) => stops.some(line => line.endsWith(`（${code}）`))).map(([, words]) => words);
  return said.length ? [...stops, `止まりの読み: ${said.join('。')}`] : [...stops];
}

/** How long the day's sleep explanation stands before it is said in full again (a night is about 8 minutes; the explanation is not repeated at every decision). */
const DAY_BED_ADVICE_MS = 8 * 60_000;
const dayBedTolds = new Map<string, number>();
/** True when the full explanation was said for this task within `DAY_BED_ADVICE_MS` (the caller then says the brief line); records the time when it is not. */
export function dayBedAdviceTold(taskId: string | undefined, now: number = Date.now()): boolean {
  if (!taskId) return false;
  const last = dayBedTolds.get(taskId);
  if (last !== undefined && now - last < DAY_BED_ADVICE_MS) return true;
  dayBedTolds.set(taskId, now);
  if (dayBedTolds.size > 32) dayBedTolds.delete(dayBedTolds.keys().next().value as string);
  return false;
}
/** For tests. */
export function forgetDayBedAdvice(): void { dayBedTolds.clear(); }

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
  const road = roadLine(tree, observation),
    meter = meterLine(tree, observation, minutes, heldMs);
  return { ...(road ? { road } : {}), ...(meter ? { meter } : {}) };
}
