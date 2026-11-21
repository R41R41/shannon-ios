import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { lineToHand, handToLine } from '../src/contracts/minecraftActShortHands.js';
import { doneFacts } from '../src/surfaces/minecraft/minecraftConditions.js';
import { doneStatusWords, parseDoneWhen, predicateHolds } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { foodComfort, foodPointsWords } from '../src/surfaces/minecraft/minecraftFoodWords.js';
import { foodLine } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { huntWeaponStop } from '../src/surfaces/minecraft/minecraftLlmcHandGuards.js';
import { nearbyLines, nearbyResourcesOf } from '../src/surfaces/minecraft/minecraftLlmcNearby.js';
import { STOCK_LEVELS, foodEnough, foodNearOf, foodStockWords, woodEnough, woodLogs } from '../src/surfaces/minecraft/minecraftStockLevels.js';
import { foodLeads } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';

// Run 7 (2026-11-11): the owner's seven notes, the head's half: wood in two amounts, food in two amounts, the village before the cow, a sword before a hunt,
// what is near by purpose, several kinds in one drop.
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} }) as unknown as BodyObservation;
const items = (pairs: Array<[string, number]>) => pairs.map(([name, count]) => ({ name, count }));

describe('wood: the least (12) and the safe amount (24), with the logs near', () => {
  const facts = (pairs: Array<[string, number]>, woodNear?: unknown) => doneFacts(frame({ inventory: items(pairs), position: { x: 0, y: 64, z: 0 }, ...woodNear ? { woodNear } : {} }))!;
  const stock = parseDoneWhen('stock:wood')!;
  it('counts a log as 1, four planks and eight sticks as a log', () => {
    expect(woodLogs(new Map([['oak_log', 4], ['oak_planks', 9], ['stick', 8]]))).toBe(4 + 2 + 1);
    expect(STOCK_LEVELS.wood).toEqual({ min: 12, safe: 24 });
  });
  it('is not done below the least, and says the amounts and what is near (4 logs, 38 near: mine count=20)', () => {
    const f = facts([['oak_log', 4]], { logs: 38, trees: 6, withinM: 24 });
    expect(predicateHolds(stock, f)).toBe(false);
    expect(doneStatusWords('stock:wood', f)).toBe('未: 木 4/最低 12（安心 24）。近くに原木 38 本（木 6 本・24m 内） → mine count=20 が目安');
  });
  it('at the least with many near is still open (go on to the safe amount); with few near it is done', () => {
    expect(doneStatusWords('stock:wood', facts([['oak_log', 14]], { logs: 30, trees: 5, withinM: 24 })))
      .toBe('未: 木 14/最低 12 は満たす・安心 24 まであと 10（近くに原木 30 本（木 5 本・24m 内）） → 取り切ってから進む（count=10。取れない分は数えず、取れる分で set state=done 可）');
    expect(doneStatusWords('stock:wood', facts([['oak_log', 14]], { logs: 3, trees: 1, withinM: 24 }))).toBe('満たしている');
    expect(woodEnough(24, { logs: 99, trees: 9, withinM: 24 })).toBe(true);
  });
  it('a frame without the count near is judged by the least', () => {
    expect(predicateHolds(stock, facts([['oak_log', 12]]))).toBe(true);
    expect(predicateHolds(stock, facts([['oak_log', 11]]))).toBe(false);
  });
});

describe('food: the safe amount beside the least, said only once the least is met', () => {
  it('40 to 100, 100 to 150, 200 to 300, 330 to 400; other needs have none', () => {
    expect([40, 100, 200, 330, 45].map(foodComfort)).toEqual([100, 150, 300, 400, null]);
  });
  it('says nothing more below the least, and the way to the safe amount above it', () => {
    expect(foodPointsWords(38, 40)).toBe('食料 38/40 点（あと 2 点: sweet_berries 1 個）');
    expect(foodPointsWords(60, 40)).toBe('食料 60/40 点・安心 100 点まであと 40 点');
    expect(foodPointsWords(100, 40)).toBe('食料 100/40 点');
  });
});

