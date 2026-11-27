import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { firstPlanInput, seedPlan, strongholdFirst } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { firstPlanSystemFor, ownFirstPlanSystem, singleRequestFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { seenDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { createEyeLedger, eyeLedgerFact, FAR_OLD_LINE_BLOCKS, throwsFromBody } from '../src/surfaces/minecraft/minecraftEyeLedger.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { readWhere, doneRange } from '../src/surfaces/minecraft/minecraftPlanFacts.js';
import { goalOf } from '../src/surfaces/minecraft/minecraftLlmcRoute.js';

/**
 * The first plan's own words and inputs (run 8 of 11/27: the plan wrote the village's beds, iron, an obsidian node and a bow before the stronghold with 11 eyes in the pack; the pack
 * was cut at 800 characters; the default plan's tool nodes stayed open with a diamond pickaxe in hand; run 7's two eye lines were not in the head's ledger of the next task).
 */
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: '2026-11-27T02:29:00Z',
  receivedAt: 't', connected: true, state: { world } as never, facts: {} as never });

const stack = (name: string, count: number, durability?: [number, number]) => ({ name, count, ...(durability ? { durability: { left: durability[0], max: durability[1] } } : {}) });
/** Run 8's pack at the first plan (the 800-character cut ended at 「warped_fun」: the water bucket and the seven beds came after it). */
const run8Pack = [stack('blaze_powder', 1), stack('coal', 11), stack('cobblestone', 42), stack('cooked_porkchop', 19), stack('crimson_nylium', 2), stack('crimson_roots', 6),
  stack('diamond', 1), stack('diamond_pickaxe', 1, [73, 1561]), stack('ender_eye', 11), stack('flint', 2), stack('flint_and_steel', 1, [62, 64]), stack('iron_chain', 2),
  stack('iron_ingot', 2), stack('iron_sword', 1, [249, 250]), stack('leather', 6), stack('obsidian', 7), stack('raw_gold', 2), stack('raw_iron', 2), stack('stone_axe', 1, [15, 131]),
  stack('torch', 1), stack('warped_fungus', 1), stack('water_bucket', 1), stack('wheat', 6), stack('white_bed', 2), stack('yellow_bed', 5)];
const WORN = '頭: iron_helmet(残り132/165)、胴: iron_chestplate(残り207/240)、脚: なし、足: なし、左手: shield(残り107/336)';
const run8World = (extra: Record<string, unknown> = {}) => ({ position: { x: 223.5, y: 64, z: -20.3 }, dimension: 'overworld', biome: 'badlands', time: '1336', health: 20, food: 20,
  inventory: run8Pack, worn: WORN, ...extra });
const GOAL = 'エンドラを討伐して';
const input = (world: Record<string, unknown>, now = 0) => firstPlanInput(GOAL, world, { readiness: true, journeyReadiness: true, now });

