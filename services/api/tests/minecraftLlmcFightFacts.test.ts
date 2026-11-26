import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { cookedWords, fightLines, gearLine, packLine, shieldLine, strikeLine, swordGap, toolLines, waterLine } from '../src/surfaces/minecraft/minecraftLlmcFightFacts.js';
import { preparationShortage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { inputFacts } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';

/** The night of 11/23 (d0001): a skeleton 45 m away with zombies around it, a stone sword, an iron, no armour, no shield, no food. */
const threat = (id: number, name: string, distance: number, x: number, y: number, z: number) => ({ id, name, distance, position: { x, y, z } });
const THREATS = [threat(19570, 'creeper', 34.3, -91, 64, -66), threat(19532, 'skeleton', 44.8, -81, 70, -105), threat(19533, 'zombie', 45.5, -85, 70, -103),
  threat(19534, 'zombie', 50.4, -88, 70, -107), threat(19592, 'skeleton', 49.4, -91, 70, -103)];
const frame = (world: Record<string, unknown>, inventory: Array<[string, number]> = [['stone_sword', 1], ['iron_ingot', 3]]): BodyObservation => ({ schemaVersion: 1,
  bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', timeOfDay: 14_000, health: 20, food: 20, worn: '頭: なし、胴: なし、脚: なし、足: なし、左手: なし', nearbyThreats: THREATS,
    inventory: inventory.map(([name, count]) => ({ name, count })), ...world } as never } });
const worldOf = (obs: BodyObservation): Record<string, unknown> => obs.state.world as Record<string, unknown>;

describe('the pack and the gear as facts (11/24)', () => {
  it('says the pack around the nearest shooter, the way there, and the night limit of a one-thing request', () => {
    const world = worldOf(frame({}));
    expect(packLine(world, true, true)).toBe('#19532 skeleton の周り 10m: skeleton 1・zombie 2（本人を含め 3 体）・そこまで 45m（夜の上限 25m）');
    expect(packLine(world, true, false)).not.toContain('夜の上限');
    expect(packLine(world, false, true)).not.toContain('夜の上限');
    expect(packLine({ nearbyThreats: [threat(1, 'zombie', 9, 0, 64, 0)] }, true, true)).toBeNull();
    expect(packLine({}, true, true)).toBeNull();
  });
  it('says the gear and whether it reaches the skeleton rule, or that a body with no weapon does not cut', () => {
    const obs = frame({});
    expect(gearLine(obs, worldOf(obs))).toBe('戦う装備: 剣 石（鉄の剣は今作れる）・防具 なし（0/4）・盾 なし・食べ物 0 点 → 射手へ詰める目安（剣と、盾か鉄の防具 3 部位・体力 10 以上）に届かない');
    const bare = frame({}, [['dirt', 20]]);
    expect(gearLine(bare, worldOf(bare))).toContain('武器 なし');
    expect(gearLine(bare, worldOf(bare))).toContain('体は斬らない');
    const armed = frame({ worn: '頭: iron_helmet、胴: iron_chestplate、脚: iron_leggings、足: なし、左手: shield' }, [['iron_sword', 1]]);
    expect(gearLine(armed, worldOf(armed))).toContain('射手 1 体へ詰める目安に届く');
    const calm = frame({ nearbyThreats: [] });
    expect(gearLine(calm, worldOf(calm))).toBeNull();
  });
  it('is in the facts of the normal and the shortened input alike (the urgent input takes the shortened ones too)', () => {
    const facts = inputFacts(frame({}), { request: true }, true);
    for (const lines of [facts.lines, facts.compressed]) {
      expect(lines.some(line => line.startsWith('#19532 skeleton の周り 10m'))).toBe(true);
      expect(lines.some(line => line.startsWith('戦う装備:'))).toBe(true);
    }
    expect(fightLines(frame({ nearbyThreats: [] }), true)).toEqual([]);
  });
});