describe('the food line: the village first with its points, the cow with what it needs', () => {
  const world = { inventory: items([['oak_log', 7]]), position: { x: 0, y: 64, z: 0 }, nearbyEntities: [{ name: 'cow', id: 14, distance: 9.5, position: { x: 9, y: 63, z: 0 } }],
    scan: { rows: ['範囲 読み込み', '干し草 ×25 最寄り (195,63,-167) 北西 102m', '畑 小麦 ×9 最寄り (202,64,-129) 西 58m'] } };
  it('lists the village hay and fields before the animals, and says a sword or an axe is needed while she has none', () => {
    const line = foodLine(frame(world), 6)!;
    expect(line.startsWith('村の食べ物: 干し草 ×25')).toBe(true);
    expect(line).toContain('1 個でパン 3＝約 33 点・焼かずに食べられる');
    expect(line.indexOf('村の食べ物')).toBeLessThan(line.indexOf('近くの食べ物の候補'));
    expect(line).toContain('（狩りは石以上の剣か斧が要る: 今 無し）');
  });
  it('says nothing of the sword when she holds one, and nothing of the village when none is known', () => {
    const armed = foodLine(frame({ ...world, inventory: items([['stone_sword', 1]]) }), 6)!;
    expect(armed).not.toContain('剣か斧が要る');
    expect(foodLine(frame({ ...world, scan: undefined }), 6)!.startsWith('近くの食べ物の候補')).toBe(true);
  });
  it('reads the nearby count of the village when the body sends one', () => {
    const nearby = [{ purpose: 'food_village', kind: '干し草ブロック', count: 13, range: 128, sites: [{ x: 231, y: 63, z: -128 }] }];
    expect(foodLine(frame({ ...world, scan: undefined, nearbyResources: nearby }), 6)).toContain('村の食べ物: 干し草ブロック 128m 内に 13個。最寄り (231,63,-128)');
  });
  it('recovery 食料の当て puts the village before the animals', () => {
    const lead = foodLeads({ position: { x: 0, y: 64, z: 0 }, nearbyEntities: world.nearbyEntities, scan: { dimension: 'overworld', rows: world.scan.rows } }, 'overworld');
    expect(lead.indexOf('干し草')).toBeLessThan(lead.indexOf('cow'));
  });
});

describe('a hunt waits for a sword or an axe of stone or better', () => {
  const hunt = { do: 'hunt', target: 'cow', count: 4 };
  const bare = frame({ food: 20, inventory: items([['oak_log', 7]]) });
  it('holds a hunt with none, says the way, and lets it go with a sword or an axe in the pack, or one made earlier in the same act', () => {
    const stop = huntWeaponStop({ hands: [hunt] }, bare)!;
    expect(stop).toMatchObject({ hand: 1, kind: 'hunt', code: 'hunt_no_weapon' });
    expect(stop.line).toContain('丸石 2・棒 1 で stone_sword');
    expect(huntWeaponStop({ hands: [hunt] }, frame({ food: 20, inventory: items([['wooden_sword', 1]]) }))).not.toBeNull();
    expect(huntWeaponStop({ hands: [hunt] }, frame({ food: 20, inventory: items([['stone_axe', 1]]) }))).toBeNull();
    expect(huntWeaponStop({ hands: [{ do: 'make', item: 'stone_sword' }, hunt] }, bare)).toBeNull();
  });
  it('counts a craft, with or without the minecraft: prefix, and holds an attack on a food animal the same way', () => {
    expect(huntWeaponStop({ hands: [{ do: 'craft', item: 'minecraft:stone_sword', count: 1 }, hunt] }, bare)).toBeNull();
    expect(huntWeaponStop({ hands: [{ do: 'attack', target: 'cow' }] }, bare)).toMatchObject({ hand: 1, kind: 'attack', code: 'hunt_no_weapon' });
    expect(huntWeaponStop({ hands: [{ do: 'attack', target: 'zombie' }] }, bare)).toBeNull();
    expect(huntWeaponStop({ hands: [{ do: 'attack', target: '#12' }] }, bare)).toBeNull();
  });
  it('lets a starving one hunt bare-handed (fullness 6 or less: the body does too)', () => {
    expect(huntWeaponStop({ hands: [hunt] }, frame({ food: 5, inventory: [] }))).toBeNull();
  });
});

