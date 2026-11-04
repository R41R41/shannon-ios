import { beforeEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { BLAZE_HOLDS, BLAZE_WINDOW_MS, blazeFightHold, forgetBlazeHolds } from '../src/surfaces/minecraft/minecraftLlmcBlazeHold.js';
import { deadlyGateHold } from '../src/surfaces/minecraft/minecraftLlmcDeadlyGates.js';
import { heldOfFrame, sentPart } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { readinessOf } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';

const pick = 'iron_pickaxe×1(耐久50/250)';
const kit = [pick, 'shield×1(耐久61/336)', 'cooked_beef×20', 'iron_sword×1'];
const spawner = { x: 140, y: 77, z: 75 };
const blaze = (id: number, extra: Record<string, unknown> = {}) => ({ id, name: 'blaze', distance: 8, reach: 'in_sight', ...extra });
const frame = (extra: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1,
  connected: true, stateAt: 't', receivedAt: 't', facts: {}, state: { world: { dimension: 'the_nether', position: spawner,
    health: 20, food: 20, inventory: kit, nearbyThreats: [blaze(1)], mapLandmarks: ['S ブレイズの湧き場 (140,77,75)'], ...extra } as never } });
const act = (kind = 'fight', target = 'blaze') => ({ hands: [{ do: 'eat', item: 'cooked_beef' }, { do: kind, target }] });
const hold = (extra: Record<string, unknown> = {}, kind = 'fight', target = 'blaze') => deadlyGateHold(act(kind, target), frame(extra), 'blaze-test');

beforeEach(forgetBlazeHolds);

describe('run62 #8: each blaze combat hand', () => {
  it('holds fight, attack and shoot while a blaze is already near, including ids from raw body threats', () => {
    for (const kind of ['fight', 'attack', 'shoot']) {
      const stopped = hold({ inventory: kit.slice(1) }, kind, '#1');
      expect(stopped).toMatchObject({ hand: 2, kind });
      expect(stopped!.line).toContain('ツルハシ 0（掘って退く道も使えない）');
      expect(stopped!.line).toContain('湧き場 (140,77,75) から 17m 以上離れた岩の壁の陰');
      expect(stopped!.line).toContain('経路と遮蔽は地図・around で確認');
    }
  });

  it('names the spawner from the local map when no landmark has been remembered', () => {
    const localMap = ['地図 v1 足=(140,77,75) x=139..141 z=74..76 方式=cube',
      'y=77 x=139..141 z=74..76', '74 . . .', '75 . S .', '76 . . .'].join('\n');
    expect(hold({ localMap, mapLandmarks: [], onFire: true })?.line).toContain('湧き場 (140,77,75) から 17m 以上');
    expect(hold({ mapLandmarks: [], onFire: true })?.line).toContain('座標未確認');
  });

  it('keeps the first-entry requirements and the completed-rods hold', () => {
    expect(hold({ health: 19, nearbyThreats: [] })?.line).toContain('体力 19/20');
    expect(hold({ inventory: [...kit, 'blaze_rod×7'], onFire: true })?.kind).toBe('rods');
  });

  it('holds below 20% wear, permits exactly 20%, a usable spare, and unmeasured wear', () => {
    expect(hold()).toBeNull();
    const low = ['iron_pickaxe×1(耐久49/250)', ...kit.slice(1)];
    expect(hold({ inventory: low })?.line).toContain('ツルハシの耐久がすべて 2 割未満');
    expect(hold({ inventory: [...low, 'stone_pickaxe×1(耐久27/131)'] })).toBeNull();
    expect(hold({ inventory: [...low, 'stone_pickaxe×1'] })).toBeNull();
    expect(hold({ inventory: [{ name: 'iron_pickaxe', count: 1, durability: { left: 2, max: 250 } }, ...kit.slice(1)] })?.line)
      .toContain('ツルハシの耐久がすべて 2 割未満');
  });

  it('reads active shield wear from worn and counts a spare once, preserving the 30-wear retreat sign', () => {
    const inventory = [pick, 'cooked_beef×20', 'iron_sword×1'];
    const worn = '左手: shield(残り60/336)';
    expect(hold({ inventory, worn })?.line).toContain('盾の耐久 60（60 以下）・予備の盾なし');
    expect(hold({ inventory: [...inventory, 'shield×1(耐久336/336)'], worn })).toBeNull();
    expect(hold({ inventory: [...inventory, 'shield×1'], worn: '左手: shield(残り30/336)' })?.line).toContain('退く合図の 30 以下');
    expect(hold({ inventory: [pick, 'shield×1(耐久60/336)', 'cooked_beef×20'] })?.line).toContain('予備の盾なし');
    expect(hold({ inventory: [pick, 'shield×1', 'cooked_beef×20'] })).toBeNull();
  });

  it('counts only visible blazes, with ids deduplicated across raw threats and live lines', () => {
    const threats = ['#1 blaze 8.0m・見える（射線の中）', '#2 blaze 9.0m・見える（射線の中）',
      '#3 blaze 10.0m・見える（射線の中）'];
    expect(hold({ threats, urgent: threats })?.line).toContain('射線の中のブレイズ 3 体');
    expect(hold({ nearbyThreats: [blaze(1), blaze(2), blaze(3)] })?.line).toContain('射線の中のブレイズ 3 体');
    expect(hold({ nearbyThreats: [blaze(1), blaze(2), blaze(3, { reach: 'walled', canSee: false })] })).toBeNull();
    expect(hold({ nearbyThreats: [blaze(1), blaze(1), blaze(2)] })).toBeNull();
  });

  it('holds burning even above 12 health and keeps the existing health and meat retreat signs', () => {
    expect(hold({ onFire: true, health: 20 })?.line).toContain('燃えている');
    expect(hold({ onFire: false })).toBeNull();
    expect(hold({ health: 8 })?.line).toContain('退く合図の 8 以下');
    expect(hold({ inventory: [pick, 'shield×1', 'cooked_beef×3'] })?.line).toContain('肉が残り 3 個');
  });

  it('leaves retreat, cover, eating, other foes and other dimensions available', () => {
    expect(hold({ onFire: true }, 'fight', 'wither_skeleton')).toBeNull();
    expect(hold({ dimension: 'overworld', onFire: true })).toBeNull();
    for (const hand of [{ do: 'go', to: { x: 160, y: 77, z: 75 } }, { do: 'eat' }, { do: 'place', block: 'cobblestone' }]) {
      expect(deadlyGateHold({ hands: [hand] }, frame({ inventory: [], onFire: true }), 'retreat')).toBeNull();
    }
  });
});

