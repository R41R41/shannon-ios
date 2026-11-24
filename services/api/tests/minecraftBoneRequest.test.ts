import { afterEach, describe, expect, it } from 'vitest';
import { planFromSeeds, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { ownFirstPlanSystem, singleRequestFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { MATERIAL_ACQUISITION_LINES } from '../src/surfaces/minecraft/minecraftRequestKnowledge.js';
import {
  REQUEST_NIGHT_LINE,
  REQUEST_PLAN_SHAPE_LINES,
  REQUEST_REPLAN_KNOWLEDGE,
  REQUEST_SCOPE_EN,
  REQUEST_STEPS_LINES,
} from '../src/surfaces/minecraft/minecraftRequestSteps.js';
import { stageKnowledge, stageTextsForKind } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { candidateInstructions } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { forgetReplans, REPLAN, REPLAN_SYSTEM } from '../src/surfaces/minecraft/minecraftLlmcReplan.js';
import { forgetStalls } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import type { LlmcQueue, RanListener } from '../src/surfaces/minecraft/minecraftLlmcQueueState.js';
import { createWaitLedger } from '../src/surfaces/minecraft/minecraftPurposeProgress.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { planGoal, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { readinessParts } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { plantLines } from '../src/surfaces/minecraft/minecraftLlmcReplanBrief.js';
import { unheldReplan } from '../src/wiring/minecraftLlmcReplanWiring.js';

afterEach(() => {
  forgetReplans();
  forgetStalls();
});

/** An overworld live state of a task whose goal is a request of one thing (the body's `planFacts` carries the flag the wiring sets from the goal). */
const asked = { body: { state: { dimension: 'overworld' }, planFacts: { now: null, above: [], next: [], request: true } } };

describe('a request of one thing asked with a method (bone meal): the words that carry it to its end', () => {
  const steps = REQUEST_STEPS_LINES.join('\n');

  it('names the method a person asks for as a step, the crop before the bone meal, and a made thing is not a done node', () => {
    expect(steps).toContain('その方法を飛ばさない');
    expect(steps).toContain('作っただけで節を閉じず、結果の物（bone_meal・wheat）で閉じる');
    expect(steps).toContain('置いて、入れて、満の骨粉を取り出すまでが 1 つの節');
  });

  it('says what to do when the bone meal is given: no hunt for it, no composter, use it on the crop as soon as it is planted', () => {
    expect(steps).toContain('骨粉をもらっている時（持ち物に bone_meal がある）');
    expect(steps).toContain('コンポスターは作らない');
    expect(steps).toContain('小麦を植えたらすぐ骨粉を使う');
  });

  it('keeps the materials that must not be lost: the cane for the sugar, the cows and chickens for milk and eggs, what is already in the pack', () => {
    expect(MATERIAL_ACQUISITION_LINES.join('\n')).toContain('サトウキビは砂糖 2 本の分を残した余りだけ入れ');
    expect(steps).toContain('牛・ニワトリは、牛乳と卵のために倒さない');
    expect(steps).toContain('持ち物にある材料の節は済み。戻って作り直さない');
    expect(steps).toContain('鉄は、バケツが足りない時のバケツ用だけ');
  });

  it('is in the first plan of a one-thing request and in the overworld decisions of one, and in nothing of the whole game', () => {
    const single = singleRequestFirstPlanSystem();
    for (const line of [...REQUEST_STEPS_LINES, ...REQUEST_PLAN_SHAPE_LINES]) expect(single).toContain(line);
    expect(ownFirstPlanSystem()).not.toContain('依頼を最後までやる段取り');
    const decision = stageKnowledge(asked)!;
    for (const line of REQUEST_STEPS_LINES) expect(decision).toContain(line);
    // first in the stage's text, not at the end of its twenty thousand tokens
    expect(decision.indexOf(REQUEST_STEPS_LINES[0]!)).toBeLessThan(decision.indexOf('- 地上の長い歩き'));
    // the whole game's overworld decision (no flag) and the whole game's replan text have none of it
    for (const whole of [stageKnowledge({ body: { state: { dimension: 'overworld' } } })!,
      stageKnowledge({ body: { state: { dimension: 'overworld' }, planFacts: { now: null, above: [], next: [] } } })!, stageTextsForKind('food', 'overworld')]) {
      expect(whole).not.toContain('依頼を最後までやる段取り');
      expect(whole).not.toContain(REQUEST_STEPS_LINES[1]!);
    }
  });

  it('shapes the plan: one node a material, the method inside the crop\'s node, a title and a doneWhen that name the same thing', () => {
    const shape = REQUEST_PLAN_SHAPE_LINES.join('\n');
    expect(shape).toContain('材料ごとに 1 節');
    expect(shape).toContain('植える・骨粉を使うは、この節の手');
    expect(shape).toContain('骨粉が持ち物に無い時だけ、骨粉の節');
    expect(shape).toContain('have:wheat_seeds>=3 で閉じない');
  });

  it('puts the night with no bed to work near, not to a hole, with the reason and the body\'s own defence', () => {
    expect(REQUEST_NIGHT_LINE).toContain('穴や囲いに入って朝を待たない');
    expect(REQUEST_NIGHT_LINE).toContain('待っても朝は早く来ず');
    expect(REQUEST_NIGHT_LINE).toContain('stopIf hostileWithin=8');
    expect(REQUEST_NIGHT_LINE).toContain('木の剣');
    expect(REQUEST_NIGHT_LINE.indexOf('木の剣')).toBeLessThan(REQUEST_NIGHT_LINE.indexOf('stopIf'));
    const request = stageKnowledge(asked)!;
    expect(request).toContain(REQUEST_NIGHT_LINE);
    expect(request).not.toContain('穴に入るのは寝る時だけ');
  });

  it('keeps the whole game\'s night line: a hole is the entrance to the work underground (as the night\'s choice A says), not a place to wait; the pen is not forbidden', () => {
    const whole = stageKnowledge({ body: { state: { dimension: 'overworld' } } })!;
    expect(whole).toContain('穴に入るのは、石のツルハシがあり、地下で鉱石を掘る作業がある時に、塞いだ縦穴を下りる入口にする場合だけ');
    expect(whole).not.toContain(REQUEST_NIGHT_LINE);
  });

  it('puts the food on the fullness, not on the pack\'s points, so that an empty pack is not read as a reason to hunt', () => {
    const food = REQUEST_STEPS_LINES.find(line => line.startsWith('- 食料は'))!;
    expect(food).toContain('満腹（fullness）が 8 以下');
    expect(food).toContain('foodPoints）が 0 でも');
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('満腹（fullness）が 8 以下');
  });
});

describe('a request of one thing gathers what its recipe needs and no more', () => {
  const steps = REQUEST_STEPS_LINES.join('\n');

  it('says it for any made thing with the reason, in the steps of the first plan and of every decision, and in the plan made again', () => {
    expect(steps).toContain('頼まれた物の配合に要る物と数だけを集める');
    expect(steps).toContain('鉄のツルハシ');
    expect(steps).toContain('それが無いと先へ進めない時だけ');
    expect(steps).toContain('理由: 配合に無い物を集めた分だけ');
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('配合に要る物と数だけを集める');
    expect(singleRequestFirstPlanSystem()).toContain('配合に要る物と数だけを集める');
    expect(stageKnowledge(asked)!).toContain('配合に要る物と数だけを集める');
  });

  it('counts what the queue is about to make as held, so the cake\'s three buckets are not made twice', () => {
    expect(steps).toContain('ケーキのバケツは牛乳と同じ 3 個で、6 個は要らない');
    expect(steps).toContain('次の手で増える見込み');
    expect(steps).toContain('同じ make を重ねて積まない');
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('同じ make を重ねない');
  });

  it('does not read the recovery line or the descent note as an order to hunt while the health is high', () => {
    expect(steps).toContain('体力が 15 以上の間は');
    expect(steps).toContain('「食料の当て」は、食べる必要が出た時の候補で、今狩れという指示ではない');
    expect(steps).toContain('準備の状態: 未達 — 食料');
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('体力が 15 以上なら');
  });

  it('is not in the whole game\'s texts (the dragon run\'s inputs are as they were)', () => {
    const whole = [stageKnowledge({ body: { state: { dimension: 'overworld' } } })!,
      stageKnowledge({ body: { state: { dimension: 'overworld' }, planFacts: { now: null, above: [], next: [] } } })!,
      ownFirstPlanSystem(), candidateInstructions()];
    for (const text of whole) for (const mark of ['配合に要る物と数だけ', 'ケーキのバケツは牛乳と同じ', '体力が 15 以上の間は']) expect(text).not.toContain(mark);
  });
});

describe('the whole game\'s preparation is for the whole game', () => {
  it('tells the always-on instructions that the descent\'s rules (food, stone tools) are not for a one-thing request', () => {
    const text = candidateInstructions();
    expect(text).toContain(REQUEST_SCOPE_EN);
    expect(text.indexOf(REQUEST_SCOPE_EN)).toBeLessThan(text.indexOf('- Required (while unmet'));
    expect(text).toContain('that one thing, made as fast as possible');
  });
});

describe('the plan made again for a request of one thing', () => {
  const frame = (world: object): BodyObservation => ({ connected: true, state: { world }, facts: {}, bodyId: 'b', sequence: 1, stateAt: new Date(0).toISOString() }) as unknown as BodyObservation;
  const idle = frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [{ name: 'oak_log', count: 2 }, { name: 'bone_meal', count: 24 }] });
  const signal = new AbortController().signal;
  const cake = (): PlanTree => ({ ...planFromSeeds([{ title: '小麦 3 本', kind: 'food', doneWhen: 'have:wheat>=3' }, { title: 'ケーキを作る', kind: 'food', doneWhen: 'have:cake>=1' }]), current: 'p1' }) as PlanTree;

  function setup(goal: string, planTree: () => PlanTree, seen: BodyObservation = idle) {
    const clock = { now: 0 };
    const briefs: string[] = [];
    const queue = { onRan: (_listener: RanListener) => undefined, lines: () => [], runningInput: () => null } as unknown as LlmcQueue;
    const unheld = unheldReplan({ held: false, taskId: 'bone', goal, createdAt: new Date(0).toISOString(), checkpoint: null,
      replanner: async (_system, brief) => { briefs.push(brief); return { ops: [], why: '待ち' }; },
      observe: () => seen, plan: { tree: planTree, view: () => null },
      bodyParts: { plan: () => undefined, planView: () => null, planTree, endgame: createEndgame(null) },
      queue, waits: createWaitLedger(null), activeClock: () => clock.now, heldMs: () => 0, validate: () => null, log: () => undefined });
    return { clock, briefs, unheld };
  }

  it('shows the short text of the request, which fits the brief, instead of the stage text, which does not (bn1 to bn4: it was dropped whole)', async () => {
    // the long text of the stage is over the brief's whole bound, so the brief always dropped it
    expect(llmcTokens(stageTextsForKind('food', 'overworld'))).toBeGreaterThan(REPLAN.briefTokens);
    expect(llmcTokens(REQUEST_REPLAN_KNOWLEDGE)).toBeLessThan(2_000);
    const { clock, briefs, unheld } = setup('骨粉を使って小麦を早く育てて、ケーキを作って', cake);
    unheld!.watch.look();
    clock.now = 130_000;
    expect(unheld!.watch.look()).toBe(true);
    await unheld!.flow.run(signal);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toContain('## この段の知識');
    expect(briefs[0]).toContain(REQUEST_REPLAN_KNOWLEDGE);
    expect(briefs[0]).toContain('bone_meal×24');
    expect(llmcTokens(briefs[0]!)).toBeLessThanOrEqual(REPLAN.briefTokens);
  });

  it('keeps the stage text for the whole game', async () => {
    const dragon = seedPlan('エンドラを討伐して')!;
    const { clock, briefs, unheld } = setup('エンドラを討伐して', () => ({ ...dragon, current: 'p1.1' }) as PlanTree);
    unheld!.watch.look();
    clock.now = 130_000;
    unheld!.watch.look();
    await unheld!.flow.run(signal);
    expect(briefs[0]).not.toContain(REQUEST_REPLAN_KNOWLEDGE);
  });

  it('says in the instructions that only the request\'s materials are added, and what to do for a stall on the crop\'s growth', () => {
    expect(REPLAN_SYSTEM).toContain('足してよい節は依頼の完成品とその材料の節だけ');
    expect(REPLAN_SYSTEM).toContain('小麦の育ち待ちで止まった時は、待たずに別の材料の節へ current を移す');
  });

  it('writes the recipe and the bone meal ways short: five materials, no cocoa beans or bones, the method in one node closed by the thing', () => {
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('小麦 3・砂糖 2・卵 1・牛乳入りバケツ 3 と作業台');
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('カカオ豆・骨・食料・石の道具は要らない');
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('骨を集めない・夜に探しに出ない');
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('doneWhen は have:bone_meal>=数');
  });
  it('shows the plan made again the wheat she planted, so that wheat 0 in the pack is not read as no wheat (bn4 added the table and the seeds again)', async () => {
    const planted = frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [{ name: 'bone_meal', count: 20 }],
      nearbyResources: [{ purpose: 'plant', kind: 'wheat', count: 3, range: 32, sites: [{ x: 3, y: 63, z: 1, note: '育ち中' }, { x: 4, y: 63, z: 1, note: '育った' }] },
        { purpose: 'plant', kind: 'sugar_cane', count: 0, range: 96, sites: [] }] });
    const { clock, briefs, unheld } = setup('骨粉を使って小麦を早く育てて、ケーキを作って', cake, planted);
    unheld!.watch.look();
    clock.now = 130_000;
    unheld!.watch.look();
    await unheld!.flow.run(signal);
    expect(briefs[0]).toContain('植物（材料）: wheat 32m 内に 3個');
    expect(briefs[0]).toContain('育ち中');
    expect(briefs[0]).not.toContain('sugar_cane');
    expect(plantLines(idle)).toEqual([]);
  });

  it('says in the facts of the plan that the task is a request, from the goal and not from a title, and the whole game says nothing', () => {
    const tree = cake();
    const base = { plan: () => undefined, planView: () => null, planTree: () => tree };
    expect(readinessParts({ ...base, singleRequest: true }, null, idle).planFacts?.request).toBe(true);
    expect(readinessParts(base, null, idle).planFacts).not.toHaveProperty('request');
    expect(planGoal('骨粉を使って小麦を早く育てて、ケーキを作って')).toBeNull();
    expect(planGoal('エンドラを討伐して')).toBe('dragon');
  });
});
