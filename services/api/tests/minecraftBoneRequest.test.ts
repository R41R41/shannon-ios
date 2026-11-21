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
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { unheldReplan } from '../src/wiring/minecraftLlmcReplanWiring.js';

afterEach(() => {
  forgetReplans();
  forgetStalls();
});

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
    expect(steps).toContain('牛・ニワトリ・羊は、牛乳と卵のために倒さない');
    expect(steps).toContain('持ち物にある材料の節は済み。戻って作り直さない');
    expect(steps).toContain('鉄は、バケツが足りない時のバケツ用だけ');
  });

  it('is in the first plan of a one-thing request and in every overworld decision, and not in the whole game\'s plan', () => {
    const single = singleRequestFirstPlanSystem();
    for (const line of [...REQUEST_STEPS_LINES, ...REQUEST_PLAN_SHAPE_LINES]) expect(single).toContain(line);
    expect(ownFirstPlanSystem()).not.toContain('依頼を最後までやる段取り');
    const decision = stageKnowledge({ body: { state: { dimension: 'overworld' } } })!;
    for (const line of REQUEST_STEPS_LINES) expect(decision).toContain(line);
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
    expect(stageKnowledge({ body: { state: { dimension: 'overworld' } } })!).toContain(REQUEST_NIGHT_LINE);
  });
});

describe('the whole game\'s preparation is for the whole game', () => {
  it('tells the always-on instructions that the descent\'s rules (food, stone tools) are not for a one-thing request', () => {
    const text = candidateInstructions();
    expect(text).toContain(REQUEST_SCOPE_EN);
    expect(text.indexOf(REQUEST_SCOPE_EN)).toBeLessThan(text.indexOf('- Required (while unmet'));
    expect(text).toContain('For a one-thing request: that thing, as fast as possible.');
  });
});

describe('the plan made again for a request of one thing', () => {
  const frame = (world: object): BodyObservation => ({ connected: true, state: { world }, facts: {}, bodyId: 'b', sequence: 1, stateAt: new Date(0).toISOString() }) as unknown as BodyObservation;
  const idle = frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [{ name: 'oak_log', count: 2 }, { name: 'bone_meal', count: 24 }] });
  const signal = new AbortController().signal;
  const cake = (): PlanTree => ({ ...planFromSeeds([{ title: '小麦 3 本', kind: 'food', doneWhen: 'have:wheat>=3' }, { title: 'ケーキを作る', kind: 'food', doneWhen: 'have:cake>=1' }]), current: 'p1' }) as PlanTree;

  function setup(goal: string, planTree: () => PlanTree) {
    const clock = { now: 0 };
    const briefs: string[] = [];
    const queue = { onRan: (_listener: RanListener) => undefined, lines: () => [], runningInput: () => null } as unknown as LlmcQueue;
    const unheld = unheldReplan({ held: false, taskId: 'bone', goal, createdAt: new Date(0).toISOString(), checkpoint: null,
      replanner: async (_system, brief) => { briefs.push(brief); return { ops: [], why: '待ち' }; },
      observe: () => idle, plan: { tree: planTree, view: () => null },
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
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('カカオ豆・骨・食料・ベッド・石の道具は要らない');
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('骨を集めない・夜に探しに出ない');
    expect(REQUEST_REPLAN_KNOWLEDGE).toContain('doneWhen は have:bone_meal>=数');
  });
});
