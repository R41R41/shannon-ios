import { afterEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { SHORT_ACT_DESCRIPTION, SHORT_ACT_INPUT_SCHEMA } from '../src/contracts/minecraftActShortContract.js';
import { minecraftV2System } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';
import { readableBootstrap } from '../src/infra/models/anthropic/anthropicFcaBootstrapText.js';
import { PLAN_UPDATE_RULES_DEFINITION } from '../src/mind/action/fca/fcaPlanTools.js';
import { candidateAct, candidateMenuTools, isUrgentLive } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { descentNote, recoveryLine } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { forgetFurnaceStands, furnaceStandStop } from '../src/surfaces/minecraft/minecraftLlmcFurnaceWait.js';
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
    expect(system).toContain('判断は 3 通り: (1) 動く: mc_act を 1〜2 つ（列に足す）');
    expect(system).toContain('(2) 調べる: mc_probe か mc_view だけ');
    expect(system).toContain('(3) 完了: fca_complete だけ');
    expect(system).toContain('列が 3 つでいっぱいなら足さない');
    expect(system).toContain('足した act は列の最後の後ろに付く（act の中の先頭は、その act の中で先に動くだけ）');
    expect(system).toContain('replace で今の項目を消して差し替える');
  });
  it('writes the tools by their names, mc_act and not mc.act', () => {
    expect(system).not.toMatch(/mc\.(act|probe|view)|plan\.update/u);
    expect(SHORT_ACT_DESCRIPTION).not.toMatch(/mc\.(act|probe|view)|plan\.update/u);
  });
  it('puts the preparation as a rule for choosing the action, the requirement apart from the aim, and says a reason does not skip it', () => {
    expect(system).toContain('## 準備の決まり（鉄を掘りに地下へ下りる前）');
    expect(PREP_DESCENT_RULE).toContain('必須（未達の間は、下りる act も鉄の採掘もしない。補う手を先に出す）: 食料の点 40 以上');
    expect(PREP_DESCENT_RULE).toContain('石のツルハシと石の斧・作業台 1 つか板 4 以上');
    expect(PREP_DESCENT_RULE).toContain('目標: 食料 40〜60 点・板 8 ほどと棒の余り');
    expect(PREP_DESCENT_RULE).toContain('省く時は prep に skipped と理由。省いた節は達成に数えない（順は変えてよい）');
    expect(system).toContain('節を飛ばす・後回しにする時は reason に、準備を省く時は prep に skipped と理由を書く');
    // The fullness does not stand for the food carried; the 30 minutes claim is gone; eating below 40 is not a new shortage.
    expect(PREP_DESCENT_RULE).toContain('満腹では代わりにならない');
    expect(system).not.toContain('満腹は 30 分もつ');
    expect(PREP_DESCENT_RULE).toContain('下りた後に食べて 40 点を切るのは未達ではない');
    // One number for the requirement in the instructions: the example of a why is a met one, and the stories of runs are one reference sentence of the stage knowledge.
    expect(system).toContain('（満たした時だけ「（食料 41.2/40・作業台 有・板 6）」）');
    // The one run named in the instructions is run 42's single example, as a fact of it (the other story is the stage knowledge's reference sentence).
    expect(system.match(/実走/gu)).toHaveLength(1);
    expect(system).not.toMatch(/run ?\d|372/u);
    expect(PREP_RULES_WORDS).toContain('以前の実走の記録。今回の所要時間ではない');
    expect(V2_STAGES.prep).toContain('準備の必須と目標は system の「準備の決まり」');
  });
  it('says what a stageKnowledge is (knowledge, the rules being the instructions\'), and that the live state and the results are facts', () => {
    expect(system).toContain('従う決まりはこの system にあり、食い違えば system が先');
    expect(system).toContain('live と道具の結果は、コードが作った事実と状態で、決まりは書いていない');
    expect(system).toContain('「列に入れた qNN」は頼みを受け付けた印（手が済んだ訳ではない。実行の結果は後の「（列の知らせ）」）');
    expect(system).toContain('履歴や要約の位置・体力・持ち物は、その記録の時点の値。今の値は最新の live');
    expect(stageKnowledge({ body: { state: { dimension: 'overworld' } } })).toContain('準備の必須と目標は system の「準備の決まり」');
  });
  it('splits what she decides from what the body is left, and says which of accept and hostileWithin counts (as the body does)', () => {
    expect(system).toContain('あなたが決めるのは、目的・対象・行き先・許す掘る/置く・済む条件、食事・睡眠・片づけ、戦うか逃げるか');
    expect(system).toContain('体に任せるのは、歩く道・途中の板や棒・作業台を置く所・戦い方の細部');
    expect(system).toContain('accept に入れた種類は hostileWithin に数えない（fight の相手もその手の間は同じ）。hpBelow と反射は accept でも効く');
    expect(SHORT_ACT_DESCRIPTION).toContain('accept の種類は stopIf の hostileWithin にも数えない（その敵が近づいても止まらない）。fight の手の相手も、その手の間は同じ');
    expect(SHORT_ACT_DESCRIPTION).not.toContain('体は自分で決めない');
  });
  it('writes the plan rules by what they really are: forbid and caution are ops of plan_update, and a note is the node\'s line', () => {
    expect(system).toContain('plan_update の forbid（してはいけない事）か caution（気をつける事）の op で、今の節に 1 行書く（plan.rules に出る）');
    const [plan] = candidateMenuTools([PLAN_UPDATE_RULES_DEFINITION]).filter(tool => tool.name === 'plan.update');
    expect(plan!.description).toContain('forbid・caution は live の plan.rules に');
    expect(plan!.description).toContain('note は節の補足の文で、live の plan の now・next の行に付く（rules には出ない）');
    expect(JSON.stringify(PLAN_UPDATE_RULES_DEFINITION.nativeInputSchema)).toContain('"forbid","caution","lift"');
  });
  it('gives the urgent answer once, in the instructions (a short thought, one act of three hands at most)', () => {
    expect(system).toContain('## 急ぎの時');
    expect(system).toContain('mc_act は 1 つ・手は合わせて 3 つまで、why は 20 字まで');
    expect(system).toContain('離れる・敵との間にブロックを置く・囲う・食べるを、採掘や工作より先に');
    expect(URGENT_NOTE).toBe('急ぎの版（決まりは system の「急ぎの時」）');
  });
  it('says the fight rule without lowering retreatHp, the health that does not come back, and the units of a fight', () => {
    expect(system).toContain('体力 8 以下では戦わない');
    expect(system).toContain('体力が戻らない間（満腹 18 未満。recovery が出る）は、下りる・戦う前に食べる。敵が近くても 1 個食べてから');
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
    expect(system).not.toContain('最大 12');
  });
  it('stays under the cap of the instructions (8,800 by llmcTokens)', () => {
    expect(llmcTokens(system)).toBeLessThan(8_800);
  });
});

