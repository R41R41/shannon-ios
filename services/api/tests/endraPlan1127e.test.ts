import { afterEach, describe, expect, it } from 'vitest';
import { planFromSeeds, type PlanPromise, type PlanSeed } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { InventoryEvent } from '../src/contracts/continueContract.js';
import { firstPlanWaiting, forgetFirstPlans, startFirstPlan, FIRST_PLAN_WAITING_MS } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { armourIronWords, endLackLine, planNowWhileFirstPlan, readinessParts, type LlmcBodyParts } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { readinessOf } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { fightLines, noPickObsidianLine, spareDigWords } from '../src/surfaces/minecraft/minecraftLlmcFightFacts.js';
import { applyLedger, emptyLedgerSeen } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';
import { purposeProduct } from '../src/surfaces/minecraft/minecraftLedgerEvents.js';
import { currentNodeLine, whereWithoutDistance } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { PREP_RULES_WORDS, PLAN_PREP_WORDS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { CURRENT_PLAN_STRUCTURE } from '../src/surfaces/minecraft/minecraftCurrentPlanPrompt.js';
import { frameDigLine } from '../src/surfaces/minecraft/minecraftEndFrameDig.js';
import { firstEntryLack } from '../src/surfaces/minecraft/minecraftEndGather.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

afterEach(() => forgetFirstPlans());
const stamp = '2026-11-27T00:00:00Z';
const frame = (world: Record<string, unknown>, seq = 1): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: seq, stateAt: stamp, receivedAt: stamp, connected: true,
  state: { world, bodyRun: { bodyBoot: 'bb', connectionId: 'c' } } as never, facts: {} as never });
const seed = (id: string, title: string, fields: Partial<PlanSeed> = {}): PlanSeed => ({ id, title, ...fields } as PlanSeed);
const empty = { schema: 'shannon.plan-tree.v2', revision: 1, current: null, nodes: [], promises: [] } as never;

