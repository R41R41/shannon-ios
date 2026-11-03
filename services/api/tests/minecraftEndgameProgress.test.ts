import { describe, expect, it } from 'vitest';
import type { PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { firstStretch, meterLine, reachedMilestoneNames } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { seenDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanDone.js';

/**
 * The seed of the way past the Nether, walked through with the frames a run would show, in the plan machinery the live run uses (the tool's
 * `seen` hook: `seenDoneUpdate`): each node closes by its own condition, in order, and the current node follows without a stall.
 * IDs are those of a dragon task begun in the Nether (the seed of that place).
 */
/** A frame; the End fight, when given, sits directly in the world as the body sends it. */
const frame = (world: object, fight?: object): BodyObservation => ({ connected: true, state: { world: { ...world, ...fight } }, facts: {}, bodyId: 'b', sequence: 1,
  stateAt: new Date(0).toISOString() }) as unknown as BodyObservation;
const items = (record: Record<string, number>) => Object.entries(record).map(([name, count]) => ({ name, count }));

describe('walking the late-game seed with the frames of a run', () => {
  const seed = seedPlan('エンドラを討伐して', 'the_nether')!;
  let now: BodyObservation = frame({});
  const plan = createFcaPlanTools({ taskId: 'progress', checkpoint: { fcaPlanTree: seed }, rules: true, seen: held => seenDoneUpdate(held, now) });
  const at = (world: object, fight?: object): PlanTree => {
    now = frame(world, fight);
    plan.port.view();
    return plan.port.tree();
  };
  const state = (tree: PlanTree, id: string) => tree.nodes.find(node => node.id === id)?.state;
  const kit = { crafting_table: 1, shield: 1, oak_slab: 12, golden_boots: 1, cooked_beef: 6 };

  it('starts at the check before the Nether\'s depth, and the later nodes need their own observations', () => {
    expect(seed.nodes.filter(node => node.parentId === null).map(node => node.title)).toEqual(['出発の点検（ネザーの奥へ）', 'ネザー要塞を探す', 'ブレイズロッド7以上',
      'エンダーパール14以上', 'エンダーアイ14個', 'オーバーワールドへ戻る', '出発の点検（エンドへ）', 'ストロングホールド', 'エンドに入る', 'エンドでドラゴン']);
    // a fortress in view before the check is not the fortress node yet: the check comes first
    const early = at({ dimension: 'the_nether', position: { x: 0, y: 64, z: 0 }, inventory: items({ cooked_beef: 2 }), mapLandmarks: ['N ネザー要塞 (10,64,10) 北10m レンガ×9'] });
    expect(state(early, 'p2')).toBe('continue');
    expect(early.current).toBe('p1.1');
  });

  it('closes the nodes one after another as the run reaches them, and the current node moves on each time', () => {
    const food = { cooked_beef: 20 };
    let tree = at({ dimension: 'the_nether', position: { x: 0, y: 64, z: 0 }, inventory: items({ ...kit, ...food }), mapLandmarks: [] });
    expect(state(tree, 'p1')).toBe('done');
    expect(tree.current).toBe('p2');
    tree = at({ dimension: 'the_nether', position: { x: 100, y: 64, z: 0 }, inventory: items({ ...kit, ...food }), mapLandmarks: ['N ネザー要塞 (110,64,0) 東10m レンガ×30'] });
    expect(state(tree, 'p2')).toBe('done');
    expect(tree.current).toBe('p3.1');
    // 3 rods and 2 powder (one more rod's worth), then 6 and 2 (seven rods in all): the node counts what the work made
    tree = at({ dimension: 'the_nether', position: { x: 110, y: 64, z: 0 }, inventory: items({ ...kit, ...food, blaze_rod: 3, blaze_powder: 2 }), mapLandmarks: [] });
    expect(state(tree, 'p3')).toBe('continue');
    tree = at({ dimension: 'the_nether', position: { x: 110, y: 64, z: 0 }, inventory: items({ ...kit, ...food, blaze_rod: 6, blaze_powder: 2 }), mapLandmarks: [] });
    expect(state(tree, 'p3')).toBe('done');
    expect(['p3.1', 'p3.2', 'p3.3'].map(id => state(tree, id))).toEqual(['done', 'done', 'done']);
    expect(tree.current).toBe('p4.1');
    tree = at({ dimension: 'the_nether', position: { x: 0, y: 70, z: 0 }, inventory: items({ ...kit, ...food, blaze_rod: 7, ender_pearl: 14 }), mapLandmarks: [] });
    expect(state(tree, 'p4')).toBe('done');
    expect(tree.current).toBe('p5.1');
    // the pearls became eyes: the eye node closes by the eyes, its open child as no longer needed
    tree = at({ dimension: 'the_nether', position: { x: 0, y: 70, z: 0 }, inventory: items({ ...kit, ...food, blaze_powder: 2, ender_eye: 14 }), mapLandmarks: [] });
    expect(state(tree, 'p5')).toBe('done');
    expect(state(tree, 'p5.1')).toBe('done');
    expect(tree.current).toBe('p6');
    // back in the overworld
    tree = at({ dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, inventory: items({ ender_eye: 12, cooked_beef: 20 }), mapLandmarks: [] });
    expect(state(tree, 'p6')).toBe('done');
    expect(tree.current).toBe('p7.1');
    tree = at({ dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, inventory: items({ ender_eye: 12, cooked_beef: 20, white_bed: 4, bow: 1, arrow: 40 }), mapLandmarks: [] });
    expect(state(tree, 'p7')).toBe('done');
    expect(tree.current).toBe('p8.1');
    // far from the room nothing of the stronghold closes; at the room the frames close its first node
    tree = at({ dimension: 'overworld', position: { x: 600, y: 70, z: -1800 }, inventory: items({ ender_eye: 11, white_bed: 4, bow: 1, arrow: 40 }), mapLandmarks: [] });
    expect(state(tree, 'p8.1')).toBe('continue');
    tree = at({ dimension: 'overworld', position: { x: 700, y: 25, z: -1893 }, inside: 'ストロングホールドの中', inventory: items({ ender_eye: 11, white_bed: 4, bow: 1, arrow: 40 }),
      mapLandmarks: ['Q エンドポータルの枠 (703,26,-1899) 北6m ×12 アイ入り 2'] });
    expect(state(tree, 'p8.1')).toBe('done');
    expect(tree.current).toBe('p8.2');
    tree = at({ dimension: 'overworld', position: { x: 703, y: 27, z: -1896 }, inventory: items({ white_bed: 4, bow: 1, arrow: 40 }),
      mapLandmarks: ['Q エンドポータルの枠 (703,26,-1899) 北3m ×12 アイ入り 12', 'e エンドポータル (703,26,-1898) 北2m'] });
    expect(state(tree, 'p8.2')).toBe('done');
    expect(state(tree, 'p8')).toBe('done');
    expect(tree.current).toBe('p9');
    // the End: entering closes its node; the crystals close theirs when the body says none are left; the dragon's node stays open
    tree = at({ dimension: 'the_end', position: { x: 100, y: 49, z: 0 }, inventory: items({ white_bed: 4, bow: 1, arrow: 40 }), mapLandmarks: [] }, { crystals: { remaining: 10 } });
    expect(state(tree, 'p9')).toBe('done');
    expect(tree.current).toBe('p10.1');
    tree = at({ dimension: 'the_end', position: { x: 20, y: 64, z: 0 }, inventory: items({ white_bed: 4, bow: 1, arrow: 20 }), mapLandmarks: [] }, { crystals: { remaining: 4 } });
    expect(state(tree, 'p10.1')).toBe('continue');
    tree = at({ dimension: 'the_end', position: { x: 20, y: 64, z: 0 }, inventory: items({ white_bed: 4, bow: 1, arrow: 10 }), mapLandmarks: [] }, { crystals: { remaining: 0 } });
    expect(state(tree, 'p10.1')).toBe('done');
    expect(state(tree, 'p10')).toBe('continue');
    expect(tree.current).toBe('p10.2');
  });

  it('keeps the meter on the later milestones: the next target after the Nether is the fortress, then the rods, and so on', () => {
    const dragon = { ...seedPlan('エンドラを討伐して')!, current: 'p9' };
    const nether = frame({ dimension: 'the_nether', position: { x: 0, y: 64, z: 0 }, inventory: [], mapLandmarks: [] });
    expect(meterLine(dragon, nether, 1_900 / 60)).toContain('次の節目 ネザー要塞 目安 3,200 秒');
    const fortress = frame({ dimension: 'the_nether', position: { x: 0, y: 64, z: 0 }, inventory: items({ cooked_beef: 4 }), mapLandmarks: ['N ネザー要塞 (10,64,0) 東10m レンガ×30'] });
    expect(meterLine(dragon, fortress, 2_000 / 60)).toContain('次の節目 ブレイズロッド 7 本 目安 4,700 秒');
  });

  it('gives the held diagnostic run only the first stretch of the road: a fortress coming into view past the Nether is not its progress', () => {
    const dragon = { ...seedPlan('エンドラを討伐して')!, current: 'p9' };
    const nether = frame({ dimension: 'the_nether', position: { x: 0, y: 64, z: 0 }, inventory: [], mapLandmarks: [] });
    const fortress = frame({ dimension: 'the_nether', position: { x: 0, y: 64, z: 0 }, inventory: items({ cooked_beef: 4 }), mapLandmarks: ['N ネザー要塞 (10,64,0) 東10m レンガ×30'] });
    expect(firstStretch(dragon, nether).next).toBeNull();
    expect(firstStretch(dragon, fortress).next).toBeNull();
    expect(firstStretch(dragon, fortress).reached).toContain('ネザー');
    expect(firstStretch(dragon, fortress).reached).not.toContain('ネザー要塞');
    // the unheld look still sees the fortress as the road moving on
    expect(reachedMilestoneNames(dragon, fortress)).toContain('ネザー要塞');
    expect(firstStretch(null, fortress)).toEqual({ next: null, reached: [] });
  });
});
