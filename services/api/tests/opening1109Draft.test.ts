import { describe, expect, it } from 'vitest';
import { applyPlanUpdate, planFromSeeds } from '@shannon/mind';
import { firstPlanInput, openingDraft, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';

describe('end1109o02 (opening lane): the seed is the first plan\'s draft from the overworld; a held condition keeps its parent open', () => {
  it('draws the seed up to the gate, with the iron pickaxe before the bucket, and fits its bound', () => {
    const draft = openingDraft(seedPlan('エンドラを討伐してください', 'overworld'))!;
    expect(draft.length).toBeLessThan(3_200);
    expect(draft).toContain('最初の鉄3を焼いて鉄のツルハシ');
    expect(draft.indexOf('最初の鉄3を焼いて鉄のツルハシ')).toBeLessThan(draft.indexOf('水入りバケツ（最初の'));
    expect(draft).toContain('dim:the_nether');
    expect(draft).not.toContain('ネザー要塞を探す');
    expect(openingDraft(seedPlan('エンドラを討伐してください', 'the_nether'))).toBeNull();
  });
  it('puts the draft before the scan in the first plan\'s input', () => {
    const draft = openingDraft(seedPlan('エンドラを討伐してください', 'overworld'))!;
    const input = firstPlanInput('エンドラを討伐してください', { dimension: 'overworld', scan: { at: 'x', text: '原木は oak が 北 20m', rows: [] } }, { scan: true, draft });
    expect(input).toContain('下書き（過去の実走から作った');
  });
  it('a parent with have: stays open after its children; the plan stays on it before the next node', () => {
    const tree = planFromSeeds([{ id: 'p4', title: '鉄の道具と防具', doneWhen: 'have:iron_pickaxe&have:shield', children: [
      { id: 'p4.1', title: 'バケツを作る', doneWhen: 'have:bucket>=1' }, { id: 'p4.2', title: '水を汲む', doneWhen: 'have:water_bucket' }] },
    { id: 'p5', title: 'ダイヤを3個掘る', doneWhen: 'have:diamond>=3' }])!;
    const after = applyPlanUpdate({ ...tree, current: 'p4.2' }, { ops: [{ op: 'set', id: 'p4.1', state: 'done' }, { op: 'set', id: 'p4.2', state: 'done' }] }).tree;
    expect(after.nodes.find(node => node.id === 'p4')?.state).not.toBe('done');
    expect(after.current).toBe('p4');
    const placed = planFromSeeds([{ id: 'p1', title: '戻る', doneWhen: 'dim:overworld', children: [{ id: 'p1.1', title: '門へ' }] }])!;
    expect(applyPlanUpdate(placed, { ops: [{ op: 'set', id: 'p1.1', state: 'done' }] }).tree.nodes.find(node => node.id === 'p1')?.state).toBe('done');
  });
});

describe('end1109o03 (opening lane): the night with no bed says its choices before the plan\'s now', async () => {
  const { nightChoiceLine } = await import('../src/surfaces/minecraft/minecraftNightArms.js');
  const world = (extra: Record<string, unknown> = {}) => ({ timeOfDay: 18_200, position: { x: 214.5, y: 79, z: 29.5 },
    mapLandmarks: ['B 村のベッド (216,79,28) 東2・北1 white_bed', 'B 村のベッド (203,79,16) 西11・北13 white_bed', 'C 村の箱 (193,78,6) 西21'], ...extra });
  const pack = (items: Record<string, number>) => new Map(Object.entries(items));
  it('names the nearest village bed (take it when a villager sleeps there) and the shaft to the iron, with what waiting costs', () => {
    const line = nightChoiceLine(world(), pack({ stone_pickaxe: 1, cobblestone: 20 }), 'overworld')!;
    expect(line).toContain('夜（朝まで 約 4 分）');
    expect(line).toContain('A) 村のベッド (216,79,28)');
    expect(line).toContain('dig takeOk collect=true');
    expect(line).toContain('B) 足元を 2 段掘って');
    // end1109o06: the hole is a shaft with the cap cell said (the feet cell now), not stairs whose mouth stays open.
    expect(line).toContain('「vertical down shaft y=77 dig=');
    expect(line).toContain('「place dirt 214,79,29」');
    // ...and it is said from about 3 minutes before the night (o06 dug in then), not earlier.
    expect(nightChoiceLine(world({ timeOfDay: 9_500 }), pack({ stone_pickaxe: 1 }), 'overworld')).toContain('夜まで 約 3 分');
    expect(nightChoiceLine(world({ timeOfDay: 8_000 }), pack({ stone_pickaxe: 1 }), 'overworld')).toBeNull();
    expect(line).toContain('stone_pickaxe');
    expect(line).toMatch(/30 分の目標の \d+%/u);
  });
  it('says nothing by day, with a bed carried, underground, outside the overworld, or with neither choice', () => {
    expect(nightChoiceLine(world({ timeOfDay: 6000 }), pack({ stone_pickaxe: 1 }), 'overworld')).toBeNull();
    expect(nightChoiceLine(world(), pack({ stone_pickaxe: 1, white_bed: 1 }), 'overworld')).toBeNull();
    expect(nightChoiceLine(world(), pack({ stone_pickaxe: 1 }), 'overworld', true)).toContain('A) 今いる所から地下で鉄を掘り進む');
    expect(nightChoiceLine(world(), pack({ stone_pickaxe: 1 }), 'overworld', true)).not.toContain('村のベッド');
    expect(nightChoiceLine(world(), pack({ stone_pickaxe: 1 }), 'the_nether')).toBeNull();
    expect(nightChoiceLine(world({ mapLandmarks: [] }), pack({ wooden_pickaxe: 1 }), 'overworld')).toBeNull();
    expect(nightChoiceLine(world({ mapLandmarks: [] }), pack({ stone_pickaxe: 1 }), 'overworld')).toContain('A) 足元を 2 段掘って');
  });
});

describe('end1109o04 (opening lane): by day with a bed, the day is the plan\'s and the sleep comes at night', async () => {
  const { dayBedLine } = await import('../src/surfaces/minecraft/minecraftNightArms.js');
  const pack = (items: Record<string, number>) => new Map(Object.entries(items));
  it('says how long until the bed works, what waiting costs and that the bed goes with her; nothing near the bed\'s minute, by night or with no bed', () => {
    const line = dayBedLine({ timeOfDay: 1000 }, pack({ white_bed: 1, stone_pickaxe: 1 }), 'overworld')!;
    expect(line).toContain('ベッドを持っている');
    expect(line).toMatch(/30 分の目標の \d+%/u);
    expect(line).toContain('夜になった所で sleep');
    expect(dayBedLine({ timeOfDay: 11_800 }, pack({ white_bed: 1 }), 'overworld')).toBeNull();
    expect(dayBedLine({ timeOfDay: 18_000 }, pack({ white_bed: 1 }), 'overworld')).toBeNull();
    expect(dayBedLine({ timeOfDay: 1000 }, pack({ stone_pickaxe: 1 }), 'overworld')).toBeNull();
    expect(dayBedLine({ timeOfDay: 1000 }, pack({ white_bed: 1 }), 'the_nether')).toBeNull();
  });
});

describe('end1109o09 (opening lane): the now wants iron and the map shows none: how to find it, not a wait for the night', async () => {
  const { ironSearchLine } = await import('../src/surfaces/minecraft/minecraftLlmcReadiness.js');
  const pack = (items: Record<string, number>) => new Map(Object.entries(items));
  const now = { id: 'p3.3', title: '鉄の兜・胸当て・脚を作って着る', doneWhen: 'have:iron_helmet&have:iron_chestplate' } as never;
  const world = (extra: Record<string, unknown> = {}) => ({ position: { x: 614.5, y: 32, z: -267.5 }, mapLandmarks: ['o 銅[copper_ore] (613,36,-269) 西1 ×8 見えている'], ...extra });
  it('says the scan, then the stair to y=16 and one row sideways', () => {
    const line = ironSearchLine(world(), pack({ iron_pickaxe: 1 }), 'overworld', now)!;
    expect(line).toContain('鉄鉱石: 今の節 p3.3 に要るが、地図に見えていない');
    expect(line).toContain('夜を待たない');
    expect(line).toContain('「vertical down stairs north y=16 dig=');
    expect(line).toContain('「go 614,16,-314 dig=');
    expect(ironSearchLine(world({ position: { x: 614.5, y: 15, z: -267.5 } }), pack({ iron_pickaxe: 1 }), 'overworld', now)).toContain('「go 614,15,-298');
    expect(ironSearchLine(world({ position: { x: 614.5, y: 15, z: -267.5 } }), pack({ iron_pickaxe: 1 }), 'overworld', now)).not.toContain('vertical down');
  });
  it('says nothing with iron on the map, a now that wants no iron, no pickaxe for it, or outside the overworld', () => {
    expect(ironSearchLine(world({ mapLandmarks: ['i 鉄鉱石[iron_ore] (543,50,-212) 南7・下12 ×1 見えている'] }), pack({ iron_pickaxe: 1 }), 'overworld', now)).toBeNull();
    expect(ironSearchLine(world(), pack({ iron_pickaxe: 1 }), 'overworld', { id: 'p5.1', title: 'ダイヤ3以上を掘る', doneWhen: 'have:diamond>=3' } as never)).toBeNull();
    expect(ironSearchLine(world(), pack({ wooden_pickaxe: 1 }), 'overworld', now)).toBeNull();
    expect(ironSearchLine(world(), pack({ iron_pickaxe: 1 }), 'the_nether', now)).toBeNull();
  });
});

describe('end1109o10 (opening lane): the night with no bed says the way to the ore as hands; iron goes to the pickaxe first; no sheep in sight', async () => {
  const { nightChoiceLine, nightArmsLine } = await import('../src/surfaces/minecraft/minecraftNightArms.js');
  const { sheepAbsentLine } = await import('../src/surfaces/minecraft/minecraftLlmcReadiness.js');
  const pack = (items: Record<string, number>) => new Map(Object.entries(items));
  const night = (extra: Record<string, unknown> = {}) => ({ timeOfDay: 14_000, position: { x: -21.5, y: 55, z: 2.5 },
    mapLandmarks: ['c 石炭[coal_ore] (-20,55,3) 東2・南1 ×6 見えている'], ...extra });
  it('with no iron on the map: the seal, then the stair to y=16 and the row, as hands (o10 payload 112 had only 「scan の行」)', () => {
    const line = nightChoiceLine(night(), pack({ stone_pickaxe: 1 }), 'overworld')!;
    expect(line).toContain('「place dirt -22,55,2」');
    expect(line).toContain('地下で鉄を掘り進む（stone_pickaxe）: 手 今の高さで横へ 1 列掘り進む「go -22,55,-28 '); expect(line).not.toContain('先に原木');
    expect(nightChoiceLine(night(), pack({ stone_pickaxe: 1, oak_log: 2 }), 'overworld')).toContain('「vertical down stairs north y=16 dig=');
    expect(nightChoiceLine(night(), pack({ stone_pickaxe: 1, oak_log: 2 }), 'overworld')).toContain('「go -22,16,-67 dig=');
    expect(line).not.toContain('scan の鉄鉱石の行');
  });
  it('with iron on the map: the go to the nearest one; after the armour the diamonds at y=-58; nothing with 3 diamonds', () => {
    const marks = ['i 鉄鉱石[iron_ore] (-36,60,4) 西15・上5 ×3 見えている', 'i 鉄鉱石[iron_ore] (-26,55,2) 西4 ×1 見えている'];
    expect(nightChoiceLine(night({ mapLandmarks: marks }), pack({ stone_pickaxe: 1 }), 'overworld')).toContain('「go -26,55,2 range=1 dig=');
    const armoured = nightChoiceLine(night(), pack({ iron_pickaxe: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, oak_log: 2 }), 'overworld')!;
    expect(armoured).toContain('地下でダイヤを掘り進む（iron_pickaxe）: 手 '); expect(armoured).toContain('「vertical down stairs north y=-58 ');
    expect(nightChoiceLine(night(), pack({ iron_pickaxe: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, diamond: 3 }), 'overworld')).toBeNull();
    expect(nightChoiceLine(night(), pack({ stone_pickaxe: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1 }), 'overworld')).toBeNull();
  });
  it('with iron 3 and no iron pickaxe, the arms line says the pickaxe first and no sword or shield', () => {
    const line = nightArmsLine({ timeOfDay: 14_000 }, pack({ stone_sword: 1, iron_ingot: 3 }), 'overworld')!;
    expect(line).toContain('鉄 3 個は鉄のツルハシ（鉄 3）が先');
    expect(line).not.toContain('盾が無い');
    expect(line).not.toContain('鉄の剣は鉄 2 個で作れる');
  });
  const nodes = [
    { id: 'p2', parentId: null, order: 1, title: '食料とベッド', state: 'continue' },
    { id: 'p2.1', parentId: 'p2', order: 1, title: '食料40点', doneWhen: 'food>=40', state: 'done' },
    { id: 'p2.3', parentId: 'p2', order: 2, title: '羊毛3と板3でベッド', doneWhen: 'have:bed>=1', state: 'continue' },
    { id: 'n4', parentId: 'p2.3', order: 1, title: '草原・平地へ移動して羊を探し倒す', doneWhen: 'have:wool>=3', state: 'continue' },
  ] as never[];
  it('with no sheep in sight: the bed is not needed to go on; the hand sets the highest bed node aside', () => {
    const now = (nodes as { id: string }[]).find(node => node.id === 'n4') as never;
    const line = sheepAbsentLine({ position: { x: 0, y: 64, z: 0 }, nearbyEntities: [{ name: 'cow' }] }, pack({ iron_pickaxe: 1 }), 'overworld', nodes, now)!;
    expect(line).toContain('羊: 今の節 n4 に羊毛が要るが、見える所に羊がいない');
    expect(line).toContain('"id":"p2","state":"blocked"');
    const foodOpen = nodes.map(node => (node as { id: string }).id === 'p2.1' ? { ...(node as object), state: 'continue' } : node) as never[];
    expect(sheepAbsentLine({ position: { x: 0, y: 64, z: 0 } }, pack({}), 'overworld', foodOpen, now)).toContain('"id":"p2.3","state":"blocked"');
  });
  it('says nothing with a sheep in sight, a bed in the pack, a village bed near, a now that wants no wool, or outside the overworld', () => {
    const now = (nodes as { id: string }[]).find(node => node.id === 'n4') as never;
    const world = { position: { x: 0, y: 64, z: 0 } };
    expect(sheepAbsentLine({ ...world, nearbyEntities: [{ name: 'sheep' }] }, pack({}), 'overworld', nodes, now)).toBeNull();
    expect(sheepAbsentLine(world, pack({ white_bed: 1 }), 'overworld', nodes, now)).toBeNull();
    expect(sheepAbsentLine({ ...world, mapLandmarks: ['B 村のベッド (20,64,10) 東20・南10 white_bed'] }, pack({}), 'overworld', nodes, now)).toBeNull();
    expect(sheepAbsentLine(world, pack({}), 'overworld', nodes, { id: 'p3.1', parentId: null, title: '鉄のツルハシ', doneWhen: 'have:iron_pickaxe' } as never)).toBeNull();
    expect(sheepAbsentLine(world, pack({}), 'the_nether', nodes, now)).toBeNull();
  });
});

describe('end1109o10 (opening lane): a sealed hole in the rock is underground for the night line', async () => {
  const { roofedInRock } = await import('../src/surfaces/minecraft/minecraftOreRoute.js');
  const layer = (row: string) => Array.from({ length: 11 }, (_, i) => ` ${i - 3} ${row}`).join('\n');
  const map = (top: string) => ['地図 v1 足=(-22,55,2) x=-29..-15 z=-5..9 方式=layers 上=北', '（以下の層は…）', 'z-x 7 6 5 4 3 2 1 0 9 8 7',
    'y=57（足 +2）', '              ^', layer(top), 'y=56（足 +1）', '              ^', layer('. . . . . . . . . . .')].join('\n');
  it('holds with rock over the head layer, not with air over it, a surface map or none', () => {
    expect(roofedInRock({ map: map('# # # # # # # # # # #') })).toBe(true);
    expect(roofedInRock({ map: map(': : : : : # # # : # :') })).toBe(false);
    expect(roofedInRock({ map: map('# # # # # # # # # # #').replace('方式=layers', '方式=surface') })).toBe(false);
    expect(roofedInRock({})).toBe(false);
  });
});

describe('thru t05 → opening: the food now with no animal in sight says the way down (the rule of prep skipped)', async () => {
  const { foodAbsentLine } = await import('../src/surfaces/minecraft/minecraftLlmcReadiness.js');
  const now = { id: 'p2.2', parentId: 'p2', title: '無ければ動物を4〜6体狩る', doneWhen: 'food>=40' } as never;
  it('names the points, that a walk makes no animal, and the hand with prep skipped', () => {
    const line = foodAbsentLine({ nearbyEntities: [{ name: 'squid' }] }, 2.4, 'overworld', now)!;
    expect(line).toContain('食料: 今の節 p2.2 は食料 2.4/40 点だが、見える所に食べられる動物がいない');
    expect(line).toContain('"prep":{"state":"skipped","why":"動物が見えない"}');
  });
  it('says nothing with an animal in sight, 40 points, a now that is not food, or outside the overworld', () => {
    expect(foodAbsentLine({ nearbyEntities: [{ name: 'salmon' }] }, 2.4, 'overworld', now)).toBeNull();
    expect(foodAbsentLine({}, 40, 'overworld', now)).toBeNull();
    expect(foodAbsentLine({}, 2.4, 'overworld', { id: 'p3.1', title: '鉄のツルハシ', doneWhen: 'have:iron_pickaxe' } as never)).toBeNull();
    expect(foodAbsentLine({}, 2.4, 'the_nether', now)).toBeNull();
  });
});

describe('end1109o11 (opening lane): the go of the way to the ore passes the go guard (eight go hands were held for ores in the dig list)', async () => {
  const { oreRouteHands } = await import('../src/surfaces/minecraft/minecraftOreRoute.js');
  const { goBlocksProblem } = await import('../src/surfaces/minecraft/minecraftLlmcGoGuard.js');
  const goDigs = (text: string) => [...text.matchAll(/「go [^」]*? dig=([^ 」]+)/gu)].map(m => m[1]!.split(','));
  it('with an iron mark, without one, and for diamonds: every go digs only rock', () => {
    const at = { position: { x: 3.5, y: 64, z: 101.5 } };
    const texts = [
      oreRouteHands({ ...at, mapLandmarks: ['i 鉄鉱石[iron_ore] (1,36,80) 南 ×3 見えている'] }, 'iron')!,
      oreRouteHands(at, 'iron')!,
      oreRouteHands(at, 'diamond')!,
      oreRouteHands({ position: { x: 3.5, y: 16, z: 101.5 } }, 'diamond')!,
    ];
    for (const text of texts) {
      const digs = goDigs(text);
      expect(digs.length).toBe(1);
      expect(goBlocksProblem({ canDig: digs[0]! })).toBeNull();
    }
    expect(texts[1]).toContain('掘った壁に見えた鉱石は mine で掘る');
  });
});

describe('end1109o12 (opening lane): every hand of the way to the ore is one the act takes as written (the stair had no way and 21 kinds to dig)', async () => {
  const { oreRouteHands } = await import('../src/surfaces/minecraft/minecraftOreRoute.js');
  const { expandShortAct } = await import('../src/contracts/minecraftActShortContract.js');
  const { llmcPrepare } = await import('../src/surfaces/minecraft/minecraftLlmc.js');
  const { MC_ACT_TOOL } = await import('../src/contracts/minecraftActTypes.js');
  const hands = (text: string) => [...text.matchAll(/「((?:go|vertical|mine) [^」]+)」/gu)].map(m => m[1]!);
  const pack = (items: Record<string, number>) => new Map(Object.entries(items));
  it('the stair, the row and the go to a mark pass the short form, the schema and the hand rules', () => {
    const texts = [
      oreRouteHands({ position: { x: 25.5, y: 94, z: -18.5 } }, 'iron')!,
      oreRouteHands({ position: { x: 25.5, y: 94, z: -18.5 } }, 'diamond')!,
      oreRouteHands({ position: { x: 3.5, y: 16, z: 101.5 } }, 'diamond')!,
      oreRouteHands({ position: { x: 3.5, y: 64, z: 101.5 }, mapLandmarks: ['i 鉄鉱石[iron_ore] (1,36,80) 南 ×3 見えている'] }, 'iron')!,
    ];
    let seen = 0;
    for (const text of texts) for (const line of hands(text)) {
      seen += 1;
      const expanded = expandShortAct({ hands: [line], why: 'test' });
      expect(expanded.errors, line).toEqual([]);
      expect(llmcPrepare(MC_ACT_TOOL, expanded.input).problem, line).toBeNull();
    }
    expect(seen).toBeGreaterThanOrEqual(7);
  });
  it('the row starts where the stair ends; with no table, planks or log the wood comes first', () => {
    const text = oreRouteHands({ position: { x: 25.5, y: 94, z: -18.5 } }, 'iron', pack({ iron_pickaxe: 1 }))!;
    expect(text).toContain('「vertical down stairs north y=16 ');
    expect(text).toContain('「go 25,16,-127 ');   // -19 - (94 - 16) - 30
    expect(text.startsWith('先に原木 2 本を取って持つ')).toBe(true);
    expect(oreRouteHands({ position: { x: 25.5, y: 94, z: -18.5 } }, 'iron', pack({ iron_pickaxe: 1, oak_log: 2 }))!.startsWith('先に原木')).toBe(false);
    expect(oreRouteHands({ position: { x: 25.5, y: 20, z: -18.5 } }, 'iron', pack({ iron_pickaxe: 1 }))!.startsWith('先に原木')).toBe(false);
  });
  it('the night line\'s own hands (the seal, the stair, the row) pass the same checks', async () => {
    const { nightChoiceLine } = await import('../src/surfaces/minecraft/minecraftNightArms.js');
    const night = { timeOfDay: 14_000, position: { x: -21.5, y: 55, z: 2.5 }, mapLandmarks: [] };
    const line = nightChoiceLine(night, pack({ stone_pickaxe: 1, oak_log: 2 }), 'overworld')!;
    const all = [...line.matchAll(/「((?:go|vertical|mine|place|dig) [^」]+)」/gu)].map(m => m[1]!);
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const one of all) {
      const expanded = expandShortAct({ hands: [one], why: 'test' });
      expect(expanded.errors, one).toEqual([]);
      expect(llmcPrepare(MC_ACT_TOOL, expanded.input).problem, one).toBeNull();
    }
  });
});