describe('the water line (11/24 try1124b: a zombie came while she stood in a pool, and every decision chose a move of 1 to 4 blocks inside the water)', () => {
  const POOL = ['地図 v1 足=(10,62,20) x=7..13 z=18..22 方式=surface 上=北', 'z/x 7 8 9 0 1 2 3',
    '18 w1 w1 w1 w1 w1 :1 :1', '19 w1 w1 w1 w1 w1 w1 :1', '20 w1 w1 w1 @0 w1 w1 :1', '21 w1 w1 w1 w1 w1 w1 :1', '22 w1 w1 w1 w1 w1 :1 :2'].join('\n');
  const ZOMBIE = threat(1513, 'zombie', 3.2, 7, 62, 21);
  it('says that she stands in water, the nearest land with the cell to stand on, and the side of the enemy', () => {
    const line = waterLine({ localMap: POOL, nearbyThreats: [ZOMBIE] })!;
    expect(line).toContain('今は水の中（周り 8 マスのうち水 8）');
    expect(line).toContain('最寄りの陸は 東2・北2（約 3m・立つ所 (12,63,18)）');
    expect(line).toContain('敵 #1513 zombie は 西 3m');
    expect(line).not.toContain('敵に近い');
  });
  it('names the land she reaches before the enemy when the nearest land is on the enemy side', () => {
    const both = ['地図 v1 足=(10,62,20) x=3..13 z=18..22 方式=surface 上=北', 'z/x 3 4 5 6 7 8 9 0 1 2 3',
      ...[18, 19].map(z => `${z} ${Array(11).fill('w1').join(' ')}`), '20 :1 w1 w1 w1 w1 w1 w1 @0 w1 :1 :1', ...[21, 22].map(z => `${z} ${Array(11).fill('w1').join(' ')}`)].join('\n');
    const line = waterLine({ localMap: both, nearbyThreats: [threat(1513, 'zombie', 3.1, 13, 62, 20)] })!;
    expect(line).toContain('最寄りの陸は 東2（約 2m・立つ所 (12,63,20)）だが敵に近い。敵より先に着ける陸は 西7（約 7m・立つ所 (3,63,20)）');
  });
  it('is silent on land, with no hostile within 12 m, or on a map that is not the surface map', () => {
    const ashore = POOL.replace('@0', ':1').replace('w1 w1 w1 :1 w1 w1', 'w1 w1 w1 :1 w1 w1');
    expect(waterLine({ localMap: ashore.replace(/w1/gu, ':1'), nearbyThreats: [ZOMBIE] })).toBeNull();
    expect(waterLine({ localMap: POOL, nearbyThreats: [] })).toBeNull();
    expect(waterLine({ localMap: POOL, nearbyThreats: [threat(1, 'zombie', 13, 20, 62, 20)] })).toBeNull();
    expect(waterLine({ localMap: POOL.replace('方式=surface', '方式=layers'), nearbyThreats: [ZOMBIE] })).toBeNull();
  });
  it('still says it after she swam about: the drawing puts * (the trail) over the block letters, and a trail cell with water around it is water; a bank cell under the trail is never named as the land', () => {
    const swum = POOL.replace('19 w1 w1 w1 w1 w1 w1 :1', '19 w1 *1 *1 *1 *1 *1 :1').replace('20 w1 w1 w1 @0 w1 w1 :1', '20 w1 *1 *1 @0 *1 *1 :1').replace('21 w1 w1 w1 w1 w1 w1 :1', '21 w1 w1 w1 *1 *1 w1 :1');
    const line = waterLine({ localMap: swum, nearbyThreats: [ZOMBIE] })!;
    expect(line).toContain('今は水の中');
    expect(line).toContain('最寄りの陸は 東2・北2');
    const bank = POOL.replace('18 w1 w1 w1 w1 w1 :1 :1', '18 w1 w1 w1 w1 w1 *1 :1');
    expect(waterLine({ localMap: bank, nearbyThreats: [ZOMBIE] })).not.toContain('(13,');
  });
  it('is one of the fight lines, so the normal and the urgent live state both carry it', () => {
    const obs = frame({ localMap: POOL, nearbyThreats: [ZOMBIE] }, [['bread', 2]]);
    expect(fightLines(obs, false).some(line => line.startsWith('今は水の中'))).toBe(true);
    expect(inputFacts(obs, {}, true).compressed.some(line => line.startsWith('今は水の中'))).toBe(true);
  });
});