describe('the bounded hold before send', () => {
  it('counts only committed holds and renews at ten minutes, separately by task and known spawner', () => {
    let clock = 0;
    const facts = readinessOf(frame({ onFire: true }))!;
    const next = (task = 'one', site = spawner) => blazeFightHold(act(), facts, [site], task, () => clock);
    for (let i = 0; i < 5; i += 1) expect(next()).not.toBeNull();
    for (let i = 0; i < BLAZE_HOLDS; i += 1) next()!.commit();
    expect(next()).toBeNull();
    const withoutMark = readinessOf(frame({ onFire: true, mapLandmarks: [] }))!;
    expect(blazeFightHold(act(), withoutMark, [], 'one', () => clock)).toBeNull();
    expect(next('two')).not.toBeNull();
    // Without a conflicting map mark, another known camp gets its own window.
    const elsewhere = readinessOf(frame({ onFire: true, mapLandmarks: [], position: { x: 240, y: 77, z: 75 } }))!;
    expect(blazeFightHold(act(), elsewhere, [{ x: 240, y: 77, z: 75 }], 'one', () => clock)).not.toBeNull();
    clock = BLAZE_WINDOW_MS - 1;
    expect(next()).toBeNull();
    clock += 1;
    expect(next()).not.toBeNull();
  });

  it('commits through heldOfFrame and sends the earlier hands unchanged', () => {
    const observation = frame({ onFire: true });
    for (let i = 0; i < BLAZE_HOLDS; i += 1) {
      const held = heldOfFrame(act(), observation, 'partial-blaze');
      expect(held).toMatchObject({ hand: 2, code: 'gate_required', kind: 'fight' });
      expect(sentPart(act(), held!)).toEqual({ hands: [act().hands[0]] });
    }
    expect(heldOfFrame(act(), observation, 'partial-blaze')).toBeNull();
  });

  it('does not consume a blaze slot when an earlier guard stops work', () => {
    const observation = frame({ health: 5, onFire: true });
    const workFirst = { hands: [{ do: 'mine', block: 'netherrack' }, { do: 'fight', target: 'blaze' }] };
    for (let i = 0; i < 5; i += 1) expect(heldOfFrame(workFirst, observation, 'earlier')?.kind).toBe('work');
    expect(heldOfFrame(act(), observation, 'earlier')?.line).toContain('1/3 回目');
  });

  it('does not consume a blaze slot when the urgent hand limit wins after the deadly hold is built', () => {
    const observation = frame({ onFire: true });
    const long = { hands: [...Array.from({ length: 4 }, () => ({ do: 'wait', seconds: 1 })), { do: 'fight', target: 'blaze' }] };
    for (let i = 0; i < 5; i += 1) expect(heldOfFrame(long, observation, 'urgent-earlier', true)?.code).toBe('urgent_limit');
    expect(heldOfFrame(act(), observation, 'urgent-earlier')?.line).toContain('1/3 回目');
  });
});
