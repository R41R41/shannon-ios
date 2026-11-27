import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { crystalOpeningLine, createHeightWatch, descentLine, endFightLines, noBowLine, waitStreakLine } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import type { EndView } from '../src/surfaces/minecraft/minecraftEndView.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { goStop } from '../src/surfaces/minecraft/minecraftLlmcGoGuard.js';

/**
 * The way down from a top 10 m or more over the ground (11/27): the head waited about 60 times on the natural obsidian top of a pillar (nine wide, no gap, so no footing line and no drop), with the
 * caged branch of the bow-less line returning before the aloft one, and the pickaxe's refusal naming no other way down.
 */
type Item = { name: string; count: number; durability?: { left: number; max: number } };
const FEET = { x: 15.5, y: 103, z: 41.5 };

/** A localMap whose layer under the feet is a nine-wide obsidian top (no gap around the feet). */
function obsidianTop(): string {
  const rows = ['地図 v1 足=(15,103,41) x=10..20 z=36..46 方式=layers 上=北'];
  for (const y of [104, 103, 102, 101]) {
    rows.push(`y=${y}`);
    for (let z = 36; z <= 46; z += 1) {
      rows.push(` ${z} ${Array.from({ length: 11 }, (_, i) => {
        const x = 10 + i;
        if (y === 103 && x === 15 && z === 41) return '@';
        return y <= 102 && x >= 11 && x <= 19 && z >= 37 && z <= 45 ? 'O' : '.';
      }).join(' ')}`);
    }
  }
  return rows.join('\n');
}

const wait = [{ x: 4, y: 65, z: 11, walkMeters: 32, walkSeconds: null, side: 0, straight: true }, { x: 8, y: 64, z: 9, walkMeters: 33, walkSeconds: null, side: 0, straight: true }];
const observation = (inventory: Item[], extra: Record<string, unknown> = {}): BodyObservation => ({ connected: true, facts: { dimension: 'the_end' }, state: { world: {
  dimension: 'the_end', position: FEET, health: 20, localMap: obsidianTop(), inventory,
  crystals: { remaining: 2, caged: 2, list: [{ id: 1016, position: { x: -42, y: 83, z: -1 }, caged: true, distance: 74 }, { id: 1018, position: { x: -34, y: 80, z: -25 }, caged: true, distance: 85 }] },
  dragon: { phase: 1, distance: 61, health: 200, approach: { strike: [], stage: [], retreat: [], wait } }, ...extra } } }) as unknown as BodyObservation;
const pack = (bucket: boolean): Item[] => [{ name: 'diamond_pickaxe', count: 1, durability: { left: 3, max: 1561 } }, { name: 'iron_sword', count: 1 }, { name: 'white_bed', count: 3 },
  ...(bucket ? [{ name: 'water_bucket', count: 1 }] : [])];
const linesOf = (bucket: boolean, footingDrop: number | null = null) => createEndgame(null).lines(observation(pack(bucket)), true, false, footingDrop).lines;

describe('the height line on a wide obsidian top with no footing line', () => {
  it('says the ground, the steps and the three ways down with their costs, with caged crystals 2 and a drop of 40', () => {
    const line = linesOf(true).find(item => item.startsWith('高所:'))!;
    expect(line).toContain('足の下は y=102 の黒曜石（幅の広い天辺。地図の範囲で 81 マス以上）、地面は約 y=64（待ち場の高さからの見積もり）で 39 段');
    expect(line).toContain('(a) 飛び降り＝go 4,65,11 range=3 maxDrop=42（待ち場の候補か地面の足場へ');
    expect(line).toContain('実走 3 回（総落差 25・17・13m）はすべて被害 0、ラボは垂直 10・25・90m を各 1 回で成功。今の 39m はラボの範囲内で、実走ではこの高さは未経験');
    expect(line).toContain('水で止められなかった時（水を置けない・外れ。実績は 0 回）は約 36 の被害');
    expect(line).toContain('火の玉が飛んでいる入力（「火の玉:」の行がある間）と、息の雲が足元にある入力では出さず、行が無い次の入力で出す');
    expect(line).toContain('(b) 掘って降りる＝vertical down shaft y=64 dig=obsidian liquid=stop で 38 段・約 357 秒');
    expect(line).toContain('黒曜石は 1 段 1 使いで足りない（必要 38・残り 3）');
    expect(line).toContain('降りる・逃げる命が先: 降りるのに使ってよい');
    expect(line).toContain('(c) 待つ＝高所に長居した実走 2 回はどちらも死んだ（落下 1・息の雲 1）');
    expect(line).not.toContain('最後の手');
    // The line leads the fight lines, and the wait line says the feet are above the waiting cells.
    expect(linesOf(true)[0]).toBe(line);
    expect(linesOf(true).find(item => item.startsWith('待ち場の候補'))).toContain('今の足は待ち場より 38 m 高い');
  });

  it('the same height when a footing line measured it (the measure is kept for later inputs, and says where it came from)', () => {
    const endgame = createEndgame(null);
    const measured = endgame.lines(observation(pack(true)), true, false, 39).lines.find(item => item.startsWith('高所:'))!;
    expect(measured).toContain('地面は約 y=64（足場の測定）で 39 段');
    const later = endgame.lines(observation(pack(true)), true, false, null).lines.find(item => item.startsWith('高所:'))!;
    expect(later).toContain('（前に測った地面）');
  });

  it('a bucket in the pack or hand changes the sentence: no bucket says water cannot stop the fall', () => {
    const withBucket = linesOf(true).find(item => item.startsWith('高所:'))!;
    const without = linesOf(false).find(item => item.startsWith('高所:'))!;
    expect(withBucket).toContain('先に同じ act の頭に equip water_bucket');
    expect(without).toContain('(a) 飛び降り＝水バケツが荷に無いので水で止められない');
    expect(without).not.toContain('maxDrop=');
  });

  it('is not said on the ground, nor a drop under 10 m', () => {
    const low = (y: number) => createEndgame(null).lines(observation(pack(true), { position: { ...FEET, y } }), true, false, null).lines.some(item => item.startsWith('高所:'));
    expect(low(103)).toBe(true);
    expect(low(74)).toBe(true);
    expect(low(73)).toBe(false);
    expect(low(64)).toBe(false);
  });
});