describe('the preparation as facts in the gear line (a fight request: raw meat and the iron for a sword)', () => {
  const counts = (entries: Array<[string, number]>) => new Map(entries);
  it('says what cooking the raw meat in the pack would come to, in points and seconds, and nothing when there is none', () => {
    // 4 raw mutton: 12.8 points now, 62.4 cooked, 40 seconds in one furnace.
    expect(cookedWords(counts([['mutton', 4]]), 12.8)).toBe('（焼けば 62.4 点・40 秒）');
    expect(cookedWords(counts([['cooked_mutton', 2]]), 31.2)).toBe('');
    expect(cookedWords(counts([]), 0)).toBe('');
  });
  it('says how much iron is between her and an iron sword, counting the raw iron once smelted, and nothing of a sword she has', () => {
    expect(swordGap(counts([['iron_ingot', 1]]), '剣 石')).toBe('（鉄の剣まであと鉄 1）');
    expect(swordGap(counts([]), null)).toBe('（鉄の剣まであと鉄 2）');
    expect(swordGap(counts([['iron_ingot', 1], ['raw_iron', 1]]), '剣 石')).toBe('（鉄の剣は鉄 2 で作れる・生の鉄は焼く）');
    expect(swordGap(counts([['iron_ingot', 2]]), '剣 石')).toBe('（鉄の剣は今作れる）');
    expect(swordGap(counts([]), '剣 鉄')).toBe('');
    // An iron axe is a weapon but not the sword.
    expect(swordGap(counts([]), '斧 鉄')).toContain('鉄の剣まであと鉄 2');
  });
  it('is in the gear line the head reads beside the food points and the sword, in the case of the raw mutton and the stone sword', () => {
    const obs = frame({}, [['stone_sword', 1], ['mutton', 4], ['iron_ingot', 1], ['raw_iron', 1]]);
    const line = gearLine(obs, worldOf(obs))!;
    expect(line).toContain('剣 石（鉄の剣は鉄 2 で作れる・生の鉄は焼く）');
    expect(line).toContain('食べ物 13 点（焼けば 62.4 点・40 秒）');
    expect(line).toContain('射手へ詰める目安');
  });
});