describe('what is near, by purpose', () => {
  const raw = [
    { purpose: 'wood', kind: 'oak_log', count: 60, range: 64, sites: [{ x: 232, y: 66, z: -133, note: '幹 5 本' }, { x: 232, y: 66, z: -127, note: '幹 5 本' }] },
    { purpose: 'food_animal', kind: 'cow', count: 4, range: 48, sites: [{ x: 242, y: 63, z: -120 }] },
    { purpose: 'ore', kind: 'coal_ore', count: 0, range: 24, sites: [] },
  ];
  const feet = { x: 260, y: 67, z: -91 };
  it('is one line a purpose, nearest first, the place worked out from her feet now', () => {
    const lines = nearbyLines(nearbyResourcesOf(raw), feet);
    expect(lines[0]).toBe('木: oak_log 64m 内に 60本。最寄り (232,66,-127) 西28・北36・下1 46m（幹 5 本） / (232,66,-133) 50m（幹 5 本）');
    expect(lines[1]).toBe('食料（動物）: cow 48m 内に 4体。最寄り (242,63,-120) 西18・北29・下4 34m');
    expect(lines[2]).toBe('鉱石（空気に面した物）: coal_ore 24m 内に なし');
    expect(nearbyLines(nearbyResourcesOf(raw), { ...feet, x: 240 })[0]).toContain('最寄り (232,66,-127) 西8');
  });
  it('puts the purpose the now of the plan is about first, and drops entries that do not read', () => {
    expect(nearbyLines(nearbyResourcesOf(raw), feet, '[p2] 食料を集める')[0]!.startsWith('食料（動物）')).toBe(true);
    expect(nearbyResourcesOf([{ purpose: 'gold', kind: 'x', count: 1, range: 1, sites: [] }, null, 'x'])).toEqual([]);
    expect(nearbyLines([], feet)).toEqual([]);
  });
  it('says a plant of the request by name (a cane by its stands), and puts it first when the now of the plan is sugar', () => {
    const plants = [...raw, { purpose: 'plant', kind: 'sugar_cane', count: 2, range: 48, sites: [{ x: 258, y: 66, z: -95, note: '根元・高さ 3 段・水に接する' }, { x: 270, y: 66, z: -80 }] }];
    const lines = nearbyLines(nearbyResourcesOf(plants), feet);
    expect(lines.find(line => line.startsWith('植物'))).toBe('植物（材料）: sugar_cane 48m 内に 2株。最寄り (258,66,-95) 西2・北4・下1 5m（根元・高さ 3 段・水に接する） / (270,66,-80) 15m');
    expect(nearbyLines(nearbyResourcesOf(plants), feet, '[p2] 砂糖を作る（サトウキビ 2 本）')[0]!.startsWith('植物（材料）')).toBe(true);
  });
  it('is a field of the live state when the body sends it, and absent when it does not', () => {
    const base = { position: { x: 260, y: 67, z: -91 }, inventory: [] };
    const parts = (world: Record<string, unknown>) => ({ observation: frame(world), elapsedMinutes: 1, trend: createFoodTrend(() => 0), events: [] });
    expect(minecraftLlmcLive(parts({ ...base, nearbyResources: raw })).nearby).toHaveLength(3);
    expect('nearby' in minecraftLlmcLive(parts(base))).toBe(false);
  });
});

describe('drop: several kinds in one hand', () => {
  it('reads and writes drop with kinds and counts, and keeps the single form', () => {
    expect(lineToHand('drop dirt:17,granite:17,gravel')).toEqual({ do: 'drop', items: [{ item: 'dirt', count: 17 }, { item: 'granite', count: 17 }, { item: 'gravel' }] });
    expect(handToLine({ do: 'drop', items: [{ item: 'dirt', count: 17 }, { item: 'granite', count: 17 }] } as never)).toBe('drop dirt:17,granite:17');
    expect(lineToHand('drop cobblestone 64 target=#12')).toEqual({ do: 'drop', items: [{ item: 'cobblestone', count: 64 }], target: '#12' });
  });
});

