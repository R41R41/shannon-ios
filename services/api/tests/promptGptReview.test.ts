import { afterEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { SHORT_ACT_DESCRIPTION, SHORT_ACT_INPUT_SCHEMA } from '../src/contracts/minecraftActShortContract.js';
import { minecraftV2System } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';
import { readableBootstrap } from '../src/infra/models/anthropic/anthropicFcaBootstrapText.js';
import { PLAN_UPDATE_RULES_DEFINITION } from '../src/mind/action/fca/fcaPlanTools.js';
import { candidateAct, candidateMenuTools, isUrgentLive } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { descentNote, recoveryLine } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { forgetFurnaceStands, furnaceStandHold } from '../src/surfaces/minecraft/minecraftLlmcFurnaceWait.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { createFoodTrend, llmcTokens, lookHint, minecraftLlmcLive, minecraftLlmcUrgentLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { PREP_NOTE } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { PREP_DESCENT_RULE, PREP_RULES_WORDS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { rangeStop } from '../src/surfaces/minecraft/minecraftLlmcRangeGuard.js';
import { rewriteLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';
import { URGENT_NOTE } from '../src/surfaces/minecraft/minecraftLlmcUrgent.js';
import { meterLine } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { stageKnowledge, V2_ALWAYS, V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { ALWAYS_TEXT_CAP_LLMC } from './support/alwaysTextCap.js';

/**
 * GPT's blind review of the prompt (2026-10-28, owner approved: rules in the instructions, facts in the live state and the results; the sure faults put right in
 * the words only). What this holds: where each rule is said once, what the live state and the results no longer say, and the urgent live state's lost facts.
 */
afterEach(() => forgetFurnaceStands());

const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: { alive: true } });
const pack = (items: Array<[string, number]>) => items.map(([name, count]) => ({ name, count }));
const system = minecraftV2System(V2_ALWAYS);

describe('the rules are in the instructions', () => {
  it('says the three forms of a decision, the full queue, and what comes first in an act against the queue (replace)', () => {
    expect(system).toContain('A decision is one of three: (1) Act: one or two mc_act (added to the queue)');
    expect(system).toContain('(2) Investigate: only mc_probe, mc_view, skill_read');
    expect(system).toContain('(3) Complete: fca_complete alone');
    expect(system).toContain('do not add when the queue is full at 3');
    expect(system).toContain("An added act goes behind the queue's last item (the first hand inside an act only runs first within that act)");
    expect(system).toContain('goes in with replace, which removes the current item');
  });
  it('writes the tools by their names, mc_act and not mc.act', () => {
    expect(system).not.toMatch(/mc\.(act|probe|view)|plan\.update/u);
    expect(SHORT_ACT_DESCRIPTION).not.toMatch(/mc\.(act|probe|view)|plan\.update/u);
  });
  it('puts the preparation as a rule for choosing the action, the requirement apart from the aim, and says a reason does not skip it', () => {
    expect(system).toContain('## Preparation rules (「準備の決まり」: before going down to dig iron)');
    // The always-on text carries the English form of the rule; the Japanese lines (below) are the planner's, so both are pinned.
    expect(system).toContain('Required (while unmet, do not go down or dig iron; to skip one, write skipped and the reason in prep; a skipped section does not count as achieved): food points 40 or more');
    expect(system).toContain('a stone pickaxe and a stone axe, and 1 crafting table or 4 or more planks (carried)');
    expect(system).toContain('Amounts: least/safe. Food 40/100 points; wood 12/24 logs');
    expect(system).toContain('fullness is no substitute');
    expect(system).toContain('Eating after the descent and dropping below 40 points is not an unmet requirement');
    expect(PREP_DESCENT_RULE).toContain('必須（未達の間は下りない・鉄を掘らない。省くなら prep に skipped と理由を書く。省いた節は達成に数えない）: 食料の点 40 以上');
    expect(PREP_DESCENT_RULE).toContain('石のツルハシと石の斧・作業台 1 つか板 4 以上');
    expect(PREP_DESCENT_RULE).toContain('量は最低と安心の両方: 食料は最低 40 点・安心 100 点、原木は最低 12・安心 24 本分');
    // The skip is said once, in the requirement (未達の間は下りない。省くなら prep に skipped と理由): not again in the priority line or the plan's.
    expect(system.split('write skipped and the reason in prep').length - 1).toBe(1);
    expect(system).not.toMatch(/never skip (the )?preparation|preparation is never skipped/i);
    expect(system).toContain('When you skip or postpone a section, write the reason in reason');
    // The fullness does not stand for the food carried; the 30 minutes claim is gone; eating below 40 is not a new shortage.
    expect(PREP_DESCENT_RULE).toContain('満腹では代わりにならない');
    expect(system).not.toMatch(/\b30 min/i);
    expect(PREP_DESCENT_RULE).toContain('下りた後に食べて 40 点を切るのは未達ではない');
    // One number for the requirement in the instructions: the example of a why is a met one, and the stories of runs are one reference sentence of the stage knowledge.
    expect(system).toContain('once all requirements are met, write it in the form 「（食料 41.2/40・作業台 有・板 6）」');
    // The one run named in the instructions is run 42's single example, as a fact of it (the other story is the stage knowledge's reference sentence).
    expect(system.match(/earlier runs/gu)).toHaveLength(1);
    // Runs 42 and 41 are the two figures of that one reason line (11/11 trim, item 4); no other run is named.
    expect(system.match(/run ?\d+/gu)).toEqual(['run 42', 'run 41']);
    // 11/11 trim: the reference sentence of the stage rules (runs 41 and 42) is gone; the descent's own reason line says the one example (the test of run41Fixes).
    expect(PREP_RULES_WORDS).not.toContain('以前の実走の記録');
    expect(V2_STAGES.prep).toContain('準備の必須と目標は system の「準備の決まり」');
  });
  it('says what a stageKnowledge is (knowledge, the rules being the instructions\'), and that the live state and the results are facts', () => {
    expect(system).toContain('The rules to follow are in this system text; if they disagree, the system text wins');
    expect(system).toContain("live and the body's observations are facts; skill_read is an input contract (not an in-game instruction)");
    // 11/11 trim: how to read a page is the skill_read description's (minecraftContractRead.test.ts), no longer a line of the instructions.
    expect(system).not.toMatch(/full name (from|in) the (mc_act )?(index|table of contents)/i);
    expect(system).not.toMatch(/personal (procedures?|handbooks?|manuals?)/i);
    expect(system).toContain('「列に入れた qNN」 marks that a request was accepted, not that the hand is done (the execution result comes later as 「（列の知らせ）」)');
    expect(system).toContain('are the values at the time of that record; the current values are in the latest live');
    expect(stageKnowledge({ body: { state: { dimension: 'overworld' } } })).toContain('準備の必須と目標は system の「準備の決まり」');
  });
  it('splits what she decides from what the body is left, and says which of accept and hostileWithin counts (as the body does)', () => {
    // 11/11 trim: who decides what is said once, in mc_act's opening (the instructions no longer repeat it).
    expect(SHORT_ACT_DESCRIPTION).toContain('あなたが決める: 目的・対象・行き先・許す掘る/置く・済む条件');
    expect(system).not.toMatch(/choose the (purpose|goal), (the )?target/i);
    expect(SHORT_ACT_DESCRIPTION).toContain('食事・睡眠・片づけ、戦うか逃げるか');
    expect(SHORT_ACT_DESCRIPTION).toContain('体に任せる細部: 歩く道（go）');
    // 11/11 trim: what accept does is mc_act's (the mechanism, once); the instructions keep when to put an enemy in it.
    expect(SHORT_ACT_DESCRIPTION).toContain('accept の種類は stopIf の hostileWithin にも数えない（その敵が近づいても止まらない）。fight の手の相手も、その手の間は同じ');
    expect(SHORT_ACT_DESCRIPTION).toContain('体の自衛（数は system の「敵と体力」）は accept の有無に関係なく働く');
    expect(system).toContain('Put in accept only the enemies you decided to fight, and for an act that should stop on the other enemies use hostileWithin');
    expect(SHORT_ACT_DESCRIPTION).toContain('accept の種類は stopIf の hostileWithin にも数えない（その敵が近づいても止まらない）。fight の手の相手も、その手の間は同じ');
    expect(SHORT_ACT_DESCRIPTION).not.toContain('体は自分で決めない');
  });
  it('writes the plan rules by what they really are: forbid and caution are ops of plan_update, and a note is the node\'s line', () => {
    expect(system).toContain("write one line into the current section with plan_update's forbid (things not to do) or caution (things to watch out for) op (it appears in plan.rules)");
    const [plan] = candidateMenuTools([PLAN_UPDATE_RULES_DEFINITION]).filter(tool => tool.name === 'plan.update');
    expect(plan!.description).toContain('forbid・caution は live の plan.rules に');
    expect(plan!.description).toContain('note は節の補足の文で、live の plan の now・next の行に付く（rules には出ない）');
    expect(JSON.stringify(PLAN_UPDATE_RULES_DEFINITION.nativeInputSchema)).toContain('"forbid","caution","lift"');
  });
  it('gives the urgent answer once, in the instructions (a short thought, one act of three hands at most)', () => {
    expect(system).toContain('## Urgent decisions (「急ぎの時」)');
    expect(system).toContain('send one mc_act with at most 3 hands in total, and keep the why to 20 characters or fewer');
    expect(system).toContain('Move away, put a block between you and the enemy, enclose yourself, eat: before any mining or crafting');
    expect(URGENT_NOTE).toBe('急ぎの版（決まりは system の「急ぎの時」）');
  });
  it('says the fight rule without lowering retreatHp, the health that does not come back, and the units of a fight', () => {
    expect(system).toContain('At health 8 or below, do not fight when the enemies are over the counts');
    expect(system).toContain('While health does not recover (fullness below 18; recovery appears), eat before going down or fighting. Even with an enemy near, eat 1 item first');
    expect(SHORT_ACT_DESCRIPTION).toContain('retreatHp は戦いをやめて食べる/退く体力（今の体力以上だと始める前に退く）');
    expect(SHORT_ACT_DESCRIPTION).not.toContain('retreatHp は今の体力より低く');
  });
  it('says what a queue guarantees (not the preparation), the pre of a descent, and that a repeat is one rule in two places', () => {
    expect(SHORT_ACT_DESCRIPTION).not.toContain('前提を書かなくても列は安全に動く');
    expect(SHORT_ACT_DESCRIPTION).toContain('後ろの項目が古い前提で動くのを防ぐだけで、準備や安全の確認の代わりではない');
    expect(SHORT_ACT_DESCRIPTION).toContain('下りる act の pre "food>=40&have:crafting_table|food>=40&have:planks>=4"');
    const rule = 'rel の手か、座標の無い手（attack・pickup・eat・craft・wait）だけ';
    expect(SHORT_ACT_DESCRIPTION).toContain(rule);
    expect((SHORT_ACT_INPUT_SCHEMA.properties.repeat as { description: string }).description).toBe('手の組を最大何回まわすか（rel の手か、座標の無い手だけ）');
    expect(SHORT_ACT_DESCRIPTION).toContain('"op":"take"');
    expect(SHORT_ACT_DESCRIPTION).not.toContain('look|take|put|takeAll');
    expect(SHORT_ACT_DESCRIPTION).toContain('地図の o は鉄ではない');
  });
  it('does not say how many acts or hands twice: the count is the instructions\', the limit of hands the description\'s', () => {
    expect(SHORT_ACT_DESCRIPTION).not.toContain('1 つの判断で足すのは 1〜2 項目');
    expect(SHORT_ACT_DESCRIPTION).not.toContain('10〜12 手');
    expect(system).not.toMatch(/(up to|max(imum)?|at most) 12\b/i);
  });
  it('stays under the cap of the instructions (English since 11/11: the cap of tests/support/alwaysTextCap.ts)', () => {
    expect(llmcTokens(system)).toBeLessThan(ALWAYS_TEXT_CAP_LLMC);
  });
});

describe('the live state and the results say facts', () => {
  it('says the unmet preparation node as a state, not an order', () => {
    expect(PREP_NOTE).toBe('※下りる前の準備の節・未達');
    expect(PREP_NOTE).not.toMatch(/済ませてから|移らない/u);
  });
  it('says the state of the preparation of a descent and that an acceptance is not a check, with no rule and no story of a run', () => {
    const observation = frame({ dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, inventory: pack([['cooked_beef', 1]]), health: 20, food: 20,
      nearbyEntities: [{ name: 'cow', position: { x: 4, y: 70, z: 0 } }] });
    const note = descentNote({ hands: [{ do: 'go', to: { x: 3, y: 36, z: 4 } }] }, observation)!;
    expect(note).toMatch(/^準備の状態（この act は地下 y=36 へ下りる手）: 未達 — 食料 20\.8\/40 点/u);
    expect(note).toContain('この受付は、準備が満たされたことを表さない');
    expect(note).not.toMatch(/下りる前に|実走|約 500 秒/u);
  });
  it('says the recovery as the fact and the food in the pack, with no rule and no story', () => {
    const line = recoveryLine(16, 10, 11, carriedItemCounts({ inventory: pack([['bread', 1]]) }, {}))!;
    expect(line).toMatch(/^体力 10\/20 は自然に戻らない（満腹 16＜18、/u);
    expect(line).not.toMatch(/実走|食べる前に|戦う前に|死ぬ/u);
  });
  it('says the look as a fact, with the tools by name', () => {
    expect(lookHint({ recentStops: ['(1,64,2)→(1,66,2) 一歩ではない ×2 3秒前'] })).toBe('同じ所で同じ止まりが続いている（原因は見えていない。mc_view の slice で縦の断面、layers で周りが見られる）');
    expect(lookHint({}, 19)).not.toMatch(/動く前に|決める/u);
  });
  it('says the meter\'s preparation by its numbers, with no cost sentence and no order to write a skip', () => {
    const tree = seedPlan('エンドラを倒して')!;
    const line = meterLine(tree, frame({ position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', inventory: pack([['blue_bed', 1], ['spruce_planks', 2]]) }), 260 / 60)!;
    expect(line).toContain('今 食料 0/40 点（あと 40 点: bread 4 個）・作業台 無・板 2');
    expect(line).not.toMatch(/省くと|死ぬ|plan\.update/u);
  });
  it('does not tell a stand of waits to be sent again: the hold says the seconds left and the work instead, and the rule is in the instructions', () => {
    const observation = frame({ position: { x: 158, y: 66, z: 199 }, health: 20, food: 20, inventory: pack([['stone_pickaxe', 1]]),
      mapLandmarks: ['c 石炭[coal_ore] (160,66,203) 東2・南4 ×5 見えている'],
      jobs: [{ status: 'waiting_external', remainingEstimateMs: 148_000, input: 'raw_iron', count: 15, position: { x: 158, y: 66, z: 200 } }] });
    const hold = furnaceStandHold({ hands: [{ do: 'wait', seconds: 30 }] }, observation, 'gpt-review')!;
    expect(hold.kind).toBe('wait');
    expect(hold.line).toContain('かまど (158,66,200) の raw_iron×15 はあと約 148 秒（raw_iron×15 を1基で焼くと 150 秒かかる。1個 10 秒。基数に分けると並んで焼ける）');
    expect(hold.line).toContain('A) 石炭 (160,66,203)');
    expect(hold.line).not.toMatch(/もう一度|出し直/u);
    expect(system).toContain('A wait-only act only when nothing else can be done');
  });
  it('does not tell a fight to be sent with a lower retreatHp: the fact, and the health of 8 or under named', () => {
    const fight = (retreatHp: number) => ({ hands: [{ do: 'fight', target: '#5493', item: 'iron_sword', retreatHp }] });
    const low = rangeStop(fight(7), frame({ health: 6 }))!;
    expect(low.code).toBe('retreat_on');
    expect(low.line).toBe('retreatHp 7 は今の体力 6 以上で、始める前に退く値。fight は送っていない');
    expect(rangeStop(fight(16), frame({ health: 15 }))!.line).toBe('retreatHp 16 は今の体力 15 以上で、始める前に退く値。fight は送っていない');
    expect(low.line).not.toMatch(/低く|下げ/u);
  });
  it('labels a result of mc_act by what it is: taken into the queue, or not taken', () => {
    const rounds = [1, 2].map(n => ({ sequence: n, stepId: `s${n}`, messages: [
      { id: `${n}:0`, role: 'tool_call', callId: `c${n}`, content: JSON.stringify({ name: n === 1 ? 'mc_act' : 'mc_probe', input: { hands: ['wait 1'], kind: 'scan' } }) },
      { id: `${n}:1`, role: 'tool_result', callId: `c${n}`, content: JSON.stringify({ ok: true, result: '列に入れた q1' }) }] }));
    const text = readableBootstrap(JSON.stringify({ kind: 'fca_public_history', summary: null, rounds }))!;
    expect(text).toContain('結果（受付）:\n列に入れた q1');
    expect(text).toContain('結果（応答）:\n列に入れた q1');
    expect(text).not.toContain('結果（成功）');
  });
});

describe('the urgent live state keeps what it lost', () => {
  const inventory = [...Array.from({ length: 20 }, (_, i) => ({ name: `item_${i}`, count: 1 })), { name: 'iron_sword', count: 1 }, { name: 'cobblestone', count: 89 }];
  const world = { position: { x: 0, y: 64, z: 0 }, health: 14.1, food: 16, dimension: 'overworld', inventory: [...pack([['bread', 2], ['cooked_beef', 1]]), ...inventory],
    nearbyThreats: [{ id: 5, name: 'drowned', distance: 5, position: { x: 3, y: 64, z: 3 }, canReachMe: true, canSee: false }] };
  const parts = { observation: frame(world), elapsedMinutes: 3, events: [] as string[], planNowTitle: '[p3] 原木から作業台', mode: URGENT_NOTE,
    recovery: ['体力 14.1/20 は自然に戻らない（満腹 16＜18、食料 39.6 点）'] };
  it('says its mode, the food points and the recovery, and that the pack was cut (the count of what was left out)', () => {
    const urgent = minecraftLlmcUrgentLive(parts);
    expect(urgent.mode).toBe(URGENT_NOTE);
    expect(urgent.foodPoints).toMatchObject({ total: expect.any(Number) });
    expect(urgent.recovery).toEqual(parts.recovery);
    expect(urgent).not.toHaveProperty('answer');
    const shown = urgent.inventory as string[];
    expect(shown).toHaveLength(15);
    expect(shown.at(-1)).toBe('ほか10件（長いため略）');
    // What an urgent decision uses is shown first: the sword (it was cut by the alphabet in run 43), the food, the blocks to wall with.
    for (const kept of ['iron_sword×1', 'bread×2', 'cooked_beef×1', 'cobblestone×89']) expect(shown, kept).toContain(kept);
  });
  it('counts the pack from all of the stacks, not from the ones shown (the 24 stacks, not 15)', () => {
    const urgent = minecraftLlmcUrgentLive(parts);
    const rewritten = rewriteLlmcLive({ plan: {}, body: { state: { at: '(0,64,0)' }, ...urgent } }).live.body as Record<string, unknown>;
    // 24 lines; the cobblestone×89 fills two slots (the body writes one line a kind, run 46), so 25 of the pack
    expect((rewritten.pack as string[])[0]).toMatch(/使用 25\/36/u);
  });
  it('is known as an urgent live state by its mode, and by the answer line of a recorded live of the earlier form', () => {
    expect(isUrgentLive({ body: { mode: URGENT_NOTE } })).toBe(true);
    expect(isUrgentLive({ body: { answer: '急ぎの答え方: 考えは 2〜3 文まで。mc.act は 1 つ、手は 3 つまで、why は 20 字まで。' } })).toBe(true);
    expect(isUrgentLive({ body: {} })).toBe(false);
    const sent = candidateAct({ hands: ['jump 1', 'jump 1', 'jump 1', 'jump 1'] }, frame(world), 'gpt-review', { urgent: true });
    expect(sent.guard?.sentHands).toBe(3);
    expect(sent.guard?.text).toContain('急ぎの判断は 3 手まで（system の「急ぎの時」。eat は数えない）');
  });
  it('is made of facts: the live state of a calm decision has no key answer either', () => {
    const calm = minecraftLlmcLive({ observation: frame(world), elapsedMinutes: 3, trend: createFoodTrend(), events: [] });
    expect(calm).not.toHaveProperty('answer');
    expect(calm).not.toHaveProperty('mode');
  });
});
