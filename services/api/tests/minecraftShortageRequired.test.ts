import { afterEach, describe, expect, it } from 'vitest';
import { PLAN_LIMITS, type PlanKind, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { planFromAnswer, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { ACT_DESCRIPTION } from '../src/contracts/minecraftActContract.js';
import { SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { forgetActNodes, followDimension, followNode, lackBefore, noteItemStart } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { doneFacts } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { llmcModelRouter } from '../src/wiring/minecraftLlmcConfiguration.js';
import type { FcaModel } from '../src/mind/action/fca/fcaPorts.js';
import { heldOfFrame, heldTail, holdV2, sentPart } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { BEFORE_DIAMONDS, BEFORE_GATE, PREP_RULES_WORDS, SAFETY_FIRST } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { gateHold, preparationShortage, readinessOf, requiredLack } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { dropAdvice, packFacts, packLines } from '../src/surfaces/minecraft/minecraftLlmcPack.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { STRATEGY_KNOWLEDGE_V2 } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { v2tree } from './helpers/planTreeV2.js';

/**
 * Run59 leg 1 (2026-11-02, coordinator): the head went on to the diamonds with the shield node open (11:30:33Z, the step on was a tag and a fact) and sent the portal hand
 * five seconds after the obsidian with the shield and the iron armour still missing in the shortage line (12:04:09Z). What is required before the diamonds and before the
 * Nether is said apart from the goals, with what going on without it costs, beside a step on to such a node and beside a hand that enters the Nether.
 */
afterEach(() => forgetActNodes());

const WORN = '頭: iron_helmet(残り165/165)、胴: iron_chestplate(残り240/240)、脚: iron_leggings(残り225/225)、足: なし、左手: なし';
const pack = (items: ReadonlyArray<readonly [string, number]>) => items.map(([name, count]) => ({ name, count }));
const frame = (items: ReadonlyArray<readonly [string, number]>, extra: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1,
  stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, inventory: pack(items), worn: WORN, ...extra } as never } });
const owned = (items: Array<[string, number]>, worn = '') => carriedItemCounts({ inventory: pack(items), worn }, {});

const FOOD: Array<[string, number]> = [['cooked_beef', 3]];
/** The gate's required list but the pickaxes and the shield (the armour is worn: `WORN`). */
const GATE_REST: Array<[string, number]> = [['iron_sword', 1], ['cobblestone', 64], ...FOOD];
const KIT: Array<[string, number]> = [['iron_pickaxe', 3], ['shield', 1], ...GATE_REST];
const WORN_PIECES = ['iron_helmet', 'iron_chestplate', 'iron_leggings'];
const GOAL_ONLY = '準備の不足（ネザーに入る前）: 目標（そろえば。必須ではない）— 金のブーツ（金 4 がそろう時）が無い';
const gateLine = (items: Array<[string, number]>) => preparationShortage({ dimension: 'overworld', counts: owned(items, WORN), food: 50, nowKinds: ['portal'], worn: WORN_PIECES });

describe('the pickaxe for the Nether: one diamond one or three iron ones', () => {
  const rest = [['shield', 1], ...GATE_REST] as Array<[string, number]>;
  it('asks three iron pickaxes, and says how many are carried', () => {
    const one = gateLine([...rest, ['iron_pickaxe', 1]])!;
    expect(one.startsWith('準備の不足（ネザーに入る前）: 必須（ネザーに入る前に必ず）— ツルハシ（ダイヤ 1 か鉄 3） 1/3・石以上のツルハシ（予備 2 本を含め 3 本） 1/3。')).toBe(true);
    expect(one).toContain(`欠けたまま進むと: ${BEFORE_GATE.risk}。目標（そろえば。必須ではない）— 金のブーツ（金 4 がそろう時）が無い`);
    expect(gateLine([...rest, ['iron_pickaxe', 2]])).toContain('ツルハシ（ダイヤ 1 か鉄 3） 2/3');
    expect(gateLine(rest)).toContain('必須（ネザーに入る前に必ず）— ツルハシ（ダイヤ 1 か鉄 3）・石以上のツルハシ（予備 2 本を含め 3 本）が無い');
    expect(gateLine([...rest, ['iron_pickaxe', 3]])).toBe(GOAL_ONLY);
  });
  it('counts a diamond or netherite pickaxe for three, and the two kinds together', () => {
    // One diamond pickaxe is the main one's three; the spares are two more of stone or better (run59 leg 2's plan 7.1).
    expect(gateLine([...rest, ['diamond_pickaxe', 1]])).toContain('必須（ネザーに入る前に必ず）— 石以上のツルハシ（予備 2 本を含め 3 本） 1/3');
    expect(gateLine([...rest, ['diamond_pickaxe', 1], ['stone_pickaxe', 2]])).toBe(GOAL_ONLY);
    expect(gateLine([...rest, ['netherite_pickaxe', 1], ['stone_pickaxe', 3]])).toBe(GOAL_ONLY);
    expect(gateLine([...rest, ['iron_pickaxe', 1], ['stone_pickaxe', 4]])).toContain('ツルハシ（ダイヤ 1 か鉄 3） 1/3');
    expect(gateLine([...rest, ['iron_pickaxe', 2], ['diamond_pickaxe', 1]])).toBe(GOAL_ONLY);
    expect(gateLine([...rest, ['iron_pickaxe', 1], ['stone_pickaxe', 4]])).not.toContain('石以上のツルハシ（予備 2 本を含め 3 本）');
  });
});