describe('end1109o13 (opening lane): the night line lifts the food prep with its hand, digs at her height with no wood, and keeps to the iron until the legs', async () => {
  const { nightChoiceLine } = await import('../src/surfaces/minecraft/minecraftNightArms.js');
  const { expandShortAct } = await import('../src/contracts/minecraftActShortContract.js');
  const { llmcPrepare } = await import('../src/surfaces/minecraft/minecraftLlmc.js');
  const { MC_ACT_TOOL } = await import('../src/contracts/minecraftActTypes.js');
  const pack = (items: Record<string, number>) => new Map(Object.entries(items));
  const night = { timeOfDay: 14_000, position: { x: 21.5, y: 108, z: 15.5 }, mapLandmarks: [] };
  it('food under 40 at night: says it cannot grow by waiting and gives the prep skipped hand for the now', () => {
    const line = nightChoiceLine(night, pack({ stone_pickaxe: 1, oak_log: 7 }), 'overworld', false, 27.2, 'p3.1')!;
    expect(line).toContain('食料 27.2 点は下りる準備の 40 に足りないが、夜は狩れず待っても増えない');
    expect(line).toContain('[{"op":"set","id":"p3.1","prep":{"state":"skipped","why":"夜は狩れない。朝に狩って 40 にする"}}]');
    expect(nightChoiceLine(night, pack({ stone_pickaxe: 1, oak_log: 7 }), 'overworld', false, 45, 'p3.1')).not.toContain('下りる準備の 40');
  });
  it('no table, planks or log at night: the row at her height, no wood first; the hands pass the act checks', () => {
    const line = nightChoiceLine({ ...night, position: { x: 38.5, y: 97, z: 25.5 } }, pack({ iron_pickaxe: 1, iron_helmet: 1, iron_chestplate: 1, oak_planks: 2 }), 'overworld', true)!;
    expect(line).toContain('地下で鉄を掘り進む（iron_pickaxe）');
    expect(line).toContain('今の高さで横へ 1 列掘り進む「go 38,97,-5 ');
    expect(line).not.toContain('先に原木');
    for (const one of [...line.matchAll(/「((?:go|vertical|mine|place|dig) [^」]+)」/gu)].map(m => m[1]!)) {
      const expanded = expandShortAct({ hands: [one], why: 'test' });
      expect(expanded.errors, one).toEqual([]);
      expect(llmcPrepare(MC_ACT_TOOL, expanded.input).problem, one).toBeNull();
    }
  });
});