describe('stock:food', () => {
  it('stays open under the safe amount while food is near, and closes at the min with none near', () => {
    expect(foodEnough(45, 6)).toBe(false);
    expect(foodEnough(45, 0)).toBe(true);
    expect(foodEnough(45, null)).toBe(true);
    expect(foodEnough(30, 0)).toBe(false);
    expect(foodEnough(100, 9)).toBe(true);
    expect(foodStockWords(45, 6)).toContain('安心 100 まであと 55');
    expect(parseDoneWhen('stock:food&have:bed>=1')).not.toBeNull();
  });
  it('counts the food near from the body nearby count', () => {
    expect(foodNearOf([{ purpose: 'food_animal', kind: 'cow', count: 4, range: 48, sites: [] }, { purpose: 'wood', kind: 'oak_log', count: 9, range: 24, sites: [] }])).toBe(4);
    expect(foodNearOf(undefined)).toBeNull();
  });
});

describe('run 7: probe kind=route, the logs near from the nearby count alone, the obsidian page', () => {
  it('route is a kind of its own (not path) with to, from and range kept within 0..32', async () => {
    const { prepareProbeInput, probeAnswerText, probeLabel } = await import('../src/surfaces/minecraft/minecraftLlmcProbeInput.js');
    const { PROBE_KINDS } = await import('../src/contracts/minecraftProbeContract.js');
    expect(PROBE_KINDS).toContain('route');
    const made = prepareProbeInput({ kind: 'route', to: { x: 10, y: 64, z: -3 }, range: 99, color: 1 }, { feet: null, creatures: [] });
    expect(made.problem).toBeNull();
    expect(made.input).toEqual({ kind: 'route', to: { x: 10, y: 64, z: -3 }, range: 32 });
    expect(made.fixes.join('／')).toContain('range を 32');
    expect(prepareProbeInput({ kind: 'route' }, { feet: null, creatures: [] }).problem).toContain('route には to');
    expect(prepareProbeInput({ kind: 'walk', to: { x: 1, y: 2, z: 3 } }, { feet: null, creatures: [] }).input?.kind).toBe('path');
    expect(probeLabel(made.input!)).toBe('route→(10,64,-3)');
    const answer = JSON.stringify({ v: 1, kind: 'route', text: '(10,64,-3) へ 歩き 12・掘り 3・置き 0、約 9 秒', status: 'ok', points: [{ x: 1, y: 64, z: 0 }, { x: 10, y: 64, z: -3 }] });
    expect(probeAnswerText(answer, true)).toContain('道の点');
  });
  it('the logs near are read from the nearby count when the body sends no woodNear', () => {
    const wood = { purpose: 'wood', kind: 'oak_log', count: 38, range: 48, trees: 6, sites: [] };
    const f = doneFacts(frame({ inventory: items([['oak_log', 4]]), position: { x: 0, y: 64, z: 0 }, nearbyResources: [wood] }))!;
    expect(doneStatusWords('stock:wood', f)).toContain('近くに原木 38 本（木 6 本・48m 内）');
  });
  it('the obsidian page tells that the body goes on digging what it hardened (count decides the total, within 120 characters)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/contracts/minecraftActShortContract.ts', import.meta.url), 'utf8');
    const sentence = '注水で固まった隣の溶岩源（挙げた源から半径 6）の黒曜石は、count まで体が続けて掘る。座標 1 個で隣も掘らせたいなら count=N で総数を決める（count を書かないと座標の数だけで、隣は掘らない）。';
    expect(source).toContain(sentence);
    expect(sentence.length).toBeLessThanOrEqual(120);
  });
});