describe('(1) the words the run asks the first plan with (ownFirstPlanSystem)', () => {
  const system = ownFirstPlanSystem();
  it('says the order for 10 or more eyes in the overworld with its reason, and keeps the ordinary opening order for fewer', () => {
    expect(system).toContain('順番（エンダーアイを 10 個以上持って現世にいる時）: 要塞の場所は目を 2 本投げれば今すぐ出せる');
    expect(system).toContain('エンドの点検（ベッド・黒曜石・弓矢）の節は、要塞の節の後ろ、エンドへ入る節の前に置く（エンドへ入ってからは取りに戻れない）');
    expect(system).toContain('理由: 点検の物は道中・要塞の近く・村や溶岩を通る時に取れる分だけでよい');
    expect(system).toContain('アイが 10 個未満の通常の序盤（村→鉄→ネザー→要塞）は、この順のまま変えない');
  });
  it('puts the dimension beside a where (only R9 said it before, and R9 is not called)', () => {
    expect(system).toContain('where は座標のあとに次元を添える: "177,63,-398（ネザー）"');
  });
  it('gives the stock-node example that fails and why, and the finished goods to write instead', () => {
    expect(system).toContain('違反例: 「鉄を取りバケツと防具を作る」を doneWhen have:iron_ingot>=20 で書く');
    expect(system).toContain('防具やバケツを作ると鉄の在庫は減るので、条件が遠ざかって節が閉じない');
    expect(system).toContain('have:iron_leggings&have:iron_boots');
  });
  it('every rule that would put preparation first carries its condition (10 or more eyes in the overworld)', () => {
    const conditional = system.split('エンダーアイを 10 個以上持って現世にいる場合').length - 1;
    // the exception to 「準備の不足は…」, the village and the dragon's beds (one line), the bow and arrows, the iron
    expect(conditional).toBeGreaterThanOrEqual(4);
    for (const rule of ['準備の不足は、必要になる仕事の前に', '村の節（ベッド全部・干し草・箱）', '竜戦用のベッドは target bed×10', '弓と矢（エンドのクリスタルを地面から壊す道具', '鉄はネザーまでに約']) {
      const line = system.split('\n').find(row => row.includes(rule));
      expect(line, rule).toBeDefined();
    }
    expect(system).toContain('エンダーアイを 10 個以上持って現世にいる場合は例外: 必要な仕事は要塞を探す節が先');
    expect(system).toContain('この節を要塞の節の後ろ・エンドへ入る節の前に置く');
    expect(system).toContain('弓と矢の節も要塞の節の後ろ・エンドへ入る節の前');
    expect(system).toContain('エンダーアイを 10 個以上持って現世にいる場合の鉄: ネザーへ行かないので「ネザーまでに約 30」は要らない');
  });
  it('is what a dragon or nether goal is asked with, and the order line is not in the words of a request of one thing', () => {
    expect(firstPlanSystemFor(GOAL)).toBe(system);
    const single = singleRequestFirstPlanSystem();
    expect(single).not.toContain('順番（エンダーアイを 10 個以上');
    expect(single).not.toContain('準備の不足は、');
    expect(single).toContain('where は座標のあとに次元を添える');
  });
});