describe('a stage that says what its lack costs says it in two parts; the others keep the one line', () => {
  it('puts the golden boots apart from what is required, and says nothing when all of it is there', () => {
    expect(gateLine(KIT)).toBe(GOAL_ONLY);
    const boots = [...KIT, ['golden_boots', 1]] as Array<[string, number]>;
    expect(gateLine(boots)).toBe('準備の不足（ネザーに入る前）: 目標（そろえば。必須ではない）— 持っているが着ていない: golden_boots');
    expect(preparationShortage({ dimension: 'overworld', counts: owned(boots, WORN), food: 50, nowKinds: ['portal'], worn: [...WORN_PIECES, 'golden_boots'] })).toBeNull();
    const noShield = gateLine(KIT.filter(([name]) => name !== 'shield'))!;
    expect(noShield.startsWith(`準備の不足（ネザーに入る前）: 必須（ネザーに入る前に必ず）— 盾が無い。欠けたまま進むと: ${BEFORE_GATE.risk}。`)).toBe(true);
    expect(noShield).toContain('目標（そろえば。必須ではない）— 金のブーツ');
  });
  it('says the sword as a goal, as the rules\' words do, not as a required need', () => {
    const noSword = gateLine(KIT.filter(([name]) => name !== 'iron_sword'));
    expect(noSword).toBe('準備の不足（ネザーに入る前）: 目標（そろえば。必須ではない）— 剣・金のブーツ（金 4 がそろう時）が無い');
    expect(requiredLack(readinessOf(frame(KIT.filter(([name]) => name !== 'iron_sword')))!, ['portal'])).toBeNull();
    expect(PREP_RULES_WORDS).toContain('目標: 金のブーツ（金 4 がそろう時）・剣・水入りバケツ');
    expect(PREP_RULES_WORDS).not.toMatch(/必須[^。]*[:：][^。]*剣/u);
  });
  it('says the food as a required lack, not as a goal', () => {
    const hungry = preparationShortage({ dimension: 'overworld', counts: owned(KIT.filter(([name]) => name !== 'cooked_beef'), WORN), food: 15.6, nowKinds: ['portal'], worn: WORN_PIECES })!;
    expect(hungry).toContain('必須（ネザーに入る前に必ず）— 食料 15.6 点（目安 40）。欠けたまま進むと:');
  });
  it('keeps the one line for the stages of the Nether\'s depth and the End', () => {
    const deep = preparationShortage({ dimension: 'the_nether', counts: owned([]), food: 10, nowKinds: null })!;
    expect(deep.startsWith('準備の不足（ネザーの奥へ）: ')).toBe(true);
    for (const word of ['必須', '欠けたまま進むと', '目標']) expect(deep).not.toContain(word);
    const end = preparationShortage({ dimension: 'overworld', counts: owned([['ender_eye', 3]]), food: 10, nowKinds: null })!;
    expect(end.startsWith('準備の不足（エンドへ）: ')).toBe(true);
    expect(end).not.toContain('必須');
  });
});