describe('the live state and the results say facts', () => {
  it('says the unmet preparation node as a state, not an order', () => {
    expect(PREP_NOTE).toBe('※下りる前の準備の節・未達');
    expect(PREP_NOTE).not.toMatch(/済ませてから|移らない/u);
  });
  it('says the state of the preparation of a descent and that an acceptance is not a check, with no rule and no story of a run', () => {
    const observation = frame({ dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, inventory: pack([['cooked_beef', 1]]), health: 20, food: 20 });
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
  it('does not tell a stand of waits to be sent again: not sent, the furnace\'s seconds, and the rule is the instructions\'', () => {
    const observation = frame({ position: { x: 158, y: 66, z: 199 }, health: 20, food: 20,
      jobs: [{ status: 'waiting_external', remainingEstimateMs: 148_000, input: 'raw_iron', count: 15, position: { x: 158, y: 66, z: 200 } }] });
    const stop = furnaceStandStop({ hands: [{ do: 'wait', seconds: 30 }] }, observation, 'gpt-review')!;
    expect(stop.code).toBe('furnace_stand');
    expect(stop.line).toBe('立って待つだけの手（合わせて 30 秒）は送っていない（手は動いていない）。かまどの焼き上がりまで (158,66,200) の raw_iron×15 はあと約 148 秒。raw_iron×15 を1基で焼くと 150 秒かかる（1個 10 秒。基数に分けると並んで焼ける）');
    expect(stop.line).not.toMatch(/もう一度|出し直|足して/u);
    // The mechanism is unchanged: the same stand again straight after is sent.
    expect(furnaceStandStop({ hands: [{ do: 'wait', seconds: 30 }] }, observation, 'gpt-review')).toBeNull();
    expect(system).toContain('wait だけの act は、有用な手を選べない時だけで、why に待つ対象と理由を書く');
  });
  it('does not tell a fight to be sent with a lower retreatHp: the fact, and the health of 8 or under named', () => {
    const fight = (retreatHp: number) => ({ hands: [{ do: 'fight', target: '#5493', item: 'iron_sword', retreatHp }] });
    const low = rangeStop(fight(7), frame({ health: 6 }))!;
    expect(low.code).toBe('retreat_on');
    expect(low.line).toBe('retreatHp 7 は今の体力 6 以上で、始める前に退く値。体力 6 は 8 以下で、fight は送っていない');
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
    expect((rewritten.pack as string[])[0]).toMatch(/使用 24\/36/u);
  });
  it('is known as an urgent live state by its mode, and by the answer line of a recorded live of the earlier form', () => {
    expect(isUrgentLive({ body: { mode: URGENT_NOTE } })).toBe(true);
    expect(isUrgentLive({ body: { answer: '急ぎの答え方: 考えは 2〜3 文まで。mc.act は 1 つ、手は 3 つまで、why は 20 字まで。' } })).toBe(true);
    expect(isUrgentLive({ body: {} })).toBe(false);
    const sent = candidateAct({ hands: ['jump 1', 'jump 1', 'jump 1', 'jump 1'] }, frame(world), 'gpt-review', { urgent: true });
    expect(sent.guard?.sentHands).toBe(3);
    expect(sent.guard?.text).toContain('急ぎの判断は 3 手まで（system の「急ぎの時」）');
  });
  it('is made of facts: the live state of a calm decision has no key answer either', () => {
    const calm = minecraftLlmcLive({ observation: frame(world), elapsedMinutes: 3, trend: createFoodTrend(), events: [] });
    expect(calm).not.toHaveProperty('answer');
    expect(calm).not.toHaveProperty('mode');
  });
});