/** 11/26: four hoglins, a wooden sword and a shield at 22/336 (the gear line read as if it reached a shooter; no line said the blows or the shield's life). */
const HOGLINS = [1, 2, 3, 4].map(id => ({ ...threat(id, 'hoglin', 3 + id, id, 60, 0), health: 40 }));
describe('the blows a fight takes and the shield left (11/26)', () => {
  it('says each near hostile with its health and the blows a wooden sword needs, and the measured case', () => {
    const obs = frame({ dimension: 'the_nether', nearbyThreats: HOGLINS }, [['wooden_sword', 1]]);
    const line = strikeLine(obs, worldOf(obs))!;
    expect(line).toContain('剣 木の 1 打撃 4');
    expect(line).toContain('hoglin #1 4m 体力 40 → 10 打撃');
    expect(line).toContain('合わせて 40 打撃');
    expect(line).toContain('40 → 22.8');
    expect(fightLines(obs, false)).toContain(line);
  });
  it('uses the table when the row has no health (marked 表), the stone sword blow, and a bare hand', () => {
    const noHealth = frame({ nearbyThreats: [threat(7, 'zombie', 5, 0, 64, 0)] }, [['stone_sword', 1]]);
    expect(strikeLine(noHealth, worldOf(noHealth))).toContain('zombie #7 5m 体力 20（表） → 4 打撃');
    const bare = frame({ nearbyThreats: [threat(7, 'zombie', 5, 0, 64, 0)] }, [['dirt', 1]]);
    expect(strikeLine(bare, worldOf(bare))).toContain('武器なし（素手の 1 打撃 1）');
    expect(strikeLine(bare, worldOf(bare))).toContain('→ 20 打撃');
    const far = frame({ nearbyThreats: [threat(7, 'zombie', 30, 0, 64, 0)] });
    expect(strikeLine(far, worldOf(far))).toBeNull();
  });
  it('says the shield when it is under a third, from the off hand first and from the pack otherwise', () => {
    expect(shieldLine({ worn: '頭: なし、胴: なし、脚: なし、足: なし、左手: shield(残り22/336)' })).toBe('盾 残り 22/336（構えている盾。1/3 を切っている）');
    expect(shieldLine({ worn: '左手: shield(残り120/336)' })).toBeNull();
    expect(shieldLine({ worn: '左手: なし', inventory: [{ name: 'shield', count: 1, durability: { left: 50, max: 336 } }] })).toContain('盾 残り 50/336（持っている盾');
    expect(shieldLine({ worn: '左手: shield' })).toBeNull();
    const obs = frame({ worn: '頭: なし、胴: なし、脚: なし、足: なし、左手: shield(残り22/336)', nearbyThreats: [] });
    expect(fightLines(obs, false)).toEqual(['盾 残り 22/336（構えている盾。1/3 を切っている）']);
  });
  it('says a short diamond pickaxe as what obsidian takes, and that the body spends the cheapest tool, while no other pickaxe is carried', () => {
    const inventory = [{ name: 'diamond_pickaxe', count: 1, durability: { left: 10, max: 1561 } }, { name: 'obsidian', count: 7 }, { name: 'cobblestone', count: 5 }, { name: 'stick', count: 2 }];
    const lines = toolLines({ inventory });
    expect(lines[0]).toBe('diamond_pickaxe 残り 10/1561（1/3 を切っている。持ち: ダイヤ 0・棒 2。作り直すなら ダイヤ 3・棒 2）');
    expect(lines[1]).toContain('体は一番安い道具から使う設計');
    expect(lines[1]).toContain('石のツルハシ: 持ち: 丸石 5・棒 2。作り直すなら 丸石 3・棒 2');
    expect(lines[1]).toContain('今は荷の石以上のツルハシがダイヤ 1 本のみ');
    expect(lines[2]).toBe('黒曜石を壊せるのはダイヤのつるはしだけ（1 個＝1 使い）。残り 10/1561 は黒曜石 10 個分（今 7 個持ち。必要: 点検あと 1→足りる・戦い用あと 5→足りる・ゲート作り直し10→足りる）。残り少ないダイヤは黒曜石用に持ち続ける: 捨てない・空けない（体も最後の 1 本は投げない）。壊れたら作り直しはダイヤ 3 が要る');
    expect(lines).toHaveLength(3);
    expect(toolLines({ inventory: [...inventory, { name: 'diamond_pickaxe', count: 1, durability: { left: 3, max: 1561 } }] }).filter(line => line.startsWith('黒曜石を壊せる'))).toHaveLength(1);
  });
  it('says it is short when the diamond pickaxe has fewer uses than the obsidian takes, and drops the spare line when a stone pickaxe is carried', () => {
    const lines = toolLines({ inventory: [{ name: 'diamond_pickaxe', count: 1, durability: { left: 4, max: 1561 } }, { name: 'stone_pickaxe', count: 4, durability: { left: 131, max: 131 } }] });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('今 0 個持ち。必要: 点検あと 8→足りない・戦い用あと 12→足りない・ゲート作り直し10→足りない');
    expect(toolLines({ inventory: [{ name: 'diamond_pickaxe', count: 1, durability: { left: 900, max: 1561 } }] })).toEqual([]);
  });
  it('lists a stone or better sword as a goal (not a requirement) of the Nether check, with what it comes to against a hoglin', () => {
    const base = { dimension: 'the_nether', food: 100, nowKinds: null, counts: new Map([['crafting_table', 1], ['shield', 1], ['cobblestone', 64]]) };
    const said = preparationShortage(base)!;
    expect(said).toContain('石以上の剣が無い');
    expect(said).toContain('ホグリン（体力 40）');
    expect(said.split('目標')[0]).not.toContain('剣');
    const armed = preparationShortage({ ...base, counts: new Map([...base.counts, ['stone_sword', 1]]) })!;
    expect(armed).not.toContain('石以上の剣');
  });
});