describe('the caged line with two caged crystals left', () => {
  const crystal = { id: 1016, position: { x: -42, y: 83, z: -1 }, caged: true, distance: 74 };
  const view = (drop: number | undefined, health = 200): EndView => ({ feet: { x: 15, y: drop === undefined ? 64 : 103, z: 41 }, ...(drop === undefined ? {} : { drop }),
    dragon: { id: 1, health, phase: 1, phaseName: null, phaseFor: 3, perched: false, position: null, headPosition: null, distance: 61, headReach: null, strike: null },
    perch: null, crystals: { remaining: 1, gone: 9, caged: 1, unseen: 0, visible: 1, list: [crystal] }, breath: [], fireballs: 0 } as unknown as EndView);

  it('aloft by 40 the aloft words come first, and then that no open crystal is left and the caged ones are judged below', () => {
    const line = noBowLine(view(40));
    expect(line).toContain('今は宙・塔の上（地面まで 40 m）');
    expect(line).toContain('檻なしの結晶はもう無い。竜はベッドか剣で倒す。檻つきは下の事実で判断');
    expect(line).not.toContain('檻つきは残したまま竜を倒す');
  });

  it('on the ground it lists the facts: the heal, the sit damage, the climb, and no walking to a cage while she sits', () => {
    const line = noBowLine(view(undefined), '前の座りで竜 200→140（傷 60）、次の座りの手前では 170（20 秒で +30）');
    expect(line).toContain('檻つき 1 本が残る: #1016 (-42,83,-1)（地面から約 17 段・材料 20 個');
    expect(line).toContain('ベッド 1 座りの傷は 61〜121、結晶が残る間は +2 体力/秒で回復しうる');
    expect(line).toContain('前の座りで竜 200→140（傷 60）、次の座りの手前では 170（20 秒で +30）');
    expect(line).toContain('体力が 50 より多い間は');
    expect(line).toContain('その柱の上で降りる手（高所の行）も先に確かめる');
    expect(line).toContain('竜の座りが近い・座っている間は檻へ歩かない');
    expect(line).not.toContain('檻つきは残したまま竜を倒す');
    expect(noBowLine(view(undefined, 40))).toContain('体力 50 以下: 窪みの剣か残りのベッドで届く。檻へは行かない');
  });

  it('with a bow and arrows the same facts stand among the fight lines', () => {
    const lines = endFightLines(view(undefined), null, true, 4);
    expect(lines.some(item => item.includes('檻なしの結晶はもう無い。檻つき 1 本が残る'))).toBe(true);
  });
});