describe('fix 1: the default plan stands in only while the first plan is being written', () => {
  const ask = (planner: () => Promise<unknown>) => startFirstPlan({ taskId: 't1', goal: 'エンドラを討伐して', held: empty, world: { dimension: 'overworld' }, planner: planner as never, log: () => {} });
  it('is waiting from the ask, and not past the bound (the ordinary words come back)', () => {
    ask(() => new Promise(() => {}));
    expect(firstPlanWaiting('t1')).not.toBeNull();
    expect(firstPlanWaiting('t1', Date.now() + FIRST_PLAN_WAITING_MS - 1_000)).not.toBeNull();
    expect(firstPlanWaiting('t1', Date.now() + FIRST_PLAN_WAITING_MS + 1_000)).toBeNull();
    expect(FIRST_PLAN_WAITING_MS).toBe(90_000);
  });
  it('is over when the plan failed or came', async () => {
    ask(() => Promise.reject(new Error('x')));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(firstPlanWaiting('t1')).toBeNull();
    forgetFirstPlans();
    ask(() => Promise.resolve({ nodes: [] }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(firstPlanWaiting('t1')).toBeNull();
  });
  it('is not waiting for a task that never asked', () => { expect(firstPlanWaiting('nobody')).toBeNull(); });
  it('the stand-in words allow a probe and a short hand, forbid a long go, and carry no paragraph that tells her to go on or that waiting makes nothing move', () => {
    const text = planNowWhileFirstPlan('[p1.4] 原木を通しの分', null, null, null);
    expect(text).toContain('probe・view・wait 5 のような短い手');
    expect(text).toContain('次の節（村・ベッドなど）も');
    expect(text).toContain('計画が届くまで始めない');
    expect(text).toContain('24m 内で取れる物の短い手');
    expect(text).toContain('長い go');
    expect(text).toContain('木・村・ベッドへの遠出は出さない');
    expect(text).toContain('理由');
    expect(text).not.toContain('今の節を進める');
    expect(text).not.toContain('なにも進まない');
    expect(text).toContain('[p1.4] 原木を通しの分');
  });
  it('is what the live now says in the seconds before the plan, with the day bed paragraph left out, and the ordinary now returns once it is not waiting', () => {
    const tree = planFromSeeds([seed('p1', '木と石の道具', { kind: 'wood', children: [seed('p1.4', '原木を通しの分', { kind: 'wood', doneWhen: 'stock:wood' })] })]);
    const world = { dimension: 'overworld', timeOfDay: 1256, inventory: [{ name: 'white_bed', count: 2 }, { name: 'ender_eye', count: 11 }], position: { x: 0, y: 64, z: 0 } };
    const parts = () => readinessParts({ plan: () => undefined, planView: () => null, planTree: () => tree, journeyReadiness: true } as LlmcBodyParts, null, frame(world), 't1');
    ask(() => new Promise(() => {}));
    const during = parts().planNow!;
    expect(during).toContain('最初の計画を書いている最中');
    expect(during).not.toContain('今の節を進める');
    forgetFirstPlans();
    expect(parts().planNow).toContain('今の節を進める');
  });
});

describe('fix 2: no diamond pickaxe, no obsidian to dig', () => {
  const counts = (items: Record<string, number>) => new Map(Object.entries(items));
  it('says obsidian cannot be dug, what is held and what the pickaxe takes, in the shortage and the facts', () => {
    const line = noPickObsidianLine(counts({ obsidian: 7, diamond: 1 }), 'overworld')!;
    expect(line).toContain('黒曜石は掘れない');
    expect(line).toContain('手元 7（点検 8・戦い 12）');
    expect(line).toContain('ダイヤ 3');
    expect(noPickObsidianLine(counts({ obsidian: 7, diamond: 1 }), 'overworld', false, true)).toBe('黒曜石は掘れない（ダイヤのつるはしが荷に無い。手元 7・作り直しはダイヤ 3）');
    expect(line).toContain('手元のダイヤ 1＝足りない');
    expect(noPickObsidianLine(counts({ obsidian: 7, diamond: 3 }), 'overworld')).toContain('作れる');
    const facts = fightLines(frame({ dimension: 'overworld', inventory: [{ name: 'obsidian', count: 7 }, { name: 'diamond', count: 1 }] }), false);
    expect(facts.some(item => item.includes('黒曜石は掘れない'))).toBe(true);
  });
  it('adds the lack of a way to dig to the End check\'s obsidian row only without the pickaxe', () => {
    const world = (inventory: unknown[]) => ({ dimension: 'overworld', worn: '頭: iron_helmet、胴: iron_chestplate、脚: iron_leggings、足: iron_boots', inventory });
    const pack = [{ name: 'ender_eye', count: 11 }, { name: 'obsidian', count: 7 }];
    const without = endLackLine(readinessOf(frame(world(pack)))!, ['stronghold'])!;
    expect(without).toContain('黒曜石 7/8（あと 1）。掘る手段が無い');
    const withPick = endLackLine(readinessOf(frame(world([...pack, { name: 'diamond_pickaxe', count: 1, durability: { left: 1500, max: 1561 } }])))!, ['stronghold'])!;
    expect(withPick).toContain('黒曜石 7/8（あと 1）');
    expect(withPick).not.toContain('掘る手段が無い');
  });
  it('says nothing with the pickaxe carried, with 12 or more obsidian, or in the End (the old lines are as they were)', () => {
    expect(noPickObsidianLine(counts({ obsidian: 7, diamond_pickaxe: 1 }), 'overworld')).toBeNull();
    expect(noPickObsidianLine(counts({ obsidian: 12 }), 'overworld')).toBeNull();
    expect(noPickObsidianLine(counts({ obsidian: 3 }), 'the_end')).toBeNull();
    const old = fightLines(frame({ dimension: 'overworld', inventory: [{ name: 'diamond_pickaxe', count: 1, durability: { left: 73, max: 1561 } }, { name: 'obsidian', count: 7 }] }), false);
    expect(old.some(item => item.includes('黒曜石を壊せるのはダイヤのつるはしだけ'))).toBe(true);
    expect(old.some(item => item.includes('黒曜石は掘れない'))).toBe(false);
  });
  it('(b) with the diamond pickaxe alone, the hands to make a stone pickaxe are a candidate of the now, from the pack', () => {
    const line = spareDigWords(counts({ diamond_pickaxe: 1, cobblestone: 42 }), 'overworld')!;
    expect(line).toContain('今の手の候補');
    expect(line).toContain('原木→板→棒 2→丸石 3');
    expect(line).toContain('作業台が要る');
    expect(spareDigWords(counts({ diamond_pickaxe: 1, stone_pickaxe: 1 }), 'overworld')).toBeNull();
    expect(spareDigWords(counts({ cobblestone: 42 }), 'overworld')).toBeNull();
    expect(spareDigWords(counts({ diamond_pickaxe: 1 }), 'the_nether')).toBeNull();
    const tree = planFromSeeds([seed('p1', '要塞へ', { kind: 'stronghold' })]);
    const world = { dimension: 'overworld', timeOfDay: 6000, inventory: [{ name: 'diamond_pickaxe', count: 1, durability: { left: 40, max: 1561 } }, { name: 'ender_eye', count: 11 }] };
    const parts = readinessParts({ plan: () => undefined, planView: () => null, planTree: () => tree, journeyReadiness: true } as LlmcBodyParts, null, frame(world), 't9');
    expect(parts.planNow).toContain('今の手の候補');
  });
});

describe('fix 3: the reservation closes with its product, where carries no distance, the armour is counted', () => {
  const promise = (over: Partial<PlanPromise> = {}): PlanPromise => ({ id: 1, rev: 1, item: 'iron_ingot', count: 7, use: '鉄の脚', state: 'open', ledger: [], ...over });
  const event = (id: string, item: string, count: number, reason: InventoryEvent['reason']): InventoryEvent => ({ id, item, count, reason, obsSeq: 2 });
  it('names the armour a purpose says', () => {
    expect(purposeProduct('鉄の脚')).toBe('iron_leggings');
    expect(purposeProduct('鉄の脚用')).toBe('iron_leggings');
    expect(purposeProduct('鉄の兜')).toBe('iron_helmet');
    expect(purposeProduct('金のブーツ')).toBe('golden_boots');
    expect(purposeProduct('帰り道の予備')).toBeNull();
  });
  it('closes when the product is worn or carried even if the make and the take were one hand (no ingredient line)', () => {
    const before = applyLedger([promise()], emptyLedgerSeen(), { events: [], observation: frame({ inventory: { iron_ingot: 7 } }), at: stamp });
    const wore = applyLedger(before.promises, before.ledgerSeen, { events: [event('skill:c:1:1:0', 'iron_ingot', -7, 'unexplained')],
      observation: frame({ inventory: { iron_leggings: 1 } }, 2), at: stamp });
    expect(wore.promises[0]).toMatchObject({ state: 'closed', closedBy: 'used' });
    expect(wore.added.filter(line => line.kind === 'closed')).toHaveLength(1);
  });
  it('stays open while the product is not held, and a stack product (a torch) does not close it from a pack that has one', () => {
    const before = applyLedger([promise()], emptyLedgerSeen(), { events: [], observation: frame({ inventory: { iron_ingot: 7 } }), at: stamp });
    expect(applyLedger(before.promises, before.ledgerSeen, { events: [], observation: frame({ inventory: { iron_ingot: 7 } }, 2), at: stamp }).promises[0]!.state).toBe('open');
    const torch = applyLedger([promise({ item: 'coal', count: 4, use: '松明' })], emptyLedgerSeen(), { events: [], observation: frame({ inventory: { coal: 4, torch: 1 } }), at: stamp });
    expect(torch.promises[0]!.state).toBe('open');
  });
  it('shows the where without a distance the head wrote, keeping the coordinates', () => {
    expect(whereWithoutDistance('437,64,1311（現世）残り約 771m')).toBe('437,64,1311（現世）');
    expect(whereWithoutDistance('437,64,1311（現世）、あと 1,200m')).toBe('437,64,1311（現世）');
    expect(whereWithoutDistance('(437,64,1311) 約 771m 先')).toBe('(437,64,1311)');
    expect(whereWithoutDistance('交点付近（地下 y=10〜40）')).toBe('交点付近（地下 y=10〜40）');
    const line = currentNodeLine({ id: 'p1.2', title: '投げ直し地点へ', where: '437,64,1311（現世）残り約 771m', doneWhen: 'at:437,64,1311~30@overworld' }, [], null);
    expect(line).toContain('＠437,64,1311（現世）');
    expect(line).not.toMatch(/771|残り約/u);
    const titled = currentNodeLine({ id: 'p1.2', title: '投げ直し地点まで歩く（残り 1,344m・海を含む）', where: '437,64,1311（現世）' }, [], null);
    expect(titled).toContain('[p1.2] 投げ直し地点まで歩く＠');
    expect(titled).not.toMatch(/1,344|残り/u);
    expect(currentNodeLine({ id: 'p2', title: '鉄を5個掘る（5m 先）', where: '' }, [], null)).toContain('鉄を5個掘る（5m 先）');
  });
  it('counts every missing piece of armour with the iron it takes in total, beside the pack', () => {
    const words = armourIronWords(['脚', '足'], new Map([['iron_ingot', 2], ['raw_iron', 2]]));
    expect(words).toContain('脚 7＋足 4＝11');
    expect(words).toContain('手元 インゴット 2・生の鉄 2');
    const world = { dimension: 'overworld', worn: '頭: iron_helmet、胴: iron_chestplate、脚: なし、足: なし', inventory: [{ name: 'ender_eye', count: 11 }, { name: 'iron_ingot', count: 2 }] };
    expect(endLackLine(readinessOf(frame(world))!, ['stronghold'])).toContain('防具 2/4（脚・足が無い）。欠けた部位ぜんぶの鉄 脚 7＋足 4＝11');
  });
  it('says the golden boots are for entering the Nether only; the road to the stronghold and the End take iron boots', () => {
    expect(PREP_RULES_WORDS).toContain('ネザーに入る時だけ、靴は鉄でなく金のブーツ');
    expect(PREP_RULES_WORDS).toContain('足の欠けは鉄のブーツ（鉄 4）で埋めてよい');
  });
  it('asks the armour node to put the table before the furnace work', () => {
    expect(PLAN_PREP_WORDS).toContain('作業台が足元の近くに無い時は先に置く');
  });
});

describe('fix 4: after the point, the plan and the words of the End\'s items', () => {
  it('(d) the first plan asks for a closing mark on every node but the dragon\'s, with the reason', () => {
    expect(CURRENT_PLAN_STRUCTURE).toContain('閉じる印: 全部の節の doneWhen に');
    expect(CURRENT_PLAN_STRUCTURE).toContain('空にするのは竜の節だけ');
    expect(CURRENT_PLAN_STRUCTURE).toContain('理由: 空の節は頭の入力に「済む条件」も「今: …」も出ない');
    expect(CURRENT_PLAN_STRUCTURE).toContain('at:x,y,z~12@overworld');
    expect(CURRENT_PLAN_STRUCTURE).not.toContain('探索など観測だけで閉じられない節は ""');
    expect(CURRENT_PLAN_STRUCTURE).toContain('at: の距離は高さを含む');
  });
  it('(a) the stage words and the gate line put the waiting minutes beside the trip\'s, and do not make the ten minutes a premise', () => {
    const all = JSON.stringify(V2_STAGES);
    expect(all).toContain('待つ 10 分も遅さなので、待つ分数と集める往復の分数を並べて選ぶ');
    expect(all).toContain('集めるために地上へ戻る往復・ベッド 1 個のための往復はしない');
    expect(CURRENT_PLAN_STRUCTURE).toContain('待つ 10 分も遅さなので、待つ分数と集める往復の分数を並べて書く');
    const lack = firstEntryLack({ dimension: 'overworld', counts: new Map([['iron_sword', 1], ['cobblestone', 64], ['water_bucket', 1]]), world: {}, food: 400 } as never, 'task-e', () => 1_000)!;
    expect(lack).toContain('取りに戻る往復の分数を、この残りの 10 分と並べて選ぶ');
    expect(lack).toContain('ベッド 1 個のための往復はしない');
  });
  it('(b)(c) the pearl node is the night plain within the ten minutes, else go on with 11 (72%); after a break to 10, the next hands with numbers', () => {
    expect(CURRENT_PLAN_STRUCTURE).toContain('where は「夜の地上の平原・暗い所」');
    expect(CURRENT_PLAN_STRUCTURE).toContain('11 個で開く確率 72%、10 個 34%');
    expect(CURRENT_PLAN_STRUCTURE).toContain('パール 1 個があれば 11 個（72%）、2 個で 12 個（100%）');
    const all = JSON.stringify(V2_STAGES);
    expect(all).toContain('投げが割れて 10 個になった時の次の手');
    expect(all).toContain('10 個（34%）のまま枠へ進む');
    expect(all).toContain('11 個ある時は、パールのために夜を待たずその 11 個（72%）で進んでよい');
    expect(all).toContain('エンダーマンが見える・パールが手に入る時は逃さず、予備の分（不足行の必要数）まで取る');
  });
  it('(e) before going down to the frames with no table, no log and no plank: the digs against the pickaxe\'s uses and the way to a table', () => {
    const world = { dimension: 'overworld', mapLandmarks: ['Q エンドポータルの枠 (216,39,-14) 北3m ×12 アイ入り 0'],
      inventory: [{ name: 'stone_pickaxe', count: 1, durability: { left: 30, max: 131 } }] };
    const line = frameDigLine(world, new Map([['stone_pickaxe', 1]]), { x: 216, y: 64, z: -14 })!;
    expect(line).toContain('枠は約 25m 下');
    expect(line).toContain('stone_pickaxe 残り 30/131（1 マス 1 使い）→ 約 25 マスを掘るのに足りる');
    expect(line).toContain('作業台を作って持つ: 原木 1 本で板 4');
    expect(frameDigLine({ ...world, inventory: [{ name: 'stone_pickaxe', count: 1, durability: { left: 10, max: 131 } }] }, new Map([['stone_pickaxe', 1]]), { x: 216, y: 64, z: -14 }))
      .toContain('足りない（あと約 15）');
    expect(frameDigLine(world, new Map([['stone_pickaxe', 1], ['crafting_table', 1]]), { x: 216, y: 64, z: -14 })).toBeNull();
    expect(frameDigLine(world, new Map([['stone_pickaxe', 1], ['oak_planks', 4]]), { x: 216, y: 64, z: -14 })).toBeNull();
    expect(frameDigLine(world, new Map(), { x: 216, y: 44, z: -14 })).toBeNull();
    expect(frameDigLine({ dimension: 'overworld' }, new Map(), { x: 0, y: 64, z: 0 })).toBeNull();
  });
});