describe('(2) the eyes line is facts and a reason, shown only for 10 or more eyes in the overworld', () => {
  it('11 eyes: the throws are two and need nothing else; the shortage things go behind the stronghold node; the chance and the pearl are facts', () => {
    const text = input(run8World());
    expect(text).toContain('エンダーアイ 11 個（オーバーワールド）。2 本投げれば要塞の場所が出る（今すぐできて、足りない物は要らない）');
    expect(text).toContain('枠は最大 12 で、割れる分の予備を足した 14 個を持って向かうのが目安（今 11/14・あと 3 個');
    expect(text).toContain('ベッド・黒曜石・弓矢（とそれ用の鉄）の不足は、道中・要塞の近く・村や溶岩を通る時に取れる分だけでよく、そのための節は要塞の節の後ろ・エンドへ入る節の前に置く');
    expect(text).not.toContain('最初の節はストロングホールドを探す節');
    // the facts side's shortage line is not removed
    expect(text).toContain('準備の不足（');
  });
  it('0 eyes (a new world): no eyes line at all, and the seed plan keeps the ordinary order (village, food, iron, ... the Nether)', () => {
    const world = { position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', time: '100', health: 20, food: 20, inventory: [] };
    const text = input(world);
    expect(text).not.toContain('エンダーアイ');
    expect(text).not.toContain('2 本投げれば');
    const kinds = seedPlan(GOAL)!.nodes.filter(node => node.parentId === null).map(node => node.kind);
    expect(kinds.slice(0, 8)).toEqual(['stone_tools', 'village', 'prep_descent', 'iron', 'water', 'iron_armor', 'diamond', 'portal']);
  });
  it('9 eyes: still no eyes line (the ordinary opening)', () => {
    const text = input(run8World({ inventory: run8Pack.map(item => item.name === 'ender_eye' ? stack('ender_eye', 9) : item) }));
    expect(text).not.toContain('2 本投げれば');
  });
  it('in the Nether with 10 or more eyes: its own line (back through the gate first, no rods, pearls or eyes to add), not the overworld line; with 9, none', () => {
    const nether = input(run8World({ dimension: 'the_nether' }));
    expect(nether).toContain('エンダーアイ 11 個（ネザーの中）。要塞の場所は現世へ戻って 2 本投げれば出る');
    expect(nether).toContain('ロッド・パール・アイを足す節は要らない。帰りのゲートで現世へ戻る節が先');
    expect(nether).not.toContain('（オーバーワールド）');
    expect(input(run8World({ dimension: 'the_nether', inventory: run8Pack.map(item => item.name === 'ender_eye' ? stack('ender_eye', 9) : item) }))).not.toContain('ネザーの中）。要塞');
  });
  it('the system says the Nether case too, so that the rule is not weighed', () => {
    expect(ownFirstPlanSystem()).toContain('ネザーの中にいて目が 10 個以上ある時: ロッド・パール・アイを足す節は要らない。帰りのゲートで現世へ戻る節が先');
  });
});

describe('(3) the whole pack and the finished things she holds', () => {
  const text = input(run8World());
  it('names every stack, the tools with their wear, from the first to the last (the water bucket and the beds were after the old cut)', () => {
    const pack = text.split('\n').find(line => line.startsWith('持ち物: '))!;
    expect(pack).toContain('diamond_pickaxe×1(耐久73/1561)');
    expect(pack).toContain('iron_sword×1(耐久249/250)');
    expect(pack).toContain('stone_axe×1(耐久15/131)');
    expect(pack).toContain('water_bucket×1');
    expect(pack).toContain('white_bed×2');
    expect(pack).toContain('yellow_bed×5');
    expect(pack).not.toContain('（数の多い');
  });
  it('says the finished things as facts (worn ones with their wear), and not the raw materials', () => {
    const line = text.split('\n').find(row => row.startsWith('持っている完成品'))!;
    expect(line).toContain('diamond_pickaxe×1(耐久73/1561)');
    expect(line).toContain('iron_sword×1');
    expect(line).toContain('water_bucket×1');
    expect(line).toContain('yellow_bed×5');
    expect(line).toContain('iron_helmet（着ている・残り 132/165）');
    expect(line).toContain('shield（着ている・残り 107/336）');
    expect(line).not.toContain('raw_iron');
    expect(line).not.toContain('cobblestone');
  });
  it('a pack too long for the input leaves out the stacks with the biggest counts first and says how many kinds', () => {
    const many = [stack('diamond_pickaxe', 1, [10, 1561]), stack('cobblestone', 300), stack('dirt', 250), ...Array.from({ length: 160 }, (_, index) => stack(`thing_number_${index}`, 1 + (index % 7)))];
    const long = firstPlanInput(GOAL, { dimension: 'overworld', inventory: many }, {});
    const pack = long.split('\n').find(line => line.startsWith('持ち物: '))!;
    expect(pack.length).toBeLessThan(1_620);
    expect(pack).toContain('diamond_pickaxe×1(耐久10/1561)');
    expect(pack).not.toContain('cobblestone×300');
    expect(pack).toMatch(/（数の多い \d+ 種は省いた）/u);
  });
});

describe('(4) the eyes run 7 threw reach the head as its ledger, and as a fact of the first plan', () => {
  const T0 = Date.parse('2026-11-26T15:00:00Z');
  /** Run 7's two throws (the ledger's own lines at 11/26: (197,-245) 171.2° 12 broke / (176,-241) 170.5° 12 broke), as the body keeps them (`world.eyeThrows`). */
  const run7 = [
    { x: 197, z: -245, yawDeg: 171.2, flewM: 12, broke: true, atMs: T0, dim: 'overworld' },
    { x: 176, z: -241, yawDeg: 170.5, flewM: 12, broke: true, atMs: T0 + 90_000, dim: 'overworld' },
  ];
  const NOW = T0 + 40 * 60_000, FEET = { x: 470, z: 127 };
  it('a body that has no eyeThrows: nothing happens (an older body)', () => {
    const ledger = createEyeLedger(undefined);
    expect(ledger.seed(undefined, NOW)).toBe(false);
    expect(ledger.throws(NOW)).toEqual([]);
    expect(eyeLedgerFact(undefined, FEET, NOW)).toEqual([]);
    expect(throwsFromBody('x')).toEqual([]);
    const endgame = createEndgame(undefined, () => NOW);
    expect(endgame.lines(frame({ dimension: 'overworld', position: { x: 470, y: 64, z: 127 }, inventory: [stack('ender_eye', 11)] }), true).lines.join('\n')).not.toContain('目玉の帳簿');
    expect(endgame.ledger.throws(NOW)).toEqual([]);
  });
  it('an empty ledger takes the body\'s throws in once, by the 7th run\'s lines: a point to the south, and its error (the unit read exactly gives a point for 0.7 degrees)', () => {
    const ledger = createEyeLedger(undefined);
    expect(ledger.seed(run7, NOW)).toBe(true);
    expect(ledger.throws(NOW)).toHaveLength(2);
    const fix = ledger.fix(NOW)!;
    expect(fix).not.toBeNull();
    expect(Math.abs(fix.x - 482)).toBeLessThan(60);
    expect(Math.abs(fix.z - 1595)).toBeLessThan(120);
    expect(fix.errorBlocks).toBeGreaterThan(100);
    // the second read does not double them
    expect(ledger.seed(run7, NOW)).toBe(false);
    expect(ledger.throws(NOW)).toHaveLength(2);
  });
  it("a cleared ledger (room found or End entered) does not take the body's old throws back in", () => {
    const ledger = createEyeLedger(undefined);
    ledger.seed(run7, NOW);
    ledger.clear();
    expect(ledger.seed(run7, NOW)).toBe(false);
    expect(ledger.throws(NOW)).toEqual([]);
  });
  it('a task restarted with its own checkpoint (a ledger that holds throws) is not doubled, and the Nether\'s and malformed records are left out', () => {
    const mine = createEyeLedger(undefined);
    mine.seed(run7, NOW);
    const restarted = createEndgame(mine.checkpoint(), () => NOW);
    const world = { dimension: 'overworld', position: { x: 470, y: 64, z: 127 }, inventory: [stack('ender_eye', 11)], eyeThrows: run7 };
    restarted.lines(frame(world), true);
    expect(restarted.ledger.throws(NOW)).toHaveLength(2);
    expect(throwsFromBody([{ ...run7[0]!, dim: 'nether' }, { ...run7[1]!, flewM: 'x' }, null, 3, run7[1]])).toHaveLength(1);
  });
  it('createEndgame reads the body\'s eyeThrows at the first decision (empty checkpoint) and says the ledger\'s lines, and the End or a seen frame clears it', () => {
    const endgame = createEndgame(undefined, () => NOW);
    const world = { dimension: 'overworld', position: { x: 470, y: 64, z: 127 }, inventory: [stack('ender_eye', 11)], eyeThrows: run7 };
    const lines = endgame.lines(frame(world), true).lines.join('\n');
    expect(lines).toContain('目玉の帳簿: 投げた 2 個（割れた 2）');
    expect(lines).toContain('交点 (4');
    expect(endgame.ledger.throws(NOW)).toHaveLength(2);
    // not a dragon task: no read, no lines
    expect(createEndgame(undefined, () => NOW).lines(frame(world), false).lines).toEqual([]);
    // the End: not read (the ledger holds only the overworld's)
    const end = createEndgame(undefined, () => NOW);
    end.lines(frame({ ...world, dimension: 'the_end' }), true);
    expect(end.ledger.throws(NOW)).toEqual([]);
  });
  it('old lines from far behind are left out only when the throws near the newest one give a point of their own', () => {
    const at = (x: number, z: number, yawDeg: number, minute: number) => ({ x, z, yawDeg, flewM: 12, broke: true, atMs: T0 + minute * 60_000, dim: 'overworld' });
    const trek = (z: number) => [at(100, -250, 172, 0), at(80, -246, 171, 1), at(300, z, 180, 40), at(250, z + 4, 178.5, 41)];
    const old = createEyeLedger(undefined);
    old.seed(trek(-250), T0 + 45 * 60_000);
    expect(old.throws(T0 + 45 * 60_000)).toHaveLength(4);
    const far = createEyeLedger(undefined);
    far.seed(trek(1500), T0 + 45 * 60_000);
    // the two throws near the newest (50 m apart) give a point of their own: the 1,700 m old ones are not mixed in
    expect(FAR_OLD_LINE_BLOCKS).toBe(500);
    expect(far.throws(T0 + 45 * 60_000)).toHaveLength(2);
    expect(far.throws(T0 + 45 * 60_000).every(item => item.z > 1000)).toBe(true);
    // one new throw alone gives no point: the old lines stay (they still say which way to walk)
    const one = createEyeLedger(undefined);
    one.seed([at(100, -250, 172, 0), at(80, -246, 171, 1), at(300, 1500, 180, 40)], T0 + 45 * 60_000);
    expect(one.throws(T0 + 45 * 60_000)).toHaveLength(3);
  });
  it('the first plan\'s input says the point, the error, the way from where she stands, where to throw again, and that the point is a guide (the full text, read by eye)', () => {
    const world = run8World({ position: { x: FEET.x, y: 63, z: FEET.z }, eyeThrows: run7 });
    const text = input(world, NOW);
    const line = text.split('\n').find(row => row.startsWith('目玉を 2 本投げた'))!;
    expect(line).toContain('交点 (');
    expect(line).toContain('あなたから 南');
    expect(line).toContain('交点は点でなく目安');
    expect(line).toContain('近づいて 1〜2 本投げ直す前提');
    expect(line).toContain('投げ直しは交点の');
    // the eyes line comes first and the ledger's fact beside it, before the food and the shortage
    expect(text.indexOf('エンダーアイ 11 個')).toBeLessThan(text.indexOf('目玉を 2 本投げた'));
    expect(text.indexOf('目玉を 2 本投げた')).toBeLessThan(text.indexOf('食料 '));
    // run 7's plan was made with the point in the pack's own frame; this prints the input a plan made from it reads
    // eslint-disable-next-line no-console
    if (process.env.PRINT_FIRST_PLAN_INPUT) console.log(text);
  });
  it('no throws, or an older body: the input has no ledger line', () => {
    expect(input(run8World(), NOW)).not.toContain('目玉を');
    expect(input(run8World({ eyeThrows: [] }), NOW)).not.toContain('目玉を');
  });
});

describe('(4b) a where with a dimension still reads as its coordinates', () => {
  it('readWhere and goalOf read the leading point and ignore the word; the dimension is not read (a Nether where is walked to as written)', () => {
    expect(readWhere('177,63,-398（ネザー）')).toEqual({ x: 177, y: 63, z: -398 });
    expect(readWhere('(196,-34,-244)（現世）', 'any')).toEqual({ x: 196, y: -34, z: -244 });
    expect(readWhere('196,-34,-244（現世） 荒廃したポータル', 'goal')).toEqual({ x: 196, y: -34, z: -244 });
    expect(goalOf({ where: '177,63,-398（ネザー）', doneWhen: 'at:177,63,-398~6@the_nether' })).toEqual({ at: { x: 177, y: 63, z: -398 }, range: 6 });
    expect(doneRange('at:1,2,3~4')).toBe(4);
  });
});

describe('(5) the default plan\'s tool nodes read the tiers above them', () => {
  const tree = seedPlan(GOAL)!;
  const idOf = (title: string) => tree.nodes.find(node => node.title.startsWith(title))!.id;
  const doneIds = (world: Record<string, unknown>) => seenDoneUpdate(tree, frame(world))?.ids ?? [];
  it('a new world (an empty pack) leaves the pickaxe, the stone tools and the iron open', () => {
    const done = doneIds({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [], food: 20, health: 20 });
    for (const title of ['作業台と木のツルハシ', '丸石で石のツルハシ・斧・剣', '鉄（約30', '最初の鉄3を焼いて鉄のツルハシ']) expect(done, title).not.toContain(idOf(title));
  });
  it('a wooden or a golden pickaxe alone does not pass the stone tools or the iron stage (no `have:pickaxe`)', () => {
    for (const name of ['wooden_pickaxe', 'golden_pickaxe']) {
      const done = doneIds({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [stack(name, 1)], food: 20, health: 20 });
      expect(done, name).not.toContain(idOf('丸石で石のツルハシ・斧・剣'));
      expect(done, name).not.toContain(idOf('最初の鉄3を焼いて鉄のツルハシ'));
      expect(done, name).not.toContain(idOf('鉄（約30'));
    }
  });
  it('run 8\'s pack (diamond pickaxe, iron sword, stone axe): the pickaxe node, the stone tools and the first iron are done; the iron top is not (no shield in the pack yet)', () => {
    const done = doneIds(run8World());
    expect(done).toContain(idOf('作業台と木のツルハシ'));
    expect(done).toContain(idOf('丸石で石のツルハシ・斧・剣'));
    expect(done).toContain(idOf('最初の鉄3を焼いて鉄のツルハシ'));
    const withShield = doneIds(run8World({ inventory: [...run8Pack, stack('shield', 1)] }));
    expect(withShield).toContain(idOf('鉄（約30'));
  });
  it('an iron pickaxe closes the pickaxe node and the stone tools too, and a stone set closes the stone tools', () => {
    const iron = doneIds({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [stack('iron_pickaxe', 1)], food: 20, health: 20 });
    expect(iron).toContain(idOf('作業台と木のツルハシ'));
    expect(iron).toContain(idOf('丸石で石のツルハシ・斧・剣'));
    const stone = doneIds({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [stack('stone_pickaxe', 1), stack('stone_axe', 1), stack('stone_sword', 1)], food: 20, health: 20 });
    expect(stone).toContain(idOf('丸石で石のツルハシ・斧・剣'));
    expect(stone).not.toContain(idOf('鉄（約30'));
  });
  it('the iron top node keeps its title and the edited condition (the seed is picked by its condition)', () => {
    const top = tree.nodes.find(node => node.kind === 'iron' && node.parentId === null)!;
    expect(top.title).toBe('鉄（約30・剣・盾・バケツまで）');
    expect(top.doneWhen).toBe('have:iron_pickaxe&have:iron_sword&have:shield&have:bucket|have:diamond_pickaxe&have:iron_sword&have:shield&have:bucket');
    expect(top.doneWhen!.length).toBeLessThanOrEqual(120);
  });
});

describe('strongholdFirst is not made stronger (the old drop stays as it was)', () => {
  it('still drops the stages that make eyes and keeps the rest in the order written', () => {
    const answer = { nodes: [{ id: 'p1', parent: '', title: 'a', kind: 'village' }, { id: 'p2', parent: '', title: 'b', kind: 'obsidian' }, { id: 'p3', parent: '', title: 'c', kind: 'stronghold' }] };
    const kept = (strongholdFirst(answer, 11) as { nodes: Array<{ id: string }> }).nodes.map(node => node.id);
    expect(kept).toEqual(['p1', 'p3']);
  });
});
