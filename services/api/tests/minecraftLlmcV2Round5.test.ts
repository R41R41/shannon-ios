import { describe, expect, it } from 'vitest';
import { applyPlanUpdate, orderedPlan, planPath, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { gateFirst, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { heldBeforeSend } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { liquidLines, useReachStop } from '../src/surfaces/minecraft/minecraftLlmcLiquid.js';
import { packFacts, packLines } from '../src/surfaces/minecraft/minecraftLlmcPack.js';
import { mapView, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { preparationShortage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { rewriteLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';
import { GATE_FIRST_KNOWLEDGE, ownFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { closedUnder, doneFacts, seenDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import run36Plan from './fixtures/minecraft-run36-plan-v1.json' with { type: 'json' };

/**
 * SHANNON_MINECRAFT_LLMC_V2, the fifth round (run 36, task 40bd0b3e: death 0 and stop 0, the fastest start so far, but the Nether not reached in
 * 1,683 s): the obsidian made in a passage the water floods (liquid facts and the bucket's use held when out of reach or out of sight), the gate's
 * check cut down to what the gate needs, the children of a parent done by the pack closed with the reason, the pack's free slots.
 * The obsidian scene is built from the acts and results of the run (task 40bd0b3e, +1216…+1500 s: seq 1782–1796): the lava source (253,-24,209),
 * the stair she dug at z=204 and x=248, the water placed at (251,-24,208) that ran into the passage (flow 5 at (248,-24,206) and (251,-24,204)).
 */
type Cell = { x: number; y: number; z: number };
const at = (x: number, y: number, z: number): Cell => ({ x, y, z });
const FEET = at(248, -24, 204);
/** x=245..255 z=202..212, y=-25..-22: rock, the stair she dug, water (w source, - flow) and the lava source (L). Feet (248,-24,204). */
function obsidianMap(options: { feet?: Cell; open?: string[]; liquids?: boolean } = {}): string {
  const feet = options.feet ?? FEET;
  const air = new Set(['248,-24,204', '248,-24,205', '248,-24,206', '248,-23,205', '248,-23,206', '248,-24,207', '248,-23,207', '249,-24,207', '249,-23,207',
    '250,-24,207', '250,-23,207', '251,-24,207', '251,-23,207', '248,-23,204', '248,-22,204', ...options.open ?? []]);
  const sym = new Map<string, string>([['251,-24,208', 'w'], ['248,-24,206', '-'], ['251,-24,207', '-'], ['250,-24,207', '-'], ['253,-24,209', 'L'],
    ['252,-24,209', 'L'], ['251,-24,204', '-']]);
  if (options.liquids === false) sym.clear();
  const lines = [`地図 v1 足=(${feet.x},${feet.y},${feet.z}) x=245..255 z=202..212 方式=layers 上=北`];
  for (let y = -22; y >= -25; y -= 1) {
    lines.push(y === -22 ? `y=${y} x=245..255 z=202..212` : `y=${y}`);
    for (let z = 202; z <= 212; z += 1) {
      const row: string[] = [];
      for (let x = 245; x <= 255; x += 1) {
        const key = `${x},${y},${z}`;
        row.push(x === feet.x && y === feet.y && z === feet.z ? '@' : sym.get(key) ?? (air.has(key) ? '.' : '#'));
      }
      lines.push(` ${z} ${row.join(' ')}`);
    }
  }
  return lines.join('\n');
}
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });
const obsidianFrame = () => frame({ localMap: obsidianMap(), position: { x: 248.5, y: -24, z: 204.5 }, dimension: 'overworld' });
const view = () => mapView(readLayers(obsidianMap())!);
const bucket = (x: number, y: number, z: number, item = 'bucket') => ({ do: 'use', item, at: [at(x, y, z)] });
const walk = (x: number, y: number, z: number) => ({ do: 'walk', to: at(x, y, z) });

describe('the obsidian scene: water, lava and the bucket', () => {
  it('says the water sources and flows, the lava and what a dig in water costs, with each source\'s distance from the eye and whether it is reached', () => {
    const text = liquidLines(view(), FEET).join('\n');
    expect(text).toContain('水: 源 1 マス・流れ 4 マス');
    expect(text).toContain('水中のマスの dig は 1 マス 6 秒ほど');
    expect(text).toMatch(/水の源（汲み戻せる）: \(251,-24,208\) 目から 5\.\dm・届かない（5m まで）/u);
    expect(text).toContain('溶岩: 源 2 マス・流れ 0 マス。近い源: ');
    expect(text).toContain('(252,-24,209)');
  });
  it('says nothing when the map shows no water, lava or obsidian near', () => {
    expect(liquidLines(mapView(readLayers(obsidianMap({ liquids: false }))!), FEET)).toEqual([]);
  });
  it('is `body.liquid` and `body.pack` in the rewritten live state, and nothing is added without them', () => {
    const body = { map: obsidianMap(), state: { at: '(248,-24,204)', dimension: 'overworld' }, planNow: '[p7.2] 黒曜石', inventory: ['cobblestone×64', 'dirt×4'] };
    const { live, notes } = rewriteLlmcLive({ body, plan: {} });
    const out = live.body as Record<string, unknown>;
    expect((out.liquid as string[])[0]).toContain('水: 源 1 マス');
    expect((out.pack as string[])[0]).toContain('持ち物の空き 34 マス');
    expect(notes.added).toEqual(expect.arrayContaining(['liquid', 'pack']));
    const bare = rewriteLlmcLive({ body: { map: undefined, state: {}, inventory: [] }, plan: {} }).live.body as Record<string, unknown>;
    expect(bare.liquid).toBeUndefined();
    expect(bare.pack).toBeUndefined();
  });
  it('holds a bucket\'s use at a source out of reach (5.1 m from the eye, run 36 seq 1787), naming the distance, before it is sent', () => {
    const stop = useReachStop({ hands: [bucket(251, -24, 208)] }, obsidianFrame())!;
    expect(stop).toMatchObject({ hand: 1, kind: 'use', code: 'use_reach' });
    expect(stop.line).toContain('(251,-24,208)');
    expect(stop.line).toMatch(/目から 5\.\dm（dig・place・use は 5m まで）/u);
  });
  it('holds it when a hard block stands between the eye and the source after a walk (seq 1789: 目との間の (249,-23,205) が deepslate)', () => {
    const stop = useReachStop({ hands: [walk(248, -24, 205), bucket(251, -24, 208)] }, obsidianFrame())!;
    expect(stop).toMatchObject({ hand: 2, kind: 'use', code: 'use_blocked' });
    expect(stop.line).toMatch(/線の間に \(\d+,-?\d+,\d+\) # 石の類 がある/u);
  });
  it('lets a use go that is within reach with a clear line, and a use after a dig, a place or a loose walk (not judged from here)', () => {
    // Standing at (251,-24,207) with (251,-23,208) opened (run 36 seq 1785 dug it): one block from the source, a clear line.
    const nearFrame = frame({ localMap: obsidianMap({ feet: at(251, -24, 207), open: ['251,-23,208'] }), position: { x: 251.5, y: -24, z: 207.5 }, dimension: 'overworld' });
    expect(useReachStop({ hands: [bucket(251, -24, 208)] }, nearFrame)).toBeNull();
    expect(useReachStop({ hands: [{ do: 'dig', at: [at(249, -24, 205)] }, bucket(251, -24, 208)] }, obsidianFrame())).toBeNull();
    expect(useReachStop({ hands: [{ do: 'walk', to: at(250, -24, 207), range: 2 }, bucket(251, -24, 208)] }, obsidianFrame())).toBeNull();
    expect(useReachStop({ hands: [{ do: 'use', item: 'flint_and_steel', at: [at(251, -24, 208)] }] }, obsidianFrame())).toBeNull();
  });
  it('goes through the part-send: the hands before the held use are sent, and it is not held when the mode is off', () => {
    const act = { hands: [{ do: 'equip', item: 'bucket' }, bucket(251, -24, 208), { do: 'wait', seconds: 2 }], why: '[p7.2] 汲み戻す' };
    const held = heldBeforeSend({ preflight: true, v2: true }, act, obsidianFrame(), 't')!;
    expect((held.input as { hands: unknown[] }).hands).toHaveLength(1);
    expect(held.tail).toContain('手 2 use');
    expect(heldBeforeSend({ preflight: true }, act, obsidianFrame(), 't')).toBeNull();
  });
});

describe('the pack: free slots and the filler that fills them (run 36, y=76 → -9 by a stair)', () => {
  const FULL = ['cobblestone×64', 'cobblestone×57', 'diorite×64', 'diorite×1', 'cobbled_deepslate×64', 'cobbled_deepslate×64', 'cobbled_deepslate×26', 'dirt×40',
    'iron_pickaxe×1(耐久130/250)', 'bread×6', 'sweet_berries×6', 'water_bucket×1', 'ほか20件（長いため略）'];
  it('counts a stack a slot, adds the omitted ones, and keeps a pack of 36', () => {
    expect(packFacts(FULL).used).toBe(12 + 20);
    expect(packLines(FULL)[0]).toBe('持ち物の空き 4 マス（使用 32/36。満杯だと dig・pickup が「満杯」で止まる）');
    expect(packLines(['dirt×4'])[0]).toContain('空き 35 マス');
    expect(packLines([])).toEqual([]);
  });
  it('names the filler that takes three slots or more, biggest first, and the dig hand\'s collect=false', () => {
    const second = packLines(FULL)[1]!;
    expect(second).toContain('掘って拾い続けた石や土 380 個');
    expect(second.indexOf('cobbled_deepslate×154')).toBeLessThan(second.indexOf('cobblestone×121'));
    expect(second).toContain('collect=false');
    expect(packLines(['cobblestone×64', 'dirt×10'])).toHaveLength(1);
  });
});

describe('the plan tree of run 36 (task 40bd0b3e, revision 21): children left open under a parent done by the pack', () => {
  const tree = run36Plan as unknown as PlanTree;
  /** The tree at the start: only what run 36 had done by the first minute is done (p1.1); the rest open, as the first plan wrote it. */
  const start = (): PlanTree => ({ ...tree, current: 'p1.1', nodes: tree.nodes.map(node => ({ ...node, state: node.id === 'p1.1' ? 'done' as const : 'continue' as const })) });
  const pack = (items: Array<[string, number]>) => frame({ dimension: 'overworld', position: at(141, 75, 204), food: 20, inventory: items.map(([name, count]) => ({ name, count })) });
  const stateOf = (result: PlanTree, id: string) => result.nodes.find(node => node.id === id)!;
  it('was: p1 done by `have:bed>=3` with 村の箱 and 鍛冶屋の箱 still `continue` (the fault of the run)', () => {
    const seen = seenDoneUpdate(start(), pack([['red_bed', 1], ['blue_bed', 1], ['purple_bed', 1]]))!;
    expect(seen.ids).toEqual(['p1', 'p1.2', 'p13']);
    const after = applyPlanUpdate(start(), seen.update).tree;
    expect(stateOf(after, 'p1').state).toBe('done');
    expect(['p1.3', 'p1.4'].map(id => stateOf(after, id).state)).toEqual(['continue', 'continue']);
  });
  it('is: in the mode the two boxes are closed done with the reason in their note, and the parent stays done', () => {
    const seen = seenDoneUpdate(start(), pack([['red_bed', 1], ['blue_bed', 1], ['purple_bed', 1]]), true)!;
    expect(seen.ids).toEqual(['p1', 'p1.2', 'p1.3', 'p1.4']);
    expect(seen.closed).toEqual(['p1.3←p1', 'p1.4←p1']);
    const after = applyPlanUpdate(start(), seen.update).tree;
    expect(['p1', 'p1.3', 'p1.4'].map(id => stateOf(after, id).state)).toEqual(['done', 'done', 'done']);
    expect(stateOf(after, 'p1.3').note).toBe('不要になった（p1 が済んだ: have:bed>=3）');
    expect(after.current).not.toBe('p1.3');
  });
  it('closes the iron under p4 (`have:iron_chestplate` from the village box): 洞窟で鉄鉱石を掘る・鉄を焼く', () => {
    const base = start();
    const seen = seenDoneUpdate(base, pack([['iron_chestplate', 1]]), true)!;
    expect(seen.ids).toContain('p4');
    expect(seen.closed).toEqual(expect.arrayContaining(['p4.1←p4', 'p4.2←p4']));
    const after = applyPlanUpdate(base, seen.update).tree;
    expect(planPath(after).done).toMatch(/^\d+\/41$/u);
    expect([stateOf(after, 'p4.1').state, stateOf(after, 'p4.2').state]).toEqual(['done', 'done']);
  });
  it('closes the open children of a node that was done earlier too, never a blocked one, and nothing when no parent is done', () => {
    const done: PlanTree = { ...start(), nodes: start().nodes.map(node => node.id === 'p1' ? { ...node, state: 'done' as const } : node.id === 'p1.4' ? { ...node, state: 'blocked' as const } : node) };
    expect(closedUnder(done, []).filter(item => item.by === 'p1').map(item => item.id)).toEqual(['p1.2', 'p1.3']);
    expect(closedUnder(start(), [])).toEqual([]);
    expect(orderedPlan(done.nodes).length).toBe(41);
  });
  it('reads the end of the run as it was: p7.2 the obsidian is current, p8 and p9 are not started (the facts the closing leaves alone)', () => {
    const facts = doneFacts(pack([['obsidian', 7]]));
    expect(tree.current).toBe('p7.2');
    expect(facts!.counts.get('obsidian')).toBe(7);
    expect(tree.nodes.filter((node: PlanNode) => node.state === 'continue' && node.parentId === 'p1').map(node => node.id)).toEqual(['p1.3', 'p1.4']);
  });
});

describe('the gate\'s check cut down: the Nether within 30 minutes', () => {
  const owned = (items: Array<[string, number]>) => carriedItemCounts({ inventory: items.map(([name, count]) => ({ name, count })) }, {});
  const GEAR: Array<[string, number]> = [['shield', 1], ['stone_sword', 1], ['iron_pickaxe', 1], ['cobblestone', 64]];
  it('the entry\'s shortage asks 40 points of food and a pickaxe, a shield, a sword and blocks; not 100 points, the armour or the water bucket', () => {
    const parts = { dimension: 'overworld', counts: owned(GEAR), food: 48, nowTitle: '黒曜石を作る' };
    expect(preparationShortage({ ...parts, v2: true })).toBeNull();
    expect(preparationShortage(parts)).toContain('食料 48 点（目安 100）');
    expect(preparationShortage({ ...parts, v2: true, food: 24 })).toBe('準備の不足（ネザーに入る前）: 食料 24 点（目安 40）');
    expect(preparationShortage({ ...parts, v2: true, counts: owned([['stone_sword', 1]]) })).toContain('盾・鉄以上のツルハシ・足場のブロックが無い');
  });
  it('the check inside the Nether is as it was (the table, slabs, gold armour and food 100 before the fortress)', () => {
    const nether = { dimension: 'the_nether', counts: owned([['shield', 1]]), food: 48, nowTitle: '要塞を探す' };
    expect(preparationShortage({ ...nether, v2: true })).toBe(preparationShortage(nether));
    expect(preparationShortage(nether)).toContain('食料 48 点（目安 100）');
  });
  it('the seed plan has no food 100 before the gate and one or two beds from the village; off it is the seed as it was', () => {
    const titles = (tree: PlanTree) => tree.nodes.map(node => `${node.title}|${node.doneWhen ?? ''}`);
    const off = seedPlan('エンドラを倒して')!, on = seedPlan('エンドラを倒して', null, true)!;
    expect(titles(off)).toContain('食料100点以上に足す|food>=100');
    expect(titles(on).some(line => line.includes('食料100点以上に足す'))).toBe(false);
    expect(titles(on)).toContain('村を回る（ベッド1〜2・干し草・畑・箱）|');
    expect(titles(off)).toContain('村を回る（ベッド全部・干し草・畑・箱）|');
    expect(on.nodes.length).toBe(off.nodes.length - 2);
    expect(titles(seedPlan('エンドラを倒して', null, false)!)).toEqual(titles(off));
    expect(titles(on).some(line => line.startsWith('出発の点検（ネザーの奥へ）'))).toBe(true);
    expect(gateFirst([]).length).toBe(0);
  });
  it('the first plan\'s words, with the mode: the gate\'s side and the Nether\'s side of the check, and the beds', () => {
    const on = ownFirstPlanSystem(true), off = ownFirstPlanSystem();
    expect(on).toContain(GATE_FIRST_KNOWLEDGE);
    expect(off).not.toContain('ゲートの前と後');
    expect(on.startsWith(off)).toBe(true);
    expect(GATE_FIRST_KNOWLEDGE).toContain('出発の点検（作業台・ハーフブロック 12・金の防具・食料 100 点）は、ネザーに入った後の節');
    expect(GATE_FIRST_KNOWLEDGE).toContain('要塞（ネザーの奥）へ行く前に済ませる順は変えない');
    expect(GATE_FIRST_KNOWLEDGE).toContain('ベッドは村で見つけた 1〜2 つでよい');
  });
});