// Run 8 (2026-11-13), the head's half of the chosen fixes.
describe('run 8: the food of the village is a fact beside the points', () => {
  const hayNear = [{ purpose: 'food_village', kind: '干し草ブロック', count: 6, range: 128, sites: [{ x: 1, y: 63, z: 1 }] }];
  it('foodPointsWords says no bread-for-hay conversion; the hay words come only with hay near', () => {
    expect(foodPointsWords(60, 40)).toBe('食料 60/40 点・安心 100 点まであと 40 点');
    expect(foodPointsWords(60, 40, 6)).toContain('村の干し草 6 個＝約 198 点（1 個 2〜3 秒・下りると戻らない');
    expect(foodPointsWords(60, 40, 6)).toContain('ネザー奥 100〜200・エンド 330');
    expect(foodPointsWords(60, 40, 0)).toBe('食料 60/40 点・安心 100 点まであと 40 点');
  });
  it('stock:food closes at 100 points whatever stands near; the words at 100 or more name no negative gap', () => {
    expect(foodEnough(120, 0)).toBe(true);
    expect(foodEnough(120, 6)).toBe(true);
    expect(foodEnough(45, 0)).toBe(true);
    expect(foodStockWords(120, 6, 6)).not.toContain('あと');
    expect(foodStockWords(120, 6, 6)).toContain('安心 100 を満たす');
  });
  it('the plan\'s now says the hay while it is near and not when it is away', () => {
    const near = doneFacts(frame({ inventory: items([['bread', 5]]), position: { x: 0, y: 64, z: 0 }, nearbyResources: hayNear }))!;
    expect(near.foodVillage).toBe(6);
    expect(near.foodHay).toBe(6);
    expect(doneStatusWords('stock:food', near)).toContain('村の干し草 6 個＝約 198 点');
    expect(predicateHolds(parseDoneWhen('stock:food')!, doneFacts(frame({ inventory: items([['bread', 40]]), position: { x: 0, y: 64, z: 0 }, nearbyResources: hayNear }))!)).toBe(true);
    const away = doneFacts(frame({ inventory: items([['bread', 5]]), position: { x: 0, y: 64, z: 0 }, nearbyResources: [] }))!;
    expect(doneStatusWords('stock:food', away)).not.toContain('干し草');
  });
  it('the first plan\'s cooking leaf closes by stock:food, not by 40 points', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/surfaces/minecraft/minecraftFirstPlan.ts', import.meta.url), 'utf8');
    expect(source).toContain("node('かまどで肉を焼く・パンを作る', { kind: 'food', doneWhen: 'stock:food' })");
  });
});


describe('run 8: a pack that is full offers a nearly spent tool when another of its kind is whole', () => {
  it('names the worn pickaxe (3 or fewer left) only with a better one beside it, and only at 0 free slots', async () => {
    const { packFacts, dropAdvice } = await import('../src/surfaces/minecraft/minecraftLlmcPack.js');
    const both = packFacts(['stone_pickaxe×1(耐久2/131)', 'stone_pickaxe×1(耐久120/131)', 'iron_pickaxe×1(耐久240/250)']);
    expect(both.worn).toEqual([['stone_pickaxe', 2]]);
    expect(dropAdvice(both)).toContain('stone_pickaxe(残り 2)');
    expect(packFacts(['stone_pickaxe×1(耐久2/131)']).worn).toEqual([]);
    expect(dropAdvice({ filler: [], junk: [] })).toBe('');
  });
});

describe('run 8: the table note says what the make itself does while she carries planks or a table', () => {
  const noTable = (inventory: unknown[]): BodyObservation => frame({ dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, inventory,
    utilities: { radius: 16, dim: 'overworld', scanned: true, found: [] } });
  it('keeps the old words without planks, and names the carried planks or table otherwise', async () => {
    const { tableNote } = await import('../src/surfaces/minecraft/minecraftLlmcTableNote.js');
    const make = { hands: [{ do: 'make', item: 'stone_pickaxe' }] };
    expect(tableNote(make, noTable(items([['oak_planks', 3]])))).toContain('先に go で作業台へ寄るか');
    expect(tableNote(make, noTable(items([['oak_planks', 4]])))).toContain('この手が持っている板・作業台を置いて作る。置ける所が無ければ止まる');
    expect(tableNote(make, noTable(items([['crafting_table', 1]])))).toContain('この手が持っている板・作業台を置いて作る');
  });
});