describe('the height watch', () => {
  it('counts the minutes and the health lost while aloft, the waits in a row, and the dragon\'s health across a sit', () => {
    const watch = createHeightWatch();
    const at = (phase: number, health: number, drop = 39): EndView => ({ feet: { x: 15, y: 103, z: 41 }, drop,
      dragon: { id: 1, health, phase, phaseName: null, phaseFor: 1, perched: false, position: null, headPosition: null, distance: 20, headReach: null, strike: null },
      perch: null, crystals: { remaining: 2, gone: 8, caged: 2, unseen: 0, visible: 0, list: [] }, breath: [], fireballs: 0 } as unknown as EndView);
    watch.view(at(0, 200), 20, 0);
    const hurt = watch.view(at(1, 200), 16, 60_000);
    expect(hurt).toMatchObject({ basis: 'measured', hits: 1, lost: 4, minutes: 1 });
    for (let i = 0; i < 10; i += 1) watch.noteActs(['wait']);
    const view = watch.view(at(0, 200), 16, 120_000);
    expect(view.waits).toBe(10);
    expect(waitStreakLine(view, true)).toContain('待つ手が 10 回続いている（高所に 2 分・体力が減った回数 1・合計 4）');
    watch.noteActs(['go']);
    expect(watch.view(at(0, 200), 16, 130_000).waits).toBe(0);
    expect(waitStreakLine(watch.view(at(0, 200), 16, 130_000), true)).toBeNull();
    // A sit, then the flight, then the next sit: the damage and what came back
    watch.view(at(5, 200), 16, 140_000);
    watch.view(at(6, 140), 16, 150_000);
    watch.view(at(0, 140), 16, 160_000);
    const next = watch.view(at(5, 170), 16, 180_000);
    expect(next.sit).toBe('前の座りで竜 200→140（傷 60）、次の座りの手前では 170（20 秒で +30）');
    // Back on the ground, the counts start over
    expect(watch.view(at(0, 170, 0), 16, 200_000)).toMatchObject({ minutes: null, hits: 0, lost: 0 });
  });

  it('a drop under 10 m, or none known, gives no height line', () => {
    expect(descentLine({ feet: { x: 0, y: 70, z: 0 }, drop: 9 } as unknown as EndView, null, null)).toBeNull();
    expect(descentLine(null, null, null)).toBeNull();
  });
});

describe('the pickaxe refusal for a dig down in the End names the other ways down', () => {
  const diamond = (left: number): Item => ({ name: 'diamond_pickaxe', count: 1, durability: { left, max: 1561 } });
  const frame = (dimension: string, inventory: Item[]): BodyObservation => {
    const rows = ['地図 v1 足=(10,60,10) x=3..17 z=3..17 方式=layers 上=北'];
    for (const dy of [1, 0, -1, -2]) {
      rows.push(`y=${60 + dy}`);
      for (let z = 3; z <= 17; z += 1) rows.push(` ${z} ${Array.from({ length: 15 }, (_, i) => dy === 0 && z === 10 && i + 3 === 10 ? '@' : dy === 0 || dy === 1 ? '.' : '#').join(' ')}`);
    }
    return { schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', facts: {}, state: { world: { dimension, position: { x: 10.5, y: 60, z: 10.5 }, localMap: rows.join('\n'), health: 20, food: 20,
      inventory, nearbyThreats: [], nearbyEntities: [] } } } as unknown as BodyObservation;
  };
  const down = { hands: [{ do: 'vertical', dir: 'down', shape: 'stairs', toward: 'north', toY: 22, maxDig: 40, canDig: ['obsidian'] }] };
  it('puts the dig\'s shortfall and the jump and the wait in one sentence in the End', () => {
    const stop = goStop(down, frame('the_end', [diamond(3)]));
    expect(stop?.code).toBe('pickaxe_wear');
    expect(stop?.line).toContain('掘って降りるには足りない（必要');
    expect(stop?.line).toContain('残り 3）');
    expect(stop?.line).toContain('別の降り方: 水バケツで着水する飛び降り（go に maxDrop。水バケツは手か hotbar に）・待つ');
    expect(stop?.line).toContain('降りる・逃げる命が先で、黒曜石でなく降りるのに使ってよい');
  });
  it('says none of it outside the End', () => {
    const stop = goStop(down, frame('overworld', [diamond(3)]));
    expect(stop?.code).toBe('pickaxe_wear');
    expect(stop?.line).not.toContain('別の降り方');
  });
});

describe('the arrows\' angle', () => {
  const shot = (pitchDeg: number) => ({ x: 0, y: 65, z: 5, distance: 30, pitchDeg, flightTicks: 40 });
  const view = (pitchDeg: number): EndView => ({ feet: { x: 0, y: 65, z: 0 }, dragon: null, perch: null, breath: [], fireballs: 0,
    crystals: { remaining: 2, gone: 8, caged: 0, unseen: 0, visible: 2, list: [], openings: [{ id: 1004, caged: false, positions: [shot(pitchDeg)], blockedBy: null, afterCageRemoved: [] }] } } as unknown as EndView);
  it('says a high arc is hard to hit and what to do after a miss, and keeps a low one plain', () => {
    const high = crystalOpeningLine(view(83))!;
    expect(high).toContain('仰角 83°（山なり）');
    expect(high).toContain('83° で 5 射 0 命中、直射 7 射で 4 命中');
    expect(high).toContain('1 回外れたら同じ所から続けず、別の結晶か別の射点へ');
    const low = crystalOpeningLine(view(20))!;
    expect(low).not.toContain('仰角');
    expect(low).not.toContain('山なり');
  });
});
