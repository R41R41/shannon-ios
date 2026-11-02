import { afterEach, describe, expect, it } from 'vitest';
import type { PlanKind, PlanNode, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { forgetActNodes, followNode, lackBefore, noteItemStart } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { heldOfFrame } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { BEFORE_DIAMONDS, BEFORE_GATE, PREP_RULES_WORDS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { gateNote, preparationShortage, readinessOf, requiredLack } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
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
    expect(gateLine([...rest, ['iron_pickaxe', 1]])).toBe(`準備の不足（ネザーに入る前）: 必須（ネザーに入る前に必ず）— ツルハシ（ダイヤ 1 か鉄 3） 1/3。欠けたまま進むと: ${BEFORE_GATE.risk}。`
      + '目標（そろえば。必須ではない）— 金のブーツ（金 4 がそろう時）が無い');
    expect(gateLine([...rest, ['iron_pickaxe', 2]])).toContain('ツルハシ（ダイヤ 1 か鉄 3） 2/3');
    expect(gateLine(rest)).toContain('必須（ネザーに入る前に必ず）— ツルハシ（ダイヤ 1 か鉄 3）が無い');
    expect(gateLine([...rest, ['iron_pickaxe', 3]])).toBe(GOAL_ONLY);
  });
  it('counts a diamond or netherite pickaxe for three, and the two kinds together', () => {
    expect(gateLine([...rest, ['diamond_pickaxe', 1]])).toBe(GOAL_ONLY);
    expect(gateLine([...rest, ['netherite_pickaxe', 1]])).toBe(GOAL_ONLY);
    expect(gateLine([...rest, ['iron_pickaxe', 1], ['stone_pickaxe', 4]])).toContain('ツルハシ（ダイヤ 1 か鉄 3） 1/3');
    expect(gateLine([...rest, ['iron_pickaxe', 2], ['diamond_pickaxe', 1]])).toBe(GOAL_ONLY);
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

describe('gateNote: a hand that enters the Nether says the required lack in its result', () => {
  const enter = { hands: [{ do: 'portal' }] };
  const noShield = frame(KIT.filter(([name]) => name !== 'shield'));
  it('says the lack, what it costs, and that the acceptance is no sign of the need met', () => {
    expect(gateNote(enter, noShield)).toBe(`準備の状態（この act はネザーへ入る手）: 未達の必須（ネザーに入る前に必ず）— 盾が無い。欠けたまま進むと: ${BEFORE_GATE.risk}。`
      + 'この受付は、準備が満たされたことを表さない');
    expect(gateNote({ hands: [{ do: 'wait', seconds: 1 }, { do: 'portal', enter: true }] }, noShield)).not.toBeNull();
  });
  it('says nothing when the hand does not enter, the need is met (the golden boots are a goal), or it is not the overworld', () => {
    expect(gateNote({ hands: [{ do: 'portal', enter: false }] }, noShield)).toBeNull();
    expect(gateNote({ hands: [{ do: 'go', to: { x: 1, y: 70, z: 1 } }] }, noShield)).toBeNull();
    expect(gateNote(enter, frame(KIT))).toBeNull();
    expect(gateNote(enter, frame([], { dimension: 'the_nether' }))).toBeNull();
    expect(gateNote(enter, null)).toBeNull();
    expect(gateNote({ hands: 'portal' }, noShield)).toBeNull();
  });
  it('goes into the notes of an act with the other notes, and not into an urgent decision\'s', () => {
    const notes: string[] = [];
    heldOfFrame(enter, noShield, 't1', false, notes);
    expect(notes).toContain(gateNote(enter, noShield));
    const urgent: string[] = [];
    heldOfFrame(enter, noShield, 't1', true, urgent);
    expect(urgent.some(line => line.includes('ネザーへ入る手'))).toBe(false);
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
      '高い足場で待つか、別の側から', '表彰台から 5〜12m', '水の入ったバケツ（鉄 3）', 'バケツ無しの 20 ブロックは被害 17', '体の落下止め（床の反射、エンドだけ）が働けば',
      '144 秒で死んだ', '3 回積んで上がり（96→99）被害 0', '積める物（黒曜石かエンドストーンが先、丸石も可）を 3 個以上残し', '柱の上に居る時間を短くする',
      '水の入ったバケツ（鉄 3）を hotbar（最初の 9 スロット）に持つ', '水バケツが手か hotbar にある時だけで、荷の中（hotbar の外）にあると起動しない',
      '落下を水バケツで止める途中で操作を取られた（水はあけた：あとで汲み直す／水はあけていない）']) expect(end, word).toContain(word);
    expect(end).not.toContain('荷の中でもよい');
    expect(STRATEGY_KNOWLEDGE_V2).toContain('鉄格子の檻つきは、水の入ったバケツ（鉄 3。hotbar に）と積める物 3 個以上を持って登る。落ちる時は体の落下止めが働けば水で止まる');
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
    expect(cautions('エンドでドラゴン')).toContain('水入りバケツ（hotbar に）と積める物3個以上で登り、長居しない');
    expect(cautions('エンドでドラゴン')).toContain('縁から5マス以上内側');
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
    expect(check.note).toContain('水入りバケツ（水を汲んだ物）を hotbar（最初の 9 スロット）に持つ');
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