describe('requiredLack: the required needs of the stage a node belongs to that are not met', () => {
  const facts = (items: Array<[string, number]>, extra: Record<string, unknown> = {}) => readinessOf(frame(items, extra))!;
  it('names the lack of the gate with what going on costs, by the kinds of the node and of those above it', () => {
    const without = facts(KIT.filter(([name]) => name !== 'shield'));
    const words = `未達の必須（ネザーに入る前に必ず）— 盾が無い。欠けたまま進むと: ${BEFORE_GATE.risk}`;
    expect(requiredLack(without, ['portal'])).toBe(words);
    expect(requiredLack(without, ['obsidian'])).toBe(words);
    expect(requiredLack(without, ['food', 'portal'])).toBe(words);
  });
  it('names the lack of the diamonds, the armour carried and not worn included', () => {
    const base: Array<[string, number]> = [['iron_pickaxe', 1], ['bucket', 1], ...FOOD];
    expect(requiredLack(facts(base, { worn: '' }), ['diamond'])).toBe(`未達の必須（ダイヤを掘る前に必ず）— 盾・鉄の兜・胸当て・脚が無い。欠けたまま進むと: ${BEFORE_DIAMONDS.risk}`);
    const carried = facts([...base, ['shield', 1], ['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1]], { worn: '頭: iron_helmet(残り165/165)、胴: なし' });
    expect(requiredLack(carried, ['diamond'])).toContain('持っているが着ていない: iron_chestplate・iron_leggings');
    expect(requiredLack(facts([...base, ['shield', 1]]), ['diamond'])).toBeNull();
  });
  it('is null for a goal only, a stage that does not say its cost, no stage, and the Nether', () => {
    expect(requiredLack(facts(KIT), ['portal'])).toBeNull();
    expect(requiredLack(facts([]), ['iron'])).toBeNull();
    expect(requiredLack(facts([]), [])).toBeNull();
    expect(requiredLack(facts([], { dimension: 'the_nether' }), ['portal'])).toBeNull();
    expect(requiredLack(facts([['ender_eye', 2]]), ['end'])).toBeNull();
  });
});

describe('gateHold: a hand that enters the Nether is held while a required need of the gate is missing (run59 leg 2, 2026-11-02 14:34Z)', () => {
  const enter = { hands: [{ do: 'portal' }] };
  const noShield = frame(KIT.filter(([name]) => name !== 'shield'));
  const said = (lack: string) => `ネザーへ入る手は送らない。${lack}。そろえてからもう一度出す（理由を書いても省けない）`;
  it('names the hand, what is missing and what going on costs, and that a reason does not skip it', () => {
    expect(gateHold(enter, noShield)).toEqual({ hand: 1, line: said(`未達の必須（ネザーに入る前に必ず）— 盾が無い。欠けたまま進むと: ${BEFORE_GATE.risk}`) });
    expect(gateHold({ hands: [{ do: 'wait', seconds: 1 }, { do: 'equip', item: 'shield' }, { do: 'portal', enter: true }] }, noShield)).toMatchObject({ hand: 3 });
    expect(gateHold({ hands: [{ do: 'portal', enter: false }, { do: 'portal' }] }, noShield)).toMatchObject({ hand: 2 });
  });
  it('holds nothing when the hand does not enter, the needs are met (the golden boots and the sword are goals), or it is not the overworld', () => {
    expect(gateHold({ hands: [{ do: 'portal', enter: false }] }, noShield)).toBeNull();
    expect(gateHold({ hands: [{ do: 'go', to: { x: 1, y: 70, z: 1 } }] }, noShield)).toBeNull();
    expect(gateHold(enter, frame(KIT))).toBeNull();
    expect(gateHold(enter, frame(KIT.filter(([name]) => name !== 'iron_sword')))).toBeNull();
    expect(gateHold(enter, frame([], { dimension: 'the_nether' }))).toBeNull();
    expect(gateHold(enter, null)).toBeNull();
    expect(gateHold({ hands: 'portal' }, noShield)).toBeNull();
  });
  describe('a go or a walk that ends in a lit portal cell enters the Nether too (the hole of 56a6f5b)', () => {
    const MAP = ['地図 v1 足=(0,70,0) x=-2..2 z=-2..2 方式=cube', 'y=71 x=-2..2 z=-2..2', '-2 . . . . .', '-1 . . . . .', '0 . . . . p', '1 . . . . .', '2 . . . . .',
      'y=70 x=-2..2 z=-2..2', '-2 . . . . .', '-1 . . . . .', '0 . . . . p', '1 . . . . .', '2 . . . . .'].join('\n');
    const lit = frame(KIT.filter(([name]) => name !== 'shield'), { localMap: MAP });
    it('holds a go to the cell, a go with the cell among its goals, a walk to it, and a relative one', () => {
      expect(gateHold({ hands: [{ do: 'go', to: { x: 2, y: 70, z: 0 } }] }, lit)).toMatchObject({ hand: 1 });
      expect(gateHold({ hands: [{ do: 'wait', seconds: 1 }, { do: 'go', to: { x: 0, y: 70, z: 1 }, goals: [{ x: 2, y: 70, z: 0 }] }] }, lit)).toMatchObject({ hand: 2 });
      expect(gateHold({ hands: [{ do: 'walk', path: [{ x: 1, y: 70, z: 0 }, { x: 2, y: 70, z: 0 }] }] }, lit)).toMatchObject({ hand: 1 });
      expect(gateHold({ hands: [{ do: 'go', rel: true, to: { x: 2, y: 0, z: 0 } }] }, lit)?.line).toContain('盾が無い');
    });
    it('holds nothing for a cell that is not a portal, a walk that stops short of it by a range, the needs met, or the Nether', () => {
      expect(gateHold({ hands: [{ do: 'go', to: { x: 1, y: 70, z: 0 } }] }, lit)).toBeNull();
      expect(gateHold({ hands: [{ do: 'walk', to: { x: 2, y: 70, z: 0 }, range: 2 }] }, lit)).toBeNull();
      expect(gateHold({ hands: [{ do: 'go', to: { x: 2, y: 70, z: 0 } }] }, frame(KIT, { localMap: MAP }))).toBeNull();
      expect(gateHold({ hands: [{ do: 'go', to: { x: 2, y: 70, z: 0 } }] }, frame([], { dimension: 'the_nether', localMap: MAP }))).toBeNull();
      expect(gateHold({ hands: [{ do: 'go', to: { x: 2, y: 70, z: 0 } }] }, frame(KIT.filter(([name]) => name !== 'shield')))).toBeNull();
    });
  });
  it('reads the armour as worn now: carried and not worn is missing, so an act that equips it and enters in one goes in the next', () => {
    const carried = frame([...KIT, ['iron_chestplate', 1]], { worn: '頭: iron_helmet(残り165/165)、胴: なし、脚: iron_leggings(残り225/225)、足: なし' });
    expect(gateHold(enter, carried)?.line).toContain('持っているが着ていない: iron_chestplate');
    expect(gateHold({ hands: [{ do: 'equip', item: 'iron_chestplate' }, { do: 'portal' }] }, carried)).toMatchObject({ hand: 2 });
  });
  it('turns the act back as the other guards do: the hands before it are sent, the rest comes back as a fact; the whole act when it is the first hand', () => {
    const act = { hands: [{ do: 'equip', item: 'iron_chestplate' }, { do: 'portal', maxPlace: 20 }], why: '[p5] 胸当てを着てゲートを建て点火（盾は材料なしで後回し）' };
    const held = heldOfFrame(act, noShield, 't1')!;
    expect(held).toMatchObject({ hand: 2, kind: 'portal', code: 'gate_required' });
    expect(held.line.startsWith('手 2 portal: ネザーへ入る手は送らない。未達の必須（ネザーに入る前に必ず）— 盾が無い。')).toBe(true);
    expect(sentPart(act, held)).toEqual({ ...act, hands: [act.hands[0]] });
    expect(heldTail(held, 2)).toContain('手 2 から先 1 手（全 2 手のうち）は体へ送っていない');
    const whole = holdV2(enter, noShield, 't1');
    expect(whole).toMatchObject({ whole: expect.stringContaining('送る前に止めた（体には何も送っていない。手は 1 つも動いていない）: 手 1 portal: ネザーへ入る手は送らない。') });
    expect(heldOfFrame(enter, noShield, 't1', true)).toMatchObject({ hand: 1, code: 'gate_required' });
    expect(heldOfFrame(enter, frame(KIT), 't1')).toBeNull();
  });
  it('says so to the model before it tries: the stage rules', () => {
    expect(PREP_RULES_WORDS).toContain('ネザーへ入る手（portal。enter でない時を除く）は、必須が未達の間は体へ送られず、足りない物と費用が返る');
  });
});

describe('followNode: the step on past an open node says what the node it steps on to requires', () => {
  const rows: Array<[id: string, kind: PlanKind, title: string, parent?: string]> = [['p4', 'iron', '鉄の装備'], ['p4.3', 'iron', '盾', 'p4'], ['p5', 'diamond', 'ダイヤ'],
    ['p6', 'portal', '黒曜石10とゲート']];
  const treeOf = (current: string): PlanTree => {
    const order = new Map<string | null, number>();
    const nodes: PlanNode[] = rows.map(([id, kind, title, parent]) => {
      const next = order.get(parent ?? null) ?? 0;
      order.set(parent ?? null, next + 1);
      return { id, parentId: parent ?? null, order: next, title, state: 'continue', kind } as PlanNode;
    });
    return v2tree({ revision: 1, current, nodes });
  };
  const start = (task: string, to: string, from: string) => { noteItemStart(task, to, from); noteItemStart(task, to, from); };
  const bare = frame([['iron_pickaxe', 1], ['bucket', 1], ...FOOD], { worn: '' });
  it('adds the skipped required needs and what they cost to the words of the step', () => {
    const tree = treeOf('p4.3');
    start('t1', 'p5', 'p4.3');
    const moved = followNode('t1', tree, false, leaf => lackBefore(bare, tree, leaf))!;
    expect(moved).toMatchObject({ to: 'p5', from: 'p4.3' });
    expect(moved.words).toContain('今の節を [p5] に進めた');
    expect(moved.words).toContain(`。未達の必須（ダイヤを掘る前に必ず）— 盾・鉄の兜・胸当て・脚が無い。欠けたまま進むと: ${BEFORE_DIAMONDS.risk}`);
  });
  it('keeps the words as they were with no lack to say, or no port to say it', () => {
    const tree = treeOf('p4.3');
    start('t2', 'p5', 'p4.3');
    const plain = followNode('t2', tree)!.words;
    expect(plain).not.toContain('未達の必須');
    const ready = frame([['iron_pickaxe', 1], ['bucket', 1], ['shield', 1], ...FOOD]);
    expect(followNode('t2', tree, false, leaf => lackBefore(ready, tree, leaf))!.words).toBe(plain);
    expect(lackBefore(null, tree, tree.nodes.find(node => node.id === 'p5')!)).toBeNull();
  });
  it('reads the stage of the node it steps on to, not of the one it leaves', () => {
    const tree = treeOf('p4.3');
    const of = (id: string) => lackBefore(bare, tree, tree.nodes.find(node => node.id === id)!);
    expect(of('p4.3')).toBeNull();
    expect(of('p5')).toContain('ダイヤを掘る前に必ず');
    expect(of('p6')).toContain('ネザーに入る前に必ず');
  });
});

describe('the Nether trip and the End\'s first minutes: the labs\' facts (S2, S1) are where the model reads them', () => {
  const lines = (id: keyof typeof V2_STAGES) => V2_STAGES[id];
  it('gives the Nether go its arguments, the pace and what to do on a stop, in the words of the body\'s rows', () => {
    const nether = lines('nether');
    for (const word of ['canDig=[netherrack,basalt,blackstone]', 'nether_bricks', 'canPlace=[cobblestone,netherrack]', 'maxDig 120〜200', 'maxPlace 40〜100', 'seconds 100〜120',
      '1.5〜2.3 秒', '「maxDig を増やす」', '「canDig に足す」', '荷の netherrack×99 を canPlace に足す', '置く物 cobblestone を N 個置いて使い切った', '火 (x,y,z) は dig で消せる',
      'mc_probe kind=scan', 'mc_probe kind=camp', '同じ種類以上の予備が荷に無い']) expect(nether, word).toContain(word);
    expect(nether).not.toContain('maxDig 150・maxPlace 40 を渡す');
  });
  it('says what to hold before the gate and why three pickaxes', () => {
    expect(PREP_RULES_WORDS).toContain('鉄のツルハシは 1 本が耐久 250 で、ネザーの岩を掘り続けると壊れて止まった');
    expect(PREP_RULES_WORDS).toContain('足場のブロック 64（丸石 128 あると橋で尽きない）');
  });
  it('tells the End\'s entry: three blocks to stack on, the island go, the breath cloud\'s dead_end, the podium, the bucket for the caged pillars', () => {
    expect(lines('stronghold')).toContain('丸石か黒曜石を 3 個以上（できれば 64 以上）荷に持つ');
    expect(lines('stronghold')).toContain('cover_none');
    const end = lines('end');
    for (const word of ['go to=島の上のマス canPlace=["cobblestone"] maxPlace=100 seconds=120', 'go 止まった dead_end: 道の先が竜の息の雲の中で', 'dragonBreath が空になる',
      '高い足場で待つか、別の側から', '表彰台から 5〜12m', '水の入ったバケツ（鉄 3）', '20 ブロックで被害 17、それ以上で死ぬ', '体の自動の落下止め（水バケツで落下を止める床の反射）は、今は働かない前提にする', '水バケツは手で使う物',
      '144 秒で死んだ', '3 回積んで上がり（96→99）被害 0', '積める物（黒曜石かエンドストーンが先、丸石も可）を 3 個以上残し', '柱の上に居る時間を短くする',
      '水の入ったバケツ（鉄 3）を hotbar（最初の 9 スロット）に持つ', '島への橋（幅 1）の先端は、竜の玉が落ちる向きによっては、体の避けが「道なし」になる']) expect(end, word).toContain(word);
    expect(end).not.toContain('落下を水バケツで止めた');
    expect(end).not.toContain('荷の中でもよい');
    expect(end).toContain('attack ender_dragon は今の手持ちで打ち、体は剣を持ち直さない。');
    expect(end).toContain('打つ前に equip で剣（か斧）を手に持つ');
    expect(STRATEGY_KNOWLEDGE_V2).toContain('鉄格子の檻つきは、水の入ったバケツ（鉄 3。hotbar に）と積める物 3 個以上を持って登る。体の落下止めは働かない前提で、落ちないように登る');
  });
  it('tells the blaze platform\'s rule: accept on every act there, or the floor reflex digs the platform (S2, c1 hold trial)', () => {
    const blaze = lines('blaze');
    for (const word of ['全部の act に accept: ["blaze"] を付ける', 'dig で火を消す・go・eat・pickup・place だけの act にも', '足元を掘って下がる', '体力が低くなった時だけ',
      '荷の丸石で go（canPlace=[cobblestone]）か place で床を戻す']) expect(blaze, word).toContain(word);
  });
  it('puts them in the cautions of the plan\'s nodes: the fortress\'s go, the End\'s entry, the dragon\'s pillars', () => {
    const plan = seedPlan('エンドラを倒して')!;
    const cautions = (title: string) => (plan.nodes.find(node => node.title === title)?.caution ?? []).join(' ');
    expect(cautions('ネザー要塞を探す')).toContain('canDig[netherrack,basalt,blackstone] canPlace[cobblestone,netherrack]');
    expect(cautions('ネザー要塞を探す')).toContain('maxDig 200・maxPlace 100');
    expect(cautions('エンドに入る')).toContain('丸石か黒曜石を3個以上持って入る');
    expect(cautions('エンドでドラゴン')).toContain('檻つきの柱は積める物3個以上を持って登り、長居しない（落下止めは当てにしない）');
    expect(cautions('エンドに入る')).toContain('橋の先端（幅1）に長居せず、玉が来る向きを見て渡る');
    expect(cautions('エンドでドラゴン')).toContain('縁から5マス以上内側');
    expect(cautions('エンドでドラゴン')).toContain('竜を打つ前に剣か斧を equip で手に持つ');
  });
  it('asks the water bucket before the End: the stage\'s shortage line and the check node\'s condition', () => {
    const base = { dimension: 'overworld', food: 90, nowKinds: ['stronghold' as const] };
    const kit: Array<[string, number]> = [['white_bed', 4], ['bow', 1], ['arrow', 30], ['ender_eye', 12], ['cobblestone', 64]];
    expect(preparationShortage({ ...base, counts: owned(kit) })).toBe('準備の不足（エンドへ）: 水入りバケツが無い');
    expect(preparationShortage({ ...base, counts: owned([...kit, ['water_bucket', 1]]) })).toBeNull();
    expect(preparationShortage({ ...base, counts: owned([...kit, ['bucket', 1]]) })).toBe('準備の不足（エンドへ）: 水入りバケツが無い');
    const plan = seedPlan('エンドラを倒して')!;
    const check = plan.nodes.find(node => node.title === '出発の点検（エンドへ）')!;
    expect(check.doneWhen).toBe('food>=80&have:bed>=4&have:arrow>=30&have:ender_eye>=12&have:water_bucket');
    expect(check.note).toContain('水入りバケツ（水を汲んだ物）を hotbar（最初の 9 スロット）に持つ: 手で使う物');
    expect(STRATEGY_KNOWLEDGE_V2).toContain('弓と矢 30・水入りバケツ');
  });
});

describe('the first plan and the knowledge say the required list where the model reads it', () => {
  const plan = seedPlan('エンドラを倒して')!;
  const titled = (title: string) => plan.nodes.find(node => node.parentId === null && node.title === title)!;
  const cautionOf = (node: PlanNode) => (node.caution ?? []).join(' ');
  it('puts it in the cautions of the diamonds and of the gate, and in the lit portal\'s step', () => {
    for (const word of ['必須', '盾', '鉄の兜胸当て脚', '食料40点']) {
      expect(cautionOf(titled('ダイヤ（y=-58）')), word).toContain(word);
      expect(cautionOf(titled('黒曜石10とゲート')), word).toContain(word);
    }
    const light = plan.nodes.find(node => node.title === 'ゲートを組んで火をつける')!;
    expect(cautionOf(light)).toContain('火をつける前に必須を確かめる');
    expect(cautionOf(titled('黒曜石10とゲート'))).toContain('足場64');
    expect(cautionOf(titled('黒曜石10とゲート'))).toContain('ツルハシ');
  });
  it('says the gate\'s required needs and its goals apart in the stage rules', () => {
    expect(PREP_RULES_WORDS).toContain('ゲート（ネザーに入る）の前の必須（そろうまで入らない。理由を書いても省けない）: 盾・鉄の兜と胸当てと脚（着る）・ツルハシ（ダイヤ 1 か鉄 3）');
    expect(PREP_RULES_WORDS).toContain('目標: 金のブーツ（金 4 がそろう時）・剣・水入りバケツ・黒曜石 10・火打ち金');
    expect(PREP_RULES_WORDS).toContain('死ねばダイヤのツルハシと黒曜石を失う');
  });
});

describe('a death is out (the owner, 2026-11-02): not dying stands above being fast, in the stages\' knowledge and the plan\'s cautions', () => {
  it('says it in every stage, in the numbers the live state shows', () => {
    expect(SAFETY_FIRST).toContain('死なないことを速さより上に置く');
    expect(SAFETY_FIRST).toContain('体力 12 未満・食料 40 点未満・防具か盾かツルハシの耐久が残り 2 割未満');
    for (const id of ['prep', 'nether', 'blaze', 'pearl', 'stronghold', 'end'] as const) expect(V2_STAGES[id], id).toContain(SAFETY_FIRST);
  });
  it('puts it in the cautions of the diamonds and the blaze rods, within the plan\'s bounds', () => {
    const plan = seedPlan('エンドラを倒して')!;
    const cautions = (title: string) => plan.nodes.find(node => node.title === title)?.caution ?? [];
    expect(cautions('ダイヤ（y=-58）').join(' ')).toContain('死ねば鉄装備を失う。体力12未満・耐久2割未満なら進まず補う');
    expect(cautions('ブレイズロッド7以上').join(' ')).toContain('死んだらアウト。体力12未満・盾の耐久2割未満なら戦わず退いて補う');
    for (const node of plan.nodes) {
      expect((node.caution ?? []).length, node.title).toBeLessThanOrEqual(PLAN_LIMITS.rules);
      for (const line of node.caution ?? []) expect(line.length, `${node.title}: ${line}`).toBeLessThanOrEqual(PLAN_LIMITS.rule);
    }
  });
});

describe('the spare pickaxes and a need that cannot be made (the coordinator, 2026-11-03; run59 leg 2, 23:34)', () => {
  it('says the spares in the stage rules and the Nether\'s knowledge, and the plan\'s gate caution', () => {
    expect(PREP_RULES_WORDS).toContain('石以上のツルハシの予備 2 本（主の他に。丸石 3・棒 2 で 1 本、体は安い方の道具から使う）');
    const nether = V2_STAGES.nether;
    expect(nether).toContain('ネザーに入る前に石のツルハシを 2〜3 本作って持つ（丸石 3・棒 2 で 1 本）');
    expect(nether).toContain('ダイヤのツルハシの耐久（持ち物の行）が 300 を切ったら、黒石か丸石と棒で石のツルハシを作って使う');
    const gate = seedPlan('エンドラを倒して')!.nodes.find(node => node.title === '黒曜石10とゲート')!;
    expect((gate.caution ?? []).join(' ')).toContain('ツルハシと石の予備2本');
  });
  it('says what to do when a required need looks impossible to make: gather, read the line, try another form; in the lines of both stages and the rules', () => {
    for (const stage of [BEFORE_DIAMONDS, BEFORE_GATE]) {
      expect(stage.risk).toContain('作れない・材料が無いと見えた時は、後回しにして先へ進まず、材料を取りに行く');
      expect(stage.risk).toContain('作る手の行の missing: … を読み、別の材料の形を試す');
    }
    expect(PREP_RULES_WORDS).toContain('必須が作れない・材料が無いと見えた時は、後回しにして先へ進まない。材料を取りに行く（盾なら木と鉄 1。');
    const noShield = frame(KIT.filter(([name]) => name !== 'shield'));
    expect(gateHold({ hands: [{ do: 'portal' }] }, noShield)?.line).toContain('作れない・材料が無いと見えた時は、後回しにして先へ進まず、材料を取りに行く');
  });
});

describe('a first plan is not thrown away for a node whose target its doneWhen does not establish (run59 task 1, the coordinator 2026-11-03)', () => {
  const answer = (target: { item: string; count: number }, doneWhen: string) => ({ nodes: [
    { id: 'p1', parent: '', title: '木', kind: 'wood', where: '', doneWhen: 'have:log>=3' },
    { id: 'p8', parent: '', title: 'ベッド', kind: 'bed', where: '', doneWhen, target },
    { id: 'p9', parent: '', title: '石', kind: 'stone_tools', where: '', doneWhen: 'have:stone_pickaxe' }] });
  it('counts a generic name as the target\'s: have:bed establishes white_bed, as the conditions read it', () => {
    const tree = planFromAnswer(answer({ item: 'white_bed', count: 1 }, 'have:bed>=1'))!;
    expect(tree.nodes.find(node => node.id === 'p8')!.target).toEqual({ item: 'white_bed', count: 1 });
    expect(planFromAnswer(answer({ item: 'white_bed', count: 1 }, 'have:white_bed>=1'))!.nodes).toHaveLength(3);
  });
  it('takes the target off a node it does not match and keeps the node, its doneWhen and the rest of the plan, and says which node and why', () => {
    const lines: string[] = [];
    const tree = planFromAnswer(answer({ item: 'shield', count: 1 }, 'have:bed>=1'), undefined, line => lines.push(line))!;
    expect(tree.nodes.map(node => node.id)).toEqual(['p1', 'p8', 'p9']);
    const node = tree.nodes.find(item => item.id === 'p8')!;
    expect(node.target).toBeUndefined();
    expect(node.doneWhen).toBe('have:bed>=1');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('first plan target dropped node=p8 p8: target shield×1 と doneWhen が不一致');
    expect(planFromAnswer({ nodes: [] })).toBeNull();
  });
  it('keeps a target that its doneWhen establishes, and is silent', () => {
    const lines: string[] = [];
    const tree = planFromAnswer(answer({ item: 'bed', count: 1 }, 'have:bed>=1'), undefined, line => lines.push(line))!;
    expect(tree.nodes.find(node => node.id === 'p8')!.target).toEqual({ item: 'bed', count: 1 });
    expect(lines).toEqual([]);
  });
});

describe('the full pack names the clutter first and keeps 128 blocks (the coordinator, 2026-11-03; run59 leg 2: 空き 2, 丸石 350 dropped)', () => {
  const lines = (...stacks: string[]) => stacks;
  it('names fences, stairs, rails, mossy cobblestone, string (under three), saplings and seeds before the filler, and not a bow\'s string', () => {
    const packed = packFacts(lines('oak_fence×3', 'oak_stairs×6', 'rail×1', 'mossy_cobblestone×1', 'string×1', 'oak_sapling×4', 'wheat_seeds×1', 'cobblestone×189', 'string×3'));
    expect(packed.junk.map(([name]) => name).sort()).toEqual(['mossy_cobblestone', 'oak_fence', 'oak_sapling', 'oak_stairs', 'rail', 'string', 'wheat_seeds']);
    expect(packed.junk.find(([name]) => name === 'string')![1]).toBe(1);
    expect(packFacts(lines('string×3', 'stick×4', 'oak_planks×6')).junk).toEqual([]);
    const words = dropAdvice(packed);
    expect(words.startsWith('雑物 oak_stairs×6・oak_sapling×4・oak_fence×3')).toBe(true);
    expect(words.endsWith('・cobblestone×61（1 マス）')).toBe(true);
  });
  it('keeps 128 of the most carried filler, in the words of a full pack and of one nearly full', () => {
    const full = packLines(lines('cobblestone×350', 'granite×37', 'dirt×22', 'oak_fence×3', ...Array.from({ length: 30 }, (_, i) => `item_${i}×1`)))
      .join('\n');
    expect(full).toContain('雑物 oak_fence×3・cobblestone×222');
    expect(full).toContain('cobblestone 128 は柱と橋用に数えていない');
    const soon = packLines(lines('cobblestone×350', 'oak_fence×3', 'rail×2', ...Array.from({ length: 26 }, (_, i) => `item_${i}×1`))).join('\n');
    expect(soon).toContain('捨てる物の候補: 雑物 oak_fence×3・rail×2・cobblestone×222');
    expect(soon).toContain('cobblestone 128 は柱と橋に残す');
  });
});

describe('what the lab\'s walk through the Nether showed (S4, run59 leg 2, 2026-11-03)', () => {
  it('says that the portal hand\'s stop is the way in, the exit is not at the frame\'s height, a go is split to 90 m, and where the piglins are', () => {
    const nether = V2_STAGES.nether;
    for (const word of ['その act は「次元が変わった…（手の途中）」と止まって返る（入れた印で、失敗ではない）', 'ゲートの出口の高さは、地上の枠の高さとは限らない',
      'go は 1 手 90m 以内に分ける', 'limit_time は、同じ行き先をそのまま出し直せば着く', '真紅の森（crimson_forest）はホグリンとピグリンが湧く所',
      '金の防具を 1 つ着ていないとピグリンは敵になる']) expect(nether, word).toContain(word);
  });
});

describe('the lab\'s walk through the crimson forest (S4, 2026-11-03)', () => {
  it('says that a repeated search_timeout is cut into relay points, what limit_place is, and to heal before leaving the fortress\'s platform', () => {
    const nether = V2_STAGES.nether;
    for (const word of ['search_timeout（道探しが終わらない）が続く所は、出し直しても同じ所で止まる', '10m 以内の立てる中継点を行き先にして区切る', 'limit_place は置く物の上限',
      '要塞）から出る前に体力を戻す', '30 秒に体力 20→0.9']) expect(nether, word).toContain(word);
  });
});

describe('the stronghold\'s road, as the lab measured it (S4, 2026-11-03)', () => {
  it('gives the overland walk its numbers and says that the Nether road did not get through the lab twice', () => {
    const stronghold = V2_STAGES.stronghold;
    for (const word of ['1,454m を 110m 前後の hop で 600 秒に 1,274m 進み', '歩く前に丸石を 300 前後持つ', 'maxPlace 100・hop は 110m 前後',
      'ネザーの歩きが 2 回とも通らなかった', '今は勧めない']) expect(stronghold, word).toContain(word);
  });
});

describe('the current node follows the body\'s dimension, and the strong model decides in the End whatever the node says (run59 00:50, the owner\'s 3-hour plan)', () => {
  const rows: Array<[id: string, kind: PlanKind, title: string, doneWhen: string, parent?: string]> = [['p1', 'prep_descent', '地上の準備', 'have:bed>=4&have:golden_boots'],
    ['p1.1', 'bed', '村のベッド集め', 'have:bed>=4', 'p1'], ['p1.3', 'other', '金のブーツを着る', 'have:golden_boots', 'p1'], ['p2', 'portal', 'ゲートでネザーへ', 'dim:the_nether'],
    ['p3', 'nether', 'ネザーの攻略', 'have:blaze_rod>=7&have:ender_pearl>=12'], ['p3.1', 'fortress', '要塞を探す', 'see:fortress', 'p3'], ['p3.2', 'blaze', 'ブレイズロッド7本', 'have:blaze_rod>=7', 'p3'],
    ['p5', 'stronghold', 'ストロングホールド', 'see:end_portal'], ['p6', 'dragon', 'エンドで竜を倒す', ''], ['p6.1', 'end', 'エンドに入る', 'dim:the_end', 'p6'],
    ['p6.3', 'dragon', 'エンダードラゴン討伐', '', 'p6']];
  const treeAt = (current: string, done: string[] = []): PlanTree => {
    const order = new Map<string | null, number>();
    const nodes: PlanNode[] = rows.map(([id, kind, title, doneWhen, parent]) => {
      const next = order.get(parent ?? null) ?? 0;
      order.set(parent ?? null, next + 1);
      return { id, parentId: parent ?? null, order: next, title, state: done.includes(id) ? 'done' : 'continue', kind, ...(doneWhen ? { doneWhen } : {}) } as PlanNode;
    });
    return v2tree({ revision: 1, current, nodes });
  };
  const facts = (dimension: string, items: Array<[string, number]> = []) => doneFacts(frame(items, { dimension }))!;

  it('moves a current node of the overworld\'s work to the first open leaf of the Nether\'s work, past the gate node that the beds hold open', () => {
    const moved = followDimension(treeAt('p1.1', ['p1.2']), facts('the_nether', [['white_bed', 1]]))!;
    expect(moved).toMatchObject({ to: 'p3.1', from: 'p1.1' });
    expect(moved.words).toContain('今の節を [p3.1] 要塞を探す に置いた（体は the_nether にいて、今の節 [p1.1] 村のベッド集め は地上の仕事。飛ばした節は順のまま残っている）');
    // a leaf whose own condition already holds is not the place to stand: the fortress seen, the rods are next
    expect(followDimension(treeAt('p1.1'), { ...facts('the_nether'), seen: new Set(['fortress']) })).toMatchObject({ to: 'p3.2' });
  });
  it('moves to the End\'s work in the End, from the Nether\'s work too, and leaves a current node that is of the dimension or of no kind', () => {
    expect(followDimension(treeAt('p3.1'), facts('the_end'))).toMatchObject({ to: 'p6.3', from: 'p3.1' });
    expect(followDimension(treeAt('p1.1'), facts('the_end'))).toMatchObject({ to: 'p6.3' });
    expect(followDimension(treeAt('p3.1'), facts('the_nether'))).toBeNull();
    expect(followDimension(treeAt('p1.3'), facts('the_nether'))).toBeNull();
    expect(followDimension(treeAt('p6.3'), facts('the_end'))).toBeNull();
  });
  it('does nothing in the overworld, without a frame, or with no leaf of the dimension\'s work open', () => {
    expect(followDimension(treeAt('p1.1'), facts('overworld'))).toBeNull();
    expect(followDimension(treeAt('p1.1'), null)).toBeNull();
    expect(followDimension(treeAt('p1.1', ['p3', 'p3.1', 'p3.2']), facts('the_nether'))).toBeNull();
  });
  it('picks the strong model in the End from the dimension, and not elsewhere for a node of the overworld', () => {
    const main = { name: 'main' } as unknown as FcaModel, strong = { name: 'strong' } as unknown as FcaModel, escalate = { name: 'up' } as unknown as FcaModel;
    const checkpoint = { fcaPlanTree: treeAt('p1.1') };
    expect(llmcModelRouter({ main, escalate: null, strong }, checkpoint, undefined, 't', () => 'the_end')).toBe(strong);
    expect(llmcModelRouter({ main, escalate: null, strong }, checkpoint, undefined, 't', () => 'the_nether')).toBe(main);
    expect(llmcModelRouter({ main, escalate: null, strong }, checkpoint, undefined, 't', () => 'overworld')).toBe(main);
    expect(llmcModelRouter({ main, escalate: null, strong }, checkpoint)).toBe(main);
    expect(llmcModelRouter({ main, escalate: null }, checkpoint, undefined, 't', () => 'the_end')).toBe(main);
    expect(llmcModelRouter({ main, escalate, strong }, { ...checkpoint, consecutiveToolFailures: 2 }, undefined, 't', () => 'the_end')).toBe(escalate);
  });
});

describe('the words that were wrong (the coordinator, 2026-11-03): go makes no walls, obsidian is not made in the Nether, stopIf is the head\'s line', () => {
  it('says what go\'s canPlace does, and that the body steps to a safe place outside the line of fire before it stops', () => {
    const end = V2_STAGES.end;
    expect(end).toContain('足元に橋を置いて渡る（go の canPlace は足元の床だけで、壁は作らない');
    expect(end).not.toContain('足元と両脇に壁を置く橋（go の canPlace）');
    for (const stage of Object.values(V2_STAGES)) expect(stage).not.toContain('ネザーの溶岩と水で作る');
    for (const words of [SHORT_ACT_DESCRIPTION, ACT_DESCRIPTION]) {
      expect(words).toContain('満たすと、体は射線の外の安全な足場へ寄ってから止まって返す（止める線は頭が決める）');
      expect(words).not.toContain('満たしたら全体を止めて返す');
    }
  });
});
