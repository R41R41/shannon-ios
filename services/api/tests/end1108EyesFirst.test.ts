import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { seedPlan, FIRST_PLAN_SYSTEM_R9, eyesForStronghold, firstPlanInput, strongholdFirst } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { doneFacts, nodesSeenDone } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/**
 * end1108a S9 (11/8): she stood in the overworld with 12 eyes, and the first plan went for 10 beds, 22 obsidian, a gate,
 * the rods, the pearls and 「アイをあと2個」 before throwing one. With 12 in the overworld the eyes' stages are done.
 */
const frame = (dimension: string, items: Array<[string, number]>): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1,
  connected: true, stateAt: '2026-11-08T00:00:00Z', receivedAt: '2026-11-08T00:00:00Z', facts: {},
  state: { world: { dimension, position: { x: 0, y: 64, z: 0 }, food: 20, inventory: Object.fromEntries(items) } } });
const gear: Array<[string, number]> = [['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1], ['shield', 1], ['iron_sword', 1]];
const titlesDone = (dimension: string, items: Array<[string, number]>) => {
  const tree = seedPlan('エンドラを倒して', dimension)!;
  const done = new Set(nodesSeenDone(tree, doneFacts(frame(dimension, [...gear, ...items]))!));
  return new Set(tree.nodes.filter(node => done.has(node.id)).map(node => node.title));
};

describe('end1108a S9: twelve eyes in the overworld close the stages that make them', () => {
  it('closes the gate, the rods, the pearls and the eyes with 12 eyes in the overworld', () => {
    const done = titlesDone('overworld', [['ender_eye', 12]]);
    for (const title of ['黒曜石10とゲート', '溶岩源で黒曜石22（ゲート10・竜戦12）', '火打ち金（火打石は砂利）', 'ブレイズロッド7以上', 'エンダーパール14以上', 'エンダーアイ14個'])
      expect(done.has(title), title).toBe(true);
    expect(done.has('目玉の交点へ行き、地下の枠の部屋を見つける')).toBe(false);
  });
  it('leaves only the stronghold and after open with what S9 supplies (end1108b: the golden boots kept her 25 minutes on gold, a gate and flint)', () => {
    const tree = seedPlan('エンドラを倒して', 'overworld')!;
    // sections.json S9's give and wear.
    const supply: Array<[string, number]> = [['diamond_pickaxe', 1], ['iron_pickaxe', 1], ['iron_axe', 1], ['iron_boots', 1], ['bow', 1], ['arrow', 32],
      ['water_bucket', 1], ['cobblestone', 64], ['torch', 16], ['cooked_beef', 24], ['white_bed', 10], ['obsidian', 12], ['ender_eye', 12],
      ['crafting_table', 1], ['furnace', 1], ['coal', 8]];
    const done = new Set(nodesSeenDone(tree, doneFacts(frame('overworld', [...gear, ...supply]))!));
    // A child of a node seen done is closed with it when the plan settles (「closed=p2.1←p2」).
    const byId = new Map(tree.nodes.map(node => [node.id, node]));
    const underDone = (node: (typeof tree.nodes)[number]): boolean => {
      for (let up = byId.get(node.parentId ?? ''); up; up = byId.get(up.parentId ?? '')) if (done.has(up.id)) return true;
      return false;
    };
    const open = tree.nodes.filter(node => !done.has(node.id) && !underDone(node));
    expect(open.map(node => node.title).filter(title => /金|ゲート|オーバーワールドへ戻る/u.test(title))).toEqual([]);
    // The opening's wood and stone tools are closed in the real run (end1108b S9's checkpoint: p1 to p1.4 done), not by this predicate alone.
    expect(new Set(open.map(node => node.kind).filter(kind => kind !== 'wood' && kind !== 'stone_tools'))).toEqual(new Set(['stronghold', 'end', 'dragon']));
  });
  it('closes the gate and the rods with 10 or 11 (end1108d: one thrown before the plan), the pearls and the eyes at 12; keeps them open with 9; 12 made in the Nether close them too', () => {
    const thrown = titlesDone('overworld', [['ender_eye', 11]]);
    for (const title of ['黒曜石10とゲート', 'ブレイズロッド7以上']) expect(thrown.has(title), title).toBe(true);
    // The coordinator, 11/9: the pearls' and eyes' stages close at 12 (the Nether is left with 12); with 10 or 11 in the overworld the
    // first plan's answer has them taken out (`strongholdFirst`), and a stage closed in the Nether stays done while eyes fly.
    for (const title of ['エンダーパール14以上', 'エンダーアイ14個']) expect(thrown.has(title), title).toBe(false);
    expect(titlesDone('overworld', [['ender_eye', 12]]).has('エンダーアイ14個')).toBe(true);
    const fewer = titlesDone('overworld', [['ender_eye', 9]]);
    for (const title of ['黒曜石10とゲート', 'ブレイズロッド7以上', 'エンダーアイ14個']) expect(fewer.has(title), title).toBe(false);
    const nether = titlesDone('the_nether', [['ender_eye', 12]]);
    for (const title of ['ブレイズロッド7以上', 'エンダーパール14以上', 'エンダーアイ14個']) expect(nether.has(title), title).toBe(true);
    const rods = titlesDone('the_nether', [['blaze_rod', 6], ['ender_pearl', 13]]);
    for (const title of ['ブレイズロッド7以上', 'エンダーパール14以上', 'エンダーアイ14個']) expect(rods.has(title), title).toBe(false);
  });
  it('says why to the first plan and in the eyes\' knowledge', () => {
    expect(FIRST_PLAN_SYSTEM_R9).toContain('オーバーワールドでエンダーアイを 10 個以上持っている時は、ゲート・ブレイズ・パール・アイを作る節を入れず');
    expect(FIRST_PLAN_SYSTEM_R9).toContain('投げた直後は拾う前で 1〜2 個少なく見える');
    expect(FIRST_PLAN_SYSTEM_R9).toContain('枠の部屋で空きを数え、足りない時だけネザーへ取りに戻る');
    expect(V2_STAGES.pearl).toContain('足すためにネザーへ戻らない');
  });
});

describe('end1108e S9: Haiku planned the gate, the rods, the pearls and the eyes with 12 eyes in view', () => {
  // The answer of end1108e's first plan (rig.log 21:45:49, 13 rows), its ids, parents and kinds.
  const row = (id: string, kind: string, title: string, parent?: string) => ({ id, kind, title, ...(parent ? { parent } : {}) });
  const answer = { nodes: [row('p1', 'wood', '木と板を集める'), row('p2', 'portal', '火打ち金を作る'), row('p2.1', 'iron', '鉄を掘って焼き火打石を得る', 'p2'),
    row('p3', 'portal', '黒曜石のゲートを作って入る'), row('p4', 'fortress', 'ネザー要塞を探す'), row('p5', 'blaze', 'ブレイズロッド7本を取る'),
    row('p6', 'pearl', 'エンダーパール14個を取る'), row('p6.1', 'iron', '予備の鉄の剣を作る', 'p6'), row('p7', 'pearl', 'アイを14個そろえる'),
    row('p8', 'stronghold', 'ストロングホールドを探す'), row('p9', 'end', 'エンドポータルを開く'), row('p10', 'end', 'エンドに入る'), row('p11', 'dragon', 'エンドラを倒す')] };
  const world = (dimension: string, eyes: number) => frame(dimension, [...gear, ['ender_eye', eyes]]).state!.world as Record<string, unknown>;
  const ids = (value: unknown) => ((value as { nodes: Array<{ id: string }> }).nodes).map(node => node.id);
  it('counts the eyes for the stronghold only in the overworld and from 10', () => {
    expect(eyesForStronghold(world('overworld', 12))).toBe(12);
    expect(eyesForStronghold(world('minecraft:overworld', 10))).toBe(10);
    expect(eyesForStronghold(world('overworld', 9))).toBeNull();
    expect(eyesForStronghold(world('the_nether', 12))).toBeNull();
  });
  it('drops the stages that make eyes and their children, and says so', () => {
    const said: string[] = [];
    expect(ids(strongholdFirst(answer, 12, line => said.push(line)))).toEqual(['p1', 'p8', 'p9', 'p10', 'p11']);
    expect(said[0]).toContain('stronghold first eyes=12 dropped=p2,p2.1,p3,p4,p5,p6,p6.1,p7');
  });
  it('end1108f: also drops the stages whose target makes eyes or opens the Nether, and a stage left with no children', () => {
    // end1108f's first plan kept 「ネザーの準備」 with flint and steel and golden boots under it, and 「アイを2個足して14へ」.
    const f = { nodes: [row('p1', 'stronghold', 'ストロングホールドの方位を出す'), row('p2', 'other', 'ネザーの準備'),
      { ...row('p2.1', 'iron', '火打ち金を作る', 'p2'), target: { item: 'flint_and_steel', count: 1 } },
      { ...row('p2.2', 'other', '金のブーツを作る', 'p2'), target: { item: 'golden_boots', count: 1 } },
      row('p3', 'portal', 'ゲート'), { ...row('p7', 'other', 'アイを2個足して14へ'), target: { item: 'minecraft:ender_eye', count: 14 } },
      { ...row('p8', 'food', '食料'), target: { item: 'bread', count: 8 } }, row('p10', 'end', 'エンドに入る'), row('p11', 'dragon', 'エンドラを倒す')] };
    const said: string[] = [];
    expect(ids(strongholdFirst(f, 12, line => said.push(line)))).toEqual(['p1', 'p8', 'p10', 'p11']);
    expect(said[0]).toContain('dropped=p2.1,p2.2,p3,p7,p2');
  });
  it('leaves the answer as it is with fewer eyes, elsewhere, or with no stronghold stage to go on with', () => {
    expect(strongholdFirst(answer, eyesForStronghold(world('overworld', 9)))).toBe(answer);
    expect(strongholdFirst(answer, eyesForStronghold(world('the_nether', 12)))).toBe(answer);
    const noStronghold = { nodes: answer.nodes.filter(node => !['stronghold', 'end', 'dragon'].includes(node.kind)) };
    expect(strongholdFirst(noStronghold, 12)).toBe(noStronghold);
  });
  it('says the count as a fact in the first plan\'s input', () => {
    const input = firstPlanInput('エンドラを倒して', world('overworld', 12), { readiness: true });
    expect(input).toContain('エンダーアイ 12 個（オーバーワールド）: ゲート・ネザー・ブレイズ・パール・アイを作る節は要らない。最初の節はストロングホールドを探す節');
    expect(firstPlanInput('エンドラを倒して', world('overworld', 9), { readiness: true })).not.toContain('エンダーアイ 9 個（オーバーワールド）');
  });
});

describe('targetMet: a target holds a node open unless its own condition names a count of the item or what it is made into', () => {
  const tree = (doneWhen: string) => ({ schema: 'shannon.plan-tree.v2' as const, revision: 1, current: 'p1', promises: [], nodes: [
    { id: 'p1', parentId: null, order: 0, title: 'ロッド', state: 'continue' as const, doneWhen, target: { item: 'blaze_rod', count: 7 } }] });
  const facts = (items: Array<[string, number]>) => doneFacts(frame('the_nether', items))!;
  it('stays open on a place or a sighting with 0 rods, and closes on the eyes the rods are made into', () => {
    expect(nodesSeenDone(tree('see:fortress|have:blaze_rod>=7'), facts([['ender_eye', 12]]))).toEqual([]);
    expect(nodesSeenDone(tree('dim:the_nether|have:blaze_rod>=7'), facts([]))).toEqual([]);
    expect(nodesSeenDone(tree('have:blaze_rod>=7|have:ender_eye>=12'), facts([['ender_eye', 12]]))).toEqual(['p1']);
    expect(nodesSeenDone(tree('have:blaze_rod>=7|have:ender_eye>=12'), facts([['ender_eye', 11]]))).toEqual([]);
  });
});

describe('end1108g7 S7: the blaze knowledge says where blazes come, where rods fall, and that the sword kills them', () => {
  it('tells the 16 m rule and the rod at the kill', () => {
    expect(V2_STAGES.blaze).toContain('湧くのはあなたが湧き場から 16m 内にいる間だけ');
    expect(V2_STAGES.blaze).toContain('棒は倒した場所に落ちる');
    expect(V2_STAGES.blaze).not.toContain('打つ時は fight target=blaze');
  });
  it('kills by sword and keeps the arrows for the End (end1108h16: chases killed 2 in 3 s with no health lost, holds 1 in about 25; owner 11/8)', () => {
    expect(V2_STAGES.blaze).toContain('倒すのは剣で: 見えている 8m 内の 1 体へ attack target=#id');
    expect(V2_STAGES.blaze).toContain('ブレイズに矢は使わない（矢はエンドのドラゴンとクリスタル用に 30 本残す');
    expect(V2_STAGES.blaze).toContain('追って斬った 2 回は 0.7 秒と 2.7 秒で倒し、傷 0。待つだけの hold は約 25 回で 1 体');
    expect(V2_STAGES.blaze).toContain('湧き場から 12m を超えた時に追うのをやめて返す');
    expect(V2_STAGES.blaze).not.toContain('shoot target=blaze n=5');
    expect(V2_STAGES.blaze).not.toContain('1m 内まで寄ってくる');
  });
});

describe('end1108h7 S7: a note without quotes is the rest of the line', () => {
  it('reads equip iron_sword note=近い blaze を剣で打つ as a sword in the hand, not a slot named blaze', async () => {
    const { lineToHand } = await import('../src/contracts/minecraftActShortHands.js');
    expect(lineToHand('equip iron_sword note=近い blaze を剣で打つ（体力 9.5）')).toEqual({ do: 'equip', item: 'iron_sword', note: '近い blaze を剣で打つ（体力 9.5）' });
    expect(lineToHand('attack #427 seconds=5 untilDead=false note=近い blaze #427 を剣で打つ')).toMatchObject({ do: 'attack', seconds: 5, untilDead: false, note: '近い blaze #427 を剣で打つ' });
    expect(lineToHand('shoot target=blaze n=5 note=見える blaze を弓で撃つ')).toMatchObject({ do: 'shoot', target: 'blaze', n: 5, note: '見える blaze を弓で撃つ' });
    expect(lineToHand('equip iron_sword note="剣"')).toEqual({ do: 'equip', item: 'iron_sword', note: '剣' });
  });
});

describe('end1108h7 S7: the stand with the fewest shooters seeing it', () => {
  it('tells to pick the spot with the fewest other shooters and not to stand where two or more see her', () => {
    expect(V2_STAGES.blaze).toContain('射手が 1 体だけ見える岩の陰');
    expect(V2_STAGES.blaze).toContain('2 体以上の射手から見える所へは出ない');
  });
});

describe('end1108h7b S7: arrows run out after four kills; the sword goes on, rods are picked by id', () => {
  it('tells the arrow count measured, that the sword goes on at 0 arrows, and how to pick a rod', async () => {
    expect(V2_STAGES.blaze).toContain('矢 32 本で倒せたブレイズは 6 体だけ');
    expect(V2_STAGES.blaze).toContain('弓と矢: ブレイズには使わない');
    expect(V2_STAGES.blaze).toContain('盾が無いことは止める理由にならない');
    expect(V2_STAGES.blaze).toContain('ロッドは pickup target=#N');
    expect(V2_STAGES.blaze).toContain('射った矢は拾えない');
    expect(V2_STAGES.blaze).not.toContain('近接の fight は弓の代わりにならない');
    const { lineToHand } = await import('../src/contracts/minecraftActShortHands.js');
    expect(lineToHand('pickup target=#20')).toMatchObject({ do: 'pickup', target: '#20' }); // the body reads #N as the id
    expect(lineToHand('pickup target=blaze_rod')).toMatchObject({ do: 'pickup', target: 'blaze_rod' });
    expect(lineToHand('attack target=blaze hold=true seconds=20')).toMatchObject({ do: 'attack', target: 'blaze', hold: true, seconds: 20 });
  });
});
