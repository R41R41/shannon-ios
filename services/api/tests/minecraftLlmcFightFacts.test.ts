import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { fightLines, gearLine, packLine } from '../src/surfaces/minecraft/minecraftLlmcFightFacts.js';
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
    expect(gearLine(obs, worldOf(obs))).toBe('戦う装備: 剣 石・防具 なし（0/4）・盾 なし・食べ物 0 点 → 射手へ詰める目安（剣と、盾か鉄の防具 3 部位・体力 10 以上）に届かない');
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
